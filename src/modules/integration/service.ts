import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditEvents,
  authIdentities,
  caseCorrespondenceMessages,
  caseDeadlineHistory,
  caseDeadlines,
  caseQueues,
  cases,
  documentSubmissionLinks,
  externalParticipantCredentials,
  intakeFormVersions,
  intakeForms,
  intakeSubmissions,
  organizationMemberships,
  organizations,
  participantIdentityLinks,
  submissionProtectedCompartments,
  users,
} from "@/db/schema";
import type { TenantScope } from "@/lib/tenancy";
import type { ApiAuthorizationContext } from "@/modules/api/auth";
import { checksumJson } from "@/modules/application/canonical";
import { auditEventValues } from "@/modules/audit/event";
import {
  assignRoleToMembership,
  ensureDefaultRoles,
} from "@/modules/auth/default-roles";
import { findCaseById, listCaseTags } from "@/modules/cases/repository";
import {
  createCaseFromSubmission,
  parseCasePriority,
  transitionCase,
  updateCaseMetadata,
} from "@/modules/cases/service";
import {
  createCaseNote,
  createOutboundCorrespondenceDraft,
  queueOutboundCorrespondence,
} from "@/modules/communications/service";
import { listCaseNotes } from "@/modules/communications/repository";
import { canViewDocumentVisibility } from "@/modules/documents/policy";
import {
  findDocumentVersion,
  listDocumentCustodyEvents,
  listSubmissionDocuments,
} from "@/modules/documents/repository";
import { downloadDocumentVersion } from "@/modules/documents/service";
import {
  fieldsInDefinition,
  parseFormDefinition,
} from "@/modules/forms/definition";
import { submitPublicForm } from "@/modules/forms/service";
import { getCaseParticipantMessagingCapability } from "@/modules/participant-portal/service";
import { decryptProtectedPayload } from "@/modules/protected-data/crypto";
import {
  applyRoutingRules,
  manualAssignCase,
} from "@/modules/routing/service";
import {
  findTransition,
  findWorkflowState,
  parseWorkflowDefinition,
  transitionsFromState,
} from "@/modules/workflows/definition";
import { ensureServiceActor } from "./actor";
import {
  ApiProblem,
  invalid,
  notFound,
  optionalString,
  requiredString,
  requireUuid,
} from "./api";

type Ctx = ApiAuthorizationContext;

function documentView(row: {
  version: {
    id: string;
    documentId: string;
    versionNumber: number;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    contentStatus: string;
    malwareScanStatus: string;
    malwareScanProvider: string | null;
    malwareScannedAt: Date | null;
    uploadedAt: Date;
  };
  document: { visibility: string; title?: string | null };
  type: { key?: string | null; name?: string | null };
}) {
  const released =
    row.version.contentStatus === "available" &&
    row.version.malwareScanStatus === "clean";
  return {
    versionId: row.version.id,
    documentId: row.version.documentId,
    versionNumber: row.version.versionNumber,
    filename: row.version.originalFilename,
    mimeType: row.version.mimeType,
    sizeBytes: row.version.sizeBytes,
    sha256: row.version.sha256,
    visibility: row.document.visibility,
    documentTypeKey: row.type.key ?? null,
    contentStatus: row.version.contentStatus,
    malwareScanStatus: row.version.malwareScanStatus,
    malwareScanProvider: row.version.malwareScanProvider,
    malwareScannedAt: row.version.malwareScannedAt,
    uploadedAt: row.version.uploadedAt,
    released,
    contentPath: released
      ? `/api/v1/documents/${row.version.id}/content`
      : null,
  };
}

async function loadSubmission(
  db: Database,
  scope: TenantScope,
  submissionId: string,
) {
  const [row] = await db
    .select({
      submission: intakeSubmissions,
      form: intakeForms,
      version: intakeFormVersions,
    })
    .from(intakeSubmissions)
    .innerJoin(
      intakeForms,
      and(
        eq(intakeForms.id, intakeSubmissions.formId),
        eq(intakeForms.organizationId, intakeSubmissions.organizationId),
      ),
    )
    .innerJoin(
      intakeFormVersions,
      and(
        eq(intakeFormVersions.id, intakeSubmissions.formVersionId),
        eq(
          intakeFormVersions.organizationId,
          intakeSubmissions.organizationId,
        ),
      ),
    )
    .where(
      and(
        eq(intakeSubmissions.id, submissionId),
        eq(intakeSubmissions.organizationId, scope.organizationId),
      ),
    )
    .limit(1);
  // Drafts belong to the participant alone until they are submitted.
  if (!row || row.submission.status !== "submitted") {
    throw notFound("Submission");
  }
  return row;
}

