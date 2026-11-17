import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type {
  Database,
  DatabaseTransaction,
} from "@/db/client";
import {
  backgroundJobAttempts,
  backgroundJobs,
  backgroundSchedules,
  organizations,
  auditEvents,
} from "@/db/schema";
import type { TenantScope } from "@/lib/tenancy";
import { createTrustedTenantScope } from "@/lib/tenancy";
import { auditEventValues } from "@/modules/audit/event";
import { retryDelaySeconds, nextScheduleRunAt } from "./backoff";

const jobTypePattern = /^[a-z][a-z0-9_.:-]*$/;
const maxPayloadBytes = 64 * 1024;

export type BackgroundJob = typeof backgroundJobs.$inferSelect;

export interface EnqueueBackgroundJobInput {
  jobType: string;
  payload?: Record<string, unknown>;
  priority?: number;
  dedupeKey?: string | null;
  availableAt?: Date;
  maxAttempts?: number;
}

export interface ClaimedJob extends BackgroundJob {
  attemptNumber: number;
}

export async function enqueueBackgroundJob(
  db: Database,
  scope: TenantScope,
  input: EnqueueBackgroundJobInput,
) {
  return db.transaction((tx) =>
    enqueueBackgroundJobInTransaction(tx, scope, input),
  );
}

export async function enqueueBackgroundJobInTransaction(
  tx: DatabaseTransaction,
  scope: TenantScope,
  input: EnqueueBackgroundJobInput,
) {
  validateJobInput(input);
  const payload = input.payload ?? {};
  const dedupeKey = input.dedupeKey?.trim() || null;

  const [created] = await tx
    .insert(backgroundJobs)
    .values({
      organizationId: scope.organizationId,
      jobType: input.jobType,
      payload,
      priority: input.priority ?? 100,
      dedupeKey,
      availableAt: input.availableAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 5,
    })
    .onConflictDoNothing()
    .returning();

  if (created) return created;
  if (!dedupeKey) {
    throw new Error("Background job could not be enqueued.");
  }

  const [existing] = await tx
    .select()
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.organizationId, scope.organizationId),
        eq(backgroundJobs.jobType, input.jobType),
        eq(backgroundJobs.dedupeKey, dedupeKey),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new Error("Background job deduplication lookup failed.");
  }

  return existing;
}

export async function claimBackgroundJobs(
  db: Database,
  input: {
    workerId: string;
    acceptedTypes: readonly string[];
    limit: number;
    leaseSeconds: number;
    now?: Date;
    organizationId?: string;
  },
): Promise<ClaimedJob[]> {
  if (
    !input.workerId.trim() ||
    input.acceptedTypes.length === 0 ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    !Number.isInteger(input.leaseSeconds) ||
    input.leaseSeconds < 1
  ) {
    return [];
  }

  const now = input.now ?? new Date();
  const candidates = await db
    .select({ id: backgroundJobs.id })
    .from(backgroundJobs)
    .where(
      and(
        inArray(backgroundJobs.jobType, [...input.acceptedTypes]),
        ...(input.organizationId
          ? [
              eq(
                backgroundJobs.organizationId,
                input.organizationId,
              ),
            ]
          : []),
        lte(backgroundJobs.availableAt, now),
        or(
          eq(backgroundJobs.status, "pending"),
          and(
            eq(backgroundJobs.status, "running"),
            lte(backgroundJobs.leaseUntil, now),
          ),
        ),
      ),
    )
    .orderBy(
      asc(backgroundJobs.priority),
      asc(backgroundJobs.availableAt),
      asc(backgroundJobs.createdAt),
    )
    .limit(Math.max(input.limit * 3, input.limit));

  const claimed: ClaimedJob[] = [];

  for (const candidate of candidates) {
    if (claimed.length >= input.limit) break;

    const result = await db.transaction(async (tx) => {
      const leaseUntil = new Date(
        now.getTime() + input.leaseSeconds * 1000,
      );
      const [job] = await tx
        .update(backgroundJobs)
        .set({
          status: "running",
          attempts: sql`${backgroundJobs.attempts} + 1`,
          lockedBy: input.workerId,
          lockedAt: now,
          leaseUntil,
          updatedAt: now,
        })
        .where(
          and(
            eq(backgroundJobs.id, candidate.id),
            lte(backgroundJobs.availableAt, now),
            or(
              eq(backgroundJobs.status, "pending"),
              and(
                eq(backgroundJobs.status, "running"),
                lte(backgroundJobs.leaseUntil, now),
              ),
            ),
          ),
        )
        .returning();

      if (!job) return null;

      await tx
        .update(backgroundJobAttempts)
        .set({
          outcome: "lease_expired",
          errorMessage: "Worker lease expired before completion.",
          completedAt: now,
        })
        .where(
          and(
            eq(backgroundJobAttempts.jobId, job.id),
            isNull(backgroundJobAttempts.completedAt),
          ),
        );

      await tx.insert(backgroundJobAttempts).values({
        organizationId: job.organizationId,
        jobId: job.id,
        attemptNumber: job.attempts,
        workerId: input.workerId,
        startedAt: now,
      });

      return {
        ...job,
        attemptNumber: job.attempts,
      } satisfies ClaimedJob;
    });

    if (result) claimed.push(result);
  }

  return claimed;
}

