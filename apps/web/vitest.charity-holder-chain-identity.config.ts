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
      "src/lib/charity-holder-auth.test.ts",
      "src/lib/charity-holder-chain-identity.test.ts",
      "src/lib/charity-holder-verification-route.test.ts",
      "src/lib/charity-holder-file-route.test.ts",
      "src/lib/charity-holder-descriptor-route.test.ts",
    ],
  },
});
