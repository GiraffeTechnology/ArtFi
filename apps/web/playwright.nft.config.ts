import { defineConfig, devices } from "@playwright/test";
import { webRuntime } from "./e2e-runtime";
const baseURL = "http://127.0.0.1:3005";
export default defineConfig({
  testDir: "./e2e-nft",
  workers: 1,
  fullyParallel: false,
  timeout: 90000,
  expect: { timeout: 15000 },
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: process.env.ARTFI_E2E_CHROMIUM_PATH
      ? { executablePath: process.env.ARTFI_E2E_CHROMIUM_PATH }
      : undefined,
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    url: `${baseURL}/api/health`,
    timeout: 120000,
    reuseExistingServer: false,
    ...webRuntime(
      `node node_modules/next/dist/bin/next ${process.env.ARTFI_E2E_PRODUCTION ? "start" : "dev --webpack"} --hostname 127.0.0.1 --port 3005`,
      "127.0.0.1",
      3005,
      {
        NEXT_PUBLIC_ETHEREUM_RPC_URL: `${baseURL}/TEST_ONLY-nft-rpc`,
        NEXT_PUBLIC_HOODI_RPC_URL: `${baseURL}/TEST_ONLY-nft-rpc`,
        NEXT_PUBLIC_BASE_RPC_URL: `${baseURL}/TEST_ONLY-nft-rpc`,
        ARTFI_API_URL: "",
        OPENSEA_API_KEY: "",
        ARTFI_NFT_TRADING_ENABLED: "false",
        ARTFI_NFT_COLLECTIONS_JSON: "[]",
      },
    ),
  },
});
