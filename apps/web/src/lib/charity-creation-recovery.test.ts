import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  zeroAddress,
  zeroHash,
  type Hex,
} from "viem";
import { charityEditionsAbi } from "./contracts";
import {
  charityCreationReadTimeoutMs,
  isCharitySeriesSetup,
  readCharitySeriesCreation,
  simulateCharitySeriesCreation,
  type CharitySeriesSetup,
} from "./charity-creation-recovery";

const wallet = "0x1000000000000000000000000000000000000001",
  collection = "0x1000000000000000000000000000000000000002";
const tx = `0x${"a".repeat(64)}` as Hex,
  blockHash = `0x${"b".repeat(64)}` as Hex;
const setup: CharitySeriesSetup = {
  version: 1,
  chainId: 560048,
  walletAddress: wallet,
  collectionAddress: collection,
  fields: {
    artworkId: `0x${"1".repeat(64)}`,
    masterArtworkHash: `0x${"2".repeat(64)}`,
    metadataHash: `0x${"3".repeat(64)}`,
    distributionWallet: wallet,
    metadataURI: "ipfs://TEST_ONLY/no-preview.json",
  },
};
function fixture() {
  const state = {
    chain: 560048,
    hash: blockHash,
    checks: 0,
    reorg: false,
    supply: 100n,
    balance: 100n,
  };
  const topics = encodeEventTopics({
    abi: charityEditionsAbi,
    eventName: "SeriesCreated",
    args: {
      tokenId: 7n,
      artworkId: setup.fields.artworkId,
      masterArtworkHash: setup.fields.masterArtworkHash,
    },
  });
  const receipt = {
    transactionHash: tx,
    status: "success",
    blockNumber: 77n,
    blockHash,
    logs: [
      {
        address: collection,
        topics,
        data: encodeAbiParameters(
          [{ type: "address" }, { type: "bytes32" }, { type: "string" }],
          [wallet, setup.fields.metadataHash, setup.fields.metadataURI],
        ),
      },
    ],
  };
  const reads: { functionName: string; blockNumber?: bigint }[] = [];
  const client = {
    waitForTransactionReceipt: vi.fn(async (_args: unknown) => receipt),
    getChainId: vi.fn(async () => state.chain),
    getBlock: vi.fn(async () => {
      state.checks++;
      return {
        number: 77n,
        hash: state.reorg && state.checks > 1 ? tx : state.hash,
      };
    }),
    readContract: vi.fn(
      async (input: { functionName: string; blockNumber?: bigint }) => {
        reads.push(input);
        return input.functionName === "totalSupply"
          ? state.supply
          : state.balance;
      },
    ),
    simulateContract: vi.fn(async (_args: unknown) => ({})),
  };
  return {
    state,
    receipt,
    reads,
    client: client as unknown as Parameters<
      typeof readCharitySeriesCreation
    >[0] &
      Parameters<typeof simulateCharitySeriesCreation>[0],
    mocks: client,
  };
}
afterEach(() => vi.useRealTimers());
describe("charity creation canonical receipt and read-only simulation", () => {
  it("binds exact call, receipt, event, recipient and 100 units at one canonical block", async () => {
    const f = fixture();
    const current = vi.fn();
    await simulateCharitySeriesCreation(f.client, setup, current);
    expect(f.mocks.simulateContract.mock.calls[0][0]).toMatchObject({
      address: collection,
      account: wallet,
      functionName: "createSeries",
      args: [
        setup.fields.artworkId,
        setup.fields.masterArtworkHash,
        setup.fields.metadataHash,
        wallet,
        setup.fields.metadataURI,
      ],
    });
    expect(
      await readCharitySeriesCreation(f.client, setup, tx, current),
    ).toEqual({
      tokenId: "7",
      quantity: "100",
      transactionHash: tx,
      blockNumber: "77",
      blockHash,
    });
    expect(f.reads.map((r) => r.blockNumber)).toEqual([77n, 77n]);
    expect(f.state.checks).toBe(2);
  });
  for (const [name, change] of [
    [
      "zero artwork",
      (s: CharitySeriesSetup) => (s.fields.artworkId = zeroHash),
    ],
    [
      "zero master",
      (s: CharitySeriesSetup) => (s.fields.masterArtworkHash = zeroHash),
    ],
    [
      "zero metadata",
      (s: CharitySeriesSetup) => (s.fields.metadataHash = zeroHash),
    ],
    [
      "zero recipient",
      (s: CharitySeriesSetup) => (s.fields.distributionWallet = zeroAddress),
    ],
    [
      "oversized UTF8 URI",
      (s: CharitySeriesSetup) =>
        (s.fields.metadataURI = "https://example.invalid/" + "界".repeat(200)),
    ],
  ] as const) {
    it("rejects invalid persisted bindings: " + name, () => {
      const value = structuredClone(setup);
      change(value);
      expect(isCharitySeriesSetup(value)).toBe(false);
    });
  }
  it("does not accept a different transaction hash as the saved request", async () => {
    const f = fixture();
    f.receipt.transactionHash = blockHash;
    await expect(
      readCharitySeriesCreation(f.client, setup, tx, () => {}),
    ).rejects.toThrow("saved transaction");
  });
  it("does not accept matching events from another collection", async () => {
    const f = fixture();
    f.receipt.logs[0].address = wallet;
    await expect(
      readCharitySeriesCreation(f.client, setup, tx, () => {}),
    ).rejects.toThrow("missing or mismatched");
  });
  it("rejects another recipient even when token ID and artwork match", async () => {
    const f = fixture();
    f.receipt.logs[0].data = encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "string" }],
      [collection, setup.fields.metadataHash, setup.fields.metadataURI],
    );
    await expect(
      readCharitySeriesCreation(f.client, setup, tx, () => {}),
    ).rejects.toThrow("missing or mismatched");
  });
  for (const field of ["supply", "balance"] as const)
    it("rejects non-100 receipt-block " + field, async () => {
      const f = fixture();
      f.state[field] = 99n;
      await expect(
        readCharitySeriesCreation(f.client, setup, tx, () => {}),
      ).rejects.toThrow("100 units");
    });
  it("rejects a reader on another chain", async () => {
    const f = fixture();
    f.state.chain = 1;
    await expect(
      readCharitySeriesCreation(f.client, setup, tx, () => {}),
    ).rejects.toThrow("block or chain changed");
    expect(f.reads).toHaveLength(0);
  });
  it("rechecks the canonical receipt block after supply reads", async () => {
    const f = fixture();
    f.state.reorg = true;
    await expect(
      readCharitySeriesCreation(f.client, setup, tx, () => {}),
    ).rejects.toThrow("block or chain changed");
    expect(f.state.checks).toBe(2);
  });
  it("stops a retired view after asynchronous receipt lookup", async () => {
    const f = fixture();
    let active = true;
    f.mocks.waitForTransactionReceipt.mockImplementation(async () => {
      active = false;
      return f.receipt;
    });
    await expect(
      readCharitySeriesCreation(f.client, setup, tx, () => {
        if (!active) throw Error("Retired view");
      }),
    ).rejects.toThrow("Retired view");
    expect(f.reads).toHaveLength(0);
  });
  it("times out without treating late receipt results as completion", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release: ((r: typeof f.receipt) => void) | undefined;
    f.mocks.waitForTransactionReceipt.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const result = readCharitySeriesCreation(f.client, setup, tx, () => {});
    const rejected = expect(result).rejects.toThrow(
      "original request remains unresolved",
    );
    await vi.advanceTimersByTimeAsync(charityCreationReadTimeoutMs + 1);
    await rejected;
    release!(f.receipt);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.reads).toHaveLength(0);
  });
  it("times out simulation without creating signing or sending authority", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.mocks.simulateContract.mockImplementation(() => new Promise(() => {}));
    const result = simulateCharitySeriesCreation(f.client, setup, () => {});
    const rejected = expect(result).rejects.toThrow(
      "No wallet request was made",
    );
    await vi.advanceTimersByTimeAsync(charityCreationReadTimeoutMs + 1);
    await rejected;
    expect(f.mocks.waitForTransactionReceipt).not.toHaveBeenCalled();
  });
});

