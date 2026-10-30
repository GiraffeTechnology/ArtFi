import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "src/lib/market-canonical-receipt.test.ts",
      "src/lib/market-transaction.test.ts",
      "src/lib/setup-recovery.test.ts",
      "src/lib/vault-setup.test.ts",
    ],
  },
});