/** The immutable original account plus references; never protected values. */
export async function getSubmission(
  db: Database,
  ctx: Ctx,
  submissionId: string,
) {
  const scope = ctx.tenantScope;
  const row = await loadSubmission(db, scope, submissionId);
  const [compartments, [caseRecord], [credential], attachments] =
    await Promise.all([
      db
        .select({
          compartment: submissionProtectedCompartments.compartmentKey,
          fieldIds: submissionProtectedCompartments.fieldIds,
        })
        .from(submissionProtectedCompartments)
        .where(
          and(
            eq(
              submissionProtectedCompartments.organizationId,
              scope.organizationId,
            ),
            eq(submissionProtectedCompartments.submissionId, submissionId),
          ),
        ),
      db
        .select({
          id: cases.id,
          caseNumber: cases.caseNumber,
          status: cases.status,
        })
        .from(cases)
        .where(
          and(
            eq(cases.organizationId, scope.organizationId),
            eq(cases.sourceSubmissionId, submissionId),
          ),
        )
        .limit(1),
      db
        .select({ status: externalParticipantCredentials.status })
        .from(externalParticipantCredentials)
        .where(
          and(
            eq(
              externalParticipantCredentials.organizationId,
              scope.organizationId,
            ),
            eq(externalParticipantCredentials.submissionId, submissionId),
          ),
        )
        .limit(1),
      db
        .select({ id: documentSubmissionLinks.id })
        .from(documentSubmissionLinks)
        .where(
          and(
            eq(documentSubmissionLinks.organizationId, scope.organizationId),
            eq(documentSubmissionLinks.submissionId, submissionId),
          ),
        ),
    ]);

  const definition = parseFormDefinition(row.version.definition);
  const answers = row.submission.answers;
  const sha256 = checksumJson(answers);
  return {
    id: row.submission.id,
    status: row.submission.status,
    channel: row.submission.channel,
    locale: row.submission.locale,
    confirmationCode: row.submission.confirmationCode,
    submittedAt: row.submission.submittedAt,
    form: {
      id: row.form.id,
      slug: row.form.slug,
      name: row.form.name,
      versionId: row.version.id,
      versionNumber: row.version.versionNumber,
      fields: fieldsInDefinition(definition).map((field) => ({
        id: field.id,
        type: field.type,
        label: field.label,
        protected: Boolean(field.protection),
      })),
    },
    originalAccount: {
      answers,
      sha256,
      recordedSha256: row.submission.originalSha256,
      digestMatchesRecord:
        row.submission.originalSha256 === null
          ? null
          : row.submission.originalSha256 === sha256,
      canonicalization: "json-sorted-keys-utf8",
      immutable: true,
    },
    protectedCompartments: compartments,
    attachmentCount: attachments.length,
    case: caseRecord ?? null,
    participantPortal: {
      enabled: Boolean(definition.participantPortal?.enabled),
      credentialActive: credential?.status === "active",
    },
  };
}

/** Explicit-scope read of protected identity fields; every read is audited. */
export async function getSubmissionProtected(
  db: Database,
  ctx: Ctx,
  submissionId: string,
) {
  const scope = ctx.tenantScope;
  await loadSubmission(db, scope, submissionId);
  const rows = await db
    .select()
    .from(submissionProtectedCompartments)
    .where(
      and(
        eq(
          submissionProtectedCompartments.organizationId,
          scope.organizationId,
        ),
        eq(submissionProtectedCompartments.submissionId, submissionId),
      ),
    );

  let compartments;
  try {
    compartments = rows.map((row) => ({
      compartment: row.compartmentKey,
      fieldIds: row.fieldIds,
      values: decryptProtectedPayload(row.ciphertext, {
        organizationId: scope.organizationId,
        submissionId,
        compartmentKey: row.compartmentKey,
      }),
    }));
  } catch {
    throw new ApiProblem(
      503,
      "protected_data_unavailable",
      "Protected data cannot be decrypted in this deployment.",
    );
  }

  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: "system",
      action: "protected_data.service_read",
      resourceType: "submission",
      resourceId: submissionId,
      source: "api",
      metadata: {
        apiClientId: ctx.clientId,
        compartments: rows.map((row) => row.compartmentKey),
      },
    }),
  );

  return { submissionId, compartments };
}

