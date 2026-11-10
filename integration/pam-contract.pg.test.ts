/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/modules/application/canonical";
import { integrationServiceScopes } from "../src/modules/integration/presets";
import { INFECTED_MARKER } from "./global-setup";
import {
  allEvents,
  api,
  baseUrl,
  loadPlaywright,
  root,
  runWorker,
  sleep,
  until,
  waitForEvent,
} from "./helpers";

const manifest = JSON.parse(
  readFileSync(
    path.join(root, "examples/reporting-manifest.example.json"),
    "utf8",
  ),
);
const playwright = loadPlaywright();
const axeSource = readFileSync(
  path.join(root, "node_modules/axe-core/axe.min.js"),
  "utf8",
);

interface Tenant {
  slug: string;
  token: string;
  limitedToken: string;
}

const platform = () => process.env.IT_PLATFORM_TOKEN as string;
let sql: ReturnType<typeof postgres>;
let a: Tenant;
let b: Tenant;
let browser: any = null;

// Webhook receiver controlled by the test.
const received: {
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  answered: number;
}[] = [];
let failNextCaseOpened = true;
let receiver: Server;
let webhookSecret = "";

async function provisionTenant(slug: string): Promise<Tenant> {
  const organization = await api(platform(), "POST", "/platform/organizations", {
    slug,
    name: `Org ${slug}`,
  });
  expect(organization.status).toBe(201);
  const full = await api(
    platform(),
    "POST",
    `/platform/organizations/${slug}/api-clients`,
    {
      name: "integration",
      permissions: [...integrationServiceScopes, "submission:view_protected"],
    },
  );
  expect(full.status).toBe(201);
  const limited = await api(
    platform(),
    "POST",
    `/platform/organizations/${slug}/api-clients`,
    { name: "limited", permissions: [...integrationServiceScopes] },
  );
  const applied = await api(
    full.body.data.token,
    "POST",
    "/application/manifest",
    manifest,
  );
  expect(applied.status, applied.text).toBe(200);
  return {
    slug,
    token: full.body.data.token,
    limitedToken: limited.body.data.token,
  };
}

async function axeViolations(page: any) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () =>
    (window as any).axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
    }),
  );
  return result.violations.map(
    (violation: any) =>
      `${violation.id}: ${violation.nodes.map((node: any) => node.target).join(" | ")}`,
  );
}

async function tabTo(page: any, selector: string) {
  for (let index = 0; index < 80; index += 1) {
    const focused = await page.evaluate(
      (target: string) =>
        Boolean(document.activeElement?.matches(target)),
      selector,
    );
    if (focused) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Keyboard focus never reached ${selector}`);
}

async function chooseByKeyboard(page: any, selector: string, value: string) {
  await tabTo(page, selector);
  for (let index = 0; index < 10; index += 1) {
    const current = await page.evaluate(
      () => (document.activeElement as HTMLSelectElement).value,
    );
    if (current === value) return;
    await page.keyboard.press("ArrowDown");
  }
  throw new Error(`Could not select ${value} with the keyboard`);
}

beforeAll(async () => {
  sql = postgres(process.env.IT_DATABASE_URL as string, {
    max: 2,
    onnotice: () => {},
  });
  receiver = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const type = request.headers["x-sicwe-event"];
      const status = type === "case.opened" && failNextCaseOpened ? 500 : 204;
      if (status === 500) failNextCaseOpened = false;
      received.push({ headers: request.headers, raw, answered: status });
      response.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) =>
    receiver.listen(Number(process.env.IT_WEBHOOK_PORT), "127.0.0.1", resolve),
  );

  a = await provisionTenant("tenant-a");
  b = await provisionTenant("tenant-b");

  const hook = await api(
    platform(),
    "POST",
    "/platform/organizations/tenant-a/webhooks",
    {
      name: "downstream",
      endpointUrl: `http://127.0.0.1:${process.env.IT_WEBHOOK_PORT}/hooks`,
      eventTypes: ["submission.created", "attachment.released", "case.opened"],
    },
  );
  expect(hook.status, hook.text).toBe(201);
  webhookSecret = hook.body.data.signingSecret;

  if (playwright) browser = await playwright.chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => receiver.close(resolve));
  await sql.end();
});