export async function renewBackgroundJobLease(
  db: Database,
  jobId: string,
  workerId: string,
  leaseSeconds: number,
  now = new Date(),
) {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new Error("Background job lease duration is invalid.");
  }

  const [updated] = await db
    .update(backgroundJobs)
    .set({
      leaseUntil: new Date(
        now.getTime() + leaseSeconds * 1000,
      ),
      updatedAt: now,
    })
    .where(
      and(
        eq(backgroundJobs.id, jobId),
        eq(backgroundJobs.status, "running"),
        eq(backgroundJobs.lockedBy, workerId),
      ),
    )
    .returning({ id: backgroundJobs.id });

  return Boolean(updated);
}

export async function completeBackgroundJob(
  db: Database,
  job: ClaimedJob,
  workerId: string,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(backgroundJobs)
      .set({
        status: "succeeded",
        lockedBy: null,
        lockedAt: null,
        leaseUntil: null,
        lastError: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(backgroundJobs.id, job.id),
          eq(backgroundJobs.status, "running"),
          eq(backgroundJobs.lockedBy, workerId),
        ),
      )
      .returning();

    if (!updated) {
      throw new Error("Background job lease is no longer owned by this worker.");
    }

    await tx
      .update(backgroundJobAttempts)
      .set({
        outcome: "succeeded",
        completedAt: now,
      })
      .where(
        and(
          eq(backgroundJobAttempts.jobId, job.id),
          eq(
            backgroundJobAttempts.attemptNumber,
            job.attemptNumber,
          ),
          eq(backgroundJobAttempts.workerId, workerId),
          isNull(backgroundJobAttempts.completedAt),
        ),
      );

    return updated;
  });
}

export async function failBackgroundJob(
  db: Database,
  job: ClaimedJob,
  workerId: string,
  error: unknown,
  now = new Date(),
) {
  const message =
    error instanceof Error
      ? error.message.slice(0, 2000)
      : "Unknown background job failure.";
  const terminal = job.attemptNumber >= job.maxAttempts;
  const availableAt = terminal
    ? job.availableAt
    : new Date(
        now.getTime() +
          retryDelaySeconds(job.attemptNumber) * 1000,
      );

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(backgroundJobs)
      .set({
        status: terminal ? "dead" : "pending",
        availableAt,
        lockedBy: null,
        lockedAt: null,
        leaseUntil: null,
        lastError: message,
        completedAt: terminal ? now : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(backgroundJobs.id, job.id),
          eq(backgroundJobs.status, "running"),
          eq(backgroundJobs.lockedBy, workerId),
        ),
      )
      .returning();

    if (!updated) {
      throw new Error("Background job lease is no longer owned by this worker.");
    }

    await tx
      .update(backgroundJobAttempts)
      .set({
        outcome: terminal ? "dead" : "retry",
        errorMessage: message,
        completedAt: now,
      })
      .where(
        and(
          eq(backgroundJobAttempts.jobId, job.id),
          eq(
            backgroundJobAttempts.attemptNumber,
            job.attemptNumber,
          ),
          eq(backgroundJobAttempts.workerId, workerId),
          isNull(backgroundJobAttempts.completedAt),
        ),
      );

    return updated;
  });
}