export async function createSubmission(
  db: Database,
  ctx: Ctx,
  body: Record<string, unknown>,
) {
  const formSlug = requiredString(body.formSlug, "formSlug", 100);
  const locale = optionalString(body.locale, "locale", 35);
  if (
    !body.answers ||
    typeof body.answers !== "object" ||
    Array.isArray(body.answers)
  ) {
    throw invalid("answers must be an object keyed by field id.");
  }
  const [organization] = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  if (!organization) throw notFound("Organization");

  const submission = await submitPublicForm(
    db,
    organization.slug,
    formSlug,
    body.answers as Record<string, unknown>,
    null,
    [],
    { locale, channel: "api", publicOnly: false },
  );

  return {
    id: submission.id,
    status: submission.status,
    confirmationCode: submission.confirmationCode,
    submittedAt: submission.submittedAt,
    originalSha256: submission.originalSha256,
    // Shown exactly once. Hand it to the participant; it is not stored.
    participantAccessSecret: submission.participantPortalSecret,
    participantPortalPath: submission.participantPortalSecret
      ? `/participant/${encodeURIComponent(organization.slug)}`
      : null,
  };
}

export async function listSubmissionAttachments(
  db: Database,
  ctx: Ctx,
  submissionId: string,
) {
  await loadSubmission(db, ctx.tenantScope, submissionId);
  const rows = await listSubmissionDocuments(
    db,
    ctx.tenantScope,
    submissionId,
  );
  return rows
    .filter((row) =>
      canViewDocumentVisibility(row.document.visibility, ctx.permissions),
    )
    .map((row) => ({
      ...documentView(row),
      formFieldId: row.link.formFieldId,
      attachedAt: row.link.attachedAt,
    }));
}

async function visibleVersion(db: Database, ctx: Ctx, versionId: string) {
  const row = await findDocumentVersion(db, ctx.tenantScope, versionId);
  if (
    !row ||
    !canViewDocumentVisibility(row.document.visibility, ctx.permissions)
  ) {
    throw notFound("Document version");
  }
  return row;
}

export async function readDocumentContent(
  db: Database,
  ctx: Ctx,
  versionId: string,
) {
  await visibleVersion(db, ctx, versionId);
  const actorUserId = await ensureServiceActor(db, ctx);
  return downloadDocumentVersion(db, ctx.tenantScope, {
    versionId,
    actorUserId,
  });
}

export async function readDocumentCustody(
  db: Database,
  ctx: Ctx,
  versionId: string,
) {
  const row = await visibleVersion(db, ctx, versionId);
  const events = await listDocumentCustodyEvents(
    db,
    ctx.tenantScope,
    versionId,
  );
  return {
    document: documentView(row),
    custody: events.map((event) => ({
      id: event.id,
      action: event.action,
      fromCustodian: event.fromCustodian,
      toCustodian: event.toCustodian,
      location: event.location,
      note: event.note,
      occurredAt: event.occurredAt,
    })),
  };
}

async function requireCase(db: Database, ctx: Ctx, caseId: string) {
  const record = await findCaseById(db, ctx.tenantScope, caseId);
  if (!record) throw notFound("Case");
  return record;
}

export async function caseProjection(
  db: Database,
  ctx: Ctx,
  caseId: string,
) {
  const record = await requireCase(db, ctx, caseId);
  const workflow = parseWorkflowDefinition(record.workflowDefinition);
  const tags = await listCaseTags(db, ctx.tenantScope, caseId);
  return {
    id: record.id,
    caseNumber: record.caseNumber,
    sourceSubmissionId: record.sourceSubmissionId,
    title: record.title,
    summary: record.summary,
    status: record.status,
    statusLabel:
      findWorkflowState(workflow, record.status)?.label ?? record.status,
    priority: record.priority,
    disposition: record.disposition,
    assignedQueueId: record.assignedQueueId,
    assignedMembershipId: record.assignedMembershipId,
    escalationLevel: record.escalationLevel,
    openedAt: record.openedAt,
    resolvedAt: record.resolvedAt,
    closedAt: record.closedAt,
    updatedAt: record.updatedAt,
    tags: tags.map((tag) => tag.tag),
    availableTransitions: transitionsFromState(workflow, record.status).map(
      (transition) => ({
        key: transition.key,
        label: transition.label,
        to: transition.to,
      }),
    ),
  };
}

