import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Interface } from "ethers";
import { SeaportABI } from "@opensea/seaport-js/lib/abi/Seaport";
import { reconcileNftOperation, recordNftTransaction } from "./engine";
import { SEAPORT } from "./config";
import type { NftOperation } from "./journal";
import type { NftPlan, NftScope } from "./model";
import type { UserSession } from "../user-auth";
const state = vi.hoisted(() => ({
  tx: null as unknown,
  receipt: null as unknown,
  block: null as unknown,
  blockNumber: 101,
  chainId: 1,
  networkReads: 0,
  blockReads: 0,
  changeBlockAfterFirst: false,
  changeChainAfterFirst: false,
  updates: [] as unknown[],
}));
vi.mock("./recorder", () => ({
  NftPlanRecorder: class {},
  ReadOnlyNftProvider: class {
    async getNetwork() {
      return {
        chainId: BigInt(
          state.changeChainAfterFirst && ++state.networkReads > 1
            ? 8453
            : state.chainId,
        ),
      };
    }
    async getTransaction() {
      return state.tx;
    }
    async getTransactionReceipt() {
      return state.receipt;
    }
    async getBlock() {
      return state.changeBlockAfterFirst && ++state.blockReads > 1
        ? { number: 100, hash: `0x${"4".repeat(64)}` }
        : state.block;
    }
    async getBlockNumber() {
      return state.blockNumber;
    }
    destroy() {}
  },
}));
vi.mock("./journal", async (original) => ({
  ...(await original<typeof import("./journal")>()),
  nftJournal: async (_action: string, operation: NftOperation) => {
    state.updates.push(structuredClone(operation));
    return { ...operation, revision: operation.revision + 1 };
  },
}));
const wallet = "0x1111111111111111111111111111111111111111";
const orderHash = `0x${"1".repeat(64)}` as const,
  hash = `0x${"2".repeat(64)}` as const,
  blockHash = `0x${"3".repeat(64)}` as const;
