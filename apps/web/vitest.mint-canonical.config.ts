import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "src/lib/rwa-mint-recovery.test.ts",
      "src/lib/mint-canonical-recovery.test.ts",
      "src/lib/setup-recovery.test.ts",
    ],
  },
});
