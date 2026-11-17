import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/db/client";
import { env } from "../src/lib/env";
import {
  ensureBuiltinSchedules,
} from "../src/modules/jobs/service";
import {
  createConfiguredBackgroundJobHandlers,
  runBackgroundWorkerIteration,
} from "../src/modules/jobs/worker";

async function main() {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }

  const once = process.argv.includes("--once");
  const workerId =
    process.env.BACKGROUND_WORKER_ID?.trim() ||
    `worker-${randomUUID()}`;
  // Validates provider configuration before touching the database.
  const handlers = createConfiguredBackgroundJobHandlers();
  const { client, db } = createDatabase(env.DATABASE_URL);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    let lastScheduleEnsure = 0;

    while (!stopping) {
      const now = Date.now();
      if (now - lastScheduleEnsure >= 60_000) {
        await ensureBuiltinSchedules(
          db,
          env.BACKGROUND_DEADLINE_SWEEP_SECONDS,
          new Date(now),
        );
        lastScheduleEnsure = now;
      }

      const result = await runBackgroundWorkerIteration(
        db,
        handlers,
        {
          workerId,
          batchSize: env.BACKGROUND_JOB_BATCH_SIZE,
          leaseSeconds: env.BACKGROUND_JOB_LEASE_SECONDS,
        },
      );

      process.stdout.write(
        [
          `worker=${workerId}`,
          `scheduled=${result.scheduled}`,
          `claimed=${result.claimed}`,
          `succeeded=${result.succeeded}`,
          `failed=${result.failed}`,
        ].join(" ") + "\n",
      );

      if (once) break;
      if (result.claimed === 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, env.BACKGROUND_JOB_POLL_MS),
        );
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : "Unknown worker failure.";
  process.stderr.write(`Background worker failed: ${message}\n`);
  process.exitCode = 1;
});
