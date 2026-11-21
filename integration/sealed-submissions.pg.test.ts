/* eslint-disable @typescript-eslint/no-explicit-any */
// Sealed submissions end to end: the served application, a real browser and
// real PostgreSQL. Proves that the plaintext of sealed answers and files never
// leaves the participant's browser (no request carries it), is never stored,
// and that the envelope the integration API serves opens with the research
// team's private keys.
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationServiceScopes } from "../src/modules/integration/presets";
import { importPrivate, open } from "../src/modules/sealed/sealed-crypto.js";
import { api, baseUrl, loadPlaywright } from "./helpers";

const playwright = loadPlaywright();
const SECRET = `SEALED-STORY-${randomBytes(6).toString("hex")}`;
const SECRET_FILE = `SEALED-FILE-${randomBytes(6).toString("hex")}`;
const ORDINARY = `ordinary-narrative-${randomBytes(4).toString("hex")}`;

const manifest = {
  schemaVersion: 1,
  application: { key: "sealed-intake", name: "Sealed intake", terminology: {} },
  forms: [{
    slug: "tell-us",
    name: "Tell us",
    definition: {
      schemaVersion: 1,
      sealing: { sourceRiskLevel: "severe" },
      sections: [{
        id: "main", title: "Your account", fields: [
          { id: "topic", type: "select", label: "Topic", required: true, options: [{ value: "work", label: "Work" }, { value: "other", label: "Other" }] },
          { id: "summary", type: "long_text", label: "Summary (not sealed)" },
          { id: "story", type: "long_text", label: "What happened", sealed: true, required: true },
          { id: "where", type: "select", label: "Where", sealed: true, options: [{ value: "depot", label: "The depot" }] },
          { id: "proof", type: "file", label: "Photos or documents", sealed: true, maxFiles: 2 },
        ],
      }],
    },
  }],
};

let sql: ReturnType<typeof postgres>;
let token = "";
let browser: any = null;
const keys = JSON.parse(process.env.IT_SEALING_KEYS ?? "[]") as Array<{ id: string; privateJwk: JsonWebKey }>;

beforeAll(async () => {
  sql = postgres(process.env.IT_DATABASE_URL as string, { max: 2, onnotice: () => {} });
  const platform = process.env.IT_PLATFORM_TOKEN as string;
  expect((await api(platform, "POST", "/platform/organizations", { slug: "sealed-tenant", name: "Sealed tenant" })).status).toBe(201);
  const client = await api(platform, "POST", "/platform/organizations/sealed-tenant/api-clients", { name: "research", permissions: [...integrationServiceScopes] });
  expect(client.status, client.text).toBe(201);
  token = client.body.data.token;
  const applied = await api(token, "POST", "/application/manifest", manifest);
  expect(applied.status, applied.text).toBe(200);
  if (playwright) browser = await playwright.chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await sql.end();
});

function containsSecret(text: string) {
  return [SECRET, SECRET_FILE, Buffer.from(SECRET_FILE).toString("base64")].some((secret) => text.includes(secret));
}

describe("sealed answers over the integration API", () => {
  it("advertises sealing and the envelope endpoint", async () => {
    const capabilities = await api(token, "GET", "/capabilities");
    expect(capabilities.body.data.limits.sealedSubmissions).toMatchObject({ available: true, serverCanDecrypt: false });
    expect(capabilities.body.data.endpoints.find((e: any) => e.id === "submissions.sealed")).toMatchObject({ available: true });
  });

  it("refuses sealed answers sent in clear", async () => {
    const response = await api(token, "POST", "/submissions", { formSlug: "tell-us", answers: { topic: "work", story: SECRET } });
    expect(response.status).toBe(422);
    expect(response.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ fieldId: "story", code: "sealed" })]));
    expect(response.text).not.toContain(SECRET);
  });
});

