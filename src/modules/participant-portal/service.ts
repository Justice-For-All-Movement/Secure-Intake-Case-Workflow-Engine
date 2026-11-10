import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  externalParticipantCredentials,
  externalParticipantSessions,
} from "@/db/schema";
import type {
  Database,
  DatabaseTransaction,
} from "@/db/client";
import { auditEvents } from "@/db/schema";
import { env } from "@/lib/env";
import { createTrustedTenantScope } from "@/lib/tenancy";
import { auditEventValues } from "@/modules/audit/event";
import {
  assertLoginAllowed,
  clearLoginFailuresForKey,
  loginBucketHash,
  recordLoginFailure,
} from "@/modules/auth/throttle";
import { recordInboundCorrespondence } from "@/modules/communications/service";
import { parseFormDefinition } from "@/modules/forms/definition";
import { evaluateCondition } from "@/modules/forms/visibility";
import {
  findWorkflowState,
  parseWorkflowDefinition,
} from "@/modules/workflows/definition";
import {
  createExternalParticipantSession,
  externalParticipantCanReplyToThread,
  findExternalParticipantCredentialForLogin,
  findExternalParticipantSessionContext,
  findCaseParticipantMessagingPolicyContext,
  insertExternalParticipantCredential,
  listExternalParticipantPortalMessages,
  markExternalParticipantAuthenticated,
  revokeExternalParticipantSessionByTokenHash,
  touchExternalParticipantSession,
} from "./repository";
import {
  createExternalParticipantSecret,
  createExternalParticipantSessionToken,
  externalParticipantSecretMatches,
  hashExternalParticipantSecret,
  hashExternalParticipantSessionToken,
} from "./token";

const DUMMY_SECRET_HASH = "0".repeat(64);

export class ExternalParticipantAuthenticationError extends Error {
  constructor() {
    super("Invalid tracking code or access secret.");
    this.name = "ExternalParticipantAuthenticationError";
  }
}

export class ExternalParticipantPortalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalParticipantPortalError";
  }
}

export interface ExternalParticipantContext {
  sessionId: string;
  credentialId: string;
  scope: ReturnType<typeof createTrustedTenantScope>;
  organization: {
    id: string;
    slug: string;
    name: string;
  };
  submission: {
    id: string;
    confirmationCode: string;
    submittedAt: Date | null;
  };
  case: {
    id: string;
    caseNumber: string;
    status: string;
    statusLabel: string;
    updatedAt: Date;
  } | null;
  allowMessaging: boolean;
}

export async function issueExternalParticipantCredentialInTransaction(
  tx: DatabaseTransaction,
  input: {
    organizationId: string;
    submissionId: string;
    actorUserId?: string | null;
  },
) {
  const secret = createExternalParticipantSecret();
  const credential = await insertExternalParticipantCredential(tx, {
    organizationId: input.organizationId,
    submissionId: input.submissionId,
    secretHash: hashExternalParticipantSecret(secret),
  });

  await tx.insert(auditEvents).values(
    auditEventValues({
      organizationId: input.organizationId,
      actorType: input.actorUserId ? "user" : "anonymous",
      actorUserId: input.actorUserId ?? null,
      action: "participant_portal.credential_issued",
      resourceType: "external_participant_credential",
      resourceId: credential.id,
      parentResourceType: "submission",
      parentResourceId: input.submissionId,
      newState: {
        status: credential.status,
        credentialVersion: credential.credentialVersion,
      },
      source: "participant_portal",
    }),
  );

  return { credential, secret };
}

function participantThrottleKeys(
  organizationSlug: string,
  confirmationCode: string,
  source?: string | null,
) {
  const credential = loginBucketHash(
    "participant",
    `${organizationSlug}:${confirmationCode}`,
  );
  const sourceKey = source?.trim()
    ? loginBucketHash("source", `participant:${source.trim()}`)
    : null;
  return {
    credential,
    all: sourceKey ? [credential, sourceKey] : [credential],
  };
}

