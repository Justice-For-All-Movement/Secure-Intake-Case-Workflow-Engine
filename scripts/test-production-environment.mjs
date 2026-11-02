import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { inspectProductionEnvironment } from "./verify-production-environment.mjs";
import { verifyDeploymentImage } from "./verify-deployment-image.mjs";
import { inspectMigrationTarget } from "./preflight-migrations.mjs";
const valid = {
  DATABASE_URL: "postgresql://user:secret@neon.example.net/neondb?sslmode=require",
  APP_BASE_URL: "https://secure-intake-preview.onrender.com",
  DOCUMENT_STORAGE_DRIVER: "s3",
  DOCUMENT_S3_ENDPOINT: "https://storage.example.net",
  DOCUMENT_S3_REGION: "us-east-2",
  DOCUMENT_S3_BUCKET: "private-documents",
  DOCUMENT_S3_ACCESS_KEY_ID: "access-key",
  DOCUMENT_S3_SECRET_ACCESS_KEY: "secret-key",
  MALWARE_SCANNER_URL: "https://scanner.example.net/v1/scan",
  MALWARE_SCANNER_PROVIDER: "scanner",
  PROTECTED_DATA_ENCRYPTION_KEY: "a".repeat(32) + "b".repeat(32),
  WEBHOOK_ENCRYPTION_KEY: "b".repeat(32) + "a".repeat(32)
};
const result = inspectProductionEnvironment(valid);
assert.equal(result.ok, true, JSON.stringify(result));
assert.deepEqual(result.failed, []);
assert.deepEqual(result.warnings, []);
const missing = inspectProductionEnvironment({});
assert.equal(missing.ok, false);
assert(missing.failed.includes("database_tls_connection"));
assert(missing.failed.includes("https_malware_scanner"));
const bad = inspectProductionEnvironment({
  ...valid,
  DATABASE_URL: "postgres://root:secret@localhost/test",
  APP_BASE_URL: "http://secure-intake-preview.onrender.com",
  DOCUMENT_S3_ENDPOINT: "http://127.0.0.1:9000",
  MALWARE_SCANNER_URL: "http://scanner.example.net",
  PROTECTED_DATA_ENCRYPTION_KEY: "1".repeat(64)
});
assert.equal(bad.ok, false);
for (const check of ["database_tls_connection", "canonical_https_app_origin", "secure_s3_endpoint",
  "https_malware_scanner", "protected_data_encryption_key_format"]) assert(bad.failed.includes(check));
for (const database of [
  "postgresql://user:secret@localhost/neondb?sslmode=require",
  "postgresql://user:secret@127.0.0.1/neondb?sslmode=require",
  "postgresql://user:secret@neon.example.net/neondb?sslmode=require&sslmode=disable",
  "postgresql://user:secret@neon.example.net/?sslmode=require"
]) {
  assert(inspectProductionEnvironment({ ...valid, DATABASE_URL: database }).failed.includes("database_tls_connection"));
}
for (const endpoint of [
  "https://127.0.0.1/v1/scan",
  "https://[::1]/v1/scan",
  "https://scanner.local/v1/scan",
  "https://localhost./v1/scan"
]) {
  assert(inspectProductionEnvironment({ ...valid, MALWARE_SCANNER_URL: endpoint }).failed.includes("https_malware_scanner"));
}
const partial = inspectProductionEnvironment({
  ...valid, PROTECTED_DATA_ENCRYPTION_KEY: undefined, WEBHOOK_ENCRYPTION_KEY: undefined
});
assert.equal(partial.ok, true);
assert.equal(partial.warnings.length, 2);
const text = JSON.stringify(inspectProductionEnvironment({
  ...valid, DATABASE_URL: "postgresql://user:very-secret-credential@localhost/neondb", DOCUMENT_S3_SECRET_ACCESS_KEY: "very-secret-credential"
}));
assert(!text.includes("very-secret-credential"), "Never report secret values.");
console.info("Deployment preflight checks passed.");

const sourceSha = "a".repeat(40);
const digest = "sha256:" + "b".repeat(64);
const image = "ghcr.io/neophilism/secure-intake-case-workflow-engine";
const evidence = {
  schemaVersion: 1,
  engine: { version: "1.0.0-rc.9", sourceCommit: sourceSha, tag: "v1.0.0-rc.9" },
  container: { repository: image, digest, immutableRef: image + "@" + digest }
};
const blueprint = "services:\n  - type: web\n    image: " + image + "@" + digest + "\n";
assert.equal(verifyDeploymentImage(evidence, sourceSha, blueprint).ok, true);
assert(verifyDeploymentImage(evidence, "c".repeat(40), blueprint).failed.includes("source_commit"));
assert(verifyDeploymentImage(evidence, sourceSha, blueprint.replace(digest, "latest")).failed.includes("blueprint_image"));
assert(verifyDeploymentImage({ ...evidence, container: { ...evidence.container, digest: "sha256:" + "0".repeat(64) } },
  sourceSha, blueprint).failed.includes("release_evidence"));