it("repricing retains the exact canonical replacement without another submission", async () => {
  const f = fixture(),
    next = `0x${"c".repeat(64)}` as Hex,
    changed = vi.fn();
  f.receipt.transactionHash = next;
  f.mocks.waitForTransactionReceipt.mockImplementation(
    async (input: unknown) => {
      (input as { onReplaced: (v: unknown) => void }).onReplaced({
        reason: "repriced",
        transactionReceipt: f.receipt,
      });
      return f.receipt;
    },
  );
  expect(
    (await readCharitySeriesCreation(f.client, setup, tx, () => {}, changed))
      .transactionHash,
  ).toBe(next);
  expect(changed).toHaveBeenCalledExactlyOnceWith(next);
});
it("invalid replacement hashes never overwrite the original pending hash", async () => {
  const f = fixture(),
    changed = vi.fn();
  f.mocks.waitForTransactionReceipt.mockImplementation(
    async (input: unknown) => {
      (input as { onReplaced: (v: unknown) => void }).onReplaced({
        reason: "repriced",
        transactionReceipt: { ...f.receipt, transactionHash: zeroHash },
      });
      return f.receipt;
    },
  );
  await expect(
    readCharitySeriesCreation(f.client, setup, tx, () => {}, changed),
  ).rejects.toThrow();
  expect(changed).not.toHaveBeenCalled();
  expect(f.reads).toHaveLength(0);
});
it("a reverted receipt from another chain is not a terminal outcome", async () => {
  const f = fixture();
  f.receipt.status = "reverted";
  f.state.chain = 1;
  await expect(
    readCharitySeriesCreation(f.client, setup, tx, () => {}),
  ).rejects.toThrow("block or chain changed");
  expect(f.reads).toHaveLength(0);
});
