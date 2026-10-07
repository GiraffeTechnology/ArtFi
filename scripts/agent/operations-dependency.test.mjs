import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  evaluateOperationsDependency,
  validateOperationsDependencyContract,
} from "./operations-dependency.mjs";

const contract = JSON.parse(
  await readFile(
    new URL("./operations-dependency.contract.json", import.meta.url),
    "utf8",
  ),
);

const healthySnapshot = (observedAt = 1_000_000) => ({
  schemaVersion: 2,
  hostRole: contract.healthContract.producerHostRole,
  observedAt,
  readOnly: true,
  overallHealthy: true,
  checks: Object.fromEntries(
    contract.healthContract.requiredChecks.map((name) => [
      name,
      { available: true, stableCode: "OK" },
    ]),
  ),
});

test("wallet and DAO operations handoff remains a required but fail-closed production dependency", () => {
  const result = validateOperationsDependencyContract(contract);
  assert.equal(contract.schemaVersion, 2);
  assert.equal(contract.healthContract.producerHostRole, "ctyun-abcdyi");
  assert.equal(contract.healthContract.hostRole, "artfi-delivery-link");
  assert.equal(result.productionReady, false);
  assert.deepEqual(result.blockers, [
    "independentIntegrity",
    "completeHttpProjection",
    "zeroCallerPathStartup",
    "managedDatabaseProbe",
    "installed",
    "injected",
    "callable",
    "upgradeRollback",
    "alertingAndStaleWatch",
    "recoveryEvidence",
    "soak",
  ]);
  assert.equal(contract.capabilities.healthSnapshot, true);
  for (const name of [
    "execute",
    "reconcile",
    "revoke",
    "sign",
    "rpc",
    "broadcast",
  ])
    assert.equal(contract.capabilities[name], false);

  const observed = evaluateOperationsDependency(
    contract,
    healthySnapshot(),
    1_001_000,
  );
  assert.equal(observed.ready, false);
  assert.equal(
    result.artifact.archiveSha256,
    "7EABD33341EC32A57CC7EED64C8D5728C446C11E5D049F48A0999653FA3B21A9",
  );
  assert.ok(observed.blockers.includes("installed"));

  const ready = structuredClone(contract);
  ready.artifact.integritySha256 = "A".repeat(64);
  for (const name of Object.keys(ready.gates)) ready.gates[name] = true;
  assert.equal(
    evaluateOperationsDependency(ready, healthySnapshot(), 1_001_000).ready,
    false,
  );
  assert.equal(
    evaluateOperationsDependency(ready, healthySnapshot(), 1_181_001).ready,
    false,
  );

  const missing = healthySnapshot();
  delete missing.checks["db-select1"];
  assert.throws(
    () => evaluateOperationsDependency(contract, missing, 1_001_000),
    /OPERATIONS_DEPENDENCY_CONTRACT_INVALID/,
  );
  const inconsistent = healthySnapshot();
  inconsistent.overallHealthy = false;
  assert.throws(
    () => evaluateOperationsDependency(contract, inconsistent, 1_001_000),
    /OPERATIONS_DEPENDENCY_CONTRACT_INVALID/,
  );
});

test("frozen r2 producer input is translated at a neutral compatibility boundary", () => {
  const result = evaluateOperationsDependency(
    contract,
    healthySnapshot(),
    1_001_000,
  );
  assert.equal(result.ready, false);

  const unknownProducer = healthySnapshot();
  unknownProducer.hostRole = "unreviewed-producer-role";
  assert.throws(
    () => evaluateOperationsDependency(contract, unknownProducer, 1_001_000),
    /OPERATIONS_DEPENDENCY_CONTRACT_INVALID/,
  );
});

test("operations dependency rejects a deployment-vendor-specific internal role", () => {
  const invalid = structuredClone(contract);
  invalid.healthContract.hostRole = "legacy-vendor-specific-host";
  assert.throws(
    () => validateOperationsDependencyContract(invalid),
    /OPERATIONS_DEPENDENCY_CONTRACT_INVALID/,
  );
});

test("a health input cannot self-promote to a production Operations Agent", () => {
  const invalid = structuredClone(contract);
  invalid.artifact.integritySha256 = "A".repeat(64);
  for (const name of Object.keys(invalid.gates)) invalid.gates[name] = true;
  invalid.status = "PRODUCTION_READY";
  invalid.productionReady = true;
  assert.throws(
    () => validateOperationsDependencyContract(invalid),
    /OPERATIONS_DEPENDENCY_CONTRACT_INVALID/,
  );
});

test("operations dependency contract cannot claim readiness with a missing gate", () => {
  const invalid = structuredClone(contract);
  invalid.productionReady = true;
  invalid.status = "PRODUCTION_READY";
  assert.throws(
    () => validateOperationsDependencyContract(invalid),
    /OPERATIONS_DEPENDENCY_CONTRACT_INVALID/,
  );
});

test("operations dependency contract rejects execution capability drift", () => {
  const invalid = structuredClone(contract);
  invalid.capabilities.execute = true;
  assert.throws(
    () => validateOperationsDependencyContract(invalid),
    /OPERATIONS_DEPENDENCY_CONTRACT_INVALID/,
  );
});

test("operations dependency contract rejects missing or undeclared fields", () => {
  assert.throws(
    () => validateOperationsDependencyContract(undefined),
    /OPERATIONS_DEPENDENCY_CONTRACT_INVALID/,
  );
  const invalid = structuredClone(contract);
  invalid.credentialPath = "forbidden";
  assert.throws(
    () => validateOperationsDependencyContract(invalid),
    /OPERATIONS_DEPENDENCY_CONTRACT_INVALID/,
  );
});
