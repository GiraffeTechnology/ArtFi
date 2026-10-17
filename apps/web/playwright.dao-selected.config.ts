import { defineConfig } from "@playwright/test";
if (!process.env.ARTFI_DAO_FIXTURE)
  throw Error("Build the isolated DAO fixture and set ARTFI_DAO_FIXTURE.");
export default defineConfig({
  testDir: "./e2e-dao-selected",
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: process.env.ARTFI_DAO_RESULTS || "test-results-dao-selected",
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