export async function openCase(
  db: Database,
  ctx: Ctx,
  body: Record<string, unknown>,
) {
  const submissionId = requireUuid(body.submissionId, "submissionId");
  const actorUserId = await ensureServiceActor(db, ctx);
  const [existing] = await db
    .select({ id: cases.id })
    .from(cases)
    .where(
      and(
        eq(cases.organizationId, ctx.organizationId),
        eq(cases.sourceSubmissionId, submissionId),
      ),
    )
    .limit(1);

  const record =
    existing ??
    (await createCaseFromSubmission(db, ctx.tenantScope, {
      submissionId,
      actorUserId,
      title: optionalString(body.title, "title", 500) ?? undefined,
      priority: body.priority
        ? parseCasePriority(String(body.priority))
        : undefined,
    }));

  let routing: "applied" | "skipped" | "failed" = "skipped";
  if (!existing && body.route !== false) {
    try {
      await applyRoutingRules(db, ctx.tenantScope, {
        caseId: record.id,
        actorUserId,
      });
      routing = "applied";
    } catch {
      routing = "failed";
    }
  }
  return {
    created: !existing,
    routing,
    case: await caseProjection(db, ctx, record.id),
  };
}

export async function transitionCaseByKey(
  db: Database,
  ctx: Ctx,
  caseId: string,
  body: Record<string, unknown>,
) {
  const record = await requireCase(db, ctx, caseId);
  const transitionKey = requiredString(
    body.transitionKey,
    "transitionKey",
    100,
  );
  const workflow = parseWorkflowDefinition(record.workflowDefinition);
  if (!findTransition(workflow, record.status, transitionKey)) {
    throw new ApiProblem(
      409,
      "transition_unavailable",
      "That transition is not available from the current status.",
      {
        status: record.status,
        available: transitionsFromState(workflow, record.status).map(
          (transition) => transition.key,
        ),
      },
    );
  }
  await transitionCase(db, ctx.tenantScope, {
    caseId,
    transitionKey,
    actorUserId: await ensureServiceActor(db, ctx),
    actorPermissions: [...ctx.permissions],
    comment: optionalString(body.comment, "comment", 10000),
    disposition: optionalString(body.disposition, "disposition", 500),
  });
  return caseProjection(db, ctx, caseId);
}

export async function triageCase(
  db: Database,
  ctx: Ctx,
  caseId: string,
  body: Record<string, unknown>,
) {
  const record = await requireCase(db, ctx, caseId);
  const currentTags = await listCaseTags(db, ctx.tenantScope, caseId);
  if (
    body.tags !== undefined &&
    (!Array.isArray(body.tags) ||
      body.tags.some((tag) => typeof tag !== "string"))
  ) {
    throw invalid("tags must be an array of strings.");
  }
  await updateCaseMetadata(db, ctx.tenantScope, {
    caseId,
    title: optionalString(body.title, "title", 500) ?? record.title,
    summary:
      body.summary === undefined
        ? record.summary
        : optionalString(body.summary, "summary", 20000),
    priority: parseCasePriority(String(body.priority ?? record.priority)),
    disposition:
      body.disposition === undefined
        ? record.disposition
        : optionalString(body.disposition, "disposition", 500),
    tags:
      (body.tags as string[] | undefined) ??
      currentTags.map((tag) => tag.tag),
    actorUserId: await ensureServiceActor(db, ctx),
  });
  return caseProjection(db, ctx, caseId);
}