export async function retryDeadBackgroundJob(
  db: Database,
  scope: TenantScope,
  jobId: string,
  actorUserId?: string | null,
  additionalAttempts = 5,
) {
  if (!Number.isInteger(additionalAttempts) || additionalAttempts < 1) {
    throw new Error("Additional attempts must be positive.");
  }

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.id, jobId),
          eq(
            backgroundJobs.organizationId,
            scope.organizationId,
          ),
          eq(backgroundJobs.status, "dead"),
        ),
      )
      .limit(1);

    if (!current) return null;

    const now = new Date();
    const [updated] = await tx
      .update(backgroundJobs)
      .set({
        status: "pending",
        maxAttempts:
          sql`${backgroundJobs.attempts} + ${additionalAttempts}`,
        availableAt: now,
        completedAt: null,
        lastError: null,
        lockedBy: null,
        lockedAt: null,
        leaseUntil: null,
        updatedAt: now,
      })
      .where(eq(backgroundJobs.id, current.id))
      .returning();

    await tx.insert(auditEvents).values(
      auditEventValues({
        organizationId: scope.organizationId,
        actorType: actorUserId ? "user" : "system",
        actorUserId: actorUserId ?? null,
        action: "job.retried",
        resourceType: "background_job",
        resourceId: current.id,
        previousState: {
          status: current.status,
          attempts: current.attempts,
          maxAttempts: current.maxAttempts,
        },
        newState: {
          status: updated.status,
          attempts: updated.attempts,
          maxAttempts: updated.maxAttempts,
        },
      }),
    );

    return updated;
  });
}

export async function setBackgroundScheduleStatus(
  db: Database,
  scope: TenantScope,
  scheduleId: string,
  status: "active" | "paused",
  actorUserId?: string | null,
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(backgroundSchedules)
      .where(
        and(
          eq(backgroundSchedules.id, scheduleId),
          eq(
            backgroundSchedules.organizationId,
            scope.organizationId,
          ),
        ),
      )
      .limit(1);

    if (!current) return null;

    const now = new Date();
    const [updated] = await tx
      .update(backgroundSchedules)
      .set({
        status,
        ...(status === "active"
          ? { nextRunAt: now }
          : {}),
        updatedAt: now,
      })
      .where(eq(backgroundSchedules.id, current.id))
      .returning();

    await tx.insert(auditEvents).values(
      auditEventValues({
        organizationId: scope.organizationId,
        actorType: actorUserId ? "user" : "system",
        actorUserId: actorUserId ?? null,
        action: "job.schedule_status_changed",
        resourceType: "background_schedule",
        resourceId: current.id,
        previousState: { status: current.status },
        newState: {
          status: updated.status,
          nextRunAt: updated.nextRunAt.toISOString(),
        },
      }),
    );

    return updated;
  });
}

