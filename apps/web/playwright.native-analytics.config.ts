import { defineConfig, devices } from "@playwright/test";
if (!process.env.ARTFI_ANALYTICS_OUTPUT || !process.env.ARTFI_E2E_CHROMIUM_PATH)
  throw Error("Existing built fixture and Chromium required.");
export default defineConfig({
  testDir: "./e2e-native-analytics",
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: process.env.ARTFI_ANALYTICS_RESULTS,
  use: {
    headless: true,
    launchOptions: { executablePath: process.env.ARTFI_E2E_CHROMIUM_PATH },
    reducedMotion: "reduce",
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
});