export async function assignCase(
  db: Database,
  ctx: Ctx,
  caseId: string,
  body: Record<string, unknown>,
) {
  await requireCase(db, ctx, caseId);
  let queueId: string | null = body.queueId
    ? requireUuid(body.queueId, "queueId")
    : null;
  if (!queueId && body.queueSlug) {
    const [queue] = await db
      .select({ id: caseQueues.id })
      .from(caseQueues)
      .where(
        and(
          eq(caseQueues.organizationId, ctx.organizationId),
          eq(caseQueues.slug, String(body.queueSlug)),
        ),
      )
      .limit(1);
    if (!queue) throw notFound("Queue");
    queueId = queue.id;
  }
  let membershipId: string | null = body.membershipId
    ? requireUuid(body.membershipId, "membershipId")
    : null;
  if (!membershipId && body.userId) {
    const [membership] = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, ctx.organizationId),
          eq(
            organizationMemberships.userId,
            requireUuid(body.userId, "userId"),
          ),
          eq(organizationMemberships.status, "active"),
        ),
      )
      .limit(1);
    if (!membership) throw notFound("Assignee");
    membershipId = membership.id;
  }
  if (!queueId && !membershipId && body.unassign !== true) {
    throw invalid(
      "Provide queueId, queueSlug, membershipId or userId (or unassign: true).",
    );
  }
  try {
    await manualAssignCase(db, ctx.tenantScope, {
      caseId,
      queueId,
      membershipId,
      actorUserId: await ensureServiceActor(db, ctx),
      reason: optionalString(body.reason, "reason", 2000),
    });
  } catch (error) {
    throw new ApiProblem(
      409,
      "assignment_failed",
      error instanceof Error && error.name === "CaseAssignmentError"
        ? error.message
        : "Case could not be assigned.",
    );
  }
  return caseProjection(db, ctx, caseId);
}

/** Ad hoc case deadline with an explicit due time. */
export async function createManualDeadline(
  db: Database,
  ctx: Ctx,
  caseId: string,
  body: Record<string, unknown>,
) {
  await requireCase(db, ctx, caseId);
  const label = requiredString(body.label, "label", 300);
  const dueAt = new Date(String(body.dueAt ?? ""));
  if (Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now()) {
    throw invalid("dueAt must be a future ISO-8601 timestamp.");
  }
  const key =
    optionalString(body.key, "key", 80) ??
    label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(key)) {
    throw invalid("key must be a lowercase identifier.");
  }
  const policyKey = `manual_${key}`;
  const now = new Date();
  const hours = Math.max(
    1,
    Math.ceil((dueAt.getTime() - now.getTime()) / 3_600_000),
  );
  const actorUserId = await ensureServiceActor(db, ctx);
  const scope = ctx.tenantScope;

  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ occurrence: caseDeadlines.occurrence })
      .from(caseDeadlines)
      .where(
        and(
          eq(caseDeadlines.caseId, caseId),
          eq(caseDeadlines.policyKey, policyKey),
        ),
      )
      .orderBy(desc(caseDeadlines.occurrence))
      .limit(1);
    const snapshot = {
      key: policyKey,
      label,
      manual: true,
      dueAt: dueAt.toISOString(),
    };
    const [deadline] = await tx
      .insert(caseDeadlines)
      .values({
        organizationId: scope.organizationId,
        caseId,
        policyKey,
        occurrence: (latest?.occurrence ?? 0) + 1,
        label,
        description: optionalString(body.description, "description", 4000),
        triggerType: "manual",
        durationValue: hours,
        durationUnit: "hours",
        pausable: false,
        policySnapshot: snapshot,
        status: "active",
        startedAt: now,
        dueAt,
      })
      .returning();
    await tx.insert(caseDeadlineHistory).values({
      organizationId: scope.organizationId,
      deadlineId: deadline.id,
      eventType: "started",
      actorUserId,
      metadata: { triggerType: "manual", dueAt: dueAt.toISOString() },
      occurredAt: now,
    });
    await tx.insert(auditEvents).values(
      auditEventValues({
        organizationId: scope.organizationId,
        actorType: "user",
        actorUserId,
        action: "deadline.started",
        resourceType: "case_deadline",
        resourceId: deadline.id,
        parentResourceType: "case",
        parentResourceId: caseId,
        source: "api",
        newState: {
          policyKey,
          occurrence: deadline.occurrence,
          status: deadline.status,
          dueAt: dueAt.toISOString(),
          warningAt: null,
        },
      }),
    );
    return deadline;
  });
}

function messageView(message: typeof caseCorrespondenceMessages.$inferSelect) {
  return {
    id: message.id,
    threadId: message.threadId,
    direction: message.direction,
    from: message.direction === "inbound" ? "participant" : "organization",
    subject: message.subject,
    body: message.body,
    status: message.status,
    sentAt: message.sentAt,
    receivedAt: message.receivedAt,
    createdAt: message.createdAt,
  };
}