const scope: NftScope = {
  slug: "isolated-digital",
  chain: "ethereum",
  contract: "0x2222222222222222222222222222222222222222",
  standard: "erc1155",
  label: "Isolated",
  charity: true,
};
const abi = new Interface(SeaportABI);
function event(expectedHash = orderHash, recipient = wallet) {
  const log = abi.encodeEventLog(abi.getEvent("OrderFulfilled")!, [
    expectedHash,
    wallet,
    "0x0000000000000000000000000000000000000000",
    recipient,
    [],
    [],
  ]);
  return {
    address: SEAPORT,
    topics: log.topics,
    data: log.data,
    transactionHash: hash,
    blockHash,
    blockNumber: 100,
  };
}
function operation(): NftOperation {
  const plan: NftPlan = {
    id: "plan-isolated",
    operationId: "operation-isolated-1",
    sessionId: "session-1",
    chainId: 1,
    request: {
      action: "buy",
      collection: scope.slug,
      tokenId: "7",
      account: wallet,
      quantity: "1",
      priceWei: "100",
      expiresAt: 0,
      orderHash,
    },
    scope,
    expiresAt: Date.now() + 60000,
    kind: "transaction",
    summary: "Isolated test",
    orderHash,
    transaction: { to: SEAPORT, data: "0x1234", value: "100" },
    fees: [],
  };
  return {
    id: plan.operationId,
    wallet,
    chainId: 1,
    requestHash: "a".repeat(64),
    revision: 1,
    status: "pending",
    walletStarted: true,
    plan,
    transactionHash: hash,
    updatedAt: new Date().toISOString(),
  };
}
const session: UserSession = {
  id: "session-1",
  address: wallet,
  chainId: 1,
  expiresAt: Date.now() + 60000,
  accessExpiresAt: Date.now() + 60000,
};
beforeEach(() => {
  vi.stubEnv("ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE", "sin");
  vi.stubEnv("ARTFI_NFT_RPC_1", "http://127.0.0.1:1");
  state.chainId = 1;
  state.blockNumber = 101;
  state.updates = [];
  state.networkReads = 0;
  state.blockReads = 0;
  state.changeBlockAfterFirst = false;
  state.changeChainAfterFirst = false;
  state.tx = {
    hash,
    chainId: 1n,
    blockNumber: 100,
    blockHash,
    from: wallet,
    to: SEAPORT,
    data: "0x1234",
    value: 100n,
  };
  state.receipt = {
    hash,
    from: wallet,
    to: SEAPORT,
    blockNumber: 100,
    blockHash,
    status: 1,
    logs: [event()],
  };
  state.block = { number: 100, hash: blockHash };
});
afterEach(() => vi.unstubAllEnvs());
describe("NFT transaction receipts and recovery", () => {
  it("requires matching transaction, expected protocol event and two canonical blocks", async () => {
    expect(
      (await reconcileNftOperation(operation(), "test-access")).status,
    ).toBe("confirmed");
    expect(state.updates).toHaveLength(1);
  });
  it.each(["from", "to", "data", "value"])(
    "rejects an unrelated transaction %s",
    async (field) => {
      state.tx = {
        ...(state.tx as object),
        [field]:
          field === "value"
            ? 101n
            : field === "data"
              ? "0x4321"
              : "0x4444444444444444444444444444444444444444",
      };
      await expect(
        reconcileNftOperation(operation(), "test-access"),
      ).rejects.toThrow("does not match");
      expect(state.updates).toHaveLength(0);
    },
  );
  it("never treats a missing or shallow receipt as settlement", async () => {
    state.receipt = null;
    expect(
      (await reconcileNftOperation(operation(), "test-access")).status,
    ).toBe("pending");
    state.receipt = {
      hash,
      from: wallet,
      to: SEAPORT,
      blockNumber: 100,
      blockHash,
      status: 1,
      logs: [event()],
    };
    state.blockNumber = 100;
    expect(
      (await reconcileNftOperation(operation(), "test-access")).status,
    ).toBe("pending");
    expect(state.updates).toHaveLength(0);
  });
  it("demotes a confirmed receipt after canonical reorganization", async () => {
    state.block = { number: 100, hash: `0x${"4".repeat(64)}` };
    expect(
      (
        await reconcileNftOperation(
          { ...operation(), status: "confirmed" },
          "test-access",
        )
      ).status,
    ).toBe("pending");
  });
  it("demotes a previously reverted receipt when a reorg removes it", async () => {
    state.receipt = null;
    expect(
      (
        await reconcileNftOperation(
          { ...operation(), status: "failed" },
          "test-access",
        )
      ).status,
    ).toBe("pending");
  });
  it.each(["confirmed", "failed"])(
    "reconciles a changed canonical outcome from %s through pending",
    async (status) => {
      state.receipt = {
        hash,
        from: wallet,
        to: SEAPORT,
        blockNumber: 100,
        blockHash,
        status: status === "confirmed" ? 0 : 1,
        logs: [event()],
      };
      const result = await reconcileNftOperation(
        { ...operation(), status },
        "test-access",
      );
      expect(result.status).toBe(
        status === "confirmed" ? "failed" : "confirmed",
      );
      expect(
        state.updates.map((value) => (value as NftOperation).status),
      ).toEqual(["pending", result.status]);
    },
  );
  it("records a reverted receipt as failed rather than confirmed", async () => {
    state.receipt = {
      hash,
      from: wallet,
      to: SEAPORT,
      blockNumber: 100,
      blockHash,
      status: 0,
      logs: [],
    };
    expect(
      (await reconcileNftOperation(operation(), "test-access")).status,
    ).toBe("failed");
  });
  it.each(["missing", "hash", "recipient", "emitter"])(
    "rejects missing or unrelated %s settlement evidence",
    async (mutation) => {
      let log = event();
      if (mutation === "hash")
        log = event(`0x${"5".repeat(64)}` as typeof orderHash);
      if (mutation === "recipient")
        log = event(orderHash, "0x4444444444444444444444444444444444444444");
      if (mutation === "emitter")
        log = { ...log, address: "0x4444444444444444444444444444444444444444" };
      state.receipt = {
        hash,
        from: wallet,
        to: SEAPORT,
        blockNumber: 100,
        blockHash,
        status: 1,
        logs: mutation === "missing" ? [] : [log],
      };
      await expect(
        reconcileNftOperation(operation(), "test-access"),
      ).rejects.toThrow("expected NFT order event");
    },
  );
  it("does not silently replace a tracked transaction hash", async () => {
    await expect(
      recordNftTransaction(
        operation(),
        `0x${"6".repeat(64)}`,
        session,
        "test-access",
      ),
    ).rejects.toThrow("another transaction");
  });
  it("does not bind an unrelated or not-yet-observed recovery hash", async () => {
    const op = operation();
    delete op.transactionHash;
    state.tx = { ...(state.tx as object), data: "0x4321" };
    await expect(
      recordNftTransaction(op, hash, session, "test-access"),
    ).rejects.toThrow("does not match");
    expect(state.updates).toHaveLength(0);
    state.tx = null;
    await expect(
      recordNftTransaction(op, hash, session, "test-access"),
    ).rejects.toThrow("not visible");
    expect(state.updates).toHaveLength(0);
  });
  it("does not record a transaction for a wallet request never started", async () => {
    const op = { ...operation(), walletStarted: false };
    delete op.transactionHash;
    await expect(
      recordNftTransaction(op, hash, session, "test-access"),
    ).rejects.toThrow("not durably started");
    expect(state.updates).toHaveLength(0);
  });
  it("allows a delayed broadcast to be recovered after review expiry, without a second send", async () => {
    state.receipt = null;
    const op = operation();
    op.status = "awaiting-wallet";
    delete op.transactionHash;
    op.plan.expiresAt = Date.now() - 1000;
    expect(
      (await recordNftTransaction(op, hash, session, "test-access")).status,
    ).toBe("pending");
    expect(state.updates).toHaveLength(1);
  });
  it("requires the original wallet and chain for a broadcast acknowledgement", async () => {
    await expect(
      recordNftTransaction(
        operation(),
        hash,
        { ...session, chainId: 8453 },
        "test-access",
      ),
    ).rejects.toThrow("Sign in");
  });
  it("keeps an approval receipt distinct from trade settlement", async () => {
    const op = operation();
    op.plan.kind = "approval";
    state.receipt = {
      hash,
      from: wallet,
      to: SEAPORT,
      blockNumber: 100,
      blockHash,
      status: 1,
      logs: [],
    };
    expect((await reconcileNftOperation(op, "test-access")).plan.kind).toBe(
      "approval",
    );
  });
  it("cannot use a receipt from another chain", async () => {
    state.chainId = 8453;
    await expect(
      reconcileNftOperation(operation(), "test-access"),
    ).rejects.toThrow("another chain");
  });
});

