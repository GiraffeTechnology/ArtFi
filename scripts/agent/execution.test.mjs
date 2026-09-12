import test from "node:test";
import assert from "node:assert/strict";
import { createAgentKernel, kernelRequestDigest } from "./agent-kernel.mjs";

// Orchestration contract fake: not cryptographic, chain or SQL acceptance.
function fixture({ loseResponse = false, refuseStart = false } = {}) {
  const request = {
    operationId: "execution-test",
    intent: { nonce: "1" },
    execution: { chainId: "560048" },
  };
  let row = {
    id: request.operationId,
    request,
    requestDigest: kernelRequestDigest(request),
    state: "PREPARED",
    version: 1,
    leaseToken: "lease",
    leaseExpiresAt: Date.now() + 60000,
  };
  let sends = 0,
    reads = 0,
    unavailable = false;
  const transitions = [];
  const kernel = createAgentKernel({
    mode: "TEST_ONLY_NO_REAL_VALUE",
    store: {
      claim: async () => structuredClone(row),
      release: async () => {},
      transition: async (id, version, patch) => {
        assert.equal(id, row.id);
        assert.equal(version, row.version);
        if (refuseStart && patch.state === "STARTED")
          throw Error("DURABLE_CAS_REFUSED");
        transitions.push(patch.state);
        row = { ...row, ...patch, version: version + 1 };
        return structuredClone(row);
      },
    },
    mintAuthority: async () => {
      reads++;
      if (unavailable) throw Error("SOURCE_UNAVAILABLE");
      return { status: "EXCLUSIVE_AT_PINNED_BLOCK" };
    },
    observe: async () => ({}),
    authorize: async () => ({
      state: "AUTHORIZED_NOT_EXECUTED",
      intentDigest: "test-digest",
      stateVersion: "v1",
    }),
    execute: async () => {
      assert.equal(row.state, "STARTED");
      sends++;
      if (loseResponse) throw Error("RESPONSE_LOST");
      return { transactionHash: "test-only-hash" };
    },
    verify: async () => ({ state: "CONFIRMED" }),
    reconcile: async () => ({
      state: "SETTLED",
      canonical: true,
      accountingMatches: true,
    }),
  });
  return {
    run: () => kernel(request),
    stats: () => ({ sends, reads, transitions }),
    outage: () => {
      unavailable = true;
    },
  };
}
test("authorized path durably starts then executes, verifies and settles exactly once", async () => {
  const f = fixture();
  assert.equal((await f.run()).state, "SETTLED");
  assert.deepEqual(f.stats().transitions, [
    "PREPARED",
    "STARTED",
    "SUBMITTED",
    "CONFIRMED",
    "SETTLED",
  ]);
  assert.equal((await f.run()).state, "SETTLED");
  assert.equal(f.stats().sends, 1);
});
test("lost execute response recovers without source access or duplicate execution", async () => {
  const f = fixture({ loseResponse: true });
  assert.equal((await f.run()).state, "SAFE_DEGRADED");
  f.outage();
  assert.equal((await f.run()).state, "SETTLED");
  assert.equal(f.stats().sends, 1);
  assert.equal(f.stats().reads, 1);
});
test("unconfirmed STARTED persistence forbids executor dispatch", async () => {
  const f = fixture({ refuseStart: true });
  assert.equal((await f.run()).state, "SAFE_DEGRADED");
  assert.equal(f.stats().sends, 0);
});
