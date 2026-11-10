import { checksumJson } from "@/modules/application/canonical";
import { and, desc, eq, max } from "drizzle-orm";
import type {
  Database,
  DatabaseTransaction,
} from "@/db/client";

type DbExecutor = Database | DatabaseTransaction;
import {
  auditEvents,
  intakeForms,
  intakeFormVersions,
  intakeSubmissions,
  organizations,
} from "@/db/schema";
import type { TenantScope } from "@/lib/tenancy";
import { auditEventValues } from "@/modules/audit/event";
import {
  parseFormDefinition,
  type FormDefinition,
} from "./definition";

export async function listForms(
  db: Database,
  scope: TenantScope,
) {
  return db
    .select()
    .from(intakeForms)
    .where(eq(intakeForms.organizationId, scope.organizationId))
    .orderBy(intakeForms.name);
}

export async function findFormById(
  db: Database,
  scope: TenantScope,
  formId: string,
) {
  const [form] = await db
    .select()
    .from(intakeForms)
    .where(
      and(
        eq(intakeForms.id, formId),
        eq(intakeForms.organizationId, scope.organizationId),
      ),
    )
    .limit(1);

  return form ?? null;
}

export async function createForm(
  db: Database,
  scope: TenantScope,
  input: {
    slug: string;
    name: string;
    description?: string | null;
    accessMode?: "public" | "authenticated";
    createdByUserId?: string | null;
  },
) {
  const [form] = await db
    .insert(intakeForms)
    .values({
      organizationId: scope.organizationId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      accessMode: input.accessMode ?? "public",
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning();


  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: input.createdByUserId ? "user" : "system",
      actorUserId: input.createdByUserId ?? null,
      action: "form.created",
      resourceType: "intake_form",
      resourceId: form.id,
      newState: {
        accessMode: form.accessMode,
        status: form.status,
      },
      metadata: { slug: form.slug },
    }),
  );

  return form;
}

export async function listFormVersions(
  db: Database,
  scope: TenantScope,
  formId: string,
) {
  return db
    .select()
    .from(intakeFormVersions)
    .where(
      and(
        eq(intakeFormVersions.organizationId, scope.organizationId),
        eq(intakeFormVersions.formId, formId),
      ),
    )
    .orderBy(desc(intakeFormVersions.versionNumber));
}

export async function findFormVersionById(
  db: Database,
  scope: TenantScope,
  versionId: string,
) {
  const [version] = await db
    .select()
    .from(intakeFormVersions)
    .where(
      and(
        eq(intakeFormVersions.id, versionId),
        eq(intakeFormVersions.organizationId, scope.organizationId),
      ),
    )
    .limit(1);

  return version ?? null;
}

export async function createDraftFormVersion(
  db: Database,
  scope: TenantScope,
  input: {
    formId: string;
    definition: FormDefinition;
    createdByUserId?: string | null;
  },
) {
  const form = await findFormById(db, scope, input.formId);
  if (!form) {
    throw new Error("Form was not found in the active organization.");
  }

  const definition = parseFormDefinition(input.definition);

  const [current] = await db
    .select({ value: max(intakeFormVersions.versionNumber) })
    .from(intakeFormVersions)
    .where(
      and(
        eq(intakeFormVersions.organizationId, scope.organizationId),
        eq(intakeFormVersions.formId, form.id),
      ),
    );

  const versionNumber = (current?.value ?? 0) + 1;

  const [version] = await db
    .insert(intakeFormVersions)
    .values({
      organizationId: scope.organizationId,
      formId: form.id,
      versionNumber,
      definition,
      status: "draft",
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning();


  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: input.createdByUserId ? "user" : "system",
      actorUserId: input.createdByUserId ?? null,
      action: "form.version_created",
      resourceType: "intake_form_version",
      resourceId: version.id,
      parentResourceType: "intake_form",
      parentResourceId: form.id,
      newState: {
        versionNumber: version.versionNumber,
        status: version.status,
      },
    }),
  );

  return version;
}

