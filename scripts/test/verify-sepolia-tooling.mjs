import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [preflight, deploy, standardsProbe, charityProbe, environmentExample] =
  await Promise.all([
    readFile(new URL("./sepolia-preflight.sh", import.meta.url), "utf8"),
    readFile(new URL("./sepolia-deploy.sh", import.meta.url), "utf8"),
    readFile(new URL("./sepolia-standards-probe.sh", import.meta.url), "utf8"),
    readFile(
      new URL("./sepolia-charity-editions-probe.sh", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../../.env.example", import.meta.url), "utf8"),
  ]);

for (const [name, script] of [
  ["sepolia-preflight.sh", preflight],
  ["sepolia-deploy.sh", deploy],
  ["sepolia-standards-probe.sh", standardsProbe],
  ["sepolia-charity-editions-probe.sh", charityProbe],
]) {
  assert.match(
    script,
    /require-sin-public-chain\.sh/,
    `${name} must fail closed outside the SIN execution zone`,
  );
}

for (const [name, script] of [
  ["sepolia-preflight.sh", preflight],
  ["sepolia-deploy.sh", deploy],
]) {
  assert.match(
    script,
    /--password-file\b/,
    `${name} must pass a password file explicitly`,
  );
  assert.doesNotMatch(
    script,
    /--password(?:\s|["'])/,
    `${name} must not treat the password-file path as the password value`,
  );
}

assert.match(preflight, /560048/, "preflight must enforce Hoodi chain ID");
// ArtFiMarket and RevenueDistributor deploy only behind an explicit opt-in that defaults
// to false. The earlier form of this check asserted the literal `artfiMarketDeployed=false`,
// which pinned the market as permanently undeployable and made ACCEPTANCE.md §4 G2 item 3
// unreachable: the suite cannot be exercised end to end with receipts if it cannot be
// deployed at all. The guard is kept, not removed — what is asserted now is that the
// default is off and that enabling it requires saying so.
assert.match(
  deploy,
  /ARTFI_DEPLOY_MARKET:-false/,
  "ArtFiMarket deployment must default to disabled",
);
assert.match(
  deploy,
  /ARTFI_DEPLOY_REVENUE_DISTRIBUTOR:-false/,
  "RevenueDistributor deployment must default to disabled",
);
assert.doesNotMatch(
  deploy,
  /artfiMarketDeployed=true\b/,
  "the deployment report must not hard-code a deployed market",
);
for (const [name, source] of [
  ["deploy", deploy],
  ["preflight", preflight],
]) {
  assert.doesNotMatch(
    source,
    /ARTFI_(MARKET|REVENUE)_[A-Z_]+:-/,
    `${name} must not give a market or revenue setting a repository default`,
  );
}
assert.match(
  preflight,
  /ARTFI_TEST_PAYLOAD_CLASS.*!=.*TEST_ONLY_NO_REAL_VALUE/s,
  "money-handling deployment must assert the test-only payload class",
);
assert.match(
  preflight,
  /ARTFI_REVIEWED_COMMIT.*head_commit/s,
  "money-handling deployment must pin the reviewed commit to HEAD",
);
assert.match(
  deploy,
  /ARTFI_DEPLOY_CHARITY_EDITIONS:-false/,
  "charity-edition deployment must remain opt-in",
);
assert.match(
  charityProbe,
  /560048/,
  "charity probe must enforce Hoodi chain ID",
);
assert.match(
  environmentExample,
  /^ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE=$/m,
  "the execution zone must not have a repository default",
);
assert.match(
  environmentExample,
  /^ARTFI_RPC_URL=$/m,
  "the public RPC URL must not have a repository default",
);
assert.match(charityProbe, /0xd9b67a26/, "charity probe must check ERC-1155");
assert.match(
  charityProbe,
  /0x0e89341c/,
  "charity probe must check ERC-1155 metadata",
);
assert.match(
  charityProbe,
  /10000000000000000/,
  "charity probe must check 0.01 ETH",
);

process.stdout.write("sepolia-tooling=pass\n");
