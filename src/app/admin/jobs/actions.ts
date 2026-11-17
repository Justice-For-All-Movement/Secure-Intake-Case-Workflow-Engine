"use server";

import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { getRuntimeDatabase } from "@/db/runtime";
import { env } from "@/lib/env";
import {
  hasPermission,
  requireTenantScope,
} from "@/modules/auth/authorization";
import { getCurrentAuthorizationContext } from "@/modules/auth/server-session";
import {
  ensureBuiltinSchedules,
  retryDeadBackgroundJob,
  setBackgroundScheduleStatus,
} from "@/modules/jobs/service";
import {
  createConfiguredBackgroundJobHandlers,
  runBackgroundWorkerIteration,
} from "@/modules/jobs/worker";

async function requireJobManager() {
  const context = await getCurrentAuthorizationContext();
  if (!context) redirect("/login");
  if (!context.tenantScope) redirect("/select-organization");
  if (!hasPermission(context, "job:manage")) {
    redirect("/forbidden");
  }
  return context;
}

export async function seedSchedulesAction() {
  const context = await requireJobManager();
  await ensureBuiltinSchedules(
    getRuntimeDatabase(),
    env.BACKGROUND_DEADLINE_SWEEP_SECONDS,
    new Date(),
    requireTenantScope(context).organizationId,
  );
  redirect("/admin/jobs?result=schedules_synced");
}

export async function runCoreJobsOnceAction() {
  const context = await requireJobManager();
  const result = await runBackgroundWorkerIteration(
    getRuntimeDatabase(),
    createConfiguredBackgroundJobHandlers(),
    {
      workerId: `admin-${context.user.id}-${randomUUID()}`,
      batchSize: env.BACKGROUND_JOB_BATCH_SIZE,
      leaseSeconds: env.BACKGROUND_JOB_LEASE_SECONDS,
      organizationId:
        requireTenantScope(context).organizationId,
    },
  );

  redirect(
    `/admin/jobs?result=claimed:${result.claimed},succeeded:${result.succeeded},failed:${result.failed}`,
  );
}

export async function retryJobAction(
  jobId: string,
  _formData: FormData,
) {
  const context = await requireJobManager();
  await retryDeadBackgroundJob(
    getRuntimeDatabase(),
    requireTenantScope(context),
    jobId,
    context.user.id,
  );
  redirect("/admin/jobs?result=job_retried");
}

export async function setScheduleStatusAction(
  scheduleId: string,
  status: "active" | "paused",
  _formData: FormData,
) {
  const context = await requireJobManager();
  await setBackgroundScheduleStatus(
    getRuntimeDatabase(),
    requireTenantScope(context),
    scheduleId,
    status,
    context.user.id,
  );
  redirect("/admin/jobs?result=schedule_updated");
}