export async function authenticateExternalParticipant(
  db: Database,
  input: {
    organizationSlug: string;
    confirmationCode: string;
    secret: string;
    source?: string | null;
  },
) {
  const organizationSlug = input.organizationSlug.trim();
  const confirmationCode = input.confirmationCode.trim().toUpperCase();
  const secret = input.secret.trim();
  const throttle = participantThrottleKeys(
    organizationSlug,
    confirmationCode,
    input.source,
  );

  await assertLoginAllowed(db, throttle.all);

  const candidateIsSane =
    organizationSlug.length > 0 &&
    organizationSlug.length <= 200 &&
    confirmationCode.length > 0 &&
    confirmationCode.length <= 200 &&
    secret.length >= 32 &&
    secret.length <= 500;

  const row = candidateIsSane
    ? await findExternalParticipantCredentialForLogin(db, {
        organizationSlug,
        confirmationCode,
      })
    : null;

  const secretMatches = externalParticipantSecretMatches(
    secret,
    row?.credential.secretHash ?? DUMMY_SECRET_HASH,
  );

  if (!row || !secretMatches) {
    await recordLoginFailure(db, throttle.all);
    throw new ExternalParticipantAuthenticationError();
  }

  const token = createExternalParticipantSessionToken();
  const tokenHash = hashExternalParticipantSessionToken(token);
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() +
      env.PARTICIPANT_SESSION_TTL_HOURS * 60 * 60 * 1000,
  );

  const session = await db.transaction(async (tx) => {
    const created = await createExternalParticipantSession(tx, {
      organizationId: row.organization.id,
      credentialId: row.credential.id,
      tokenHash,
      expiresAt,
    });
    await markExternalParticipantAuthenticated(
      tx,
      row.credential.id,
      now,
    );
    await tx.insert(auditEvents).values(
      auditEventValues({
        organizationId: row.organization.id,
        actorType: "anonymous",
        action: "participant_portal.authenticated",
        resourceType: "external_participant_credential",
        resourceId: row.credential.id,
        parentResourceType: "submission",
        parentResourceId: row.submission.id,
        metadata: {
          sessionId: created.id,
          credentialVersion: row.credential.credentialVersion,
        },
        source: "participant_portal",
        occurredAt: now,
      }),
    );
    return created;
  });

  await clearLoginFailuresForKey(db, throttle.credential);

  return {
    token,
    expiresAt: session.expiresAt,
    organizationSlug: row.organization.slug,
  };
}

export async function resolveExternalParticipantContext(
  db: Database,
  input: {
    organizationSlug: string;
    sessionToken: string;
  },
): Promise<ExternalParticipantContext | null> {
  const token = input.sessionToken.trim();
  if (!token) return null;

  const row = await findExternalParticipantSessionContext(db, {
    organizationSlug: input.organizationSlug.trim(),
    tokenHash: hashExternalParticipantSessionToken(token),
  });
  if (!row) return null;

  const definition = parseFormDefinition(row.formVersion.definition);
  const portal = definition.participantPortal;
  if (!portal?.enabled) return null;

  await touchExternalParticipantSession(db, row.session.id);

  let caseView: ExternalParticipantContext["case"] = null;
  if (row.case) {
    const workflow = parseWorkflowDefinition(
      row.case.workflowDefinition,
    );
    const state = findWorkflowState(workflow, row.case.status);
    caseView = {
      id: row.case.id,
      caseNumber: row.case.caseNumber,
      status: row.case.status,
      statusLabel: state?.label ?? row.case.status,
      updatedAt: row.case.updatedAt,
    };
  }

  const allowMessaging =
    portal.allowMessaging &&
    (!portal.messagingCondition ||
      evaluateCondition(
        portal.messagingCondition,
        row.submission.answers,
      ));

  return {
    sessionId: row.session.id,
    credentialId: row.credential.id,
    scope: createTrustedTenantScope(row.organization.id),
    organization: row.organization,
    submission: {
      id: row.submission.id,
      confirmationCode: row.submission.confirmationCode ?? "",
      submittedAt: row.submission.submittedAt,
    },
    case: caseView,
    allowMessaging,
  };
}

export async function getCaseParticipantMessagingCapability(
  db: Database,
  scope: ReturnType<typeof createTrustedTenantScope>,
  caseId: string,
) {
  const row = await findCaseParticipantMessagingPolicyContext(
    db,
    scope,
    caseId,
  );
  if (!row) {
    return {
      portalEnabled: false,
      allowMessaging: false,
      reason: "no_participant_portal" as const,
    };
  }

  const definition = parseFormDefinition(row.formVersion.definition);
  const portal = definition.participantPortal;
  if (!portal?.enabled) {
    return {
      portalEnabled: false,
      allowMessaging: false,
      reason: "portal_disabled" as const,
    };
  }

  if (
    !row.credential?.id ||
    row.credential.status !== "active" ||
    row.credential.revokedAt
  ) {
    return {
      portalEnabled: true,
      allowMessaging: false,
      reason: "credential_unavailable" as const,
    };
  }

  const allowMessaging =
    portal.allowMessaging &&
    (!portal.messagingCondition ||
      evaluateCondition(
        portal.messagingCondition,
        row.submission.answers,
      ));

  return {
    portalEnabled: true,
    allowMessaging,
    reason: allowMessaging
      ? ("allowed" as const)
      : ("status_only" as const),
  };
}

