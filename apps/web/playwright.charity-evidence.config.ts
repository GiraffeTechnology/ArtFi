import { defineConfig, devices } from "@playwright/test";
if (!process.env.ARTFI_PORTFOLIO_FIXTURE)
  throw Error(
    "Build the isolated portfolio fixture and set ARTFI_PORTFOLIO_FIXTURE.",
  );
export default defineConfig({
  testDir: "./e2e-charity-evidence",
  timeout: 22000,
  globalTimeout: 120000,
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir:
    process.env.ARTFI_PORTFOLIO_RESULTS || "test-results-charity-evidence",
  use: {
    headless: true,
    acceptDownloads: true,
    launchOptions: process.env.ARTFI_E2E_CHROMIUM_PATH
      ? { executablePath: process.env.ARTFI_E2E_CHROMIUM_PATH }
      : undefined,
    screenshot: "off",
    video: "off",
    trace: "off",
  },
});
