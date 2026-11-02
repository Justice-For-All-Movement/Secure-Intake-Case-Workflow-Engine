import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dependencyInventory } from "./dependency-inventory.mjs";

const entry = () => ({ version: "1.2.3", resolved: "https://registry.npmjs.org/example/-/example-1.2.3.tgz", integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, license: "MIT" });
const fixture = () => ({ name: "test-engine", version: "1.0.0", lockfileVersion: 3,
  packages: { "": { name: "test-engine", version: "1.0.0" }, "node_modules/example": entry() } });
const bytes = value => Buffer.from(JSON.stringify(value));

test("binds inventory to exact source bytes and preserves nested installations", () => {
  const lock = fixture();
  lock.packages["node_modules/example/node_modules/@scope/nested"] = { ...entry(), license: undefined, optional: true };
  const input = bytes(lock), report = dependencyInventory(input);
  assert.deepEqual(report.summary, { dependencies: 2, missingLicenseMetadata: 1 });
  assert.equal(report.source.lockSha256, createHash("sha256").update(input).digest("hex"));
  assert.equal(report.dependencies[1].name, "@scope/nested");
  assert.equal(report.dependencies[1].declaredLicense, null);
  assert.equal(report.dependencies[1].optional, true);
  assert.deepEqual(dependencyInventory(input), report);
});

test("dependency order is deterministic without discarding duplicate names", () => {
  const lock = fixture();
  lock.packages["node_modules/z/node_modules/example"] = entry();
  const reversed = { ...lock, packages: Object.fromEntries(Object.entries(lock.packages).reverse()) };
  assert.deepEqual(dependencyInventory(bytes(lock)).dependencies, dependencyInventory(bytes(reversed)).dependencies);
});

for (const [label, change] of [
  ["mutable source", p => { p.resolved = "git+https://example.invalid/repo"; }],
  ["untrusted registry", p => { p.resolved = "https://example.invalid/a.tgz"; }],
  ["credentials", p => { p.resolved = "https://user:password@registry.npmjs.org/a.tgz"; }],
  ["query", p => { p.resolved += "?token=synthetic"; }],
  ["missing integrity", p => { delete p.integrity; }],
  ["short integrity", p => { p.integrity = "sha512-YQ=="; }],
  ["linked installation", p => { p.link = true; }],
  ["invalid license", p => { p.license = { type: "MIT" }; }],
  ["invalid flags", p => { p.dev = "false"; }],
]) test(`rejects ${label}`, () => {
  const lock = fixture(); change(lock.packages["node_modules/example"]);
  assert.throws(() => dependencyInventory(bytes(lock)), /Unsupported or incomplete/);
});

test("rejects malformed, oversized and unsupported input", () => {
  for (const input of [Buffer.from("{"), Buffer.alloc(2 * 1024 * 1024 + 1), bytes({ ...fixture(), lockfileVersion: 2 }), bytes({ ...fixture(), packages: { "": {} } })])
    assert.throws(() => dependencyInventory(input), /Unsupported or incomplete/);
});

test("rejects package paths with traversal segments", () => {
  const lock = fixture(); lock.packages["node_modules/.."] = entry();
  assert.throws(() => dependencyInventory(bytes(lock)), /Unsupported or incomplete/);
});

test("committed lock inventory has no silent license gaps", () => {
  const report = dependencyInventory(readFileSync(new URL("../package-lock.json", import.meta.url)));
  assert.equal(report.source.lockSha256, "5d7f30fabb0692441aa5d982a98bf2fd42ac3074e30c30dc19475906e89fb907");
  assert.equal(report.summary.dependencies, 584);
  assert.equal(report.summary.missingLicenseMetadata, 0);
});
