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
    async () => ({ availa