describe("NFT receipt exact identity and final canonicality", () => {
  it("regression receipt identity: rejects an unrelated returned transaction hash", async () => {
    state.tx = { ...(state.tx as object), hash: `0x${"4".repeat(64)}` };
    await expect(
      reconcileNftOperation(operation(), "test-access"),
    ).rejects.toThrow("does not match");
    expect(state.updates).toHaveLength(0);
  });
  it("regression receipt identity: rejects an unrelated returned receipt hash", async () => {
    state.receipt = {
      ...(state.receipt as object),
      hash: `0x${"4".repeat(64)}`,
    };
    await expect(
      reconcileNftOperation(operation(), "test-access"),
    ).rejects.toThrow("receipt identity");
    expect(state.updates).toHaveLength(0);
  });
  it("regression receipt identity: a block changed during depth lookup cannot be confirmed", async () => {
    state.changeBlockAfterFirst = true;
    expect(
      (await reconcileNftOperation(operation(), "test-access")).status,
    ).toBe("pending");
    expect(state.updates).toHaveLength(0);
  });
  it.each([
    "tx-chain",
    "tx-block-hash",
    "tx-block-number",
    "receipt-from",
    "receipt-to",
    "receipt-number",
    "receipt-zero-hash",
    "receipt-status-null",
    "receipt-status-other",
  ])("rejects unavailable or mismatched %s identity", async (field) => {
    if (field === "tx-chain")
      state.tx = { ...(state.tx as object), chainId: 8453n };
    if (field === "tx-block-hash")
      state.tx = { ...(state.tx as object), blockHash: `0x${"4".repeat(64)}` };
    if (field === "tx-block-number")
      state.tx = { ...(state.tx as object), blockNumber: 99 };
    if (field === "receipt-from")
      state.receipt = { ...(state.receipt as object), from: SEAPORT };
    if (field === "receipt-to")
      state.receipt = { ...(state.receipt as object), to: wallet };
    if (field === "receipt-number")
      state.receipt = { ...(state.receipt as object), blockNumber: -1 };
    if (field === "receipt-zero-hash")
      state.receipt = {
        ...(state.receipt as object),
        blockHash: `0x${"0".repeat(64)}`,
      };
    if (field === "receipt-status-null")
      state.receipt = { ...(state.receipt as object), status: null };
    if (field === "receipt-status-other")
      state.receipt = { ...(state.receipt as object), status: 2 };
    await expect(
      reconcileNftOperation(operation(), "test-access"),
    ).rejects.toThrow();
    expect(state.updates).toHaveLength(0);
  });
  it("a wrong canonical block number cannot establish confirmation", async () => {
    state.block = { number: 99, hash: blockHash };
    expect(
      (await reconcileNftOperation(operation(), "test-access")).status,
    ).toBe("pending");
    expect(state.updates).toHaveLength(0);
  });
  it("a malformed observed head cannot establish confirmation", async () => {
    state.blockNumber = NaN;
    expect(
      (await reconcileNftOperation(operation(), "test-access")).status,
    ).toBe("pending");
    expect(state.updates).toHaveLength(0);
  });
  it("a chain change before final journal publication is rejected", async () => {
    state.changeChainAfterFirst = true;
    await expect(
      reconcileNftOperation(operation(), "test-access"),
    ).rejects.toThrow("another chain");
    expect(state.updates).toHaveLength(0);
  });
  it("removed settlement logs cannot confirm an NFT trade", async () => {
    state.receipt = {
      ...(state.receipt as object),
      logs: [{ ...event(), removed: true }],
    };
    await expect(
      reconcileNftOperation(operation(), "test-access"),
    ).rejects.toThrow("expected NFT order event");
    expect(state.updates).toHaveLength(0);
  });
  it("a confirmed operation is demoted when the final block recheck changes", async () => {
    state.changeBlockAfterFirst = true;
    expect(
      (
        await reconcileNftOperation(
          { ...operation(), status: "confirmed" },
          "test-access",
        )
      ).status,
    ).toBe("pending");
    expect(state.updates.map((x) => (x as NftOperation).status)).toEqual([
      "pending",
    ]);
  });
});

describe("NFT settlement log inclusion identity", () => {
  it.each(["transactionHash", "blockHash", "blockNumber"])(
    "cannot confirm an event missing %s",
    async (field) => {
      const log = { ...event() };
      Reflect.deleteProperty(log, field);
      state.receipt = { ...(state.receipt as object), logs: [log] };
      await expect(
        reconcileNftOperation(operation(), "test-access"),
      ).rejects.toThrow("expected NFT order event");
      expect(state.updates).toEqual([]);
    },
  );
});