export async function listExternalParticipantMessages(
  db: Database,
  context: ExternalParticipantContext,
) {
  if (!context.allowMessaging || !context.case) return [];

  const rows = await listExternalParticipantPortalMessages(
    db,
    context.scope,
    context.case.id,
  );

  return rows.map(({ message, thread }) => ({
    id: message.id,
    threadId: thread.id,
    threadSubject: thread.subject,
    direction: message.direction,
    subject: message.subject,
    body: message.body,
    sentAt: message.sentAt,
    receivedAt: message.receivedAt,
    createdAt: message.createdAt,
  }));
}

export async function sendExternalParticipantMessage(
  db: Database,
  context: ExternalParticipantContext,
  input: {
    threadId?: string | null;
    subject?: string | null;
    body: string;
  },
) {
  if (!context.allowMessaging) {
    throw new ExternalParticipantPortalError(
      "Messaging is not enabled for this submission.",
    );
  }
  if (!context.case) {
    throw new ExternalParticipantPortalError(
      "Messaging becomes available after a case has been created.",
    );
  }

  const body = input.body.trim();
  const subject = input.subject?.trim() || null;
  const threadId = input.threadId?.trim() || null;

  if (!body || body.length > 20_000) {
    throw new ExternalParticipantPortalError(
      "Message body must be between 1 and 20000 characters.",
    );
  }
  if (subject && subject.length > 500) {
    throw new ExternalParticipantPortalError(
      "Message subject cannot exceed 500 characters.",
    );
  }

  if (
    threadId &&
    !(await externalParticipantCanReplyToThread(
      db,
      context.scope,
      context.case.id,
      threadId,
    ))
  ) {
    throw new ExternalParticipantPortalError(
      "The requested portal thread is unavailable.",
    );
  }

  return recordInboundCorrespondence(
    db,
    context.scope,
    {
      caseId: context.case.id,
      threadId,
      channel: "portal",
      visibility: "participant",
      subject,
      body,
      senderAddress: "external-participant",
      recipients: [],
      provider: "participant-portal",
      actorUserId: null,
      actorType: "anonymous",
      auditSource: "participant_portal",
    },
  );
}

export async function logoutExternalParticipant(
  db: Database,
  input: {
    sessionToken: string;
  },
) {
  const token = input.sessionToken.trim();
  if (!token) return;
  await revokeExternalParticipantSessionByTokenHash(
    db,
    hashExternalParticipantSessionToken(token),
  );
}

/**
 * Participant-initiated recovery: an authenticated participant replaces the
 * access secret (for example after it may have been seen by someone else).
 * The previous secret stops working immediately and every other session for
 * the credential is revoked. The new secret is returned once, never stored.
 * Staff and API clients cannot call this: there is deliberately no staff
 * path that could take over a participant's access.
 */
export async function rotateExternalParticipantSecret(
  db: Database,
  context: ExternalParticipantContext,
) {
  const secret = createExternalParticipantSecret();
  const now = new Date();
  return db.transaction(async (tx) => {
    const [credential] = await tx
      .update(externalParticipantCredentials)
      .set({
        secretHash: hashExternalParticipantSecret(secret),
        credentialVersion: sql`${externalParticipantCredentials.credentialVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(externalParticipantCredentials.id, context.credentialId),
          eq(
            externalParticipantCredentials.organizationId,
            context.scope.organizationId,
          ),
          eq(externalParticipantCredentials.status, "active"),
        ),
      )
      .returning();
    if (!credential) {
      throw new ExternalParticipantPortalError(
        "The access secret could not be replaced.",
      );
    }
    await tx
      .update(externalParticipantSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(externalParticipantSessions.credentialId, credential.id),
          ne(externalParticipantSessions.id, context.sessionId),
          isNull(externalParticipantSessions.revokedAt),
        ),
      );
    await tx.insert(auditEvents).values(
      auditEventValues({
        organizationId: context.scope.organizationId,
        actorType: "anonymous",
        action: "participant_portal.secret_rotated",
        resourceType: "external_participant_credential",
        resourceId: credential.id,
        parentResourceType: "submission",
        parentResourceId: context.submission.id,
        newState: { credentialVersion: credential.credentialVersion },
        source: "participant_portal",
        occurredAt: now,
      }),
    );
    return { secret, credentialVersion: credential.credentialVersion };
  });
}
