/**
 * Opt-in live verification of the external providers a deployment configured:
 * S3-compatible document storage, the malware scanner and the HTTP email API.
 *
 * Each provider is checked only when its configuration is present and is
 * otherwise reported as `skipped`, so the command (and the workflow that runs
 * it) succeeds without any secret. Pass `--require=s3,scanner,email` to turn a
 * skip into a failure. Output names checks and categorical results only: no
 * endpoint, bucket, token, address or upstream response text is printed.
 *
 *   S3       create-only PUT, GET with SHA-256 comparison, a second PUT of the
 *            same key must be refused, then DELETE of the test object.
 *   scanner  the EICAR anti-malware test string must be `infected`, harmless
 *            bytes must be `clean`.
 *   email    sends ONE message, and only when LIVE_EMAIL_TEST_RECIPIENT is set.
 *
 * Run: npx tsx scripts/verify-live-providers.ts [--require=s3,scanner,email]
 */
import { createHash, randomBytes } from "node:crypto";
import { S3CompatibleStorageAdapter } from "../src/modules/documents/storage-s3";
import { getMalwareScanner } from "../src/modules/documents/scanner";
import {
  emailConfigFromEnvironment,
  HttpEmailSender,
} from "../src/modules/email/http-email";

type Outcome = "passed" | "failed" | "skipped";
interface CheckResult {
  provider: "s3" | "scanner" | "email";
  check: string;
  outcome: Outcome;
  reason?: string;
}

const results: CheckResult[] = [];
const record = (result: CheckResult) => {
  results.push(result);
  console.log(JSON.stringify(result));
};
const category = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/https?:\/\/\S+/g, "<url>").slice(0, 160)
    : "unknown error";

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

async function verifyS3() {
  const env = process.env;
  const configured =
    env.DOCUMENT_S3_ENDPOINT &&
    env.DOCUMENT_S3_BUCKET &&
    env.DOCUMENT_S3_ACCESS_KEY_ID &&
    env.DOCUMENT_S3_SECRET_ACCESS_KEY;
  if (!configured) {
    record({ provider: "s3", check: "configuration", outcome: "skipped", reason: "DOCUMENT_S3_* not set" });
    return;
  }
  const storage = new S3CompatibleStorageAdapter({
    endpoint: env.DOCUMENT_S3_ENDPOINT!.trim(),
    region: env.DOCUMENT_S3_REGION?.trim() || "us-east-1",
    bucket: env.DOCUMENT_S3_BUCKET!.trim(),
    accessKeyId: env.DOCUMENT_S3_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.DOCUMENT_S3_SECRET_ACCESS_KEY!.trim(),
    sessionToken: env.DOCUMENT_S3_SESSION_TOKEN?.trim() || undefined,
  });
  const key = `live-verification/${randomBytes(12).toString("hex")}`;
  const payload = randomBytes(4096);
  let written = false;
  try {
    await storage.put(key, payload);
    written = true;
    record({ provider: "s3", check: "create_only_put", outcome: "passed" });
    const read = await storage.get(key);
    record({
      provider: "s3",
      check: "read_back_sha256",
      outcome: sha256(read) === sha256(payload) ? "passed" : "failed",
      ...(sha256(read) === sha256(payload) ? {} : { reason: "digest mismatch" }),
    });
    let overwritten = false;
    try {
      await storage.put(key, randomBytes(16));
      overwritten = true;
    } catch {
      // expected: If-None-Match: * refuses the second write
    }
    record({
      provider: "s3",
      check: "existing_version_not_overwritten",
      outcome: overwritten ? "failed" : "passed",
      ...(overwritten ? { reason: "provider accepted a second create-only PUT" } : {}),
    });
  } catch (error) {
    record({ provider: "s3", check: written ? "read_back_sha256" : "create_only_put", outcome: "failed", reason: category(error) });
  } finally {
    if (written) {
      try {
        await storage.remove(key);
        record({ provider: "s3", check: "delete_test_object", outcome: "passed" });
      } catch (error) {
        record({ provider: "s3", check: "delete_test_object", outcome: "failed", reason: category(error) });
      }
    }
  }
}