describe.skipIf(!playwright)("sealed answers in a real browser", () => {
  it("disables sealed fields without JavaScript and explains why; they are never named", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`${baseUrl()}/intake/sealed-tenant/tell-us`);
    expect(await page.isDisabled("#field-story")).toBe(true);
    expect(await page.getAttribute("#field-story", "name")).toBeNull();
    expect(await page.textContent('[data-testid="sealed-notice"]')).toContain("need JavaScript");
    expect(await page.textContent('[data-testid="sealed-notice"]')).toContain("Only the research team can read them");
    // A script-less post cannot carry a sealed answer and stores nothing
    // without the required sealed envelope. (Script-less server-action posts
    // are refused by the framework here anyway: with Referrer-Policy
    // no-referrer the browser sends Origin: null.)
    const before = await sql`select count(*)::int as n from intake_submissions where status = 'submitted'`;
    await page.selectOption("#field-topic", "work");
    await page.fill("#field-summary", ORDINARY);
    await Promise.all([
      page.waitForLoadState("load"),
      page.click('[data-testid="submit-report"]'),
    ]);
    const after = await sql`select count(*)::int as n from intake_submissions where status = 'submitted'`;
    expect(after[0].n).toBe(before[0].n);
    await context.close();
  });

  it("encrypts sealed answers and files in the browser: no request carries their plaintext, drafts hold none", async () => {
    const page = await browser.newPage();
    const bodies: string[] = [];
    page.on("request", (request: any) => {
      const buffer = request.postDataBuffer();
      bodies.push(`${request.url()}\n${buffer ? buffer.toString("latin1") : ""}`);
    });
    await page.goto(`${baseUrl()}/intake/sealed-tenant/tell-us`);
    await page.waitForSelector("#field-story:not([disabled])");
    expect(await page.textContent("main")).toContain("encrypted on this device");
    await page.selectOption("#field-topic", "work");
    await page.fill("#field-summary", ORDINARY);
    await page.fill("#field-story", SECRET);
    await page.selectOption("#field-where", "depot");

    // A draft keeps the ordinary answers only.
    await page.click('button[name="__intent"][value="save_draft"]');
    await page.waitForSelector('[data-testid="resume-code"]');
    expect(await page.textContent("main")).toContain("never saved in a draft");
    const drafts = await sql`select answers::text as answers from intake_submissions where status = 'draft'`;
    expect(drafts.some((row) => row.answers.includes(ORDINARY))).toBe(true);
    expect(drafts.some((row) => containsSecret(row.answers))).toBe(false);

    await page.setInputFiles("#field-proof input[type=file]", {
      name: "evidence.txt", mimeType: "text/plain", buffer: Buffer.from(SECRET_FILE),
    });
    await Promise.all([
      page.waitForURL(/\/intake\/confirmation\//, { timeout: 30_000 }),
      page.click('[data-testid="submit-report"]'),
    ]);

    expect(bodies.length).toBeGreaterThan(1);
    const leaked = bodies.filter(containsSecret);
    expect(leaked.map((body) => body.slice(0, 200))).toEqual([]);
    expect(bodies.some((body) => body.includes("pam-sealed"))).toBe(true);
    expect(bodies.some((body) => body.includes(ORDINARY))).toBe(true);
    await page.close();

    // Nothing in the database holds the plaintext.
    const tables = await sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
    for (const { tablename } of tables) {
      const rows = await sql.unsafe(`select t::text as row from "${tablename}" t`);
      for (const row of rows) expect(containsSecret(row.row), tablename).toBe(false);
    }

    // The integration API exposes the envelope; each research key opens it.
    const listed = await api(token, "GET", "/submissions?status=submitted");
    const submission = listed.body.data.find((s: any) => s.id);
    const detail = await api(token, "GET", `/submissions/${submission.id}`);
    expect(detail.body.data.originalAccount.answers).toEqual({ topic: "work", summary: ORDINARY });
    expect(detail.body.data.sealed).toMatchObject({ fieldIds: ["story", "where", "proof"], sourceRiskLevel: "severe" });
    const sealed = await api(token, "GET", `/submissions/${submission.id}/sealed`);
    expect(sealed.status, sealed.text).toBe(200);
    expect(sealed.body.data.commitment).toBe(detail.body.data.sealed.commitment);
    expect(containsSecret(sealed.text)).toBe(false);
    for (const key of keys) {
      const opened: any = await open(sealed.body.data.envelope, key.id, await importPrivate(key.privateJwk));
      expect(opened.commitmentVerified).toBe(true);
      expect(opened.content.answers).toEqual({ story: SECRET, where: "depot", proof: ["evidence.txt"] });
      expect(opened.content.text).toContain(SECRET);
      expect(Buffer.from(opened.content.files[0].base64, "base64").toString()).toBe(SECRET_FILE);
    }
    const events = await api(token, "GET", "/events?limit=500");
    expect(events.body.data.some((e: any) => e.type === "submission.created" && e.resource.id === submission.id)).toBe(true);
    expect(containsSecret(events.text)).toBe(false);
  });
});
