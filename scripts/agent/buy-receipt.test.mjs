import test from "node:test";
import assert from "node:assert/strict";
import { createBuyReceiptVerifier } from "./buy-receipt.mjs";

const address = (byte) => `0x${byte.repeat(40)}`;
const digest = (byte) => `0x${byte.repeat(64)}`;
const market = address("1"),
  nft = address("2"),
  payment = address("3"),
  grounding = address("4"),
  buyer = address("5"),
  seller = address("6"),
  transactionHash = digest("a"),
  blockHash = digest("b"),
  runtimeCodeHash = digest("c"),
  nftCodeHash = digest("d"),
  paymentCodeHash = digest("e"),
  groundingCodeHash = digest("f"),
  buyerSignature = `0x${"11".repeat(65)}`,
  sellerSignature = `0x${"22".repeat(65)}`;

const intent = Object.freeze({ wallet: buyer, principal: buyer, nonce: "1" });
const sale = Object.freeze({
  seller,
  buyer,
  recipient: buyer,
  nft,
  tokenId: "7",
  paymentToken: payment,
  price: "10",
  validFrom: "0",
  validUntil: "100",
  nonce: "1",
});

class TestInterface {
  constructor(abi) {
    this.abi = abi.join("\n");
  }
  encodeFunctionData() {
    return "0x1234";
  }
  parseLog(log) {
    if (this.abi.includes("BoundedBuySettled") && log.kind === "settlement")
      return { args: log.args };
    if (this.abi.includes("indexed tokenId") && log.kind === "nft-transfer")
      return { args: log.args };
    if (this.abi.includes("uint256 value") && log.kind === "payment-transfer")
      return { args: log.args };
    return null;
  }
}

const ethers = Object.freeze({
  isAddress: (value) => /^0x[0-9a-fA-F]{40}$/.test(value ?? ""),
  Interface: TestInterface,
  TypedDataEncoder: {
    hash: (_domain, types) =>
      Object.hasOwn(types, "BoundedIntent") ? digest("7") : digest("8"),
  },
  verifyTypedData: (_domain, types, _value, signature) => {
    if (Object.hasOwn(types, "BoundedIntent") && signature === buyerSignature)
      return buyer;
    if (Object.hasOwn(types, "FixedNFTSale") && signature === sellerSignature)
      return seller;
    throw Error("INVALID_TEST_SIGNATURE");
  },
  keccak256: (code) =>
    ({
      "0x01": runtimeCodeHash,
      "0x02": nftCodeHash,
      "0x03": paymentCodeHash,
      "0x04": groundingCodeHash,
    })[code] ?? digest("0"),
});

const deploymentTrust = Object.freeze({
  mode: "TEST_ONLY_NO_REAL_VALUE",
  accountingPolicy: "TEST_ONLY_ARTFI_RWA_BUY_TOKEN_POSTCONDITIONS_V1",
  reviewEvidenceSha256: "1".repeat(64),
  executorSourceSha256:
    "8716AC88F23FB734F21A3FF69F4C404743CCA0A4A9C7B4DAA525C3BEE8A71D80",
  proxyOrUpgradeAllowed: false,
  executor: { address: market, runtimeCodeHash },
  nft: { address: nft, runtimeCodeHash: nftCodeHash },
  payment: { address: payment, runtimeCodeHash: paymentCodeHash },
  grounding: { address: grounding, runtimeCodeHash: groundingCodeHash },
});

function fixture(change = {}) {
  const logs = [
    {
      address: payment,
      kind: "payment-transfer",
      args: { from: buyer, to: seller, value: 10n },
      index: 1,
    },
    {
      address: nft,
      kind: "nft-transfer",
      args: { from: seller, to: buyer, tokenId: 7n },
      index: 2,
    },
    {
      address: market,
      kind: "settlement",
      args: {
        intentDigest: digest("7"),
        saleDigest: digest("8"),
        buyer,
        seller,
        nft,
        tokenId: 7n,
        paymentToken: payment,
        price: 10n,
      },
      index: 3,
    },
  ].map((log) => ({
    ...log,
    removed: false,
    transactionHash,
    blockHash,
    blockNumber: 10,
  }));
  const receipt = {
    status: 1,
    hash: transactionHash,
    to: market,
    from: buyer,
    blockHash,
    blockNumber: 10,
    logs,
    ...change.receipt,
  };
  const transaction = {
    hash: transactionHash,
    to: market,
    from: buyer,
    blockHash,
    blockNumber: 10,
    chainId: 560048n,
    value: 0n,
    data: "0x1234",
    ...change.transaction,
  };
  const code = new Map([
    [market, "0x01"],
    [nft, "0x02"],
    [payment, "0x03"],
    [grounding, "0x04"],
  ]);
  return {
    input: {
      transactionHash,
      intent,
      buyerSignature,
      sale,
      sellerSignature,
    },
    verifier: createBuyReceiptVerifier({
      ethers,
      market,
      runtimeCodeHash,
      marketABI: ["function buy()"],
      deploymentTrust,
      client: {
        getNetwork: async () => ({ chainId: 560048n }),
        getTransactionReceipt: async () => receipt,
        getTransaction: async () => transaction,
        getBlock: async (number) =>
          number === "finalized"
            ? { number: 12, hash: digest("9") }
            : { number: 10, hash: blockHash },
        getCode: async (target) => change.code?.get(target) ?? code.get(target),
        readExecutorBindings: async () => ({
          collection: nft,
          payment,
          grounding,
          ...change.bindings,
        }),
      },
    }),
  };
}

test("buy receipt binds exact canonical call, code, events, ordering and accounting", async () => {
  const f = fixture();
  const result = await f.verifier(f.input);
  assert.equal(result.state, "CONFIRMED");
  assert.equal(result.canonical, true);
  assert.equal(result.accountingMatches, true);
  assert.equal(result.binding.transactionHash, transactionHash);
  assert.equal(result.binding.blockHash, blockHash);
  assert.equal(result.binding.tokenId, "7");
});

test("buy receipt rejects calldata drift before accepting emitted events", async () => {
  const f = fixture({ transaction: { data: "0x5678" } });
  assert.deepEqual(await f.verifier(f.input), {
    state: "UNKNOWN",
    canonical: false,
    accountingMatches: false,
    reason: "BUY_CALLDATA_MISMATCH",
  });
});

test("buy receipt rejects incomplete logs and dependency-code drift", async () => {
  const changed = fixture({ code: new Map([[nft, "0x01"]]) });
  assert.equal(
    (await changed.verifier(changed.input)).reason,
    "BUY_DEPENDENCY_CODE_MISMATCH",
  );
  const missingLogs = fixture({ receipt: { logs: undefined } });
  assert.equal(
    (await missingLogs.verifier(missingLogs.input)).reason,
    "BUY_RECEIPT_INVALID",
  );
});
