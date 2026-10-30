import { defineConfig, devices } from "@playwright/test";

// Real Next routes consume an isolated TEST_ONLY catalog and Oracle upstream.
// Development mode uses the adapters' existing loopback allowance; no production
// trust, Oracle credentials, wallet, or real-asset configuration is changed.
const baseURL = "http://127.0.0.1:3023";
const upstream = "http://127.0.0.1:3024";
export default defineConfig({
  testDir: "./e2e-rwa-oracle",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    launchOptions: {
      chromiumSandbox: true,
      ...(process.env.ARTFI_E2E_CHROMIUM_PATH
        ? { executablePath: process.env.ARTFI_E2E_CHROMIUM_PATH }
        : {}),
    },
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "node e2e-rwa-oracle/source-server.mjs 3024",
      url: `${upstream}/health`,
      reuseExistingServer: false,
    },
    {
      command:
        "node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3023",
      url: `${baseURL}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ARTFI_API_URL: `${upstream}/catalog/`,
        ARTFI_ORACLE_READ_API_URL: `${upstream}/oracle/`,
        NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG: "blue-hour-archive",
        NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID: "1",
        NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS:
          "0x1000000000000000000000000000000000000002",
      },
    },
  ],
});
