/**
 * Point-in-time restore drill for the engine's Neon database (opt-in).
 *
 * 1. Creates a temporary Neon branch of the source branch AS OF a past
 *    timestamp (Neon point-in-time restore), with its own compute endpoint.
 * 2. Connects to that branch and checks that the restored database is a
 *    usable engine database: every migration in drizzle/meta/_journal.json is
 *    applied and the core tables answer.
 * 3. Always deletes the temporary branch.
 *
 * The production branch is never written. Prints check names and counts only:
 * no connection string, password, host or row content.
 *
 * Environment: NEON_API_KEY, NEON_PROJECT_ID (required); NEON_SOURCE_BRANCH_ID
 * (default: the project's default branch), NEON_DATABASE_NAME (default
 * neondb), NEON_ROLE_NAME (default neondb_owner), RESTORE_POINT (ISO time,
 * default one hour ago; must lie inside the project's history window).
 */
import { readFile } from "node:fs/promises";

const API = "https://console.neon.tech/api/v2";

export function restoreDrillConfig(env, now = new Date()) {
  const apiKey = env.NEON_API_KEY?.trim();
  const projectId = env.NEON_PROJECT_ID?.trim();
  if (!apiKey || !projectId) return null;
  if (!/^[a-z0-9-]{1,64}$/.test(projectId)) throw new Error("NEON_PROJECT_ID is malformed.");
  const sourceBranchId = env.NEON_SOURCE_BRANCH_ID?.trim() || null;
  if (sourceBranchId && !/^br-[a-z0-9-]{1,64}$/.test(sourceBranchId)) {
    throw new Error("NEON_SOURCE_BRANCH_ID is malformed.");
  }
  const databaseName = env.NEON_DATABASE_NAME?.trim() || "neondb";
  const roleName = env.NEON_ROLE_NAME?.trim() || "neondb_owner";
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(databaseName)) throw new Error("NEON_DATABASE_NAME is malformed.");
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(roleName)) throw new Error("NEON_ROLE_NAME is malformed.");
  const restorePoint = env.RESTORE_POINT?.trim()
    ? new Date(env.RESTORE_POINT.trim())
    : new Date(now.getTime() - 3_600_000);
  if (Number.isNaN(restorePoint.getTime()) || restorePoint >= now) {
    throw new Error("RESTORE_POINT must be a past ISO timestamp.");
  }
  return { apiKey, projectId, sourceBranchId, databaseName, roleName, restorePoint };
}

async function neon(fetcher, config, method, path, body) {
  const response = await fetcher(API + path, {
    method,
    redirect: "error",
    headers: {
      authorization: "Bearer " + config.apiKey,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Neon API " + method + " " + path.split("?")[0].replace(/[a-z]+-[a-z0-9-]+/g, "<id>") + " returned HTTP " + response.status + ".");
  }
  return response.json();
}

async function waitForOperations(fetcher, config, operations, sleep) {
  for (const operation of operations ?? []) {
    for (let attempt = 0; ; attempt += 1) {
      const { operation: current } = await neon(fetcher, config, "GET",
        `/projects/${config.projectId}/operations/${operation.id}`);
      if (current.status === "finished" || current.status === "skipped") break;
      if (["failed", "error", "cancelled"].includes(current.status)) {
        throw new Error("Neon operation " + current.action + " ended " + current.status + ".");
      }
      if (attempt >= 60) throw new Error("Neon operation did not finish in time.");
      await sleep(2000);
    }
  }
}

export async function runRestoreDrill(config, deps) {
  const { fetcher, connect, expectedMigrations, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {} } = deps;
  let sourceBranchId = config.sourceBranchId;
  if (!sourceBranchId) {
    const { branches } = await neon(fetcher, config, "GET", `/projects/${config.projectId}/branches`);
    const primary = branches.find(branch => branch.default || branch.primary);
    if (!primary) throw new Error("The project has no default branch.");
    sourceBranchId = primary.id;
  }
  const name = "restore-drill-" + new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const created = await neon(fetcher, config, "POST", `/projects/${config.projectId}/branches`, {
    branch: { parent_id: sourceBranchId, parent_timestamp: config.restorePoint.toISOString(), name },
    endpoints: [{ type: "read_write" }],
  });
  const branchId = created.branch.id;
  log({ check: "branch_created_at_restore_point", outcome: "passed" });
  const result = { restorePoint: config.restorePoint.toISOString(), checks: [] };
  try {
    await waitForOperations(fetcher, config, created.operations, sleep);
    const { uri } = await neon(fetcher, config, "GET",
      `/projects/${config.projectId}/connection_uri?branch_id=${encodeURIComponent(branchId)}` +
      `&database_name=${encodeURIComponent(config.databaseName)}&role_name=${encodeURIComponent(config.roleName)}`);
    const db = await connect(uri);
    try {
      const [{ applied }] = await db.query(
        "select count(*)::int as applied from drizzle.__drizzle_migrations");
      const migrationsOk = applied === expectedMigrations;
      result.checks.push({ check: "migrations_present", outcome: migrationsOk ? "passed" : "failed", applied, expected: expectedMigrations });
      for (const table of ["organizations", "intake_submissions", "cases", "audit_events"]) {
        const [{ rows }] = await db.query(`select count(*)::int as rows from ${table}`);
        result.checks.push({ check: `table_${table}_readable`, outcome: "passed", rows });
      }
    } finally {
      await db.close();
    }
  } finally {
    await neon(fetcher, config, "DELETE", `/projects/${config.projectId}/branches/${branchId}`);
    result.checks.push({ check: "temporary_branch_deleted", outcome: "passed" });
  }
  result.ok = result.checks.every(check => check.outcome === "passed");
  return result;
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  try {
    const config = restoreDrillConfig(process.env);
    if (!config) {
      console.log(JSON.stringify({ status: "skipped", reason: "NEON_API_KEY and NEON_PROJECT_ID not set" }));
    } else {
      const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
      const { default: postgres } = await import("postgres");
      const result = await runRestoreDrill(config, {
        fetcher: fetch,
        expectedMigrations: journal.entries.length,
        log: entry => console.log(JSON.stringify(entry)),
        connect: async uri => {
          const sql = postgres(uri, { max: 1, ssl: "require", onnotice: () => {} });
          return { query: text => sql.unsafe(text), close: () => sql.end() };
        },
      });
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error("Restore drill failed: " + (error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, "<uri>") : "unknown error"));
    process.exitCode = 1;
  }
}
