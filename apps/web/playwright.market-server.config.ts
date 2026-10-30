import { defineConfig } from "@playwright/test";
if (!process.env.ARTFI_MARKET_FIXTURE)
  throw new Error(
    "Build the standalone mirror catalog fixture and set ARTFI_MARKET_FIXTURE.",
  );
export default defineConfig({
  testDir: "./e2e-market-server",
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: process.env.ARTFI_MARKET_RESULTS || "test-results-market-server",
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