export async function publishFormVersion(
  db: Database,
  scope: TenantScope,
  versionId: string,
  actorUserId: string,
) {
  return db.transaction(async (tx) => {
    const [version] = await tx
      .select()
      .from(intakeFormVersions)
      .where(
        and(
          eq(intakeFormVersions.id, versionId),
          eq(intakeFormVersions.organizationId, scope.organizationId),
        ),
      )
      .limit(1);

    if (!version) {
      throw new Error("Form version was not found in the active organization.");
    }
    if (version.status !== "draft") {
      throw new Error("Only draft form versions may be published.");
    }

    const [form] = await tx
      .select()
      .from(intakeForms)
      .where(
        and(
          eq(intakeForms.id, version.formId),
          eq(intakeForms.organizationId, scope.organizationId),
        ),
      )
      .limit(1);

    if (!form || form.status !== "active") {
      throw new Error("The parent form is not active.");
    }

    await tx
      .update(intakeFormVersions)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(
        and(
          eq(intakeFormVersions.organizationId, scope.organizationId),
          eq(intakeFormVersions.formId, version.formId),
          eq(intakeFormVersions.status, "published"),
        ),
      );

    const [published] = await tx
      .update(intakeFormVersions)
      .set({
        status: "published",
        publishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(intakeFormVersions.id, version.id))
      .returning();

    await tx
      .update(intakeForms)
      .set({ updatedAt: new Date() })
      .where(eq(intakeForms.id, version.formId));

    await tx.insert(auditEvents).values(
      auditEventValues({
        organizationId: scope.organizationId,
        actorType: "user",
        actorUserId,
        action: "form.version_published",
        resourceType: "intake_form_version",
        resourceId: published.id,
        parentResourceType: "intake_form",
        parentResourceId: version.formId,
        previousState: { status: version.status },
        newState: {
          status: published.status,
          versionNumber: published.versionNumber,
        },
      }),
    );

    return published;
  });
}

export interface PublishedForm {
  form: typeof intakeForms.$inferSelect;
  version: typeof intakeFormVersions.$inferSelect;
  organization: {
    id: string;
    slug: string;
    name: string;
  };
  definition: FormDefinition;
}

export async function findPublishedFormBySlugs(
  db: Database,
  organizationSlug: string,
  formSlug: string,
  options: { publicOnly?: boolean } = {},
): Promise<PublishedForm | null> {
  const conditions = [
    eq(organizations.slug, organizationSlug),
    eq(organizations.status, "active"),
    eq(intakeForms.slug, formSlug),
    eq(intakeForms.status, "active"),
    eq(intakeFormVersions.status, "published"),
  ];

  if (options.publicOnly ?? true) {
    conditions.push(eq(intakeForms.accessMode, "public"));
  }

  const [row] = await db
    .select({
      form: intakeForms,
      version: intakeFormVersions,
      organization: {
        id: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
      },
    })
    .from(intakeForms)
    .innerJoin(
      organizations,
      eq(intakeForms.organizationId, organizations.id),
    )
    .innerJoin(
      intakeFormVersions,
      and(
        eq(intakeFormVersions.formId, intakeForms.id),
        eq(
          intakeFormVersions.organizationId,
          intakeForms.organizationId,
        ),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(intakeFormVersions.versionNumber))
    .limit(1);

  if (!row) return null;

  return {
    ...row,
    definition: parseFormDefinition(row.version.definition),
  };
}

export async function findSubmissionDraftByTokenHash(
  db: Database,
  draftTokenHash: string,
) {
  const [submission] = await db
    .select()
    .from(intakeSubmissions)
    .where(
      and(
        eq(intakeSubmissions.draftTokenHash, draftTokenHash),
        eq(intakeSubmissions.status, "draft"),
      ),
    )
    .limit(1);

  return submission ?? null;
}

export async function findVersionForSubmission(
  db: Database,
  submission: typeof intakeSubmissions.$inferSelect,
) {
  const [version] = await db
    .select()
    .from(intakeFormVersions)
    .where(
      and(
        eq(intakeFormVersions.id, submission.formVersionId),
        eq(
          intakeFormVersions.organizationId,
          submission.organizationId,
        ),
        eq(intakeFormVersions.formId, submission.formId),
      ),
    )
    .limit(1);

  if (!version) {
    throw new Error("Submission form version is unavailable.");
  }

  return {
    version,
    definition: parseFormDefinition(version.definition),
  };
}

export async function insertSubmission(
  db: DbExecutor,
  input: {
    organizationId: string;
    formId: string;
    formVersionId: string;
    submitterUserId?: string | null;
    status: "draft" | "submitted";
    answers: Record<string, unknown>;
    draftTokenHash?: string | null;
    confirmationCode?: string | null;
    locale?: string | null;
    channel?: "public_form" | "api";
  },
) {
  const submittedAt =
    input.status === "submitted" ? new Date() : null;

  const [submission] = await db
    .insert(intakeSubmissions)
    .values({
      organizationId: input.organizationId,
      formId: input.formId,
      formVersionId: input.formVersionId,
      submitterUserId: input.submitterUserId ?? null,
      status: input.status,
      answers: input.answers,
      draftTokenHash: input.draftTokenHash ?? null,
      confirmationCode: input.confirmationCode ?? null,
      locale: input.locale ?? null,
      channel: input.channel ?? "public_form",
      originalSha256:
        input.status === "submitted"
          ? checksumJson(input.answers)
          : null,
      submittedAt,
    })
    .returning();

  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: input.organizationId,
      actorType: input.submitterUserId ? "user" : "anonymous",
      actorUserId: input.submitterUserId ?? null,
      action:
        input.status === "submitted"
          ? "submission.received"
          : "submission.draft_created",
      resourceType: "submission",
      resourceId: submission.id,
      parentResourceType: "intake_form",
      parentResourceId: input.formId,
      newState: { status: submission.status },
      metadata: {
        formVersionId: input.formVersionId,
        answerFieldCount: Object.keys(input.answers).length,
      },
    }),
  );

  return submission;
}

