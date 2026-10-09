import { readFileSync } from "node:fs";

/** Isolated TEST_ONLY addresses and credentials. Never point this suite at a live service. */
export const sessionEnvironment = {
  webURL: "http://127.0.0.1:3003",
  apiURL: "http://127.0.0.1:8083",
  chainId: 560048,
  bridgeToken: "TEST_ONLY_session_browser_bridge_0000000000000000",
  sessionSecret: "TEST_ONLY_session_browser_signing_1111111111111111",
  indexerKey: "TEST_ONLY_session_browser_verifier_2222222222222222",
  mysqlDSN:
    process.env.ARTFI_E2E_MYSQL_DSN ||
    "root:local-root-only@tcp(127.0.0.1:3306)/artfi?parseTime=true",
  wholeMarket: "0x1000000000000000000000000000000000000001",
  collection: "0x1000000000000000000000000000000000000002",
  fractionMarket: "0x1000000000000000000000000000000000000003",
  fractionToken: "0x1000000000000000000000000000000000000004",
  paymentToken: "0x1000000000000000000000000000000000000005",
  slug: "blue-hour-archive",
} as const;

export const sessionCookies = {
  access: "artfi_user_access",
  refresh: "artfi_user_refresh",
  challenge: "artfi_user_challenge",
} as const;

export function assetPath(kind: "whole" | "fraction") {
  return `/market/${kind === "whole" ? "rwa" : "fractionals"}/${sessionEnvironment.slug}`;
}

const sourceFixturePath = process.env.ARTFI_E2E_SOURCE_FIXTURE;
if (!sourceFixturePath)
  throw new Error(
    "Use test:e2e:session to generate the isolated public source-evidence fixture.",
  );
export const sessionSourceFixture = JSON.parse(
  readFileSync(sourceFixturePath, "utf8"),
) as {
  mode: "TEST_ONLY";
  sources: unknown[];
  publications: {
    revision: number;
    asset: { slug: string };
    evidence: unknown;
  }[];
};
if (
  sessionSourceFixture.mode !== "TEST_ONLY" ||
  sessionSourceFixture.sources.length !== 1 ||
  sessionSourceFixture.publications.length !== 2
)
  throw new Error("Invalid isolated source fixture.");
