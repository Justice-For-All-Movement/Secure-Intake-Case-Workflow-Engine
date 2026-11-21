import { and, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "@/db/client";
import { auditEvents, submissionSealedEnvelopes } from "@/db/schema";
import type { TenantScope } from "@/lib/tenancy";
import { auditEventValues } from "@/modules/audit/event";
import {
  sealedFieldsInDefinition,
  type FormDefinition,
} from "@/modules/forms/definition";
import type { ValidationError } from "@/modules/forms/validation";
import { validationMessage } from "@/modules/forms/form-ui-strings";
import {
  type AnswerMap,
  visibleFieldIdsForDefinition,
} from "@/modules/forms/visibility";
import {
  checkSealedEnvelope,
  parseSealedEnvelopeText,
  SealedEnvelopeError,
  type CheckedSealedEnvelope,
} from "./envelope";
import { sealingConfig, type SealingConfig } from "./recipients";

type DbExecutor = Database | DatabaseTransaction;

function sealedError(
  fieldId: string,
  code: "sealed" | "sealed_unavailable" | "sealed_invalid" | "required",
): ValidationError {
  return {
    fieldId,
    code,
    message: validationMessage({ code, message: "" }),
  };
}

export type SealedSubmissionCheck =
  | { ok: true; sealed: CheckedSealedEnvelope | null }
  | { ok: false; errors: ValidationError[] };

/**
 * Decides what a submission may carry for its sealed fields, before anything
 * is stored. `rawAnswers` are the answers as received: a sealed field must not
 * appear there in clear (refused, never stored). `ordinaryAnswers` decide which
 * sealed fields are visible; a visible required sealed field needs an
 * envelope (its content is checked in the browser — the server cannot read
 * it). The envelope is validated strictly against the configured recipients.
 */
export function checkSealedSubmission(
  definition: FormDefinition,
  input: {
    rawAnswers: AnswerMap;
    ordinaryAnswers: AnswerMap;
    envelope: string | Record<string, unknown> | null | undefined;
    /** Drafts never carry sealed answers. */
    draft?: boolean;
  },
  config: SealingConfig = sealingConfig(),
): SealedSubmissionCheck {
  const sealedFields = sealedFieldsInDefinition(definition);
  const sealedIds = new Set(sealedFields.map((field) => field.id));
  const plaintext = Object.keys(input.rawAnswers).filter((id) => sealedIds.has(id));
  if (plaintext.length > 0) {
    return { ok: false, errors: plaintext.map((id) => sealedError(id, "sealed")) };
  }
  const supplied =
    input.envelope !== null &&
    input.envelope !== undefined &&
    input.envelope !== "";
  if (input.draft) {
    // A draft is stored readable to anyone holding its resume code: sealed
    // answers never go into one.
    return supplied
      ? { ok: false, errors: [sealedError(sealedFields[0]?.id ?? "__sealed", "sealed_invalid")] }
      : { ok: true, sealed: null };
  }
  if (sealedFields.length === 0) {
    return supplied
      ? { ok: false, errors: [{ fieldId: "__sealed", code: "sealed_invalid", message: "This form has no sealed fields." }] }
      : { ok: true, sealed: null };
  }

  const visible = visibleFieldIdsForDefinition(definition, input.ordinaryAnswers);
  const requiredVisible = sealedFields.filter(
    (field) => field.required && visible.has(field.id),
  );

  if (!supplied) {
    return requiredVisible.length > 0
      ? {
          ok: false,
          errors: requiredVisible.map((field) =>
            sealedError(field.id, config.status === "ready" ? "required" : "sealed_unavailable"),
          ),
        }
      : { ok: true, sealed: null };
  }

  if (config.status !== "ready") {
    return { ok: false, errors: [sealedError(sealedFields[0].id, "sealed_unavailable")] };
  }
  try {
    const checked =
      typeof input.envelope === "string"
        ? parseSealedEnvelopeText(input.envelope, config.recipients)
        : checkSealedEnvelope(input.envelope, config.recipients);
    return { ok: true, sealed: checked };
  } catch (error) {
    if (error instanceof SealedEnvelopeError) {
      return { ok: false, errors: [sealedError(sealedFields[0].id, "sealed_invalid")] };
    }
    throw error;
  }
}

/** Stores the envelope in the submission's transaction. Logs no content. */
export async function storeSealedEnvelope(
  tx: DbExecutor,
  input: {
    organizationId: string;
    submissionId: string;
    sealed: CheckedSealedEnvelope;
    actorType: "user" | "anonymous" | "system";
    actorUserId?: string | null;
  },
) {
  const [row] = await tx
    .insert(submissionSealedEnvelopes)
    .values({
      organizationId: input.organizationId,
      submissionId: input.submissionId,
      envelopeJson: input.sealed.serialized,
      commitment: input.sealed.commitment,
      recipientKeyIds: input.sealed.recipientKeyIds,
      sizeBytes: input.sealed.sizeBytes,
    })
    .returning({
      id: submissionSealedEnvelopes.id,
      createdAt: submissionSealedEnvelopes.createdAt,
    });

  await tx.insert(auditEvents).values(
    auditEventValues({
      organizationId: input.organizationId,
      actorType: input.actorType,
      actorUserId: input.actorUserId ?? null,
      action: "submission.sealed_envelope_stored",
      resourceType: "submission",
      resourceId: input.submissionId,
      metadata: {
        // The commitment is salted inside the ciphertext: it reveals nothing.
        commitment: input.sealed.commitment,
        recipientCount: input.sealed.recipientKeyIds.length,
        sizeBytes: input.sealed.sizeBytes,
      },
    }),
  );
  return row;
}

export interface SealedEnvelopeSummary {
  commitment: string;
  recipientKeyIds: string[];
  sizeBytes: number;
  receivedAt: Date;
}

export async function findSealedEnvelopeSummary(
  db: DbExecutor,
  scope: TenantScope,
  submissionId: string,
): Promise<SealedEnvelopeSummary | null> {
  const [row] = await db
    .select({
      commitment: submissionSealedEnvelopes.commitment,
      recipientKeyIds: submissionSealedEnvelopes.recipientKeyIds,
      sizeBytes: submissionSealedEnvelopes.sizeBytes,
      receivedAt: submissionSealedEnvelopes.createdAt,
    })
    .from(submissionSealedEnvelopes)
    .where(
      and(
        eq(submissionSealedEnvelopes.organizationId, scope.organizationId),
        eq(submissionSealedEnvelopes.submissionId, submissionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findSealedEnvelope(
  db: DbExecutor,
  scope: TenantScope,
  submissionId: string,
) {
  const [row] = await db
    .select()
    .from(submissionSealedEnvelopes)
    .where(
      and(
        eq(submissionSealedEnvelopes.organizationId, scope.organizationId),
        eq(submissionSealedEnvelopes.submissionId, submissionId),
      ),
    )
    .limit(1);
  return row ?? null;
}
