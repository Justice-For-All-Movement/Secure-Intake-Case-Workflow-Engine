import { and, eq, lt, notExists, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  apiIdempotencyKeys,
  auditEvents,
  cases,
  intakeSubmissions,
} from "@/db/schema";
import type { TenantScope } from "@/lib/tenancy";
import { auditEventValues } from "@/modules/audit/event";

export interface RetentionPolicy {
  /** Unsubmitted drafts untouched for this many days are deleted. */
  draftRetentionDays: number;
  /** Stored API idempotency keys older than this many hours are deleted. */
  idempotencyRetentionHours: number;
}

export class RetentionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionConfigurationError";
  }
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
) {
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RetentionConfigurationError(
      `${name} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

export function retentionPolicyFromEnvironment(
  source: Record<string, string | undefined> = process.env,
): RetentionPolicy {
  return {
    draftRetentionDays: boundedInteger(
      source.DRAFT_RETENTION_DAYS,
      30,
      1,
      3650,
      "DRAFT_RETENTION_DAYS",
    ),
    idempotencyRetentionHours: boundedInteger(
      source.API_IDEMPOTENCY_RETENTION_HOURS,
      168,
      24,
      8760,
      "API_IDEMPOTENCY_RETENTION_HOURS",
    ),
  };
}

export function retentionCutoffs(policy: RetentionPolicy, now: Date) {
  return {
    draftsBefore: new Date(now.getTime() - policy.draftRetentionDays * 86_400_000),
    idempotencyBefore: new Date(
      now.getTime() - policy.idempotencyRetentionHours * 3_600_000,
    ),
  };
}

/**
 * Deletes expired, never-submitted drafts and old stored API idempotency
 * responses for one tenant. Submitted accounts are never touched (the
 * database trigger refuses that anyway), and a draft that a case somehow
 * references is kept. Records one audit event with counts only.
 */
export async function sweepExpiredRecords(
  db: Database,
  scope: TenantScope,
  policy: RetentionPolicy,
  now = new Date(),
) {
  const { draftsBefore, idempotencyBefore } = retentionCutoffs(policy, now);

  return db.transaction(async (tx) => {
    const drafts = await tx
      .delete(intakeSubmissions)
      .where(
        and(
          eq(intakeSubmissions.organizationId, scope.organizationId),
          eq(intakeSubmissions.status, "draft"),
          lt(intakeSubmissions.updatedAt, draftsBefore),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(cases)
              .where(eq(cases.sourceSubmissionId, intakeSubmissions.id)),
          ),
        ),
      )
      .returning({ id: intakeSubmissions.id });

    const keys = await tx
      .delete(apiIdempotencyKeys)
      .where(
        and(
          eq(apiIdempotencyKeys.organizationId, scope.organizationId),
          lt(apiIdempotencyKeys.createdAt, idempotencyBefore),
        ),
      )
      .returning({ id: apiIdempotencyKeys.id });

    if (drafts.length > 0 || keys.length > 0) {
      await tx.insert(auditEvents).values(
        auditEventValues({
          organizationId: scope.organizationId,
          actorType: "system",
          action: "retention.swept",
          resourceType: "organization",
          resourceId: scope.organizationId,
          metadata: {
            draftsDeleted: drafts.length,
            idempotencyKeysDeleted: keys.length,
            draftRetentionDays: policy.draftRetentionDays,
            idempotencyRetentionHours: policy.idempotencyRetentionHours,
          },
        }),
      );
    }

    return {
      draftsDeleted: drafts.length,
      idempotencyKeysDeleted: keys.length,
    };
  });
}
