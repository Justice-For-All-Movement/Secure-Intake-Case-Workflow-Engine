/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/client";
import {
  assertLoginAllowed,
  LoginRateLimitError,
  loginBucketHash,
  recordLoginFailure,
} from "../src/modules/auth/throttle";
import { integrationServiceScopes } from "../src/modules/integration/presets";
import { api, root, runWorker } from "./helpers";

// Retention, provider-gated email delivery, draft throttling and concurrent
// load against the real database, served app and real worker process.

const manifest = JSON.parse(
  readFileSync(
    path.join(root, "examples/reporting-manifest.example.json"),
    "utf8",
  ),
);
const platform = () => process.env.IT_PLATFORM_TOKEN as string;

let sql: ReturnType<typeof postgres>;
let token = "";
let organizationId = "";

const mail: { headers: Record<string, any>; body: any }[] = [];
let mailServer: Server;
let mailPort = 0;

const submission = (narrative: string) => ({
  formSlug: "report",
  answers: { participation: "anonymous", narrative },
});

beforeAll(async () => {
  sql = postgres(process.env.IT_DATABASE_URL as string, {
    max: 2,
    onnotice: () => {},
  });
  mailServer = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      mail.push({ headers: request.headers, body: JSON.parse(raw) });
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ id: `msg-${mail.length}` }));
    });
  });
  await new Promise<void>((resolve) =>
    mailServer.listen(0, "127.0.0.1", resolve),
  );
  mailPort = (mailServer.address() as AddressInfo).port;

  const slug = "tenant-ops";
  const organization = await api(platform(), "POST", "/platform/organizations", {
    slug,
    name: "Operations tenant",
  });
  expect(organization.status, organization.text).toBe(201);
  const client = await api(
    platform(),
    "POST",
    `/platform/organizations/${slug}/api-clients`,
    { name: "ops", permissions: [...integrationServiceScopes] },
  );
  expect(client.status, client.text).toBe(201);
  token = client.body.data.token;
  const applied = await api(token, "POST", "/application/manifest", manifest);
  expect(applied.status, applied.text).toBe(200);
  const [row] = await sql`select id from organizations where slug = ${slug}`;
  organizationId = row.id;
});

afterAll(async () => {
  await new Promise((resolve) => mailServer.close(resolve));
  await sql.end();
});

describe("retention", () => {
  it("deletes expired drafts and old idempotency keys, never submitted accounts", async () => {
    const created = await api(token, "POST", "/submissions", submission("Kept."), {
      "idempotency-key": "retention-0001",
    });
    expect(created.status, created.text).toBe(201);
    const submittedId = created.body.data.id;
    const [source] = await sql`
      select form_id, form_version_id from intake_submissions where id = ${submittedId}`;

    const insertDraft = async (age: string) => {
      const [draft] = await sql`
        insert into intake_submissions
          (organization_id, form_id, form_version_id, status, answers, draft_token_hash, created_at, updated_at)
        values (${organizationId}, ${source.form_id}, ${source.form_version_id}, 'draft', '{}'::jsonb,
                ${randomBytes(32).toString("hex")}, now() - ${age}::interval, now() - ${age}::interval)
        returning id`;
      return draft.id as string;
    };
    const expiredDraft = await insertDraft("40 days");
    const freshDraft = await insertDraft("1 day");
    await sql`
      update api_idempotency_keys set created_at = now() - interval '10 days'
      where organization_id = ${organizationId} and idempotency_key = 'retention-0001'`;
    // Make the tenant's retention schedule due now.
    await sql`
      update background_schedules set next_run_at = now()
      where organization_id = ${organizationId} and key = 'retention-sweep'`;

    await runWorker();

    const remaining = await sql`
      select id from intake_submissions
      where id in (${expiredDraft}, ${freshDraft}, ${submittedId})`;
    const ids = remaining.map((row) => row.id).sort();
    expect(ids).toEqual([freshDraft, submittedId].sort());
    const keys = await sql`
      select count(*)::int as n from api_idempotency_keys
      where organization_id = ${organizationId} and idempotency_key = 'retention-0001'`;
    expect(keys[0].n).toBe(0);
    const audit = await sql`
      select metadata from audit_events
      where organization_id = ${organizationId} and action = 'retention.swept'`;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({
      draftsDeleted: 1,
      idempotencyKeysDeleted: 1,
    });
  });
});

