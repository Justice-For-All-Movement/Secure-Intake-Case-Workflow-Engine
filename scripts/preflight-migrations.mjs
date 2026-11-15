import { databaseUrl } from "./verify-production-environment.mjs";

export function inspectMigrationTarget(env) {
  const failed = [];
  const targetUrl = env.DATABASE_URL;
  if (!databaseUrl(targetUrl)) failed.push("database_tls_connection");
  const expectedHost = env.MIGRATION_EXPECTED_HOST;
  const expectedDatabase = env.MIGRATION_EXPECTED_DATABASE;
  if (typeof expectedHost !== "string" || !expectedHost.trim()) failed.push("expected_host");
  if (typeof expectedDatabase !== "string" || !expectedDatabase.trim()) failed.push("expected_database");
  if (databaseUrl(targetUrl)) {
    const target = new URL(targetUrl);
    if (target.hostname.toLowerCase() !== expectedHost?.toLowerCase()) failed.push("expected_host");
    try {
      if (decodeURIComponent(target.pathname.slice(1)) !== expectedDatabase) failed.push("expected_database");
    } catch {
      failed.push("expected_database");
    }
  }
  return { ok: failed.length === 0, failed: [...new Set(failed)] };
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const result = inspectMigrationTarget(process.env);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
