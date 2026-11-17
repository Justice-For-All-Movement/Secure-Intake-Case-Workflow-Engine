import assert from "node:assert/strict";
import { canonicalBaseUrl, probePublicService, wakePublicService } from "./probe-public.mjs";
const origin = "https://secure-intake.example.org";
assert.equal(canonicalBaseUrl(origin), origin);
for (const bad of ["http://secure-intake.example.org", "https://secure-intake.example.org/path", "https://u:p@secure-intake.example.org", "https://localhost", "https://secure-intake.example.org:8443"]) {
  assert.throws(() => canonicalBaseUrl(bad));
}
const seen = [];
const fake = async url => {
  seen.push(url);
  return Response.json(url.endsWith("/api/health")
    ? { status: "ok", check: "liveness", version: "1.0.0-rc.9" }
    : { status: "ready", check: "readiness", version: "1.0.0-rc.9", checks: { database: "ok" } });
};
const result = await probePublicService(origin, fake, "1.0.0-rc.9");
assert.equal(result.status, "smoke_verified");
assert.deepEqual(seen, [origin + "/api/health", origin + "/api/ready"]);
await assert.rejects(() => probePublicService(origin, fake, "1.0.0-rc.8"), /expected deployed version/);
await assert.rejects(() => probePublicService(origin, fake, "main"), /valid package version/);
await assert.rejects(() => probePublicService(origin, fake, undefined, 0), /timeout/);
await assert.rejects(() => probePublicService(origin, async () => new Response("unavailable", { status: 503 })));
await assert.rejects(() => probePublicService(origin, async url => Response.json(url.endsWith("/api/health")
  ? { status: "ok", check: "liveness", version: "v" }
  : { status: "ready", check: "readiness", version: "v", checks: { database: "unavailable" } })));

await assert.rejects(
  () => probePublicService(origin, async url => url.endsWith("/api/health")
    ? Response.json({ status: "ok", check: "liveness", version: "1.0.0-rc.9" })
    : Response.json({ status: "not_ready", check: "readiness", version: "1.0.0-rc.9",
      checks: { database: "unconfigured" } }, { status: 503 })),
  /HTTP 503 database=unconfigured/
);
await assert.rejects(
  () => probePublicService(origin, async url => url.endsWith("/api/health")
    ? Response.json({ status: "ok", check: "liveness", version: "1.0.0-rc.9" })
    : Response.json({ status: "not_ready", check: "readiness", version: "1.0.0-rc.9",
      checks: { database: "postgresql:\/\/sensitive-secret" } }, { status: 503 })),
  error => error instanceof Error && !error.message.includes("sensitive-secret") &&
    error.message.includes("HTTP 503")
);
// Cold start: transport failures and gateway statuses are retried, then the service answers.
{
  let calls = 0;
  const sleeps = [];
  const coldStart = async () => {
    calls += 1;
    if (calls === 1) { const e = new Error("aborted"); e.name = "TimeoutError"; throw e; }
    if (calls === 2) return new Response("starting", { status: 503 });
    return Response.json({ status: "ok", check: "liveness", version: "1.0.0-rc.9" });
  };
  const woke = await wakePublicService(origin, coldStart, { attempts: 4, delayMs: 5, sleep: async ms => { sleeps.push(ms); } });
  assert.equal(woke.attempts, 3);
  assert.deepEqual(sleeps, [5, 5]);
}
// A non-gateway answer ends the wake phase at once; the strict probe judges it.
{
  let calls = 0;
  const woke = await wakePublicService(origin, async () => { calls += 1; return new Response("x", { status: 500 }); }, { attempts: 4, delayMs: 0 });
  assert.equal(woke.attempts, 1);
  assert.equal(calls, 1);
}
// A service that never answers is reported by category only.
await assert.rejects(
  () => wakePublicService(origin, async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:443 secret-detail"); }, { attempts: 3, delayMs: 0 }),
  error => error instanceof Error && /after 3 wake attempts \(transport error\)/.test(error.message) && !error.message.includes("secret-detail")
);
await assert.rejects(() => wakePublicService(origin, fake, { attempts: 0 }), /Wake attempts/);
await assert.rejects(() => wakePublicService(origin, fake, { attempts: 11 }), /Wake attempts/);
await assert.rejects(() => wakePublicService(origin, fake, { delayMs: -1 }), /Wake delay/);
await assert.rejects(() => wakePublicService("http://insecure.example.org", fake), /canonical HTTPS origin/);
console.info("Deployment smoke-check contract passed.");
