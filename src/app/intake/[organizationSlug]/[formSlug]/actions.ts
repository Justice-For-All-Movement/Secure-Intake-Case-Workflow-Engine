"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import {
  assertLoginAllowed,
  LoginRateLimitError,
  loginBucketHash,
  recordLoginFailure,
  trustedLoginSource,
} from "@/modules/auth/throttle";
import { getRuntimeDatabase } from "@/db/runtime";
import { createTrustedTenantScope } from "@/lib/tenancy";
import { answersFromFormData } from "@/modules/forms/form-data";
import { findPublishedFormBySlugs } from "@/modules/forms/repository";
import {
  createPublicDraftSubmission,
  FormNotAvailableError,
  loadDraftSubmissionByToken,
  SubmissionValidationError,
  submitDraftSubmissionByToken,
  submitPublicForm,
  updateDraftSubmissionByToken,
} from "@/modules/forms/service";
import { resolveFormLocale } from "@/modules/forms/localization";
import type { PublicFormActionState } from "@/modules/forms/public-action-state";
import {
  cleanupStagedPublicUploads,
  PublicUploadValidationError,
  stagePublicSubmissionUploads,
  type StagedPublicUploadSet,
} from "@/modules/documents/public-upload";

export async function submitPublicFormAction(
  organizationSlug: string,
  formSlug: string,
  _previousState: PublicFormActionState,
  formData: FormData,
): Promise<PublicFormActionState> {
  const db = getRuntimeDatabase();
  const published = await findPublishedFormBySlugs(
    db,
    organizationSlug,
    formSlug,
    { publicOnly: true },
  );

  if (!published) {
    redirect("/intake/unavailable");
  }

  const answers = answersFromFormData(published.definition, formData);
  const locale = resolveFormLocale(published.definition, [
    stringField(formData, "__locale"),
  ]);
  const draftCode = stringField(formData, "__draft");
  const intent = stringField(formData, "__intent");

  if (intent === "resume") {
    const loaded = await loadDraftSubmissionByToken(
      db,
      stringField(formData, "__resume_code"),
      { organizationSlug, formSlug },
    );
    // One uniform answer for unknown, used, foreign or malformed codes.
    return loaded
      ? {
          status: "draft_loaded",
          errors: [],
          draftAnswers: loaded.answers,
          resumeCode: stringField(formData, "__resume_code"),
        }
      : { status: "draft_not_found", errors: [] };
  }

  if (intent === "save_draft") {
    if (published.definition.resumableDrafts === false) {
      return { status: "idle", errors: [] };
    }
    try {
      if (draftCode) {
        try {
          await updateDraftSubmissionByToken(db, draftCode, answers, {
            locale,
          });
          return { status: "draft_saved", errors: [], resumeCode: draftCode };
        } catch (error) {
          if (!(error instanceof FormNotAvailableError)) throw error;
          // Fall through: the earlier draft is gone, start a new one.
        }
      }
      // New drafts are counted per trusted client source (only when the
      // deployment trusts its proxy's forwarding headers). Updates of an
      // existing draft are not counted.
      const source = trustedLoginSource(await headers());
      const draftKey = source ? loginBucketHash("draft", source) : null;
      if (draftKey) {
        try {
          await assertLoginAllowed(db, [draftKey]);
        } catch (error) {
          if (error instanceof LoginRateLimitError) {
            return { status: "draft_rate_limited", errors: [] };
          }
          throw error;
        }
      }
      const draft = await createPublicDraftSubmission(
        db,
        organizationSlug,
        formSlug,
        answers,
        { locale },
      );
      if (draftKey) {
        await recordLoginFailure(db, [draftKey], new Date(), {
          limit: env.PUBLIC_DRAFT_CREATE_LIMIT_PER_HOUR,
          windowMinutes: 60,
          blockMinutes: 60,
        });
      }
      return {
        status: "draft_saved",
        errors: [],
        resumeCode: draft.resumeToken,
      };
    } catch (error) {
      if (error instanceof SubmissionValidationError) {
        return { status: "validation_error", errors: error.errors };
      }
      if (error instanceof FormNotAvailableError) {
        redirect("/intake/unavailable");
      }
      throw error;
    }
  }

  let stagedUploads: StagedPublicUploadSet | null = null;

  try {
    stagedUploads = await stagePublicSubmissionUploads(
      db,
      createTrustedTenantScope(published.form.organizationId),
      published.definition,
      answers,
      formData,
    );

    const submissionAnswers = {
      ...answers,
      ...stagedUploads.answerReferences,
    };

    let submission: Awaited<ReturnType<typeof submitPublicForm>>;
    try {
      let fromDraft: Awaited<
        ReturnType<typeof submitDraftSubmissionByToken>
      > | null = null;
      if (draftCode) {
        try {
          fromDraft = await submitDraftSubmissionByToken(
            db,
            draftCode,
            submissionAnswers,
            stagedUploads.uploads,
          );
        } catch (error) {
          if (!(error instanceof FormNotAvailableError)) throw error;
        }
      }
      submission =
        fromDraft ??
        (await submitPublicForm(
          db,
          organizationSlug,
          formSlug,
          submissionAnswers,
          null,
          stagedUploads.uploads,
          { locale },
        ));
    } catch (error) {
      await cleanupStagedPublicUploads(stagedUploads);
      stagedUploads = null;
      throw error;
    }

    stagedUploads = null;

    if (submission.participantPortalSecret) {
      const trackingCode = submission.confirmationCode ?? "";
      return {
        status: "submitted",
        errors: [],
        confirmationCode: trackingCode,
        participantPortal: {
          trackingCode,
          accessSecret: submission.participantPortalSecret,
          loginPath: `/participant/${encodeURIComponent(
            organizationSlug,
          )}`,
        },
      };
    }

    redirect(
      `/intake/confirmation/${encodeURIComponent(
        submission.confirmationCode ?? "",
      )}`,
    );
  } catch (error) {
    if (error instanceof PublicUploadValidationError) {
      return {
        status: "validation_error",
        errors: error.errors,
      };
    }

    if (error instanceof SubmissionValidationError) {
      return {
        status: "validation_error",
        errors: error.errors,
      };
    }

    if (error instanceof FormNotAvailableError) {
      redirect("/intake/unavailable");
    }

    throw error;
  }

  return { status: "idle", errors: [] };
}

function stringField(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}
