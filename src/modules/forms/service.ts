import type { Database } from "@/db/client";
import {
  createConfirmationCode,
  createDraftResumeToken,
  hashDraftResumeToken,
} from "./draft-token";
import type { AnswerMap } from "./visibility";
import { validateSubmissionAnswers } from "./validation";
import {
  findPublishedFormBySlugs,
  findSubmissionDraftByTokenHash,
  findVersionForSubmission,
  finalizeDraftSubmission,
  insertSubmission,
  updateDraftSubmission,
} from "./repository";
import { splitProtectedAnswers } from "@/modules/protected-data/answers";
import { encryptProtectedPayload } from "@/modules/protected-data/crypto";
import { synchronizeProtectedCompartments } from "@/modules/protected-data/repository";
import { issueExternalParticipantCredentialInTransaction } from "@/modules/participant-portal/service";
import { createTrustedTenantScope } from "@/lib/tenancy";
import {
  persistStagedPublicUploads,
  type StagedPublicUpload,
} from "@/modules/documents/public-upload";

export class FormNotAvailableError extends Error {
  constructor() {
    super("The requested form is not available.");
    this.name = "FormNotAvailableError";
  }
}

export class SubmissionValidationError extends Error {
  readonly errors: Array<{ fieldId: string; message: string }>;

  constructor(errors: Array<{ fieldId: string; message: string }>) {
    super("Submission validation failed.");
    this.name = "SubmissionValidationError";
    this.errors = errors;
  }
}

export interface DraftSubmissionResult {
  submissionId: string;
  resumeToken: string;
}

export async function createPublicDraftSubmission(
  db: Database,
  organizationSlug: string,
  formSlug: string,
  rawAnswers: AnswerMap,
  options: { locale?: string | null } = {},
): Promise<DraftSubmissionResult> {
  const published = await findPublishedFormBySlugs(
    db,
    organizationSlug,
    formSlug,
    { publicOnly: true },
  );

  if (!published) {
    throw new FormNotAvailableError();
  }

  const validation = validateSubmissionAnswers(
    published.definition,
    rawAnswers,
    { partial: true },
  );
  if (!validation.success) {
    throw new SubmissionValidationError(validation.errors);
  }

  const split = splitProtectedAnswers(
    published.definition,
    validation.answers,
  );
  const resumeToken = createDraftResumeToken();

  const submission = await db.transaction(async (tx) => {
    const created = await insertSubmission(tx, {
      organizationId: published.form.organizationId,
      formId: published.form.id,
      formVersionId: published.version.id,
      status: "draft",
      answers: split.ordinaryAnswers,
      locale: options.locale ?? null,
      draftTokenHash: hashDraftResumeToken(resumeToken),
    });

    await synchronizeProtectedCompartments(tx, {
      organizationId: created.organizationId,
      submissionId: created.id,
      compartments: split.compartments,
      encrypt: encryptProtectedPayload,
    });

    return created;
  });

  return {
    submissionId: submission.id,
    resumeToken,
  };
}

export async function updateDraftSubmissionByToken(
  db: Database,
  resumeToken: string,
  rawAnswers: AnswerMap,
  options: { locale?: string | null } = {},
) {
  const submission = await findSubmissionDraftByTokenHash(
    db,
    hashDraftResumeToken(resumeToken),
  );
  if (!submission) {
    throw new FormNotAvailableError();
  }

  const { definition } = await findVersionForSubmission(db, submission);
  const validation = validateSubmissionAnswers(
    definition,
    rawAnswers,
    { partial: true },
  );

  if (!validation.success) {
    throw new SubmissionValidationError(validation.errors);
  }

  const split = splitProtectedAnswers(definition, validation.answers);

  return db.transaction(async (tx) => {
    const updated = await updateDraftSubmission(
      tx,
      submission.id,
      split.ordinaryAnswers,
      options.locale ?? null,
    );
    if (!updated) {
      throw new FormNotAvailableError();
    }

    await synchronizeProtectedCompartments(tx, {
      organizationId: updated.organizationId,
      submissionId: updated.id,
      compartments: split.compartments,
      encrypt: encryptProtectedPayload,
    });

    return updated;
  });
}

