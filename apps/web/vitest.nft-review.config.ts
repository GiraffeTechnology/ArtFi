import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "src/lib/nft/client.test.ts",
      "src/lib/nft/client-envelope.test.ts",
    ],
  },
});
