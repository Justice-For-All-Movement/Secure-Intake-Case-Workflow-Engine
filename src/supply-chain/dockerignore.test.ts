import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contents = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8");
const patterns = new Set(contents.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#")));
describe("production container source context", () => {
  it.each([".git", "**/.git", "**/node_modules", "**/.next", "**/.data",
    "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12",
    "**/*.pfx", "**/*.sqlite", "**/*.dump", "**/*.backup"])(
    "excludes potentially sensitive content: %s",
    pattern => expect(patterns.has(pattern)).toBe(true)
  );
});
