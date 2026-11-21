// Service-level end-to-end test on a real PostgreSQL database (runs when
// TEST_DATABASE_URL names a role that may create databases; skipped otherwise).
// Proves that the plaintext of sealed fields is never stored anywhere — not in
// submissions, drafts, protected compartments, audit events or the envelope
// table — and that what is stored opens with the recipients' private keys.
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PROTECTED_DATA_ENCRYPTION_KEY ||= "cd".repeat(32);
});

import { createDatabase, type Database } from "@/db/client";
import { organizations, users } from "@/db/schema";
import { createTrustedTenantScope } from "@/lib/tenancy";
import { createDraftFormVersion, createForm, publishFormVersion } from "@/modules/forms/repository";
import {
  createPublicDraftSubmission,
  loadDraftSubmissionByToken,
  SubmissionValidationError,
  submitDraftSubmissionByToken,
  submitPublicForm,
  updateDraftSubmissionByToken,
} from "@/modules/forms/service";
import { getSubmission, getSubmissionSealedEnvelope } from "@/modules/integration/service";
import type { ApiAuthorizationContext } from "@/modules/api/auth";
import { createRoutingRule, createQueue } from "@/modules/routing/service";
import { importPrivate, open, seal } from "./sealed-crypto";
import { SealingUnavailableError } from "./recipients";
import { SealedRoutingError } from "./policy";
import { testSealingKeys } from "./test-keys";

const adminUrl = process.env.TEST_DATABASE_URL;
const SECRET = `SEALED-PLAINTEXT-${randomBytes(6).toString("hex")}`;
const SECRET_FILE = `SEALED-FILE-BYTES-${randomBytes(6).toString("hex")}`;

const definition = {
  schemaVersion: 1,
  sealing: { sourceRiskLevel: "severe" },
  sections: [{
    id: "s", title: "Report", fields: [
      { id: "kind", type: "select", label: "Kind", required: true, options: [{ value: "abuse", label: "Abuse" }] },
      { id: "alias", type: "short_text", label: "Alias", protection: { compartment: "identity" } },
      { id: "story", type: "long_text", label: "What happened", sealed: true, required: true },
      { id: "proof", type: "file", label: "Files", sealed: true },
    ],
  }],
};