export async function updateDraftSubmission(
  db: DbExecutor,
  submissionId: string,
  answers: Record<string, unknown>,
  locale?: string | null,
) {
  const [submission] = await db
    .update(intakeSubmissions)
    .set({
      answers,
      ...(locale ? { locale } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(intakeSubmissions.id, submissionId),
        eq(intakeSubmissions.status, "draft"),
      ),
    )
    .returning();


  if (submission) {
    await db.insert(auditEvents).values(
      auditEventValues({
        organizationId: submission.organizationId,
        actorType: submission.submitterUserId ? "user" : "anonymous",
        actorUserId: submission.submitterUserId ?? null,
        action: "submission.draft_updated",
        resourceType: "submission",
        resourceId: submission.id,
        newState: { status: submission.status },
        metadata: {
          answerFieldCount: Object.keys(answers).length,
        },
      }),
    );
  }

  return submission ?? null;
}

export async function finalizeDraftSubmission(
  db: DbExecutor,
  submissionId: string,
  answers: Record<string, unknown>,
  confirmationCode: string,
) {
  const [submission] = await db
    .update(intakeSubmissions)
    .set({
      answers,
      status: "submitted",
      confirmationCode,
      originalSha256: checksumJson(answers),
      draftTokenHash: null,
      submittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(intakeSubmissions.id, submissionId),
        eq(intakeSubmissions.status, "draft"),
      ),
    )
    .returning();


  if (submission) {
    await db.insert(auditEvents).values(
      auditEventValues({
        organizationId: submission.organizationId,
        actorType: submission.submitterUserId ? "user" : "anonymous",
        actorUserId: submission.submitterUserId ?? null,
        action: "submission.received",
        resourceType: "submission",
        resourceId: submission.id,
        parentResourceType: "intake_form",
        parentResourceId: submission.formId,
        previousState: { status: "draft" },
        newState: { status: submission.status },
        metadata: {
          formVersionId: submission.formVersionId,
          answerFieldCount: Object.keys(answers).length,
        },
      }),
    );
  }

  return submission ?? null;
}


export async function findSubmittedConfirmation(
  db: Database,
  confirmationCode: string,
) {
  const [submission] = await db
    .select({
      id: intakeSubmissions.id,
      confirmationCode: intakeSubmissions.confirmationCode,
      submittedAt: intakeSubmissions.submittedAt,
    })
    .from(intakeSubmissions)
    .where(
      and(
        eq(intakeSubmissions.confirmationCode, confirmationCode),
        eq(intakeSubmissions.status, "submitted"),
      ),
    )
    .limit(1);

  return submission ?? null;
}
