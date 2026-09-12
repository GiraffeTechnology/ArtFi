import test from "node:test";
import assert from "node:assert/strict";
import {
  canRequestRevocation,
  validateRevocationResult,
} from "./agent-console.mjs";

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
