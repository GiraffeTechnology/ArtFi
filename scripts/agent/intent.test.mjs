import test from "node:test";
import assert from "node:assert/strict";
import { createAgentService } from "./agent-service.mjs";
import { createIntentAuthorizer } from "./bounded-intent.mjs";

const address = (byte) => `0x${byte.repeat(40)}`;
const digest = (byte) => `0x${byte.repeat(64)}`;
const buyer = address("1"),
  seller = address("2"),
  executor = address("3"),
  venue = address("4"),
  collection = address("5"),
  paymentToken = address("6"),
  assetScope = digest("a"),
  buyerSignature = `0x${"11".repeat(65)}`,
  sellerSignature = `0x${"22".repeat(65)}`;

const ethers = Object.freeze({
  ZeroAddress: address("0"),
  ZeroHash: digest("0"),
  isAddress: (value) => /^0x[0-9a-fA-F]{40}$/.test(value ?? ""),
  getAddress(value) {
    if (!this.isAddress(value)) throw Error("INVALID_TEST_ADDRESS");
    return value.toLowerCase();
  },
  verifyTypedData(_domain, _types, _value, signature) {
    if (signature === buyerSignature) return buyer;
    if (signature === sellerSignature) return seller;
    throw Error("INVALID_TEST_SIGNATURE");
  },
  AbiCoder: {
    defaultAbiCoder: () => ({
      encode: (_types, values) =>
        JSON.stringify(values, (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
    }),
  },
  keccak256: () => assetScope,
  TypedDataEncoder: { hash: () => digest("b") },
});

const policy = Object.freeze({
  chainId: "560048",
  executor,
  collection,
  paymentToken,
  venue,
  counterparties: [seller],
  allowedCounterpartyPolicy: digest("c"),
  allowedVenuePolicy: digest("d"),
  jurisdictionPolicy: digest("e"),
  settlementPolicy: digest("f"),
});

const intent = Object.freeze({
  intentId: digest("7"),
  principal: buyer,
  wallet: buyer,
  assetScope,
  actionScope: "1",
  maxUnitPrice: "10",
  minUnitPrice: "10",
  maxTransactionValue: "10",
  maxAggregateExposure: "20",
  maxExecutions: "1",
  maxOpenOrders: "0",
  validFrom: "0",
  validUntil: "100",
  allowedCounterpartyPolicy: policy.allowedCounterpartyPolicy,
  allowedVenuePolicy: policy.allowedVenuePolicy,
  jurisdictionPolicy: policy.jurisdictionPolicy,
  slippageLimit: "0",
  settlementPolicy: policy.settlementPolicy,
  nonce: "1",
  revocationRef: digest("8"),
});

const sale = Object.freeze({
  seller,
  buyer,
  recipient: buyer,
  nft: collection,
  tokenId: "7",
  paymentToken,
  price: "10",
  validFrom: "0",
  validUntil: "100",
  nonce: "1",
});

const domain = Object.freeze({
  name: "ArtFi Bounded Intent",
  version: "1",
  chainId: "560048",
  verifyingContract: executor,
});

const plan = Object.freeze({
  operationId: intent.intentId,
  mode: "TEST_ONLY_NO_REAL_VALUE",
  domain,
  intent,
  asset: { chainId: "560048", contract: collection, tokenId: "7" },
  sale,
  sellerSignature,
  signature: buyerSignature,
});

const observation = Object.freeze({
  available: true,
  current: true,
  revoked: false,
  groundingCurrent: true,
  assetRestricted: false,
  version: "observation-1",
  executions: "0",
  aggregateExposure: "0",
  openOrders: "0",
});

function serviceOptions(overrides = {}) {
  let prepared;
  const options = {
    mode: "TEST_ONLY_NO_REAL_VALUE",
    ethers,
    policy,
    clock: () => 1000,
    planFor: async () => structuredClone(plan),
    observe: async () => structuredClone(observation),
    inspectRevocation: async () => {
      throw Error("UNUSED");
    },
    store: {
      prepare: async (request) => {
        prepared = structuredClone(request);
        return {
          id: request.operationId,
          state: "PREPARED",
          request: prepared,
        };
      },
      get: async () => null,
      noteRevocation: async () => {
        throw Error("UNUSED");
      },
    },
    ...overrides,
  };
  return { options, prepared: () => prepared };
}

test("service injects its fixed TEST_ONLY mode and authorizes the exact signed BUY policy", async () => {
  const fixture = serviceOptions();
  const service = createAgentService(fixture.options);
  const result = await service.createIntent(
    { authenticated: true, wallet: buyer, expiresAt: 2000 },
    plan,
  );
  assert.deepEqual(result, {
    id: intent.intentId,
    state: "PREPARED",
    existing: false,
  });
  assert.equal(fixture.prepared().authorityVersion, observation.version);
  assert.equal(fixture.prepared().execution.executor, executor);
});

test("service rejects incomplete or ambiguous policy before any adapter call", () => {
  for (const badPolicy of [
    { ...policy, executor: address("0") },
    { ...policy, venue: "invalid" },
    { ...policy, counterparties: [] },
    { ...policy, allowedVenuePolicy: digest("0") },
    { ...policy, mode: "PRODUCTION" },
  ]) {
    const fixture = serviceOptions({ policy: badPolicy });
    assert.throws(
      () => createAgentService(fixture.options),
      /SERVICE_POLICY_INVALID/,
    );
    assert.equal(fixture.prepared(), undefined);
  }
});

test("authorizer fails closed on missing input and signed requests outside policy or exposure", () => {
  const authorize = createIntentAuthorizer({
    ethers,
    policy: { ...policy, mode: "TEST_ONLY_NO_REAL_VALUE" },
    readState: () => structuredClone(observation),
    clock: () => 1,
  });
  const proposal = {
    action: "BUY",
    opensOrder: false,
    counterparty: seller,
    venue,
    contract: collection,
    tokenId: "7",
    unitPrice: "10",
    quantity: "1",
    value: "10",
    quotedUnitPrice: "10",
  };
  assert.throws(() => authorize(), /INTENT_SHAPE_INVALID/);
  assert.throws(
    () =>
      authorize({
        intent: { ...intent, allowedVenuePolicy: digest("9") },
        signature: buyerSignature,
        proposal,
      }),
    /POLICY_UNSUPPORTED/,
  );
  const exposed = createIntentAuthorizer({
    ethers,
    policy: { ...policy, mode: "TEST_ONLY_NO_REAL_VALUE" },
    readState: () => ({ ...observation, aggregateExposure: "11" }),
    clock: () => 1,
  });
  assert.throws(
    () => exposed({ intent, signature: buyerSignature, proposal }),
    /EXPOSURE_EXCEEDED/,
  );
});