describe("authentication fails closed", () => {
  it("rejects missing, malformed and unknown credentials", async () => {
    expect((await api(null, "GET", "/cases")).status).toBe(401);
    expect((await api("nonsense", "GET", "/cases")).status).toBe(401);
    expect(
      (await api(`sicwe_000000000000_${"x".repeat(43)}`, "GET", "/events"))
        .status,
    ).toBe(401);
    expect(
      (await api("wrong-platform-token-wrong-platform-token", "POST", "/platform/organizations", { slug: "zz", name: "zz" })).status,
    ).toBe(401);
    // A tenant credential is not a platform credential.
    expect(
      (await api(a.token, "POST", "/platform/organizations", { slug: "zz", name: "zz" })).status,
    ).toBe(401);
  });

  it("refuses non-delegable scopes and unscoped operations", async () => {
    const refused = await api(
      platform(),
      "POST",
      "/platform/organizations/tenant-a/api-clients",
      { name: "bad", permissions: ["api:manage"] },
    );
    expect(refused.status).toBe(400);
    const narrow = await api(
      platform(),
      "POST",
      "/platform/organizations/tenant-a/api-clients",
      { name: "narrow", permissions: ["case:view"] },
    );
    const token = narrow.body.data.token;
    expect((await api(token, "GET", "/events")).status).toBe(403);
    expect((await api(token, "GET", "/submissions")).status).toBe(403);
    expect(
      (await api(token, "POST", "/submissions", { formSlug: "report", answers: {} })).status,
    ).toBe(403);
  });

  it("serves the capability document an identity verifier relies on", async () => {
    const response = await api(a.token, "GET", "/capabilities");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.split(";")[0]).toBe(
      "application/json",
    );
    expect(response.text.length).toBeLessThan(65536);
    const data = response.body.data;
    expect(data.schemaVersion).toBe(1);
    expect(data.apiVersion).toBe("v1");
    expect(data.engine.service).toBe("secure-intake-case-workflow-engine");
    expect(data.authentication).toMatchObject({
      scheme: "bearer",
      tenantSource: "api_client",
    });
    expect(data.authentication.grantedScopes).toEqual(
      expect.arrayContaining(["case:view", "event:view", "submission:view"]),
    );
    expect(data.endpoints.every((endpoint: any) => endpoint.available)).toBe(
      true,
    );
    expect(response.text).not.toContain("tenant-a");

    // When the sibling identity engine is checked out, run its real verifier.
    const adapter =
      "/home/user/identity-authorization-and-policy-engine/src/intake-service-adapter.ts";
    if (existsSync(adapter)) {
      const { verifyIntakeService } = await import(/* @vite-ignore */ adapter);
      const verified = await verifyIntakeService(
        {
          tenantId: "t1",
          projectId: "p1",
          connectionId: "c1",
          origin: "https://intake.example.org",
          credentialFingerprint: createHash("sha256").update(a.token).digest("hex"),
          actorId: "actor-1",
          localRoles: ["operator"],
          requiredScopes: ["case:view", "event:view"],
          supportedVersions: [data.engine.version],
          epoch: 1,
          enabled: true,
        },
        async () => a.token,
        new Date().toISOString(),
        // The verifier insists on an HTTPS origin; route it to the local app.
        (url: string, options: RequestInit) =>
          fetch(url.replace("https://intake.example.org", baseUrl()), options),
      );
      expect(verified.upstreamVersion).toBe(data.engine.version);
      expect(verified.actor.kind).toBe("service");
    }
  });
});

