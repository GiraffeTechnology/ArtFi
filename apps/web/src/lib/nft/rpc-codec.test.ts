import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Interface,
  JsonRpcProvider,
  type JsonRpcPayload,
  type JsonRpcResult,
} from "ethers";
import { SeaportABI } from "@opensea/seaport-js/lib/abi/Seaport";
import { ReadOnlyNftProvider } from "./recorder";
import { reconcileNftOperationWithContext } from "./engine";
import { SEAPORT } from "./config";
import type { NftOperation } from "./journal";
import type { NftEngineContext } from "./engine";
const account = "0x1111111111111111111111111111111111111111",
  hash = `0x${"22".repeat(32)}`,
  blockHash = `0x${"33".repeat(32)}`,
  otherHash = `0x${"44".repeat(32)}`,
  orderHash = `0x${"11".repeat(32)}` as const;
const event = new Interface(SeaportABI).encodeEventLog("OrderFulfilled", [
  orderHash,
  account,
  "0x" + "00".repeat(20),
  account,
  [],
  [],
]);
type Mode =
  | "normal"
  | "tx-hash"
  | "receipt-hash"
  | "reorg"
  | "shallow"
  | "reverted"
  | "removed"
  | "chain-change"
  | "missing";
class FixtureProvider extends ReadOnlyNftProvider {
  readonly methods: string[] = [];
  blockReads = 0;
  chainReads = 0;
  constructor(readonly mode: Mode) {
    super("http://127.0.0.1:1", undefined, {
      batchMaxCount: 1,
      cacheTimeout: -1,
    });
  }
  // TEST_ONLY transport seam: real ethers request/response codecs, no sockets or keys.
  async fixtureSend(
    input: JsonRpcPayload | JsonRpcPayload[],
  ): Promise<JsonRpcResult[]> {
    return (Array.isArray(input) ? input : [input]).map((payload) => {
      this.methods.push(payload.method);
      let result: unknown;
      if (payload.method === "eth_chainId")
        result =
          this.mode === "chain-change" && ++this.chainReads > 1
            ? "0x2105"
            : "0x1";
      else if (payload.method === "eth_blockNumber")
        result = this.mode === "shallow" ? "0x64" : "0x65";
      else if (payload.method === "eth_getTransactionByHash")
        result = {
          hash: this.mode === "tx-hash" ? otherHash : hash,
          type: "0x0",
          blockHash,
          blockNumber: "0x64",
          transactionIndex: "0x0",
          from: account,
          to: SEAPORT,
          gas: "0x5208",
          gasPrice: "0x1",
          value: "0x64",
          nonce: "0x1",
          input: "0x1234",
          chainId: "0x1",
          v: "0x25",
          r: "0x" + "01".padStart(64, "0"),
          s: "0x" + "02".padStart(64, "0"),
        };
      else if (payload.method === "eth_getTransactionReceipt")
        result =
          this.mode === "missing"
            ? null
            : {
                transactionHash:
                  this.mode === "receipt-hash" ? otherHash : hash,
                blockHash,
                blockNumber: "0x64",
                transactionIndex: "0x0",
                from: account,
                to: SEAPORT,
                cumulativeGasUsed: "0x5208",
                gasUsed: "0x5208",
                effectiveGasPrice: "0x1",
                contractAddress: null,
                logsBloom: "0x" + "00".repeat(256),
                status: this.mode === "reverted" ? "0x0" : "0x1",
                type: "0x0",
                logs:
                  this.mode === "reverted"
                    ? []
                    : [
                        {
                          address: SEAPORT,
                          topics: event.topics,
                          data: event.data,
                          blockHash,
                          blockNumber: "0x64",
                          transactionHash: hash,
                          transactionIndex: "0x0",
                          logIndex: "0x0",
                          removed: this.mode === "removed",
                        },
                      ],
              };
      else if (payload.method === "eth_getBlockByNumber")
        result = {
          hash:
            this.mode === "reorg" && ++this.blockReads > 1
              ? otherHash
              : blockHash,
          number: "0x64",
          parentHash: "0x" + "55".repeat(32),
          timestamp: "0x65000000",
          nonce: "0x0000000000000000",
          difficulty: "0x1",
          gasLimit: "0x1c9c380",
          gasUsed: "0x5208",
          miner: account,
          extraData: "0x",
          baseFeePerGas: "0x1",
          transactions: [hash],
        };
      else throw Error("TEST_ONLY unexpected RPC method " + payload.method);
      return { id: payload.id, result };
    });
  }
}
function operation(status = "pending"): NftOperation {
  const plan: NftOperation["plan"] = {
    id: "TEST_ONLY-plan",
    operationId: "TEST_ONLY-operation",
    sessionId: "TEST_ONLY-session",
    chainId: 1,
    scope: {
      slug: "test-only-digital",
      chain: "ethereum",
      contract: "0x2222222222222222222222222222222222222222",
      standard: "erc1155",
      label: "TEST_ONLY",
      charity: false,
    },
    request: {
      action: "buy",
      collection: "test-only-digital",
      tokenId: "7",
      account,
      quantity: "1",
      priceWei: "100",
      expiresAt: 0,
      orderHash,
    },
    kind: "transaction",
    transaction: { to: SEAPORT, data: "0x1234", value: "100" },
    orderHash,
    expiresAt: Date.now() + 60000,
    summary: "TEST_ONLY codec response, no actual transaction",
    fees: [],
  };
  return {
    id: plan.operationId,
    wallet: account,
    chainId: 1,
    requestHash: "a".repeat(64),
    revision: 1,
    status,
    walletStarted: true,
    plan,
    transactionHash: hash,
    updatedAt: new Date().toISOString(),
  };
}
afterEach(() => vi.restoreAllMocks());
function setup(mode: Mode) {
  vi.spyOn(JsonRpcProvider.prototype, "_send").mockImplementation(function (
    this: JsonRpcProvider,
    payload,
  ) {
    return (this as FixtureProvider).fixtureSend(payload);
  });
  const provider = new FixtureProvider(mode),
    updates: NftOperation[] = [];
  const context: Pick<NftEngineContext, "provider" | "api" | "journal"> = {
    provider: () => provider,
    api: () => {
      throw Error("TEST_ONLY venue requests prohibited");
    },
    journal: async (_action, row) => {
      const next = {
        ...row,
        revision: (row.revision || 0) + 1,
      } as NftOperation;
      updates.push(structuredClone(next));
      return next;
    },
  };
  return { provider, updates, context };
}
describe("native NFT receipt through real ethers JSON-RPC codecs", () => {
  it("decodes the original transaction/receipt/block and confirms only matching canonical evidence", async () => {
    const f = setup("normal");
    const result = await reconcileNftOperationWithContext(
      operation(),
      f.context,
    );
    expect(result.status).toBe("confirmed");
    expect(result.transactionHash).toBe(hash);
    expect(f.updates.map((x) => x.status)).toEqual(["confirmed"]);
    expect(f.provider.methods).toContain("eth_getTransactionReceipt");
    expect(
      f.provider.methods.filter((x) => x === "eth_getBlockByNumber"),
    ).toHaveLength(2);
    expect(f.provider.methods.some((x) => /send|sign|broadcast/i.test(x))).toBe(
      false,
    );
  });
  it.each(["tx-hash", "receipt-hash", "removed"] as const)(
    "rejects decoded %s evidence without confirming",
    async (mode) => {
      const f = setup(mode);
      await expect(
        reconcileNftOperationWithContext(operation(), f.context),
      ).rejects.toThrow();
      expect(f.updates).toEqual([]);
    },
  );
  it.each(["shallow", "missing", "reorg"] as const)(
    "retains pending for decoded %s observations",
    async (mode) => {
      const f = setup(mode);
      expect(
        (await reconcileNftOperationWithContext(operation(), f.context)).status,
      ).toBe("pending");
      expect(f.updates).toEqual([]);
    },
  );
  it("decodes a reverted receipt as failed without asserting settlement", async () => {
    const f = setup("reverted");
    expect(
      (await reconcileNftOperationWithContext(operation(), f.context)).status,
    ).toBe("failed");
    expect(f.updates.map((x) => x.status)).toEqual(["failed"]);
  });
  it("an actual ethers network-change error cannot publish a confirmation", async () => {
    const f = setup("chain-change");
    await expect(
      reconcileNftOperationWithContext(operation(), f.context),
    ).rejects.toThrow();
    expect(f.updates).toEqual([]);
  });
  it("a decoded final reorg demotes the earlier confirmed journal record", async () => {
    const f = setup("reorg");
    expect(
      (
        await reconcileNftOperationWithContext(
          operation("confirmed"),
          f.context,
        )
      ).status,
    ).toBe("pending");
    expect(f.updates.map((x) => x.status)).toEqual(["pending"]);
  });
});