describe("email delivery", () => {
  it("stays pending without a provider and is delivered once one is configured", async () => {
    const [membership] = await sql`
      select id from organization_memberships where organization_id = ${organizationId} limit 1`;
    expect(membership).toBeTruthy();
    const [notification] = await sql`
      insert into notifications
        (organization_id, organization_membership_id, event_type, severity, title, body, link, in_app_visible)
      values (${organizationId}, ${membership.id}, 'case.assigned', 'info',
              'A case was assigned', 'Open the queue to review it.', null, true)
      returning id`;
    const [delivery] = await sql`
      insert into notification_deliveries (organization_id, notification_id, channel, destination)
      values (${organizationId}, ${notification.id}, 'email', 'member@example.test')
      returning id`;
    const [job] = await sql`
      insert into background_jobs (organization_id, job_type, payload, priority, max_attempts, dedupe_key, available_at)
      values (${organizationId}, 'notification.deliver', ${sql.json({ deliveryId: delivery.id })},
              50, 5, ${`notification-delivery:${delivery.id}`}, now())
      returning id`;

    await runWorker();
    const [unclaimed] = await sql`select status, attempts from background_jobs where id = ${job.id}`;
    expect(unclaimed).toMatchObject({ status: "pending", attempts: 0 });
    expect(mail).toHaveLength(0);

    await runWorker({
      EMAIL_TRANSPORT_DRIVER: "http",
      EMAIL_HTTP_URL: `http://127.0.0.1:${mailPort}/emails`,
      EMAIL_HTTP_TOKEN: "integration-test-token",
      EMAIL_FROM: "Intake <noreply@example.test>",
      EMAIL_PROVIDER: "test-relay",
    });

    expect(mail).toHaveLength(1);
    expect(mail[0].headers.authorization).toBe("Bearer integration-test-token");
    expect(mail[0].headers["idempotency-key"]).toBe(`notification-${delivery.id}`);
    expect(mail[0].body).toMatchObject({
      from: "Intake <noreply@example.test>",
      to: ["member@example.test"],
      subject: "A case was assigned",
      text: "Open the queue to review it.",
    });
    const [delivered] = await sql`
      select status, provider, external_message_id from notification_deliveries where id = ${delivery.id}`;
    expect(delivered).toMatchObject({
      status: "delivered",
      provider: "test-relay",
      external_message_id: "msg-1",
    });
    const [done] = await sql`select status from background_jobs where id = ${job.id}`;
    expect(done.status).toBe("succeeded");
  });

  it("refuses to start a worker with an unsafe email configuration", async () => {
    await expect(
      runWorker({
        EMAIL_TRANSPORT_DRIVER: "http",
        EMAIL_HTTP_URL: "http://mail.example.test/emails",
        EMAIL_FROM: "noreply@example.test",
      }),
    ).rejects.toThrow(/EMAIL_HTTP_URL must be HTTPS/);
  });
});

describe("public draft throttle", () => {
  it("blocks a source after the configured number of new drafts", async () => {
    const { client, db } = createDatabase(process.env.IT_DATABASE_URL as string);
    try {
      const key = loginBucketHash("draft", `198.51.100.${randomBytes(1)[0]}`);
      const limits = { limit: 3, windowMinutes: 60, blockMinutes: 60 };
      for (let index = 0; index < 3; index += 1) {
        await assertLoginAllowed(db, [key]);
        await recordLoginFailure(db, [key], new Date(), limits);
      }
      await expect(assertLoginAllowed(db, [key])).rejects.toBeInstanceOf(
        LoginRateLimitError,
      );
      const other = loginBucketHash("draft", "203.0.113.7");
      await expect(assertLoginAllowed(db, [other])).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });
});

describe("load", () => {
  it("accepts 60 concurrent submissions with distinct ids and no lost writes", async () => {
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        api(token, "POST", "/submissions", submission(`Load test ${index}.`)),
      ),
    );
    const elapsed = Date.now() - started;
    expect(results.map((result) => result.status)).toEqual(
      Array.from({ length: 60 }, () => 201),
    );
    const ids = new Set(results.map((result) => result.body.data.id));
    expect(ids.size).toBe(60);
    const [count] = await sql`
      select count(*)::int as n from intake_submissions
      where organization_id = ${organizationId} and answers->>'narrative' like 'Load test %'`;
    expect(count.n).toBe(60);
    expect(elapsed).toBeLessThan(60_000);
  });

  it("creates exactly one submission for 12 concurrent requests with one idempotency key", async () => {
    const body = submission("Concurrent duplicate.");
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        api(token, "POST", "/submissions", body, {
          "idempotency-key": "concurrent-dup-0001",
        }),
      ),
    );
    for (const result of results) {
      expect([201, 409]).toContain(result.status);
    }
    const created = results.filter((result) => result.status === 201);
    expect(created.length).toBeGreaterThan(0);
    expect(new Set(created.map((result) => result.body.data.id)).size).toBe(1);
    const [count] = await sql`
      select count(*)::int as n from intake_submissions
      where organization_id = ${organizationId} and answers->>'narrative' = 'Concurrent duplicate.'`;
    expect(count.n).toBe(1);
  });
});
