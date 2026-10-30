import { defineConfig, devices } from "@playwright/test";
import { webRuntime } from "./e2e-runtime";
const baseURL = process.env.ARTFI_SAFE_E2E_BASE_URL || "http://127.0.0.1:3002";
const port = new URL(baseURL).port;
export default defineConfig({
  testDir: "./e2e-safe",
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
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
    url: `${baseURL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    ...webRuntime(
      `node node_modules/next/dist/bin/next ${process.env.ARTFI_E2E_PRODUCTION ? "start" : "dev --webpack"} --hostname 127.0.0.1 --port ${port}`,
      "127.0.0.1",
      port,
      {
        NEXT_PUBLIC_HOODI_RPC_URL: `${baseURL}/test-hoodi-rpc`,
        NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS:
          "0x1000000000000000000000000000000000000055",
        ARTFI_ADMIN_SAFE_ADDRESS: "0x1000000000000000000000000000000000000055",
        NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS:
          "0x1000000000000000000000000000000000000006",
      },
    ),
  },
});
