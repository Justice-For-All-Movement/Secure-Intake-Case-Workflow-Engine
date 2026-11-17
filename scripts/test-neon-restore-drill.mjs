import assert from "node:assert/strict";
import { restoreDrillConfig, runRestoreDrill } from "./neon-restore-drill.mjs";

const now = new Date("2026-11-17T12:00:00Z");
assert.equal(restoreDrillConfig({}, now), null);
const config = restoreDrillConfig({ NEON_API_KEY: "k", NEON_PROJECT_ID: "proj-123" }, now);
assert.equal(config.restorePoint.toISOString(), "2026-11-17T11:00:00.000Z");
assert.equal(config.databaseName, "neondb");
assert.throws(() => restoreDrillConfig({ NEON_API_KEY: "k", NEON_PROJECT_ID: "../x" }, now), /NEON_PROJECT_ID/);
assert.throws(() => restoreDrillConfig({ NEON_API_KEY: "k", NEON_PROJECT_ID: "p", RESTORE_POINT: "2027-01-01T00:00:00Z" }, now), /past/);
assert.throws(() => restoreDrillConfig({ NEON_API_KEY: "k", NEON_PROJECT_ID: "p", NEON_SOURCE_BRANCH_ID: "main" }, now), /BRANCH/);

function fakeNeon({ failQuery = false, migrations = 22 } = {}) {
  const calls = [];
  let deleted = false;
  const fetcher = async (url, init) => {
    const path = url.replace("https://console.neon.tech/api/v2", "");
    calls.push(init.method + " " + path.split("?")[0]);
    assert.equal(init.headers.authorization, "Bearer k");
    if (init.method === "GET" && path === "/projects/proj-123/branches") {
      return Response.json({ branches: [{ id: "br-other" }, { id: "br-main", default: true }] });
    }
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.branch.parent_id, "br-main");
      assert.equal(body.branch.parent_timestamp, "2026-11-17T11:00:00.000Z");
      return Response.json({ branch: { id: "br-drill" }, operations: [{ id: "op-1" }] });
    }
    if (path.startsWith("/projects/proj-123/operations/op-1")) {
      return Response.json({ operation: { status: "finished", action: "create_branch" } });
    }
    if (path.startsWith("/projects/proj-123/connection_uri")) {
      assert.match(path, /branch_id=br-drill/);
      return Response.json({ uri: "postgresql://role:secret@host/neondb" });
    }
    if (init.method === "DELETE") {
      assert.equal(path, "/projects/proj-123/branches/br-drill");
      deleted = true;
      return Response.json({});
    }
    return new Response("unexpected", { status: 500 });
  };
  const connect = async uri => {
    assert.match(uri, /^postgresql:/);
    return {
      query: async text => {
        if (failQuery) throw new Error("relation does not exist");
        return text.includes("__drizzle_migrations") ? [{ applied: migrations }] : [{ rows: 3 }];
      },
      close: async () => {},
    };
  };
  return { fetcher, connect, calls, wasDeleted: () => deleted };
}

{
  const neon = fakeNeon();
  const result = await runRestoreDrill(config, { ...neon, expectedMigrations: 22, sleep: async () => {} });
  assert.equal(result.ok, true);
  assert(neon.wasDeleted());
  assert(result.checks.some(check => check.check === "table_audit_events_readable"));
  assert(!JSON.stringify(result).includes("secret"));
}
{
  const neon = fakeNeon({ migrations: 21 });
  const result = await runRestoreDrill(config, { ...neon, expectedMigrations: 22, sleep: async () => {} });
  assert.equal(result.ok, false);
  assert(neon.wasDeleted());
}
{
  // A failing check still deletes the temporary branch.
  const neon = fakeNeon({ failQuery: true });
  await assert.rejects(() => runRestoreDrill(config, { ...neon, expectedMigrations: 22, sleep: async () => {} }), /relation/);
  assert(neon.wasDeleted());
}
{
  // API errors name the method and a redacted path, never ids or bodies.
  const failing = async () => new Response("internal detail", { status: 403 });
  await assert.rejects(
    () => runRestoreDrill(config, { fetcher: failing, connect: async () => null, expectedMigrations: 22 }),
    error => /HTTP 403/.test(error.message) && !error.message.includes("proj-123") && !error.message.includes("detail"),
  );
}
console.info("Restore drill contract passed.");
