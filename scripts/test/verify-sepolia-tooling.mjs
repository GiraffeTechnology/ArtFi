import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [preflight, deploy] = await Promise.all([
  readFile(new URL("./sepolia-preflight.sh", import.meta.url), "utf8"),
  readFile(new URL("./sepolia-deploy.sh", import.meta.url), "utf8"),
]);

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

process.stdout.write("sepolia-tooling=pass\n");
