import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: { alias: { "@": resolve("src") } },
  test: {
    include: [
      "src/lib/fraction-matching.test.ts",
      "src/lib/fraction-match-execution.test.ts",
      "src/lib/fraction-reviewed-snapshot.test.ts",
    ],
  },
});
