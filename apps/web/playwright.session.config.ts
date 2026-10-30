import { defineConfig, devices } from "@playwright/test";
import { apiRuntimeCommand, webRuntime } from "./e2e-runtime";
import {
  sessionEnvironment as fixture,
  sessionSourceFixture,
} from "./e2e-session/environment";

// Never retain auth headers, cookies, request bodies, page snapshots or signing artifacts.
// Playwright 1.62 uses this flag to disable automatic failure-page ARIA snapshots.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

const isolated = {
  ARTFI_ENV: "test",
  ARTFI_RWA_EVIDENCE_MODE: "TEST_ONLY",
  ARTFI_RWA_APPROVED_SOURCES_JSON: JSON.stringify(sessionSourceFixture.sources),
  ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE: "",
  ARTFI_RPC_URL: "",
  ARTFI_ORACLE_READ_API_URL: "",
  ARTFI_EXTERNAL_TRADE_ENABLED: "false",
  ARTFI_OPERATOR_BEARER_TOKEN: "",
  ARTFI_MARKETPLACE_ALLOWLIST: "",
  ARTFI_OBJECT_PUBLIC_BASE_URL: "",
  OPENSEA_API_KEY: "",
  REDIS_URL: "",
  R2_ENDPOINT: "",
  R2_BUCKET: "",
  R2_ACCESS_KEY_ID: "",
  R2_SECRET_ACCESS_KEY: "",
  GIRAFFE_LANGUAGE_URL: "",
  ARTFI_USER_AUTH_BRIDGE_TOKEN: fixture.bridgeToken,
  ARTFI_INDEXER_SHARED_KEY: fixture.indexerKey,
};

export default defineConfig({
  testDir: "./e2e-session",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : "list",
  preserveOutput: "never",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: fixture.webURL,
    trace: "off",
    screenshot: "off",
    video: "off",
    serviceWorkers: "block",
    launchOptions: process.env.ARTFI_E2E_CHROMIUM_PATH
      ? { executablePath: process.env.ARTFI_E2E_CHROMIUM_PATH }
      : undefined,
  },
  webServer: [
    {
      command: apiRuntimeCommand("go run ./cmd/server"),
      cwd: "../api",
      // This endpoint reads SQL, so an API that silently lost persistence is not ready.
      url: `${fixture.apiURL}/v1/orders?chainId=${fixture.chainId}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...isolated,
        ARTFI_API_ADDR: "127.0.0.1:8083",
        ARTFI_WEB_ORIGIN: fixture.webURL,
        ARTFI_USER_SESSION_SECRET: fixture.sessionSecret,
        MYSQL_DSN: fixture.mysqlDSN,
      },
    },
    {
      url: `${fixture.webURL}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      ...webRuntime(
        `node node_modules/next/dist/bin/next ${process.env.ARTFI_E2E_PRODUCTION ? "start" : "dev --webpack"} --hostname 127.0.0.1 --port 3003`,
        "127.0.0.1",
        3003,
        {
          ...isolated,
          ARTFI_WEB_URL: fixture.webURL,
          ARTFI_API_URL: fixture.apiURL,
          ARTFI_USER_AUTH_API_URL: fixture.apiURL,
          NEXT_PUBLIC_API_URL: fixture.apiURL,
          NEXT_PUBLIC_HOODI_RPC_URL: `${fixture.webURL}/TEST_ONLY-hoodi-rpc`,
          NEXT_PUBLIC_ETHEREUM_RPC_URL: `${fixture.webURL}/TEST_ONLY-hoodi-rpc`,
          NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_MARKET_ADDRESS: fixture.wholeMarket,
          NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS:
            fixture.collection,
          NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID: "1",
          NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG: fixture.slug,
          NEXT_PUBLIC_ARTFI_FRACTION_MARKET_ADDRESS: fixture.fractionMarket,
          NEXT_PUBLIC_ARTFI_FRACTION_TOKEN_ADDRESS: fixture.fractionToken,
          NEXT_PUBLIC_ARTFI_FRACTION_SLUG: fixture.slug,
        },
      ),
    },
  ],
});
