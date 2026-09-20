import test from "node:test";
import assert from "node:assert/strict";
import { createAgentService } from "./agent-service.mjs";
import { createOracleObservation } from "./oracle-observation.mjs";
const address = "0x" + "ab".repeat(20),
  hash = "0x" + "12".repeat(32),
  mixedCaseRevocationHash = "0x" + "aB".repeat(32);
const ethers = {
  ZeroAddress: "0x" + "00".repeat(20),
  ZeroHash: "0x" + "00".repeat(32),
  isAddress: (value) => /^0x[0-9a-fA-F]{40}$/.test(value),
  getAddress: (value) => value.toLowerCase(),
  verifyTypedData: () => {
    throw Error("CRYPTO_OUTSIDE_SOURCE_OUTAGE_TEST");
  },
  AbiCoder: { defaultAbiCoder: () => ({}) },
  keccak256: () => {
    throw Error("CRYPTO_OUTSIDE_SOURCE_OUTAGE_TEST");
  },
  TypedDataEncoder: {
    hash: () => {
      throw Error("CRYPTO_OUTSIDE_SOURCE_OUTAGE_TEST");
    },
  },
};
const policy = Object.freeze({
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
});
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
      ethers,
      policy,
      clock: () => 1000,
      sourceObservationTimeoutMs: 20,
      observe: createOracleObservation({
        mode: "TEST_ONLY_NO_REAL_VALUE",
        observe,
        resolveRequiredAttestation: async () => ({
          attestation: { envelope: { attestationId: "fixture-attestation-1" } },
          expectedSubject: {
            assetId: "fixture",
            chainId: "560048",
            contract: address,
            tokenId: "1",
            purpose: "fixture-required-flow",
          },
        }),
        attestationService: { verify() {} },
        verifyOracleAttestation: async () => ({ valid: true, errorCode: null }),
      }),
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
      inspectRevocation: async (_request, transactionHash) => {
        proofs++;
        assert.equal(transactionHash, mixedCaseRevocationHash.toLowerCase());
        return {
          transactionHash: mixedCaseRevocationHash,
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
    await assert.rejects(
      service.recordRevocation(
        session,
        "test",
        "0x" + "00".repeat(32),
      ),
      /REVOCATION_HASH_INVALID/,
    );
    assert.equal(proofs, 0);
    assert.equal(
      (await service.recordRevocation(session, "test", mixedCaseRevocationHash))
        .state,
      "CONFIRMED",
    );
    assert.equal(
      row.revocation.transactionHash,
      mixedCaseRevocationHash.toLowerCase(),
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
