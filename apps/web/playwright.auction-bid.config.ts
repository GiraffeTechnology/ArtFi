import { defineConfig, devices } from "@playwright/test";
if (!process.env.ARTFI_AUCTION_BID_FIXTURE)
  throw Error("Build the isolated auction bid fixture first.");
export default defineConfig({
  testDir: "./e2e-auction-bid",
  timeout: 12000,
  globalTimeout: 90000,
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir:
    process.env.ARTFI_AUCTION_BID_RESULTS || "test-results-auction-bid",
  use: {
    headless: true,
    launchOptions: process.env.ARTFI_E2E_CHROMIUM_PATH
      ? { executablePath: process.env.ARTFI_E2E_CHROMIUM_PATH }
      : undefined,
    screenshot: "off",
    video: "off",
    trace: "off",
  },
});