describe.skipIf(!adminUrl)("sealed submissions on PostgreSQL", () => {
  const name = `intake_sealed_${randomBytes(5).toString("hex")}`;
  let admin: ReturnType<typeof postgres>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let organizationId: string;
  let userId: string;
  let versionId: string;
  let keys: Awaited<ReturnType<typeof testSealingKeys>>;
  const previous = process.env.SEALING_RECIPIENTS;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${name}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    const migrator = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await migrate(drizzle(migrator), { migrationsFolder: path.resolve("drizzle") });
    await migrator.end();
    handle = createDatabase(url.toString());
    db = handle.db;
    keys = await testSealingKeys(2);
    delete process.env.SEALING_RECIPIENTS;

    [{ id: organizationId }] = await db.insert(organizations).values({ slug: "sealed-org", name: "Sealed org" }).returning();
    [{ id: userId }] = await db.insert(users).values({ email: `admin-${randomUUID()}@example.org` }).returning();
    const scope = createTrustedTenantScope(organizationId);
    const form = await createForm(db, scope, { slug: "report", name: "Report", createdByUserId: userId });
    ({ id: versionId } = await createDraftFormVersion(db, scope, { formId: form.id, definition: definition as never, createdByUserId: userId }));
  }, 60_000);

  afterAll(async () => {
    if (previous === undefined) delete process.env.SEALING_RECIPIENTS;
    else process.env.SEALING_RECIPIENTS = previous;
    await handle?.client.end();
    await admin?.unsafe(`drop database if exists ${name} with (force)`).catch(() => {});
    await admin?.end();
  });

  it("refuses to publish a form with sealed fields until SEALING_RECIPIENTS is configured", async () => {
    const scope = createTrustedTenantScope(organizationId);
    await expect(publishFormVersion(db, scope, versionId, userId)).rejects.toBeInstanceOf(SealingUnavailableError);
    process.env.SEALING_RECIPIENTS = keys.config;
    await expect(publishFormVersion(db, scope, versionId, userId)).resolves.toMatchObject({ status: "published" });
  });

  it("refuses routing rules that read a sealed field", async () => {
    const scope = createTrustedTenantScope(organizationId);
    const queue = await createQueue(db, scope, { slug: "triage", name: "Triage", assignmentStrategy: "manual" });
    await expect(createRoutingRule(db, scope, {
      name: "by story", priority: 1, targetQueueId: queue.id,
      definition: { schemaVersion: 1, match: "all", conditions: [{ field: "submission", fieldId: "story", operator: "exists" }] },
    })).rejects.toBeInstanceOf(SealedRoutingError);
    await expect(createRoutingRule(db, scope, {
      name: "by kind", priority: 1, targetQueueId: queue.id,
      definition: { schemaVersion: 1, match: "all", conditions: [{ field: "submission", fieldId: "kind", operator: "equals", value: "abuse" }] },
    })).resolves.toBeTruthy();
  });

  it("drafts never hold sealed fields; the envelope is stored at submission; no plaintext is stored anywhere", async () => {
    process.env.SEALING_RECIPIENTS = keys.config;
    // A draft carrying a sealed answer in clear is refused outright.
    await expect(createPublicDraftSubmission(db, "sealed-org", "report", { kind: "abuse", story: SECRET }))
      .rejects.toBeInstanceOf(SubmissionValidationError);
    const draft = await createPublicDraftSubmission(db, "sealed-org", "report", { kind: "abuse", alias: "River" });
    await expect(updateDraftSubmissionByToken(db, draft.resumeToken, { kind: "abuse", story: SECRET }))
      .rejects.toBeInstanceOf(SubmissionValidationError);
    const loaded = await loadDraftSubmissionByToken(db, draft.resumeToken, { organizationSlug: "sealed-org", formSlug: "report" });
    expect(loaded?.answers).toEqual({ kind: "abuse" });

    // Submitting without the envelope fails: the required sealed answer is missing.
    await expect(submitDraftSubmissionByToken(db, draft.resumeToken, { kind: "abuse" }))
      .rejects.toBeInstanceOf(SubmissionValidationError);
    // A sealed answer in clear is refused even with an envelope.
    const content = {
      text: `What happened\n${SECRET}`,
      answers: { story: SECRET, proof: ["a.txt"] },
      files: [{ fieldId: "proof", name: "a.txt", type: "text/plain", base64: Buffer.from(SECRET_FILE).toString("base64") }],
    };
    const envelope = await seal(content, keys.recipients);
    await expect(submitDraftSubmissionByToken(db, draft.resumeToken, { kind: "abuse", story: SECRET }, [], { sealedEnvelope: JSON.stringify(envelope) }))
      .rejects.toBeInstanceOf(SubmissionValidationError);
    // A tampered envelope (plaintext next to the ciphertext) is refused.
    await expect(submitDraftSubmissionByToken(db, draft.resumeToken, { kind: "abuse" }, [], { sealedEnvelope: JSON.stringify({ ...envelope, story: SECRET }) }))
      .rejects.toBeInstanceOf(SubmissionValidationError);

    const fromDraft = await submitDraftSubmissionByToken(db, draft.resumeToken, { kind: "abuse", alias: "River" }, [], { sealedEnvelope: JSON.stringify(envelope) });
    expect(fromDraft.answers).toEqual({ kind: "abuse" });
    const direct = await submitPublicForm(db, "sealed-org", "report", { kind: "abuse" }, null, [], { sealedEnvelope: JSON.stringify(await seal(content, keys.recipients)) });
    // The API path takes the envelope as an object.
    const viaApi = await submitPublicForm(db, "sealed-org", "report", { kind: "abuse" }, null, [], { channel: "api", publicOnly: false, sealedEnvelope: (await seal(content, keys.recipients)) as never });

    // Nothing in the whole database contains the plaintext or the file bytes.
    const tables = await handle.client<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
    let scanned = 0;
    for (const { tablename } of tables) {
      const rows = await handle.client.unsafe(`select t::text as row from "${tablename}" t`);
      for (const row of rows) {
        scanned++;
        expect(row.row, tablename).not.toContain(SECRET);
        expect(row.row, tablename).not.toContain(SECRET_FILE);
        expect(row.row, tablename).not.toContain(Buffer.from(SECRET_FILE).toString("base64"));
      }
    }
    expect(scanned).toBeGreaterThan(10);

    // What is stored is the envelope, exposed through the integration API, and it opens with each key.
    const ctx = { clientId: randomUUID(), clientName: "pam", organizationId, tenantScope: createTrustedTenantScope(organizationId), permissions: new Set(["submission:view"]) } as unknown as ApiAuthorizationContext;
    for (const submission of [fromDraft, direct, viaApi]) {
      const detail = await getSubmission(db, ctx, submission.id);
      expect(detail.sealed).toMatchObject({ fieldIds: ["story", "proof"], sourceRiskLevel: "severe", envelopePath: `/api/v1/submissions/${submission.id}/sealed` });
      expect(detail.form.fields.find((f) => f.id === "story")).toMatchObject({ sealed: true, protected: false });
      const sealed = await getSubmissionSealedEnvelope(db, ctx, submission.id);
      expect(sealed.commitment).toBe(detail.sealed?.commitment);
      for (const pair of keys.pairs) {
        const opened = await open(sealed.envelope as never, pair.id, await importPrivate(pair.privateJwk));
        expect(opened.commitmentVerified).toBe(true);
        expect(opened.content).toEqual(content);
      }
    }
    expect((await getSubmissionSealedEnvelope(db, ctx, fromDraft.id)).envelope).toEqual(envelope);

    // The envelope is immutable.
    await expect(handle.client`update submission_sealed_envelopes set commitment = ${"0".repeat(64)}`).rejects.toThrow(/immutable/);
    await expect(handle.client`delete from submission_sealed_envelopes`).rejects.toThrow(/cannot be deleted/);
  }, 60_000);
});
