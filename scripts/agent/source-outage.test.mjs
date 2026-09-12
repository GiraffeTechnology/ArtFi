import test from "node:test";
import assert from "node:assert/strict";
import { createAgentService } from "./agent-service.mjs";
const address = "0x" + "ab".repeat(20),
  hash = "0x" + "12".repeat(32);
const session = { authenticated: true, wallet: address, expiresAt: 2000 };
test("source throw/unavailable/stale preserves owned durable read and independently verified revoke", async () => {
  for (const observe of [
    async () => {
      throw Error("SOURCE_OFFLINE");
    },
    async () => ({ available: false, current: false, observedAt: 1 }),
    async () => ({ available: true, current: false, observedAt: 1 }),
    async () => new Promise(() => {}),
  ]) {
    const row = {
      id: "test",
      state: "PREPARED",
      request: {
        intent: { wallet: address, nonce: "1" },
        sale: { nft: address, tokenId: "1" },
      },
    };
    let proofs = 0;
    const service = createAgentService({
      mode: "TEST_ONLY_NO_REAL_VALUE",
      ethers: { isAddress: () => true, getAddress: (x) => x },
      policy: {
        chainId: "560048",
        executor: address,
        collection: address,
        paymentToken: address,
      },
      clock: () => 1000,
      sourceObservationTimeoutMs: 20,
      observe,
      planFor: async () => {
        throw Error("UNUSED");
      },
      store: {
        prepare: async () => {
          throw Error("UNUSED");
        },
        get: async () => row,
        noteRevocation: async (id, wallet, proof) => {
          row.revocation = proof;
          return row;
        },
      },
      inspectRevocation: async () => {
        proofs++;
        return {
          transactionHash: hash,
          wallet: address,
          nonce: "1",
          executor: address,
          chainId: "560048",
          state: "CONFIRMED",
          canonical: true,
        };
      },
    });
    let timer;
    const before = await Promise.race([
      service.getIntent(session, "test"),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), 200);
      }),
    ]);
    clearTimeout(timer);
    assert.equal(
      before.timeout,
      undefined,
      "source must not indefinitely block durable read",
    );
    assert.equal(before.fresh, false);
    assert.equal(before.execution.state, "PREPARED");
    assert.equal(
      (await service.recordRevocation(session, "test", hash)).state,
      "CONFIRMED",
    );
    assert.equal(
      (await service.getIntent(session, "test")).revocation.state,
      "CONFIRMED",
    );
    assert.equal(proofs, 1);
    await assert.rejects(
      service.getIntent({ ...session, authenticated: false }, "test"),
      /AUTHENTICATED_SESSION_REQUIRED/,
    );
  }
});
