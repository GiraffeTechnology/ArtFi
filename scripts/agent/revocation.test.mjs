import test from "node:test";
import assert from "node:assert/strict";
import { createAgentKernel, kernelRequestDigest } from "./agent-kernel.mjs";
const wallet = "0x" + "ab".repeat(20),
  executor = "0x" + "cd".repeat(20);
const request = {
  operationId: "revoke-test",
  intent: { wallet, nonce: "7" },
  execution: { chainId: "560048", executor },
};
const proof = {
  state: "CONFIRMED",
  canonical: true,
  transactionHash: "0x" + "12".repeat(32),
  wallet,
  executor,
  chainId: "560048",
  nonce: "7",
};
function fixture(revocation, state = "PREPARED", failCAS = false) {
  let row = {
    id: request.operationId,
    request,
    requestDigest: kernelRequestDigest(request),
    state,
    version: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: Date.now() + 60000,
    revocation,
  };
  let authority = 0,
    sends = 0,
    releases = 0;
  const unused = async () => {
    throw Error("UNEXPECTED_CALL");
  };
  const kernel = createAgentKernel({
    mode: "TEST_ONLY_NO_REAL_VALUE",
    store: {
      leaseDurationMs: 60000,
      operationTimeoutMs: 1000,
      claim: async () => structuredClone(row),
      renew: async () => {
        row = { ...row, leaseExpiresAt: row.leaseExpiresAt + 60000 };
        return structuredClone(row);
      },
      transition: async (id, version, patch) => {
        assert.equal(version, row.version);
        if (failCAS) throw Error("DURABLE_CAS_REFUSED");
        row = { ...row, ...patch, version: version + 1 };
        return structuredClone(row);
      },
      release: async () => {
        releases++;
      },
    },
    mintAuthority: async () => {
      authority++;
      throw Error("READER_UNAVAILABLE");
    },
    authorize: unused,
    observe: unused,
    execute: async () => {
      sends++;
    },
    verify: unused,
    reconcile: async () => ({
      state: "SETTLED",
      canonical: true,
      accountingMatches: true,
    }),
  });
  return {
    run: () => kernel(request),
    row: () => row,
    counts: () => ({ authority, sends, releases }),
  };
}
test("confirmed exact revocation terminates PREPARED despite reader outage; retry stays terminal", async () => {
  const f = fixture(proof);
  assert.equal((await f.run()).reason, "INTENT_REVOKED");
  assert.equal((await f.run()).state, "TERMINAL_REJECTED");
  assert.deepEqual(f.counts(), { authority: 0, sends: 0, releases: 2 });
});
test("pending, noncanonical and identity-drift evidence cannot permanently terminate", async () => {
  for (const change of [
    { state: "PENDING" },
    { canonical: false },
    { transactionHash: "bad" },
    { transactionHash: "0x" + "00".repeat(32) },
    { wallet: executor },
    { executor: wallet },
    { chainId: "1" },
    { nonce: "8" },
  ]) {
    const f = fixture({ ...proof, ...change });
    assert.equal((await f.run()).state, "SAFE_DEGRADED");
    assert.equal(f.row().state, "PREPARED");
    assert.equal(f.counts().sends, 0);
  }
});
test("already STARTED must reconcile, never use later revocation to erase outcome", async () => {
  const f = fixture(proof, "STARTED");
  assert.equal((await f.run()).state, "SETTLED");
  assert.equal(f.counts().sends, 0);
  assert.equal(f.counts().authority, 0);
});
test("failed terminal CAS cannot claim a durable terminal result", async () => {
  const f = fixture(proof, "PREPARED", true);
  const result = await f.run();
  assert.equal(result.state, "SAFE_DEGRADED");
  assert.equal(f.row().state, "PREPARED");
  assert.equal(f.counts().sends, 0);
});