export async function submitDraftSubmissionByToken(
  db: Database,
  resumeToken: string,
  rawAnswers: AnswerMap,
  stagedUploads: readonly StagedPublicUpload[] = [],
) {
  const submission = await findSubmissionDraftByTokenHash(
    db,
    hashDraftResumeToken(resumeToken),
  );
  if (!submission) {
    throw new FormNotAvailableError();
  }

  const { definition } = await findVersionForSubmission(db, submission);
  const validation = validateSubmissionAnswers(
    definition,
    rawAnswers,
  );

  if (!validation.success) {
    throw new SubmissionValidationError(validation.errors);
  }

  const split = splitProtectedAnswers(definition, validation.answers);

  return db.transaction(async (tx) => {
    const finalized = await finalizeDraftSubmission(
      tx,
      submission.id,
      split.ordinaryAnswers,
      createConfirmationCode(),
    );

    if (!finalized) {
      throw new FormNotAvailableError();
    }

    await synchronizeProtectedCompartments(tx, {
      organizationId: finalized.organizationId,
      submissionId: finalized.id,
      compartments: split.compartments,
      encrypt: encryptProtectedPayload,
    });

    if (stagedUploads.length > 0) {
      await persistStagedPublicUploads(
        tx,
        createTrustedTenantScope(finalized.organizationId),
        finalized.id,
        stagedUploads,
      );
    }

    const participantPortal = definition.participantPortal?.enabled
      ? await issueExternalParticipantCredentialInTransaction(tx, {
          organizationId: finalized.organizationId,
          submissionId: finalized.id,
          actorUserId: finalized.submitterUserId,
        })
      : null;

    return {
      ...finalized,
      participantPortalSecret: participantPortal?.secret ?? null,
    };
  });
}

export async function submitPublicForm(
  db: Database,
  organizationSlug: string,
  formSlug: string,
  rawAnswers: AnswerMap,
  submitterUserId?: string | null,
  stagedUploads: readonly StagedPublicUpload[] = [],
  options: {
    locale?: string | null;
    channel?: "public_form" | "api";
    publicOnly?: boolean;
  } = {},
) {
  const published = await findPublishedFormBySlugs(
    db,
    organizationSlug,
    formSlug,
    { publicOnly: options.publicOnly ?? true },
  );

  if (!published) {
    throw new FormNotAvailableError();
  }

  const validation = validateSubmissionAnswers(
    published.definition,
    rawAnswers,
  );

  if (!validation.success) {
    throw new SubmissionValidationError(validation.errors);
  }

  const split = splitProtectedAnswers(
    published.definition,
    validation.answers,
  );

  return db.transaction(async (tx) => {
    const submission = await insertSubmission(tx, {
      organizationId: published.form.organizationId,
      formId: published.form.id,
      formVersionId: published.version.id,
      submitterUserId: submitterUserId ?? null,
      status: "submitted",
      answers: split.ordinaryAnswers,
      confirmationCode: createConfirmationCode(),
      locale: options.locale ?? null,
      channel: options.channel ?? "public_form",
    });

    await synchronizeProtectedCompartments(tx, {
      organizationId: submission.organizationId,
      submissionId: submission.id,
      compartments: split.compartments,
      encrypt: encryptProtectedPayload,
    });

    if (stagedUploads.length > 0) {
      await persistStagedPublicUploads(
        tx,
        createTrustedTenantScope(submission.organizationId),
        submission.id,
        stagedUploads,
      );
    }

    const participantPortal = published.definition.participantPortal?.enabled
      ? await issueExternalParticipantCredentialInTransaction(tx, {
          organizationId: submission.organizationId,
          submissionId: submission.id,
          actorUserId: submission.submitterUserId,
        })
      : null;

    return {
      ...submission,
      participantPortalSecret: participantPortal?.secret ?? null,
    };
  });
}

/**
 * Loads a draft for its owner. Returns null — never a reason — when the code
 * is unknown, already submitted, malformed, or belongs to another form, so
 * the response does not reveal whether a draft exists. Protected answers are
 * not returned: they are write-only until an authorized reveal.
 */
export async function loadDraftSubmissionByToken(
  db: Database,
  resumeToken: string,
  expected: { organizationSlug: string; formSlug: string },
) {
  const token = resumeToken.trim();
  if (token.length < 20 || token.length > 200) return null;
  const submission = await findSubmissionDraftByTokenHash(
    db,
    hashDraftResumeToken(token),
  );
  if (!submission) return null;
  const published = await findPublishedFormBySlugs(
    db,
    expected.organizationSlug,
    expected.formSlug,
    { publicOnly: true },
  );
  if (
    !published ||
    published.form.id !== submission.formId ||
    published.form.organizationId !== submission.organizationId
  ) {
    return null;
  }
  return {
    answers: submission.answers,
    locale: submission.locale,
    updatedAt: submission.updatedAt,
  };
}