/** Participant-visible portal thread only: no notes, no other channels. */
export async function listParticipantMessages(
  db: Database,
  ctx: Ctx,
  caseId: string,
) {
  await requireCase(db, ctx, caseId);
  const [capability, rows] = await Promise.all([
    getCaseParticipantMessagingCapability(db, ctx.tenantScope, caseId),
    db
      .select()
      .from(caseCorrespondenceMessages)
      .where(
        and(
          eq(caseCorrespondenceMessages.organizationId, ctx.organizationId),
          eq(caseCorrespondenceMessages.caseId, caseId),
          eq(caseCorrespondenceMessages.channel, "portal"),
          inArray(caseCorrespondenceMessages.visibility, [
            "participant",
            "public",
          ]),
          inArray(caseCorrespondenceMessages.status, ["sent", "received"]),
        ),
      )
      .orderBy(
        asc(caseCorrespondenceMessages.createdAt),
        asc(caseCorrespondenceMessages.id),
      ),
  ]);
  return { messaging: capability, messages: rows.map(messageView) };
}

export async function postParticipantMessage(
  db: Database,
  ctx: Ctx,
  caseId: string,
  body: Record<string, unknown>,
) {
  await requireCase(db, ctx, caseId);
  const capability = await getCaseParticipantMessagingCapability(
    db,
    ctx.tenantScope,
    caseId,
  );
  if (!capability.allowMessaging) {
    throw new ApiProblem(
      409,
      "participant_messaging_unavailable",
      "Safe participant messaging is not available for this case.",
      { reason: capability.reason },
    );
  }
  const text = requiredString(body.body, "body", 20000);
  const actorUserId = await ensureServiceActor(db, ctx);
  const draft = await createOutboundCorrespondenceDraft(
    db,
    ctx.tenantScope,
    {
      caseId,
      threadId: body.threadId
        ? requireUuid(body.threadId, "threadId")
        : null,
      channel: "portal",
      visibility: "participant",
      subject: optionalString(body.subject, "subject", 500),
      body: text,
      recipients: [],
      actorUserId,
    },
  );
  const sent = await queueOutboundCorrespondence(db, ctx.tenantScope, {
    messageId: draft.id,
    actorUserId,
  });
  return messageView(sent);
}

export async function listInternalNotes(
  db: Database,
  ctx: Ctx,
  caseId: string,
) {
  await requireCase(db, ctx, caseId);
  const notes = await listCaseNotes(db, ctx.tenantScope, caseId);
  return notes
    .filter(
      (note) =>
        note.visibility !== "restricted" ||
        ctx.permissions.has("document:view_private"),
    )
    .map((note) => ({
      id: note.id,
      visibility: note.visibility,
      body: note.body,
      authorUserId: note.authorUserId,
      createdAt: note.createdAt,
    }));
}

export async function addInternalNote(
  db: Database,
  ctx: Ctx,
  caseId: string,
  body: Record<string, unknown>,
) {
  await requireCase(db, ctx, caseId);
  const note = await createCaseNote(db, ctx.tenantScope, {
    caseId,
    visibility: "internal",
    body: requiredString(body.body, "body", 20000),
    actorUserId: await ensureServiceActor(db, ctx),
  });
  return {
    id: note.id,
    visibility: note.visibility,
    body: note.body,
    createdAt: note.createdAt,
  };
}

const providerPattern = /^[a-z0-9][a-z0-9_.:-]{0,99}$/;

function identityInput(body: Record<string, unknown>) {
  const provider = requiredString(body.provider, "provider", 100);
  const subject = requiredString(body.subject, "subject", 255);
  if (!providerPattern.test(provider)) {
    throw invalid("provider must be a lowercase identifier.");
  }
  return { provider, subject };
}

/**
 * Maps an external identity-provider subject to a staff user in this
 * organization so cases can be assigned to them. The user has no local
 * password; roles are limited to this organization's existing role keys.
 */