export async function ensureBuiltinSchedules(
  db: Database,
  intervalSeconds: number,
  now = new Date(),
  organizationId?: string,
) {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
    throw new Error("Deadline sweep interval must be positive.");
  }

  const activeOrganizations = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.status, "active"),
        ...(organizationId
          ? [eq(organizations.id, organizationId)]
          : []),
      ),
    );

  for (const organization of activeOrganizations) {
    for (const schedule of [
      {
        key: "deadline-sweep",
        jobType: "deadline.sweep",
        priority: 20,
      },
      {
        key: "review-sweep",
        jobType: "review.sweep",
        priority: 20,
      },
      {
        // Expired drafts and stored idempotency responses: hourly is plenty.
        key: "retention-sweep",
        jobType: "retention.sweep",
        priority: 80,
        intervalSeconds: Math.max(intervalSeconds, 3600),
      },
    ] as const) {
      const scheduleInterval: number =
        ("intervalSeconds" in schedule ? schedule.intervalSeconds : undefined) ??
        intervalSeconds;
      await db
        .insert(backgroundSchedules)
        .values({
          organizationId: organization.id,
          key: schedule.key,
          jobType: schedule.jobType,
          payload: {},
          intervalSeconds: scheduleInterval,
          priority: schedule.priority,
          maxAttempts: 5,
          nextRunAt: now,
        })
        .onConflictDoUpdate({
          target: [
            backgroundSchedules.organizationId,
            backgroundSchedules.key,
          ],
          set: {
            intervalSeconds: scheduleInterval,
            updatedAt: now,
          },
        });
    }
  }
}

export async function enqueueDueSchedules(
  db: Database,
  now = new Date(),
  organizationId?: string,
) {
  const due = await db
    .select()
    .from(backgroundSchedules)
    .where(
      and(
        eq(backgroundSchedules.status, "active"),
        ...(organizationId
          ? [
              eq(
                backgroundSchedules.organizationId,
                organizationId,
              ),
            ]
          : []),
        lte(backgroundSchedules.nextRunAt, now),
      ),
    )
    .orderBy(asc(backgroundSchedules.nextRunAt))
    .limit(100);

  let enqueued = 0;

  for (const schedule of due) {
    const didEnqueue = await db.transaction(async (tx) => {
      const nextRunAt = nextScheduleRunAt(
        schedule.nextRunAt,
        schedule.intervalSeconds,
        now,
      );

      const [claimed] = await tx
        .update(backgroundSchedules)
        .set({
          nextRunAt,
          lastEnqueuedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(backgroundSchedules.id, schedule.id),
            eq(backgroundSchedules.status, "active"),
            eq(backgroundSchedules.nextRunAt, schedule.nextRunAt),
          ),
        )
        .returning();

      if (!claimed) return false;

      await enqueueBackgroundJobInTransaction(
        tx,
        createTrustedTenantScope(schedule.organizationId),
        {
          jobType: schedule.jobType,
          payload: schedule.payload,
          priority: schedule.priority,
          maxAttempts: schedule.maxAttempts,
          dedupeKey:
            `schedule:${schedule.id}:${schedule.nextRunAt.toISOString()}`,
          availableAt: now,
        },
      );

      return true;
    });

    if (didEnqueue) enqueued += 1;
  }

  return enqueued;
}

function validateJobInput(input: EnqueueBackgroundJobInput) {
  if (!jobTypePattern.test(input.jobType)) {
    throw new Error("Background job type is invalid.");
  }
  if (
    input.maxAttempts !== undefined &&
    (!Number.isInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      input.maxAttempts > 100)
  ) {
    throw new Error("Background job max attempts are invalid.");
  }
  if (
    input.priority !== undefined &&
    (!Number.isInteger(input.priority) ||
      input.priority < 0 ||
      input.priority > 10000)
  ) {
    throw new Error("Background job priority is invalid.");
  }
  if (
    input.dedupeKey &&
    (input.dedupeKey.length > 500 || !input.dedupeKey.trim())
  ) {
    throw new Error("Background job dedupe key is invalid.");
  }

  const encoded = JSON.stringify(input.payload ?? {});
  if (Buffer.byteLength(encoded, "utf8") > maxPayloadBytes) {
    throw new Error("Background job payload exceeds 64 KiB.");
  }
}
