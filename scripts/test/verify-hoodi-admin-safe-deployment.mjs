import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const verifier = join(
  repoRoot,
  "scripts/release/verify-hoodi-admin-safe-deployment.mjs",
);
const example = JSON.parse(
  readFileSync(
    join(repoRoot, "release/hoodi-admin-safe-deployment.example.json"),
    "utf8",
  ),
);
const scratch = mkdtempSync(join(tmpdir(), "artfi-hoodi-admin-safe-verifier-"));

function verify(candidate) {
  const path = join(scratch, "candidate.json");
  writeFileSync(path, `${JSON.stringify(candidate)}\n`, { flag: "w" });
  return spawnSync(process.execPath, [verifier, path], { encoding: "utf8" });
}

function reject(name, mutate) {
  const candidate = structuredClone(example);
  mutate(candidate);
  const result = verify(candidate);
  assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
}

try {
  assert.equal(verify(example).status, 0, "valid Hoodi manifest must pass");
  reject("wrong chain", (candidate) => {
    candidate.chainId = 11155111;
  });
  reject("threshold one", (candidate) => {
    candidate.adminSafe.threshold = 1;
  });
  reject("zero delay", (candidate) => {
    candidate.adminSafe.delaySeconds = 0;
  });
  reject("wrong safe id", (candidate) => {
    candidate.safeId = "not-the-canonical-safe";
  });
  reject("cross-stage safe drift", (candidate) => {
    candidate.stages.stage3.roleHolders.factoryAdmin =
      "0x2222222222222222222222222222222222222222";
  });
  reject("bootstrap role retained", (candidate) => {
    candidate.stages.stage2.bootstrapDeployerRolesRevoked = false;
  });
  reject("NFT treasury overclaim", (candidate) => {
    candidate.nftTreasuryCustodyClaimed = true;
  });
  for (const stageName of ["stage2", "stage3", "charity"]) {
    reject(`${stageName} missing role inventory`, (candidate) => {
      candidate.stages[stageName].roleHolders = {};
    });
  }
  reject("stage2 missing one required role", (candidate) => {
    delete candidate.stages.stage2.roleHolders.registryPauser;
  });
  reject("stage3 missing one required role", (candidate) => {
    delete candidate.stages.stage3.roleHolders.factoryCreator;
  });
  reject("charity missing one required role", (candidate) => {
    delete candidate.stages.charity.roleHolders.charityDonationRecorder;
  });
  reject("extra fake role", (candidate) => {
    candidate.stages.stage2.roleHolders.fakeRole = candidate.adminSafe.address;
  });
  reject("missing treasury applicability declaration", (candidate) => {
    delete candidate.treasuryAuthority;
  });
  // PRD.md §7.0's second place: a Hoodi deployment record that does not declare the markers, and
  // one that declares only some of them.
  reject("missing test-asset markers", (candidate) => {
    delete candidate.testAssetMarkers;
  });
  reject("partial test-asset markers", (candidate) => {
    candidate.testAssetMarkers = ["TESTNET"];
  });
  process.stdout.write(
    "hoodi-admin-safe-verifier-tests=pass (1 positive, 17 negative)\n",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
