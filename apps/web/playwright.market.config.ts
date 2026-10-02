import { defineConfig, devices } from "@playwright/test";

// Isolated, deterministic wallet/RPC fixtures. These addresses have no real-asset meaning.
const baseURL = "http://127.0.0.1:3001";
export default defineConfig({
  testDir: "./e2e-market",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    ...devices["Desktop Chrome"],
    launchOptions: process.env.ARTFI_E2E_CHROMIUM_PATH
      ? { executablePath: process.env.ARTFI_E2E_CHROMIUM_PATH }
      : undefined,
  },
  webServer: {
    command: "pnpm dev --hostname 127.0.0.1 --port 3001",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_HOODI_RPC_URL: `${baseURL}/test-hoodi-rpc`,
      NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_MARKET_ADDRESS:
        "0x1000000000000000000000000000000000000001",
      NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS:
        "0x1000000000000000000000000000000000000002",
      NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID: "1",
      NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG: "blue-hour-archive",
      NEXT_PUBLIC_ARTFI_FRACTION_MARKET_ADDRESS:
        "0x1000000000000000000000000000000000000003",
      NEXT_PUBLIC_ARTFI_FRACTION_TOKEN_ADDRESS:
        "0x1000000000000000000000000000000000000004",
      NEXT_PUBLIC_ARTFI_FRACTION_SLUG: "blue-hour-archive",
    },
  },
});
