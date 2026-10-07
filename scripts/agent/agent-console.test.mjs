import test from "node:test";
import assert from "node:assert/strict";
import {
  canRequestRevocation,
  normalizeRevocationHash,
  validateRevocationResult,
} from "./agent-console.mjs";

test("revocation hashes use one canonical boundary", () => {
  assert.equal(
    normalizeRevocationHash(`0x${"aB".repeat(32)}`),
    `0x${"ab".repeat(32)}`,
  );
  for (const value of [undefined, "0x12", `0x${"gg".repeat(32)}`])
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
