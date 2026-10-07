import { defineConfig, devices } from "@playwright/test";

// TEST_ONLY: browser responses are controlled public-read fixtures, never live
// registry/warehouse facts or transaction instructions. No upstream is configured.
const baseURL = "http://127.0.0.1:3021";
export default defineConfig({
  testDir: "./e2e-oracle",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    launchOptions: process.env.ARTFI_E2E_CHROMIUM_PATH
      ? { executablePath: process.env.ARTFI_E2E_CHROMIUM_PATH }
      : undefined,
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command:
      "node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3021",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_HOODI_RPC_URL: `${baseURL}/test-hoodi-rpc`,
      NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS:
        "0x1000000000000000000000000000000000000002",
      NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID: "1",
      NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG: "blue-hour-archive",
      ARTFI_ORACLE_READ_API_URL: "",
    },
  },
});
