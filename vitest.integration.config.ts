import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

// End-to-end contract suite: real PostgreSQL, the built app served over HTTP,
// the real worker process, the real clamscan binary and a real browser.
// Needs TEST_DATABASE_URL (a role that may create databases).
export default defineConfig({
  test: {
    include: ["integration/**/*.pg.test.ts"],
    globalSetup: ["integration/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  resolve: {
    alias: { "@": path.resolve(rootDirectory, "src") },
  },
});
