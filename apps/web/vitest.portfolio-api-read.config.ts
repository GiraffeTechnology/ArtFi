import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve("src"),
      "server-only": resolve("test-fixtures/server-only.ts"),
    },
  },
  test: {
    include: [
      "src/lib/portfolio-route.test.ts",
      "src/lib/portfolio-records-contract.test.ts",
      "src/lib/portfolio-records-state.test.ts",
    ],
  },
});
