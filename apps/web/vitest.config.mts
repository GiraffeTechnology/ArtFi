import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` is supplied by the Next.js bundler, not by a package. Aliasing it to an empty
      // module lets the server-boundary modules keep the marker — which is what stops a secret
      // reaching a client component — while their security-critical paths stay unit tested.
      "server-only": fileURLToPath(
        new URL("./src/test/server-only-stub.ts", import.meta.url),
      ),
    },
  },
});
