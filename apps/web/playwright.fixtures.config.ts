import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { webRuntime } from "./e2e-runtime";

// These existing conditional cases run only in their explicit isolated harness.
// Use a sandbox-compatible runner; do not change host security policy.
// Compose one object: defineConfig(base, overrides) concatenates webServer
// entries, which would start two servers at the same fixture address.
export default defineConfig({
  ...base,
  testMatch: [
    "agent-runtime-live.spec.ts",
    "charity-editions-populated.spec.ts",
  ],
  fullyParallel: false,
  retries: 0,
  use: {
    ...base.use,
    launchOptions: { ...base.use?.launchOptions, chromiumSandbox: true },
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: process.env.ARTFI_E2E_BASE_URL
    ? undefined
    : {
        ...webRuntime(
          "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3000",
          "127.0.0.1",
          3000,
        ),
        url: "http://127.0.0.1:3000/api/health",
        reuseExistingServer: false,
        timeout: 30_000,
      },
});
