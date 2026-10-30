import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: {
    alias: { "server-only": resolve("test-fixtures/server-only.ts") },
  },
  test: {
    include: [
      "src/lib/nft/reconciliation.test.ts",
      "src/lib/nft/engine.test.ts",
    ],
  },
});