describe("service API: submission, idempotency, original account", () => {
  let submissionId = "";

  it("creates a pseudonymous submission idempotently without storing the secret", async () => {
    const body = {
      formSlug: "report",
      locale: "es",
      answers: {
        participation: "pseudonymous",
        preferred_name: "River",
        narrative: "Something happened at the depot.",
      },
    };
    const first = await api(a.token, "POST", "/submissions", body, {
      "idempotency-key": "create-sub-0001",
    });
    expect(first.status, first.text).toBe(201);
    submissionId = first.body.data.id;
    expect(first.body.data.participantAccessSecret).toMatch(/^[\w-]{32,}$/);

    const replay = await api(a.token, "POST", "/submissions", body, {
      "idempotency-key": "create-sub-0001",
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(replay.body.data.id).toBe(submissionId);
    expect(replay.body.data.participantAccessSecret).toBeNull();
    expect(replay.body.data.participantAccessSecretWithheld).toBe(true);

    const reused = await api(
      a.token,
      "POST",
      "/submissions",
      { ...body, locale: "en" },
      { "idempotency-key": "create-sub-0001" },
    );
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe("idempotency_key_reused");

    const stored = await sql`select response_body::text as body from api_idempotency_keys`;
    expect(stored.some((row) => row.body.includes(first.body.data.participantAccessSecret))).toBe(false);
    const count = await sql`select count(*)::int as n from intake_submissions where id = ${submissionId}`;
    expect(count[0].n).toBe(1);
  });

  it("rejects invalid answers and unknown forms without creating anything", async () => {
    const invalid = await api(a.token, "POST", "/submissions", {
      formSlug: "report",
      answers: { participation: "pseudonymous" },
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.details[0].fieldId).toBe("narrative");
    expect(
      (await api(a.token, "POST", "/submissions", { formSlug: "nope", answers: {} })).status,
    ).toBe(404);
  });

  it("returns the original account with a verifiable digest and no protected values", async () => {
    const response = await api(a.token, "GET", `/submissions/${submissionId}`);
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.channel).toBe("api");
    expect(data.locale).toBe("es");
    expect(data.originalAccount.answers).toEqual({
      participation: "pseudonymous",
      narrative: "Something happened at the depot.",
    });
    expect(response.text).not.toContain("River");
    expect(data.protectedCompartments).toEqual([
      { compartment: "identity", fieldIds: ["preferred_name"] },
    ]);
    const digest = createHash("sha256")
      .update(canonicalJson(data.originalAccount.answers), "utf8")
      .digest("hex");
    expect(data.originalAccount.sha256).toBe(digest);
    expect(data.originalAccount.recordedSha256).toBe(digest);
    expect(data.originalAccount.digestMatchesRecord).toBe(true);
  });

  it("stores protected identity encrypted and reveals it only with the explicit scope", async () => {
    const rows = await sql`select ciphertext from submission_protected_compartments where submission_id = ${submissionId}`;
    expect(rows).toHaveLength(1);
    expect(String(rows[0].ciphertext)).not.toContain("River");

    const denied = await api(a.limitedToken, "GET", `/submissions/${submissionId}/protected`);
    expect(denied.status).toBe(403);
    const allowed = await api(a.token, "GET", `/submissions/${submissionId}/protected`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.compartments[0].values).toEqual({ preferred_name: "River" });
    const event = await waitForEvent(
      a.token,
      (item) => item.type === "protected_data.service_read" && item.resource.id === submissionId,
      "protected read audit",
    );
    expect(JSON.stringify(event)).not.toContain("River");
  });

  it("keeps the submitted original account immutable in the database", async () => {
    await expect(
      sql`update intake_submissions set answers = '{"narrative":"rewritten"}'::jsonb where id = ${submissionId}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      sql`update intake_submissions set status = 'draft' where id = ${submissionId}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      sql`delete from intake_submissions where id = ${submissionId}`,
    ).rejects.toThrow(/cannot be deleted/);
    // Analysis is recorded elsewhere and leaves the account untouched.
    const opened = await api(a.token, "POST", "/cases", { submissionId });
    const caseId = opened.body.data.case.id;
    await api(a.token, "POST", `/cases/${caseId}/notes`, { body: "Analyst view: plausible." });
    await api(a.token, "POST", `/cases/${caseId}/triage`, { summary: "Analyst summary", priority: "high", tags: ["depot"] });
    const after = await api(a.token, "GET", `/submissions/${submissionId}`);
    expect(after.body.data.originalAccount.digestMatchesRecord).toBe(true);
    expect(after.body.data.originalAccount.answers.narrative).toBe("Something happened at the depot.");
    expect(after.body.data.case.id).toBe(caseId);
  });
});

describe.skipIf(!playwright)("participant journey in a real browser", () => {
  const narrative = "The night shift was told to ignore the alarm.";
  const internalNote = "INTERNAL-ONLY-ASSESSMENT-91ac";
  let resumeCode = "";
  let trackingCode = "";
  let accessSecret = "";
  let submissionId = "";
  let caseId = "";
  let cleanVersionId = "";
  let infectedVersionId = "";
  const cleanBytes = Buffer.from("A harmless statement.\n".repeat(20));
  const infectedBytes = Buffer.from(`prefix ${INFECTED_MARKER} suffix`);

  it("public form is accessible, multilingual and announces no cost or lawyer requirement", async () => {
    const page = await browser.newPage();
    await page.goto(`${baseUrl()}/intake/tenant-a/report`);
    expect(await axeViolations(page)).toEqual([]);
    expect(await page.getAttribute("main", "lang")).toBe("en");
    expect(await page.textContent("main")).toContain("free");
    expect(await page.textContent("main")).toContain("do not need a lawyer");

    await page.click('nav.language-switcher a[hreflang="es"]');
    await page.waitForURL(/lang=es/);
    expect(await page.getAttribute("main", "lang")).toBe("es");
    expect(await page.textContent("main")).toContain("Hacer un informe");
    expect(await page.textContent("main")).toContain("¿Cómo quiere participar?");
    expect(await page.textContent("main")).toContain("gratuito");
    expect(await axeViolations(page)).toEqual([]);
    await page.close();

    // Accept-Language negotiation without a query parameter.
    const context = await browser.newContext({ locale: "es-MX" });
    const negotiated = await context.newPage();
    await negotiated.goto(`${baseUrl()}/intake/tenant-a/report`);
    expect(await negotiated.getAttribute("main", "lang")).toBe("es");
    await context.close();
  });

  it("saves a draft with the keyboard only and reveals nothing for a wrong resume code", async () => {
    const page = await browser.newPage();
    await page.goto(`${baseUrl()}/intake/tenant-a/report?lang=es`);
    await chooseByKeyboard(page, "#field-participation", "pseudonymous");
    await tabTo(page, "#field-preferred_name");
    await page.keyboard.type("Heron");
    await tabTo(page, "#field-narrative");
    await page.keyboard.type(narrative);
    await tabTo(page, 'button[name="__intent"][value="save_draft"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-testid="resume-code"]');
    resumeCode = (await page.textContent('[data-testid="resume-code"]')).trim();
    expect(resumeCode).toMatch(/^[\w-]{40,}$/);
    await page.close();

    const drafts = await sql`select status, answers, draft_token_hash, locale from intake_submissions where draft_token_hash is not null`;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].draft_token_hash).not.toBe(resumeCode);
    expect(drafts[0].locale).toBe("es");
    expect(JSON.stringify(drafts[0].answers)).not.toContain("Heron");
    // A draft is the participant's alone: the service API cannot see it.
    const listed = await api(a.token, "GET", "/submissions?status=draft");
    const draftId = (await sql`select id from intake_submissions where draft_token_hash is not null`)[0].id;
    expect((await api(a.token, "GET", `/submissions/${draftId}`)).status).toBe(404);
    expect(listed.status).toBe(200);

    // Unknown code and a real code used on another tenant look identical.
    const outcomes: string[] = [];
    for (const [slug, code] of [
      ["tenant-a", "x".repeat(43)],
      ["tenant-b", resumeCode],
    ]) {
      const probe = await browser.newPage();
      await probe.goto(`${baseUrl()}/intake/${slug}/report`);
      await probe.click("details.draft-resume summary");
      await probe.fill("#resume-code", code);
      await probe.click('details.draft-resume button[type="submit"]');
      await probe.waitForSelector(".error-summary");
      outcomes.push((await probe.textContent(".error-summary")).trim());
      expect(await probe.inputValue("#field-narrative")).toBe("");
      await probe.close();
    }
    expect(outcomes[0]).toBe(outcomes[1]);
  });

  it("resumes the draft, uploads files and submits; uploads start quarantined", async () => {
    const work = process.env.IT_WORK_DIR as string;
    await mkdir(path.join(work, "files"), { recursive: true });
    const cleanPath = path.join(work, "files", "statement.txt");
    const infectedPath = path.join(work, "files", "attachment.txt");
    await writeFile(cleanPath, cleanBytes);
    await writeFile(infectedPath, infectedBytes);

    const page = await browser.newPage();
    await page.goto(`${baseUrl()}/intake/tenant-a/report?lang=es`);
    await page.click("details.draft-resume summary");
    await page.fill("#resume-code", resumeCode);
    await page.click('details.draft-resume button[type="submit"]');
    await page.waitForFunction(
      (text: string) =>
        (document.querySelector("#field-narrative") as HTMLTextAreaElement)?.value === text,
      narrative,
    );
    expect(await page.inputValue("#field-participation")).toBe("pseudonymous");
    // Protected answers are write-only: never sent back to a browser.
    expect(await page.inputValue("#field-preferred_name")).toBe("");
    await page.fill("#field-preferred_name", "Heron");
    await page.setInputFiles('input[name="supporting_files"]', [cleanPath, infectedPath]);
    await page.click('button[data-testid="submit-report"]');
    await page.waitForSelector('[data-testid="access-secret"]');
    trackingCode = (await page.textContent('[data-testid="tracking-code"]')).trim();
    accessSecret = (await page.textContent('[data-testid="access-secret"]')).trim();
    await page.close();

    const created = await waitForEvent(
      a.token,
      (event) =>
        event.type === "submission.created" &&
        event.action === "submission.received" &&
        (event as any).previousState?.status === "draft",
      "submission.created from draft",
    );
    submissionId = created.resource.id;
    const submission = await api(a.token, "GET", `/submissions/${submissionId}`);
    expect(submission.body.data.confirmationCode).toBe(trackingCode);
    expect(submission.body.data.channel).toBe("public_form");
    expect(submission.body.data.locale).toBe("es");
    expect(submission.body.data.originalAccount.answers.narrative).toBe(narrative);
    expect(submission.text).not.toContain("Heron");
    expect(submission.text).not.toContain(accessSecret);
    // The resume code is spent.
    expect((await sql`select draft_token_hash from intake_submissions where id = ${submissionId}`)[0].draft_token_hash).toBeNull();

    const attachments = await api(a.token, "GET", `/submissions/${submissionId}/attachments`);
    expect(attachments.body.data).toHaveLength(2);
    for (const attachment of attachments.body.data) {
      expect(attachment).toMatchObject({
        contentStatus: "quarantined",
        malwareScanStatus: "pending",
        released: false,
        contentPath: null,
      });
      const content = await api(a.token, "GET", `/documents/${attachment.versionId}/content`);
      expect(content.status).toBe(409);
      expect(content.body.error.code).toBe("content_unavailable");
    }
    cleanVersionId = attachments.body.data.find((item: any) => item.filename === "statement.txt").versionId;
    infectedVersionId = attachments.body.data.find((item: any) => item.filename === "attachment.txt").versionId;
  });

  it("keeps uploads quarantined when no scanner or no signature database is available", async () => {
    const none = await runWorker({ MALWARE_SCANNER_DRIVER: "none" }, 3);
    expect(none.failed).toBeGreaterThanOrEqual(2);
    const broken = await runWorker(
      { CLAMSCAN_DATABASE_DIR: process.env.IT_EMPTY_SIGNATURES as string },
      3,
    );
    expect(broken.succeeded).toBe(broken.claimed - broken.failed);
    const attachments = await api(a.token, "GET", `/submissions/${submissionId}/attachments`);
    for (const attachment of attachments.body.data) {
      expect(attachment.released).toBe(false);
      expect(attachment.contentStatus).toBe("quarantined");
      expect((await api(a.token, "GET", `/documents/${attachment.versionId}/content`)).status).toBe(409);
    }
    const events = await allEvents(a.token);
    expect(events.some((event) => event.type === "attachment.released")).toBe(false);
  });

  it("worker scans with clamscan: clean file released with digest, infected file blocked", async () => {
    // Failed scan jobs back off before they can be claimed again.
    await until(
      async () => {
        await runWorker({}, 4);
        const list = await api(a.token, "GET", `/submissions/${submissionId}/attachments`);
        return list.body.data.every((item: any) => item.malwareScanStatus !== "pending") ? list : null;
      },
      "scan completion",
      90_000,
    );
    const list = await api(a.token, "GET", `/submissions/${submissionId}/attachments`);
    const clean = list.body.data.find((item: any) => item.versionId === cleanVersionId);
    const infected = list.body.data.find((item: any) => item.versionId === infectedVersionId);
    expect(clean).toMatchObject({ contentStatus: "available", malwareScanStatus: "clean", released: true, malwareScanProvider: "clamscan" });
    expect(infected).toMatchObject({ contentStatus: "blocked", malwareScanStatus: "infected", released: false, contentPath: null });

    const response = await fetch(`${baseUrl()}${clean.contentPath}`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.equals(cleanBytes)).toBe(true);
    const digest = createHash("sha256").update(cleanBytes).digest("hex");
    expect(clean.sha256).toBe(digest);
    expect(response.headers.get("x-content-sha256")).toBe(digest);
    expect(response.headers.get("digest")).toBe(
      `sha-256=${createHash("sha256").update(cleanBytes).digest("base64")}`,
    );

    const blocked = await api(a.token, "GET", `/documents/${infectedVersionId}/content`);
    expect(blocked.status).toBe(409);
    expect(blocked.text).not.toContain(INFECTED_MARKER);

    const custody = await api(a.token, "GET", `/documents/${cleanVersionId}/custody`);
    expect(custody.status).toBe(200);
    expect(custody.body.data.document.sha256).toBe(digest);
    expect(custody.body.data.custody.length).toBeGreaterThan(0);

    const released = await waitForEvent(a.token, (event) => event.type === "attachment.released" && event.resource.id === cleanVersionId, "attachment.released");
    expect(released.resource.parentId).toBe(submissionId);
    expect(released.metadata.sha256).toBe(digest);
    await waitForEvent(a.token, (event) => event.type === "attachment.blocked" && event.resource.id === infectedVersionId, "attachment.blocked");
  });

  it("opens a case, promotes only the released file, then triage, assign, deadline, referral, transition", async () => {
    const opened = await api(a.token, "POST", "/cases", { submissionId });
    expect(opened.status, opened.text).toBe(201);
    caseId = opened.body.data.case.id;
    expect(opened.body.data.case.sourceSubmissionId).toBe(submissionId);
    const again = await api(a.token, "POST", "/cases", { submissionId });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ created: false, case: { id: caseId } });

    const opening = await waitForEvent(a.token, (event) => event.type === "case.opened" && event.resource.id === caseId, "case.opened");
    expect(opening.action).toBe("case.created");

    const documents = await api(a.token, "GET", `/cases/${caseId}/documents`);
    const text = JSON.stringify(documents.body);
    expect(text).toContain(cleanVersionId);
    expect(text).not.toContain(infectedVersionId);

    const staff = await api(a.token, "POST", "/identity/staff", {
      provider: "external-idp",
      subject: "worker-1",
      displayName: "Case Worker",
      roleKeys: ["case_worker"],
    });
    expect(staff.status, staff.text).toBe(200);
    // Queue assignment requires membership of the queue's team.
    const outsider = await api(a.token, "POST", `/cases/${caseId}/assignment`, { queueSlug: "example_queue", userId: staff.body.data.userId });
    expect(outsider.status).toBe(409);
    expect(outsider.body.error.code).toBe("assignment_failed");
    const joined = await api(a.token, "POST", "/identity/staff", { provider: "external-idp", subject: "worker-1", teamSlugs: ["example_team"] });
    expect(joined.status, joined.text).toBe(200);
    expect(joined.body.data.userId).toBe(staff.body.data.userId);
    expect((await api(a.token, "POST", "/identity/staff", { provider: "external-idp", subject: "worker-2", roleKeys: ["administrator"] })).status).toBe(403);
    expect((await api(a.token, "GET", "/identity/staff?provider=external-idp&subject=worker-1")).body.data.userId).toBe(staff.body.data.userId);

    const triaged = await api(a.token, "POST", `/cases/${caseId}/triage`, { priority: "critical", tags: ["safety"], summary: "Triage: credible and pressing." });
    expect(triaged.status, triaged.text).toBe(200);
    expect(triaged.body.data).toMatchObject({ priority: "critical", tags: ["safety"] });

    const assigned = await api(a.token, "POST", `/cases/${caseId}/assignment`, { queueSlug: "example_queue", userId: staff.body.data.userId, reason: "triage" });
    expect(assigned.status, assigned.text).toBe(200);
    expect(assigned.body.data.assignedMembershipId).toBe(staff.body.data.membershipId);

    const deadline = await api(a.token, "POST", `/cases/${caseId}/deadlines`, { operation: "create", label: "First response", dueAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(deadline.status, deadline.text).toBe(201);
    const deadlines = await api(a.token, "GET", `/cases/${caseId}/deadlines`);
    expect(JSON.stringify(deadlines.body)).toContain(deadline.body.data.id);
    const extended = await api(a.token, "POST", `/cases/${caseId}/deadlines`, { operation: "extend", deadlineId: deadline.body.data.id, reason: "awaiting records", extensionValue: 2, extensionUnit: "calendar_days" });
    expect(extended.status, extended.text).toBe(200);

    const referral = await api(a.token, "POST", `/cases/${caseId}/referrals`, { policyKey: "example_external_referral", recipientName: "Example Agency", subject: "Referral", summary: "For follow-up." });
    expect(referral.status, referral.text).toBe(201);

    const unavailable = await api(a.token, "POST", `/cases/${caseId}/transitions`, { transitionKey: "close_d" });
    expect(unavailable.status).toBe(409);
    const moved = await api(a.token, "POST", `/cases/${caseId}/transitions`, { transitionKey: "advance_a_to_b", comment: "Accepted for review." });
    expect(moved.status, moved.text).toBe(200);
    expect(moved.body.data.status).toBe("state_b");
    const transition = await waitForEvent(a.token, (event) => event.type === "case.transitioned" && event.resource.id === caseId, "case.transitioned");
    expect(transition.newState?.status).toBe("state_b");
    expect((await api(a.token, "GET", `/cases/${caseId}/reviews`)).status).toBe(200);
  });

  it("participant sign-in reveals nothing about existence and the portal hides internal material", async () => {
    await api(a.token, "POST", `/cases/${caseId}/notes`, { body: internalNote });
    const message = await api(a.token, "POST", `/cases/${caseId}/participant-messages`, { subject: "Thank you", body: "We have read your report. Can you tell us the date?" });
    expect(message.status, message.text).toBe(201);

    const attempt = async (slug: string, code: string, secret: string) => {
      const page = await browser.newPage();
      await page.goto(`${baseUrl()}/participant/${slug}`);
      await page.fill('input[name="trackingCode"]', code);
      await page.fill('input[name="accessSecret"]', secret);
      await page.click('button[type="submit"]');
      await page.waitForLoadState("networkidle");
      return page;
    };
    const wrongSecret = await attempt("tenant-a", trackingCode, "w".repeat(43));
    const unknownCode = await attempt("tenant-a", "SCW-0000000000000000", "w".repeat(43));
    const otherTenant = await attempt("tenant-b", trackingCode, accessSecret);
    const bodies = await Promise.all(
      [wrongSecret, unknownCode, otherTenant].map(async (page) => ({
        url: new URL(page.url()).search,
        text: (await page.textContent("main")).replace(/tenant-[ab]|Org tenant-[ab]/g, ""),
      })),
    );
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(wrongSecret.url()).not.toContain("/portal");
    await Promise.all([wrongSecret, unknownCode, otherTenant].map((page) => page.close()));

    const page = await attempt("tenant-a", trackingCode, accessSecret);
    await page.waitForURL(/\/portal/);
    expect(await axeViolations(page)).toEqual([]);
    const html = await page.content();
    expect(html).toContain("We have read your report.");
    expect(html).toContain(trackingCode);
    expect(html.includes("State B")).toBe(true);
    for (const hidden of [internalNote, "Triage: credible", "safety", "critical", "Case Worker", "Example Agency", "statement.txt", "attachment.txt", "Heron", "First response", "Accepted for review"]) {
      expect(html.includes(hidden), hidden).toBe(false);
    }

    await page.click("details summary");
    await page.fill('textarea[name="body"]', "It was on the second of the month.");
    await page.click('details button[type="submit"]');
    await page.waitForURL(/sent=1/);
    const inbound = await waitForEvent(a.token, (event) => event.type === "participant.message.received" && event.resource.parentId === caseId, "participant.message.received");
    expect(JSON.stringify(inbound)).not.toContain("second of the month");
    const thread = await api(a.token, "GET", `/cases/${caseId}/participant-messages`);
    expect(thread.body.data.messages.map((item: any) => item.direction)).toEqual(["outbound", "inbound"]);
    expect(thread.text).not.toContain(internalNote);

    // Recovery: the participant replaces the secret; the old one stops working.
    await page.click('section[aria-labelledby="participant-secret-heading"] button');
    await page.waitForSelector('[data-testid="rotated-secret"]');
    const rotated = (await page.textContent('[data-testid="rotated-secret"]')).trim();
    expect(rotated).not.toBe(accessSecret);
    await page.close();
    const stale = await attempt("tenant-a", trackingCode, accessSecret);
    expect(stale.url()).not.toContain("/portal");
    await stale.close();
    const fresh = await attempt("tenant-a", trackingCode, rotated);
    await fresh.waitForURL(/\/portal/);
    await fresh.close();
    expect((await sql`select secret_hash from external_participant_credentials where submission_id = ${submissionId}`)[0].secret_hash).not.toContain(rotated);
  });

  it("an anonymous participant gets status only: safe follow-up is refused", async () => {
    const created = await api(a.token, "POST", "/submissions", { formSlug: "report", answers: { participation: "anonymous", narrative: "Anonymous account of events." } });
    const opened = await api(a.token, "POST", "/cases", { submissionId: created.body.data.id });
    const refused = await api(a.token, "POST", `/cases/${opened.body.data.case.id}/participant-messages`, { body: "Hello?" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "participant_messaging_unavailable", details: { reason: "status_only" } });
    expect((await api(a.token, "GET", `/submissions/${created.body.data.id}`)).body.data.protectedCompartments).toEqual([]);
  });

  it("submits a complete report with the keyboard alone", async () => {
    const page = await browser.newPage();
    await page.goto(`${baseUrl()}/intake/tenant-a/report`);
    await chooseByKeyboard(page, "#field-participation", "anonymous");
    await tabTo(page, "#field-narrative");
    await page.keyboard.type("Typed entirely from the keyboard.");
    await tabTo(page, 'button[data-testid="submit-report"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-testid="tracking-code"]');
    const code = (await page.textContent('[data-testid="tracking-code"]')).trim();
    await page.close();
    const rows = await sql`select answers, status from intake_submissions where confirmation_code = ${code}`;
    expect(rows[0].status).toBe("submitted");
    expect(rows[0].answers.narrative).toBe("Typed entirely from the keyboard.");

    // Validation errors are reachable and announced.
    const invalid = await browser.newPage();
    await invalid.goto(`${baseUrl()}/intake/tenant-a/report`);
    await invalid.evaluate(() => document.querySelector('form[data-testid="report-form"]')?.setAttribute("novalidate", ""));
    await tabTo(invalid, 'button[data-testid="submit-report"]');
    await invalid.keyboard.press("Enter");
    await invalid.waitForSelector(".error-summary[role=alert]");
    expect(await invalid.evaluate(() => document.activeElement?.classList.contains("error-summary"))).toBe(true);
    expect(await axeViolations(invalid)).toEqual([]);
    await invalid.close();
  });
});

