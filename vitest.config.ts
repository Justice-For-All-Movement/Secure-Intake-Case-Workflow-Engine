import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // This contract suite runs under Node’s built-in test runner in CI.
    // Vitest must not collect it as an empty Vitest suite.
    exclude: [
      ...configDefaults.exclude,
      "registry/**/*.test.mjs",
      // Real-Postgres end-to-end suite: `npm run test:pg`.
      "integration/**",
    ],
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDirectory, "src"),
    },
  },
});
