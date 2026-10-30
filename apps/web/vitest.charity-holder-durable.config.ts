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
      "src/lib/charity-holder-verification-route.test.ts",
      "src/lib/charity-holder-challenge-route.test.ts",
      "src/lib/charity-holder-challenge-store.test.ts",
    ],
  },
});
