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
      "src/lib/notification-inbox-view.test.tsx",
      "src/components/notification-inbox.test.tsx",
      "src/lib/notification-inbox-state.test.ts",
      "src/lib/notification-transport.test.ts",
      "src/lib/notification-deadlines.test.ts",
    ],
  },
});
