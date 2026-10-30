import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: { alias: { "@": resolve("src") } },
  test: {
    include: [
      "src/lib/portfolio-records-state.test.ts",
      "src/lib/portfolio-read-limits.test.ts",
      "src/lib/portfolio-records-contract.test.ts",
    ],
  },
});
