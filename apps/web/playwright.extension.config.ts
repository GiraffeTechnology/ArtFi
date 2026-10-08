import { defineConfig } from "@playwright/test";

// Independent from the web/mock-provider suites. No web/API deployment is started.
export default defineConfig({
  testDir: "./e2e-extension",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/extension-results.json" }],
  ],
  outputDir: "test-results/extension",
  projects: [{ name: "prepermission", testMatch: "prepermission.spec.ts" }],
});