export async function upsertStaffIdentity(
  db: Database,
  ctx: Ctx,
  body: Record<string, unknown>,
) {
  const { provider, subject } = identityInput(body);
  const displayName = optionalString(body.displayName, "displayName", 200);
  const roleKeys = Array.isArray(body.roleKeys)
    ? body.roleKeys.map(String)
    : [];
  if (roleKeys.includes("administrator")) {
    throw new ApiProblem(
      403,
      "role_not_delegable",
      "The administrator role cannot be granted through the API.",
    );
  }

  const result = await db.transaction(async (tx) => {
    const [identity] = await tx
      .select()
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.provider, provider),
          eq(authIdentities.subject, subject),
        ),
      )
      .limit(1);

    let userId = identity?.userId ?? null;
    if (!userId) {
      const email =
        optionalString(body.email, "email", 320)?.toLowerCase() ??
        `${checksumJson([provider, subject]).slice(0, 32)}@external.invalid`;
      const [existingUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existingUser) {
        // Never bind an external subject to a pre-existing local account.
        throw new ApiProblem(
          409,
          "email_in_use",
          "That email already belongs to another account.",
        );
      }
      const [user] = await tx
        .insert(users)
        .values({ email, displayName })
        .returning({ id: users.id });
      userId = user.id;
      await tx.insert(authIdentities).values({
        userId,
        provider,
        subject,
        email: optionalString(body.email, "email", 320),
      });
    }

    await tx
      .insert(organizationMemberships)
      .values({ organizationId: ctx.organizationId, userId })
      .onConflictDoNothing();
    const [membership] = await tx
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, ctx.organizationId),
          eq(organizationMemberships.userId, userId),
        ),
      )
      .limit(1);

    await tx.insert(auditEvents).values(
      auditEventValues({
        organizationId: ctx.organizationId,
        actorType: "system",
        action: "identity.staff_linked",
        resourceType: "organization_membership",
        resourceId: membership.id,
        source: "api",
        metadata: { provider, roleKeys, apiClientId: ctx.clientId },
      }),
    );

    return {
      provider,
      subject,
      userId,
      membershipId: membership.id,
      membershipStatus: membership.status,
      roleKeys,
    };
  });

  if (roleKeys.length) {
    await ensureDefaultRoles(db, ctx.tenantScope);
    for (const roleKey of roleKeys) {
      try {
        await assignRoleToMembership(
          db,
          ctx.tenantScope,
          result.membershipId,
          roleKey,
        );
      } catch {
        throw invalid(`Unknown role key: ${roleKey}`);
      }
    }
  }
  return result;
}

export async function findStaffIdentity(
  db: Database,
  ctx: Ctx,
  provider: string,
  subject: string,
) {
  const [row] = await db
    .select({
      userId: authIdentities.userId,
      membershipId: organizationMemberships.id,
      membershipStatus: organizationMemberships.status,
    })
    .from(authIdentities)
    .innerJoin(
      organizationMemberships,
      and(
        eq(organizationMemberships.userId, authIdentities.userId),
        eq(organizationMemberships.organizationId, ctx.organizationId),
      ),
    )
    .where(
      and(
        eq(authIdentities.provider, provider),
        eq(authIdentities.subject, subject),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Identity link");
  return { provider, subject, ...row };
}

/** Links a submission's participant to an external identity subject. */
export async function linkParticipantIdentity(
  db: Database,
  ctx: Ctx,
  submissionId: string,
  body: Record<string, unknown>,
) {
  await loadSubmission(db, ctx.tenantScope, submissionId);
  const { provider, subject } = identityInput(body);
  const [link] = await db
    .insert(participantIdentityLinks)
    .values({
      organizationId: ctx.organizationId,
      submissionId,
      provider,
      subject,
      createdByApiClientId: ctx.clientId,
    })
    .onConflictDoUpdate({
      target: [
        participantIdentityLinks.submissionId,
        participantIdentityLinks.provider,
      ],
      set: { subject },
    })
    .returning();
  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: ctx.organizationId,
      actorType: "system",
      action: "identity.participant_linked",
      resourceType: "submission",
      resourceId: submissionId,
      source: "api",
      // The external subject is deliberately not written to the event log.
      metadata: { provider, apiClientId: ctx.clientId },
    }),
  );
  return {
    submissionId,
    provider: link.provider,
    subject: link.subject,
    createdAt: link.createdAt,
  };
}

export async function listParticipantIdentityLinks(
  db: Database,
  ctx: Ctx,
  provider: string,
  subject: string,
) {
  const rows = await db
    .select({
      submissionId: participantIdentityLinks.submissionId,
      createdAt: participantIdentityLinks.createdAt,
      caseId: cases.id,
    })
    .from(participantIdentityLinks)
    .leftJoin(
      cases,
      and(
        eq(cases.sourceSubmissionId, participantIdentityLinks.submissionId),
        eq(cases.organizationId, participantIdentityLinks.organizationId),
      ),
    )
    .where(
      and(
        eq(participantIdentityLinks.organizationId, ctx.organizationId),
        eq(participantIdentityLinks.provider, provider),
        eq(participantIdentityLinks.subject, subject),
      ),
    )
    .orderBy(asc(participantIdentityLinks.createdAt));
  return rows;
}
