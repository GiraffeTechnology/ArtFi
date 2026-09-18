const digest = (value) =>
  typeof value === "string" && /^[A-F0-9]{64}$/.test(value);

const requiredChecks = Object.freeze([
  "tunnel-service",
  "tunnel-listener",
  "sin-service",
  "sin-app-listener",
  "sin-e2e-health",
  "db-select1",
]);

const requiredGates = Object.freeze([
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

const fail = () => {
  throw new Error("OPERATIONS_DEPENDENCY_CONTRACT_INVALID");
};
const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

export function validateOperationsDependencyContract(input) {
  const contract = structuredClone(input);
  if (
    !exactKeys(contract, [
      "schemaVersion",
      "dependencyRole",
      "satisfiesOperationsAgent",
      "artifact",
      "healthContract",
      "capabilities",
      "gates",
      "status",
      "productionReady",
    ]) ||
    !exactKeys(contract.artifact, [
      "name",
      "version",
      "archiveSha256",
      "manifestSha256",
      "integritySha256",
      "testResultsSha256",
    ]) ||
    !exactKeys(contract.healthContract, [
      "snapshotSchemaVersion",
      "hostRole",
      "freshnessSeconds",
      "requiredChecks",
    ]) ||
    !exactKeys(contract.capabilities, [
      "healthSnapshot",
      "execute",
      "reconcile",
      "revoke",
      "sign",
      "rpc",
      "broadcast",
    ]) ||
    !exactKeys(contract.gates, requiredGates) ||
    contract.schemaVersion !== 1 ||
    contract.dependencyRole !== "OPERATIONS_HEALTH_INPUT" ||
    contract.satisfiesOperationsAgent !== false ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(contract.artifact.name) ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(contract.artifact.version) ||
    !digest(contract.artifact.archiveSha256) ||
    !digest(contract.artifact.manifestSha256) ||
    (contract.artifact.integritySha256 !== null &&
      !digest(contract.artifact.integritySha256)) ||
    !digest(contract.artifact.testResultsSha256) ||
    contract.healthContract?.snapshotSchemaVersion !== 2 ||
    contract.healthContract?.hostRole !== "ctyun-abcdyi" ||
    contract.healthContract?.freshnessSeconds !== 180 ||
    !Array.isArray(contract.healthContract?.requiredChecks) ||
    contract.healthContract.requiredChecks.length !== requiredChecks.length ||
    requiredChecks.some(
      (value, index) => contract.healthContract.requiredChecks[index] !== value,
    ) ||
    contract.capabilities?.healthSnapshot !== true ||
    ["execute", "reconcile", "revoke", "sign", "rpc", "broadcast"].some(
      (name) => contract.capabilities?.[name] !== false,
    ) ||
    requiredGates.some((name) => typeof contract.gates?.[name] !== "boolean") ||
    contract.status !== "PARTIAL_INPUT_READY_NOT_7X24" ||
    contract.productionReady !== false
  )
    fail();

  const blockers = requiredGates.filter((name) => !contract.gates[name]);
  if (contract.artifact.integritySha256 === null)
    blockers.unshift("artifact.integritySha256");
  return Object.freeze({
    artifact: Object.freeze({ ...contract.artifact }),
    productionReady: contract.productionReady,
    blockers: Object.freeze(blockers),
  });
}

export function evaluateOperationsDependency(
  input,
  snapshot,
  nowMs = Date.now(),
) {
  const frozenInput = structuredClone(input);
  const contract = validateOperationsDependencyContract(frozenInput);
  const expected = frozenInput.healthContract;
  if (
    !Number.isSafeInteger(nowMs) ||
    !exactKeys(snapshot, [
      "schemaVersion",
      "hostRole",
      "observedAt",
      "readOnly",
      "overallHealthy",
      "checks",
    ]) ||
    snapshot.schemaVersion !== expected.snapshotSchemaVersion ||
    snapshot.hostRole !== expected.hostRole ||
    !Number.isSafeInteger(snapshot.observedAt) ||
    snapshot.observedAt < 0 ||
    snapshot.observedAt > nowMs + 5000 ||
    snapshot.readOnly !== true ||
    typeof snapshot.overallHealthy !== "boolean" ||
    !exactKeys(snapshot.checks, expected.requiredChecks)
  )
    fail();
  for (const name of expected.requiredChecks) {
    const check = snapshot.checks[name];
    if (
      !exactKeys(check, ["available", "stableCode"]) ||
      ![true, false, null].includes(check.available) ||
      typeof check.stableCode !== "string" ||
      !/^[A-Z][A-Z0-9_]{1,63}$/.test(check.stableCode) ||
      (check.available === true) !== (check.stableCode === "OK")
    )
      fail();
  }
  const healthy = expected.requiredChecks.every(
    (name) => snapshot.checks[name].available === true,
  );
  if (healthy !== snapshot.overallHealthy) fail();
  const fresh = nowMs - snapshot.observedAt <= expected.freshnessSeconds * 1000;
  const blockers = [
    ...contract.blockers,
    ...(!fresh ? ["healthSnapshot.stale"] : []),
    ...(!healthy ? ["healthSnapshot.unhealthy"] : []),
  ];
  return Object.freeze({
    // Health input is required by production composition, but it cannot
    // satisfy the complete Operations Agent responsibilities by itself.
    ready: false,
    observedAt: snapshot.observedAt,
    blockers: Object.freeze(blockers),
  });
}
