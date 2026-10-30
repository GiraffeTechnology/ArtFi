import test from "node:test";
import assert from "node:assert/strict";
import {
  canRequestRevocation,
  normalizeRevocationHash,
  oracleAttestationText,
  validateRevocationResult,
} from "./agent-console.mjs";

test("revocation hashes use one canonical boundary", () => {
  assert.equal(
    normalizeRevocationHash(`0x${"aB".repeat(32)}`),
    `0x${"ab".repeat(32)}`,
  );
  for (const value of [
    undefined,
    "0x12",
    `0x${"gg".repeat(32)}`,
    `0x${"00".repeat(32)}`,
  ])
    assert.throws(
      () => normalizeRevocationHash(value),
      /REVOCATION_SUBMISSION_INVALID/,
    );
});

test("revocation control permits exactly the not-requested durable state", () => {
  assert.equal(canRequestRevocation(), false);
  assert.equal(
    canRequestRevocation({ revocation: { state: "NOT_REQUESTED" } }),
    true,
  );
  for (const state of ["PENDING", "CONFIRMED", "UNKNOWN"])
    assert.equal(canRequestRevocation({ revocation: { state } }), false);
});

test("revocation result binds the operation and only accepts durable states", () => {
  assert.equal(
    validateRevocationResult(
      { id: "operation-1", state: "PENDING" },
      "operation-1",
    ),
    "PENDING",
  );
  assert.equal(
    validateRevocationResult(
      { id: "operation-1", state: "CONFIRMED" },
      "operation-1",
    ),
    "CONFIRMED",
  );
  for (const result of [
    null,
    { id: "other", state: "CONFIRMED" },
    { id: "operation-1", state: "UNKNOWN" },
  ])
    assert.throws(
      () => validateRevocationResult(result, "operation-1"),
      /REVOCATION_RESULT_INVALID/,
    );
});

for (const errorCode of [
  "NOT_CURRENT",
  "REVOKED",
  "SOURCE_TIMEOUT",
  "SOURCE_CIRCUIT_OPEN",
  "SOURCE_RATE_LIMITED",
]) {
  test(`console exposes persisted ${errorCode} as a historical rejection`, () => {
    assert.equal(
      oracleAttestationText({ valid: false, errorCode }),
      "Oracle attestation (last check, not current authority): rejected · " +
        errorCode,
    );
  });
}
test("console distinguishes valid history, absent optional evidence, and malformed evidence", () => {
  assert.equal(oracleAttestationText(), "");
  assert.match(
    oracleAttestationText({ valid: true, errorCode: null }),
    /not current authority\): valid$/,
  );
  for (const evidence of [
    null,
    { valid: true },
    { valid: "true", errorCode: null },
    { valid: false, errorCode: "<script>private details</script>" },
  ]) {
    assert.match(
      oracleAttestationText(evidence),
      /rejected · ATTESTATION_VERIFICATION_FAILED$/,
    );
  }
});
