import test from "node:test";
import assert from "node:assert/strict";
import { createAgentService } from "./agent-service.mjs";

const address = "0x" + "ab".repeat(20);
const hash = "0x" + "12".repeat(32);
function fixture(inspect) {
  const row = {
    id: "test",
    state: "PREPARED",
    revocation: { state: "PENDING", transactionHash: hash },
    request: {
      execution: { chainId: "560048", executor: address },
      intent: { wallet: address, nonce: "1" },
      sale: { nft: address, tokenId: "1" },
    },
  };
  const writes = [];
  let observationCalls = 0;
  const ethers = {
    ZeroAddress: "0x" + "00".repeat(20),
    ZeroHash: "0x" + "00".repeat(32),
    isAddress: (value) => /^0x[0-9a-fA-F]{40}$/.test(value),
    getAddress: (value) => value.toLowerCase(),
    verifyTypedData() {
      throw Error("UNUSED");
    },
    AbiCoder: { defaultAbiCoder: () => ({}) },
    keccak256() {
      throw Error("UNUSED");
    },
    TypedDataEncoder: {
      hash() {
        throw Error("UNUSED");
      },
    },
  };
  const session = {
    authenticated: true,
    wallet: address,
    chainId: "560048",
    expiresAt: 2000,
  };
  const policy = {
    chainId: "560048",
    executor: address,
    collection: address,
    paymentToken: address,
    venue: address,
    counterparties: [address],
    allowedCounterpartyPolicy: hash,
    allowedVenuePolicy: hash,
    jurisdictionPolicy: hash,
    settlementPolicy: hash,
  };
  const proof = {
    transactionHash: hash,
    wallet: address,
    nonce: "1",
    executor: address,
    chainId: "560048",
    state: "CONFIRMED",
    canonical: true,
  };
  const service = createAgentService({
    mode: "TEST_ONLY_NO_REAL_VALUE",
    ethers,
    policy,
    clock: () => 1000,
    sourceObservationTimeoutMs: 20,
    observe: async () => {
      observationCalls++;
      return { available: false, current: false, observedAt: 1000 };
    },
    planFor: async () => {
      throw Error("UNUSED");
    },
    store: {
      prepare: async () => {
        throw Error("UNUSED");
      },
      get: async () => row,
      noteRevocation: async (id, wallet, value) => {
        writes.push({ id, wallet, value });
        row.revocation = structuredClone(value);
        return row;
      },
    },
    inspectRevocation: inspect,
  });
  return {
    row,
    writes,
    proof,
    session,
    service,
    observations: () => observationCalls,
  };
}
async function boundedRead(f) {
  let timer;
  try {
    return await Promise.race([
      f.service.getIntent(f.session, "test"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("READ_STILL_HANGING")), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
test("hanging revocation inspection preserves the pending record and durable status", async () => {
  let signal;
  const f = fixture(async (_request, _hash, value) => {
    signal = value;
    return new Promise(() => {});
  });
  const original = structuredClone(f.row.revocation);
  const result = await boundedRead(f);
  assert.equal(result.execution.state, "PREPARED");
  assert.equal(result.revocation.state, "PENDING");
  assert.equal(result.fresh, false);
  assert.equal(f.observations(), 1);
  assert.deepEqual(f.row.revocation, original);
  assert.equal(f.writes.length, 0);
  assert.equal(signal.aborted, true);
});
test("a late confirmed inspection cannot write after the read timeout", async () => {
  let resolveProof;
  const f = fixture(
    async () =>
      new Promise((resolve) => {
        resolveProof = resolve;
      }),
  );
  const result = await boundedRead(f);
  assert.equal(result.revocation.state, "PENDING");
  resolveProof(f.proof);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.writes.length, 0);
  assert.equal(f.row.revocation.state, "PENDING");
  assert.equal(f.observations(), 1);
});
test("a timely canonical revocation remains recorded exactly once", async () => {
  let f;
  f = fixture(async () => f.proof);
  const result = await boundedRead(f);
  assert.equal(result.revocation.state, "CONFIRMED");
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].id, "test");
  assert.equal(f.writes[0].wallet, address);
  assert.deepEqual(f.writes[0].value, f.proof);
  assert.equal((await boundedRead(f)).revocation.state, "CONFIRMED");
  assert.equal(f.writes.length, 1);
});
