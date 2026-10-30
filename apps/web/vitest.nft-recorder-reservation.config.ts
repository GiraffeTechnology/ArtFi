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
      "src/lib/nft/recorder-reservation.test.ts",
      "src/lib/nft/engine.test.ts",
      "src/lib/nft/validation.test.ts",
    ],
  },
});
