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
      "src/lib/user-signin-completion.test.ts",
      "src/lib/user-auth.test.ts",
      "src/lib/user-auth-json.test.ts",
    ],
  },
});
