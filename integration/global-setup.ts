import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const root = path.resolve(import.meta.dirname, "..");

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
    child.on("error", reject);
  });
}

/** Marker bytes of the harmless test file the local signature flags. */
export const INFECTED_MARKER = "SICWE-TEST-MALWARE-MARKER-7f3a9c";

export default async function setup() {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      "TEST_DATABASE_URL is required for the integration suite (a role allowed to create databases).",
    );
  }

  const databaseName = `intake_it_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  const databaseUrl = url.toString();

  const migrator = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  await migrate(drizzle(migrator), {
    migrationsFolder: path.join(root, "drizzle"),
  });
  await migrator.end();

  const work = await mkdtemp(path.join(tmpdir(), "sicwe-it-"));
  const signatures = path.join(work, "signatures");
  await mkdir(signatures);
  // A locally created body signature: the official ClamAV database is not
  // needed (and may be unreachable) for this suite.
  await writeFile(
    path.join(signatures, "test.ndb"),
    `Sicwe.Test.Marker:0:*:${Buffer.from("SICWE-TEST-MALWARE-MARKER").toString("hex")}\n`,
  );
  const emptySignatures = path.join(work, "signatures-empty");
  await mkdir(emptySignatures);

  const port = await freePort();
  const webhookPort = await freePort();
  const platformToken = randomBytes(36).toString("base64url");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: databaseUrl,
    APP_BASE_URL: `http://127.0.0.1:${port}`,
    PROTECTED_DATA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    WEBHOOK_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    PLATFORM_API_TOKEN_SHA256: createHash("sha256")
      .update(platformToken)
      .digest("hex"),
    WEBHOOK_ALLOWED_PRIVATE_ORIGINS: `http://127.0.0.1:${webhookPort}`,
    DOCUMENT_STORAGE_DRIVER: "local",
    DOCUMENT_STORAGE_ROOT: path.join(work, "documents"),
    MALWARE_SCANNER_DRIVER: "clamscan",
    CLAMSCAN_DATABASE_DIR: signatures,
    AUTH_LOGIN_FAILURE_LIMIT: "50",
    API_DEFAULT_RATE_LIMIT_PER_MINUTE: "5000",
    BACKGROUND_JOB_POLL_MS: "200",
  };

  if (
    !existsSync(path.join(root, ".next", "BUILD_ID")) ||
    process.env.INTEGRATION_REBUILD === "1"
  ) {
    await run("npm", ["run", "build"], { ...process.env });
  }

  const server: ChildProcess = spawn(
    process.execPath,
    [
      path.join(root, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: root, env, stdio: ["ignore", "ignore", "inherit"] },
  );

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ready`);
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      server.kill("SIGKILL");
      throw new Error("The application did not become ready.");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  Object.assign(process.env, {
    IT_BASE_URL: `http://127.0.0.1:${port}`,
    IT_DATABASE_URL: databaseUrl,
    IT_PLATFORM_TOKEN: platformToken,
    IT_WEBHOOK_PORT: String(webhookPort),
    IT_WORK_DIR: work,
    IT_EMPTY_SIGNATURES: emptySignatures,
    IT_SERVER_ENV: JSON.stringify(
      Object.fromEntries(
        [
          "DATABASE_URL",
          "APP_BASE_URL",
          "PROTECTED_DATA_ENCRYPTION_KEY",
          "WEBHOOK_ENCRYPTION_KEY",
          "WEBHOOK_ALLOWED_PRIVATE_ORIGINS",
          "DOCUMENT_STORAGE_DRIVER",
          "DOCUMENT_STORAGE_ROOT",
          "MALWARE_SCANNER_DRIVER",
          "CLAMSCAN_DATABASE_DIR",
          "BACKGROUND_JOB_POLL_MS",
        ].map((key) => [key, env[key]]),
      ),
    ),
  });

  return async () => {
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    server.kill("SIGKILL");
    await admin
      .unsafe(`drop database if exists ${databaseName} with (force)`)
      .catch(() => {});
    await admin.end();
    await rm(work, { recursive: true, force: true });
  };
}
