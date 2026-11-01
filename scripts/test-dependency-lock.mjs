import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const script = readFileSync(new URL("scripts/restore-lockfile.mjs", root));
const archive = readFileSync(new URL("package-lock.json.gz.b64", root), "utf8");
const expected = "5d7f30fabb0692441aa5d982a98bf2fd42ac3074e30c30dc19475906e89fb907";
const digest = value => createHash("sha256").update(value).digest("hex");

function isolated(encoded, run) {
  const dir = mkdtempSync(join(tmpdir(), "intake-lock-test-"));
  try {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts/restore-lockfile.mjs"), script);
    writeFileSync(join(dir, "package-lock.json.gz.b64"), encoded);
    return run(dir, () => spawnSync(process.execPath, [join(dir, "scripts/restore-lockfile.mjs")], {
      cwd: dir, encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH ?? "" },
    }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("restoration is exact and repeatable", () => isolated(archive, (dir, restore) => {
  assert.equal(restore().status, 0);
  const first = readFileSync(join(dir, "package-lock.json"));
  assert.equal(digest(first), expected);
  assert.equal(JSON.parse(first).lockfileVersion, 3);
  assert.equal(restore().status, 0);
  assert.deepEqual(readFileSync(join(dir, "package-lock.json")), first);
}));

for (const [name, encoded, message] of [
  ["invalid encoding", "%%%", "Dependency lock archive encoding is invalid."],
  ["checksum mismatch", "AA==", "Dependency lock archive checksum mismatch."],
  ["truncated archive", archive.trim().slice(0, -4), "Dependency lock archive checksum mismatch."],
]) {
  test(`${name} fails before replacing an existing lock`, () => isolated(encoded, (dir, restore) => {
    const sentinel = "existing-lock-must-survive\n";
    writeFileSync(join(dir, "package-lock.json"), sentinel);
    const result = restore();
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(message));
    assert.equal(readFileSync(join(dir, "package-lock.json"), "utf8"), sentinel);
  }));
}

test("missing archive fails before replacing an existing lock", () => isolated(archive, (dir, restore) => {
  writeFileSync(join(dir, "package-lock.json"), "untouched");
  rmSync(join(dir, "package-lock.json.gz.b64"));
  assert.notEqual(restore().status, 0);
  assert.equal(readFileSync(join(dir, "package-lock.json"), "utf8"), "untouched");
}));