async function verifyScanner() {
  let scanner;
  try {
    scanner = getMalwareScanner();
  } catch (error) {
    record({ provider: "scanner", check: "configuration", outcome: "failed", reason: category(error) });
    return;
  }
  if (!scanner) {
    record({ provider: "scanner", check: "configuration", outcome: "skipped", reason: "no scanner configured" });
    return;
  }
  // The industry-standard harmless EICAR test file, assembled at run time.
  const eicar = Buffer.from(
    ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(""),
    "latin1",
  );
  const harmless = Buffer.from(`live verification ${randomBytes(8).toString("hex")}\n`);
  for (const [check, data, expected] of [
    ["eicar_detected", eicar, "infected"],
    ["harmless_file_clean", harmless, "clean"],
  ] as const) {
    try {
      const result = await scanner.scan({
        data,
        filename: `${check}.txt`,
        mimeType: "text/plain",
        sha256: sha256(data),
      });
      record({
        provider: "scanner",
        check,
        outcome: result.status === expected ? "passed" : "failed",
        ...(result.status === expected ? {} : { reason: `scanner answered ${result.status}` }),
      });
    } catch (error) {
      record({ provider: "scanner", check, outcome: "failed", reason: category(error) });
    }
  }
}

async function verifyEmail() {
  let config;
  try {
    config = emailConfigFromEnvironment(process.env);
  } catch (error) {
    record({ provider: "email", check: "configuration", outcome: "failed", reason: category(error) });
    return;
  }
  if (!config) {
    record({ provider: "email", check: "configuration", outcome: "skipped", reason: "EMAIL_TRANSPORT_DRIVER not http" });
    return;
  }
  const recipient = process.env.LIVE_EMAIL_TEST_RECIPIENT?.trim();
  if (!recipient) {
    record({ provider: "email", check: "send_one_message", outcome: "skipped", reason: "LIVE_EMAIL_TEST_RECIPIENT not set" });
    return;
  }
  try {
    const result = await new HttpEmailSender(config).send({
      idempotencyKey: `live-verification-${randomBytes(8).toString("hex")}`,
      to: [recipient],
      subject: "Secure intake engine: live email verification",
      text: "This message confirms that the deployment's email provider accepts messages from the engine. No action is needed.",
    });
    record({
      provider: "email",
      check: "send_one_message",
      outcome: "passed",
      reason: result.externalMessageId ? "provider returned a message id" : "provider accepted without an id",
    });
  } catch (error) {
    record({ provider: "email", check: "send_one_message", outcome: "failed", reason: category(error) });
  }
}

async function main() {
  const requireArg = process.argv.find((arg) => arg.startsWith("--require="));
  const required = new Set(
    (requireArg?.slice("--require=".length) ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const name of required) {
    if (!["s3", "scanner", "email"].includes(name)) {
      console.error(`Unknown provider in --require: ${name}`);
      process.exitCode = 2;
      return;
    }
  }

  await verifyS3();
  await verifyScanner();
  await verifyEmail();

  const failed = results.filter((result) => result.outcome === "failed");
  const missing = [...required].filter(
    (provider) => !results.some((result) => result.provider === provider && result.outcome === "passed"),
  );
  console.log(
    JSON.stringify({
      summary: failed.length === 0 && missing.length === 0 ? "passed" : "failed",
      passed: results.filter((result) => result.outcome === "passed").length,
      failed: failed.length,
      skipped: results.filter((result) => result.outcome === "skipped").length,
      requiredButNotVerified: missing,
    }),
  );
  if (failed.length > 0 || missing.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Live provider verification failed: ${category(error)}`);
  process.exitCode = 1;
});
