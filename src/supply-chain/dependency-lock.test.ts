import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("restores the exact dependency lock and rejects corruption without replacing output", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const output = execFileSync(process.execPath, ["--test", "scripts/test-dependency-lock.mjs"], {
    cwd: root, encoding: "utf8", timeout: 15000,
    env: { PATH: process.env.PATH ?? "" },
  });
  expect(output).toContain("pass 5");
}, 20000);

it("validates deterministic dependency inventory and rejects incomplete metadata", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const output = execFileSync(process.execPath, ["--test", "scripts/test-dependency-inventory.mjs"], {
    cwd: root, encoding: "utf8", timeout: 15000,
    env: { PATH: process.env.PATH ?? "" },
  });
  expect(output).toContain("pass 14");
}, 20000);
