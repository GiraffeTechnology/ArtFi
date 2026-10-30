import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: [
      "src/lib/native-market-analytics.test.ts",
      "src/lib/native-market-analytics-server.test.ts",
      "src/components/native-market-analytics.test.tsx",
    ],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
