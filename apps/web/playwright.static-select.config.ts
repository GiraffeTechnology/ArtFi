import { defineConfig } from "@playwright/test";

if (!process.env.ARTFI_STATIC_SELECT_FIXTURE) {
  throw new Error(
    "Build the standalone static-select fixture and set ARTFI_STATIC_SELECT_FIXTURE before running this configuration.",
  );
}
export default defineConfig({
  testDir: "./e2e-static-select",
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir:
    process.env.ARTFI_STATIC_SELECT_RESULTS || "test-results-static-select",
  use: {
    headless: true,
    launchOptions: process.env.ARTFI_E2E_CHROMIUM_PATH
      ? { executablePath: process.env.ARTFI_E2E_CHROMIUM_PATH }
      : undefined,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
});