const migrationTarget = {
  DATABASE_URL: "postgresql://user:secret@ep-secure.example.net/casework?sslmode=require",
  MIGRATION_EXPECTED_HOST: "ep-secure.example.net",
  MIGRATION_EXPECTED_DATABASE: "casework"
};
assert.equal(inspectMigrationTarget(migrationTarget).ok, true);
assert(inspectMigrationTarget({ ...migrationTarget, MIGRATION_EXPECTED_DATABASE: "other" })
  .failed.includes("expected_database"));
assert(inspectMigrationTarget({ ...migrationTarget, MIGRATION_EXPECTED_HOST: "other.example.net" })
  .failed.includes("expected_host"));
assert(inspectMigrationTarget({ ...migrationTarget, DATABASE_URL: migrationTarget.DATABASE_URL + "&sslmode=disable" })
  .failed.includes("database_tls_connection"));
assert(inspectMigrationTarget({ ...migrationTarget, MIGRATION_EXPECTED_HOST: "" })
  .failed.includes("expected_host"));
assert(inspectMigrationTarget({ ...migrationTarget, DATABASE_URL: "postgresql://user:secret@ep-secure.example.net/%ZZ?sslmode=require" })
  .failed.includes("expected_database"));

// Bind the exact supported release schema, not JavaScript string coercion.
for (const invalidEvidence of [null, [], {},
  { ...evidence, engine: { sourceCommit: sourceSha, tag: "vundefined" } },
  { ...evidence, engine: { ...evidence.engine, version: null, tag: "vnull" } },
  { ...evidence, engine: { ...evidence.engine, version: [], tag: "v" } },
  { ...evidence, engine: { ...evidence.engine, version: "1.0.0-rc.9\n", tag: "v1.0.0-rc.9\n" } },
  { ...evidence, engine: { ...evidence.engine, version: "2.0.0", tag: "v2.0.0" } },
  { ...evidence, container: { ...evidence.container, digest: [digest] } },
  { ...evidence, unsupportedAuthority: true },
]) assert.equal(verifyDeploymentImage(invalidEvidence, sourceSha, blueprint).ok, false);
for (const invalidSource of [undefined, null, [sourceSha], "0".repeat(40), "main", sourceSha + "\n"])
  assert.equal(verifyDeploymentImage(evidence, invalidSource, blueprint).ok, false);
for (const invalidBlueprint of [null, {}, Buffer.from(blueprint), "x".repeat(1024 * 1024 + 1)])
  assert.equal(verifyDeploymentImage(evidence, sourceSha, invalidBlueprint).ok, false);

const temporary = mkdtempSync(join(tmpdir(), "intake-image-preflight-"));
try {
  const evidenceFile = join(temporary, "evidence.json"), blueprintFile = join(temporary, "render.yaml");
  writeFileSync(evidenceFile, JSON.stringify(evidence));
  writeFileSync(blueprintFile, blueprint);
  const command = fileURLToPath(new URL("./verify-deployment-image.mjs", import.meta.url));
  const normalArgs = ["--evidence", evidenceFile, "--source", sourceSha, "--blueprint", blueprintFile];
  const cli = args => spawnSync(process.execPath, [command, ...args], {
    encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH ?? "" },
  });
  const passing = cli(normalArgs);
  assert.equal(passing.status, 0, passing.stderr);
  assert.deepEqual(JSON.parse(passing.stdout), { ok: true, failed: [] });
  const mismatch = cli(normalArgs.map(value => value === sourceSha ? "c".repeat(40) : value));
  assert.equal(mismatch.status, 1);
  assert(JSON.parse(mismatch.stdout).failed.includes("source_commit"));
  for (const args of [[], normalArgs.slice(0, -1),
    ["--evidence", evidenceFile, "--evidence", evidenceFile, "--blueprint", blueprintFile],
    ["--source", "--evidence", evidenceFile, sourceSha, "--blueprint", blueprintFile]]) {
    assert.equal(cli(args).status, 2);
  }
  const marker = "synthetic-private-input-must-not-be-logged";
  for (const input of [`{${marker}`, "x".repeat(65537)]) {
    writeFileSync(evidenceFile, input);
    const invalid = cli(normalArgs);
    assert.equal(invalid.status, 2);
    assert(!invalid.stdout.includes(marker) && !invalid.stderr.includes(marker));
    assert(!invalid.stderr.includes(temporary));
  }
  rmSync(evidenceFile);
  assert.equal(cli(normalArgs).status, 2);
} finally { rmSync(temporary, { recursive: true, force: true }); }
console.info("Release evidence shape, source and fail-closed CLI regression checks passed.");
