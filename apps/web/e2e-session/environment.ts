/** Isolated TEST_ONLY addresses and credentials. Never point this suite at a live service. */
export const sessionEnvironment = {
  webURL: "http://127.0.0.1:3003",
  apiURL: "http://127.0.0.1:8083",
  chainId: 560048,
  bridgeToken: "TEST_ONLY_session_browser_bridge_0000000000000000",
  sessionSecret: "TEST_ONLY_session_browser_signing_1111111111111111",
  indexerKey: "TEST_ONLY_session_browser_verifier_2222222222222222",
  mysqlDSN: "root:local-root-only@tcp(127.0.0.1:3306)/artfi?parseTime=true",
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
