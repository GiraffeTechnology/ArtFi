import { defineConfig, devices } from "@playwright/test";
import { webRuntime } from "./e2e-runtime";

const externalBaseURL = process.env.ARTFI_E2E_BASE_URL?.replace(/\/$/, "");
const baseURL = externalBaseURL || "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    launchOptions: process.env.ARTFI_E2E_CHROMIUM_PATH
      ? { executablePath: process.env.ARTFI_E2E_CHROMIUM_PATH }
      : undefined,
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: externalBaseURL
    ? undefined
    : {
        ...webRuntime(
          `node node_modules/next/dist/bin/next ${process.env.ARTFI_E2E_PRODUCTION ? "start" : process.env.ARTFI_E2E_WEBPACK ? "dev --webpack" : "dev"} --hostname 0.0.0.0`,
          "0.0.0.0",
          3000,
        ),
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
