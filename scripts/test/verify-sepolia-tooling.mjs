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

assert.match(preflight, /11155111/, "preflight must enforce Sepolia chain ID");
assert.match(
  deploy,
  /artfiMarketDeployed=false/,
  "deployment must keep ArtFiMarket disabled",
);
assert.match(
  deploy,
  /ARTFI_DEPLOY_CHARITY_EDITIONS:-false/,
  "charity-edition deployment must remain opt-in",
);
assert.match(
  charityProbe,
  /11155111/,
  "charity probe must enforce Sepolia chain ID",
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
