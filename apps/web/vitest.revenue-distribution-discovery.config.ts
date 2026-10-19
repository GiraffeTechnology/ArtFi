import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: { alias: { "@": resolve("src") } },
  test: {
    include: [
      "src/lib/revenue-distribution-discovery.test.tsx",
      "src/components/revenue-claims.test.tsx",
    ],
  },
});