describe("webhooks", () => {
  it("delivers signed events, retries failures and stays idempotent for the receiver", async () => {
    await until(
      async () => {
        await runWorker({}, 6);
        const opened = received.filter((item) => item.headers["x-sicwe-event"] === "case.opened");
        return opened.some((item) => item.answered === 500) &&
          opened.some((item) => item.answered === 204 && opened.find((first) => first.answered === 500 && first.headers["x-sicwe-event-id"] === item.headers["x-sicwe-event-id"]))
          ? true
          : null;
      },
      "webhook redelivery",
      90_000,
    );

    const types = new Set(received.map((item) => item.headers["x-sicwe-event"]));
    expect(types.has("submission.created")).toBe(true);
    expect(types.has("case.opened")).toBe(true);
    // Only subscribed types are delivered.
    for (const type of types) {
      expect(["submission.created", "attachment.released", "case.opened"]).toContain(type);
    }

    const now = Math.floor(Date.now() / 1000);
    for (const delivery of received) {
      const timestamp = String(delivery.headers["x-sicwe-timestamp"]);
      const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${delivery.raw}`).digest("hex");
      const presented = String(delivery.headers["x-sicwe-signature"]).replace(/^sha256=/, "");
      expect(timingSafeEqual(Buffer.from(expected), Buffer.from(presented))).toBe(true);
      expect(Math.abs(now - Number(timestamp))).toBeLessThan(300);
      const tampered = createHmac("sha256", webhookSecret).update(`${timestamp}.${delivery.raw} `).digest("hex");
      expect(tampered).not.toBe(presented);
      const payload = JSON.parse(delivery.raw);
      expect(payload.eventId).toBe(delivery.headers["x-sicwe-event-id"]);
      expect(payload.id).toBe(delivery.headers["x-sicwe-delivery"]);
      expect(delivery.raw).not.toContain("narrative");
    }

    // The failed delivery was repeated with the same ids and a fresh signature,
    // so a receiver that de-duplicates on eventId processes it exactly once.
    const failed = received.find((item) => item.answered === 500)!;
    const retries = received.filter((item) => item.headers["x-sicwe-event-id"] === failed.headers["x-sicwe-event-id"]);
    expect(retries.length).toBeGreaterThanOrEqual(2);
    expect(new Set(retries.map((item) => item.headers["x-sicwe-delivery"])).size).toBe(1);
    const processed = new Set(received.filter((item) => item.answered === 204).map((item) => item.headers["x-sicwe-event-id"]));
    const successes = received.filter((item) => item.answered === 204);
    expect(processed.size).toBe(successes.length);

    // Webhook and feed describe the same event.
    const feed = await allEvents(a.token);
    const payload = JSON.parse(failed.raw);
    expect(feed.find((event) => event.id === payload.eventId)).toMatchObject({ type: "case.opened", cursor: payload.cursor, sequence: payload.sequence });
    const deliveries = await sql`select status from webhook_deliveries where id = ${String(failed.headers["x-sicwe-delivery"])}`;
    expect(deliveries[0].status).toBe("delivered");
  });

  it("refuses private webhook destinations that the operator has not approved", async () => {
    for (const endpointUrl of ["http://127.0.0.1:9/hook", "https://127.0.0.1/hook", "http://example.org/hook", "https://localhost/hook"]) {
      const response = await api(platform(), "POST", "/platform/organizations/tenant-a/webhooks", { name: `bad ${endpointUrl}`, endpointUrl, eventTypes: ["*"] });
      expect(response.status, endpointUrl).toBe(400);
    }
  });
});

describe("event feed", () => {
  it("is ordered, resumable by cursor and acknowledgeable", async () => {
    const everything = await allEvents(a.token);
    expect(everything.length).toBeGreaterThan(10);
    const sequences = everything.map((event) => event.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);

    const firstPage = await api(a.token, "GET", "/events?limit=3");
    expect(firstPage.body.data.map((event: any) => event.id)).toEqual(everything.slice(0, 3).map((event) => event.id));
    expect(firstPage.body.cursor.hasMore).toBe(true);
    const secondPage = await api(a.token, "GET", `/events?limit=3&after=${firstPage.body.cursor.next}`);
    expect(secondPage.body.data.map((event: any) => event.id)).toEqual(everything.slice(3, 6).map((event) => event.id));

    const filtered = await api(a.token, "GET", "/events?types=case.opened,submission.created&limit=500");
    expect(new Set(filtered.body.data.map((event: any) => event.type))).toEqual(new Set(["case.opened", "submission.created"]));

    expect((await api(a.token, "GET", "/events?after=not-a-cursor")).status).toBe(400);
    const last = everything[everything.length - 1].cursor;
    expect((await api(a.token, "POST", "/events/ack", { cursor: last })).status).toBe(200);
    const resumed = await api(a.token, "GET", "/events");
    expect(resumed.body.data.every((event: any) => event.sequence > everything[everything.length - 1].sequence)).toBe(true);
    // The acknowledged position belongs to one credential only.
    expect((await api(a.limitedToken, "GET", "/events?limit=1")).body.data[0].id).toBe(everything[0].id);
    const text = JSON.stringify(everything);
    for (const secret of ["River", "Heron", "Something happened", "INTERNAL-ONLY"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("tenant isolation", () => {
  it("a second tenant sees nothing of the first through any endpoint", async () => {
    const submissions = await api(a.token, "GET", "/submissions?limit=100");
    const cases = await api(a.token, "GET", "/cases?limit=100");
    expect(submissions.body.data.length).toBeGreaterThan(0);
    expect(cases.body.data.length).toBeGreaterThan(0);
    const submissionId = submissions.body.data.find((item: any) => item.status === "submitted").id;
    const caseId = cases.body.data[0].id;
    const versions = await sql`select v.id from document_versions v join organizations o on o.id = v.organization_id where o.slug = 'tenant-a'`;

    // Lists, search and counts for tenant B are empty of tenant A's records.
    const aIds = new Set<string>([
      ...submissions.body.data.map((item: any) => item.id),
      ...cases.body.data.map((item: any) => item.id),
      ...versions.map((row) => row.id as string),
    ]);
    for (const listing of ["/submissions?limit=100", "/cases?limit=100", "/cases?q=report&limit=100", "/cases?q=SCW&limit=100", "/cases?focus=all&limit=100", "/audit-events?limit=100", "/events?limit=500"]) {
      const response = await api(b.token, "GET", listing);
      expect(response.status, listing).toBe(200);
      for (const id of aIds) expect(response.text, `${listing} leaked ${id}`).not.toContain(id);
    }
    expect((await api(b.token, "GET", "/submissions?limit=100")).body.data).toHaveLength(0);
    expect((await api(b.token, "GET", "/cases?limit=100")).body.data).toHaveLength(0);
    const bEvents = await allEvents(b.token);
    expect(bEvents.every((event) => !["submission.created", "case.opened", "attachment.released"].includes(event.type))).toBe(true);

    // Direct references to tenant A's records are indistinguishable from absent ones.
    const reads = [
      `/submissions/${submissionId}`,
      `/submissions/${submissionId}/protected`,
      `/submissions/${submissionId}/attachments`,
      `/cases/${caseId}`,
      `/cases/${caseId}/status`,
      `/cases/${caseId}/documents`,
      `/cases/${caseId}/deadlines`,
      `/cases/${caseId}/referrals`,
      `/cases/${caseId}/reviews`,
      `/cases/${caseId}/notes`,
      `/cases/${caseId}/participant-messages`,
      ...versions.flatMap((row) => [`/documents/${row.id}`, `/documents/${row.id}/content`, `/documents/${row.id}/custody`]),
    ];
    for (const pathname of reads) {
      const response = await api(b.token, "GET", pathname);
      expect(response.status, pathname).toBe(404);
    }
    const writes: [string, unknown][] = [
      ["/cases", { submissionId }],
      [`/cases/${caseId}/transitions`, { transitionKey: "advance_a_to_b" }],
      [`/cases/${caseId}/triage`, { priority: "low" }],
      [`/cases/${caseId}/assignment`, { queueSlug: "example_queue" }],
      [`/cases/${caseId}/notes`, { body: "cross-tenant" }],
      [`/cases/${caseId}/participant-messages`, { body: "cross-tenant" }],
      [`/cases/${caseId}/deadlines`, { operation: "create", label: "x", dueAt: new Date(Date.now() + 1e7).toISOString() }],
      [`/cases/${caseId}/referrals`, { policyKey: "example_external_referral", recipientName: "x" }],
      [`/submissions/${submissionId}/identity`, { provider: "external-idp", subject: "p" }],
    ];
    for (const [pathname, body] of writes) {
      const response = await api(b.token, "POST", pathname, body);
      expect([404, 409], pathname).toContain(response.status);
      expect(response.status === 409 ? response.body.error.code : "not_found", pathname).toMatch(/not_found|submission_not_submitted/);
    }
    const untouched = await sql`select count(*)::int as n from case_notes where body = 'cross-tenant'`;
    expect(untouched[0].n).toBe(0);

    // Identity links are tenant scoped.
    await api(a.token, "POST", `/submissions/${submissionId}/identity`, { provider: "external-idp", subject: "participant-9" });
    expect((await api(a.token, "GET", "/identity/participants?provider=external-idp&subject=participant-9")).body.data).toHaveLength(1);
    expect((await api(b.token, "GET", "/identity/participants?provider=external-idp&subject=participant-9")).body.data).toHaveLength(0);
    expect((await api(b.token, "GET", "/identity/staff?provider=external-idp&subject=worker-1")).status).toBe(404);

    // Staff download URLs and public form drafts require the right tenant too.
    for (const row of versions) {
      const response = await fetch(`${baseUrl()}/api/documents/${row.id}/download`, { redirect: "manual", headers: { authorization: `Bearer ${b.token}` } });
      expect([401, 403, 404, 307, 302]).toContain(response.status);
      expect(await response.text()).not.toContain("harmless statement");
    }
    // Stored object keys are tenant-prefixed and never shared.
    const keys = await sql`select o.slug, v.storage_key from document_versions v join organizations o on o.id = v.organization_id`;
    for (const row of keys) expect(row.slug).toBe("tenant-a");
  });
});
