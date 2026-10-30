import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: { alias: { "@": resolve("src") } },
  test: {
    include: [
      "src/lib/dao-governance-wallet-boundary.test.ts",
      "src/lib/dao-session-action.test.ts",
      "src/lib/dao-selected-execution.test.ts",
    ],
  },
});
