import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import {
  earlierProposalRange,
  proposalBlockInput,
  proposalRange,
  readPublicProposalPage,
} from "./dao-proposal-discovery";
const governor = "0x1000000000000000000000000000000000000001";
const hash = "0x" + "a".repeat(64),
  transactionHash = "0x" + "b".repeat(64);
function fixture() {
  const log = {
    address: governor,
    args: { proposalId: 7n, kind: 1, approvalNumerator: 500000n },
    blockNumber: 15000n,
    blockHash: hash,
    transactionHash,
    logIndex: 0,
    removed: false,
  };
  const getChainId = vi.fn(async () => 560048);
  const getBlock = vi.fn(
    async ({ blockNumber }: { blockTag?: string; blockNumber?: bigint }) => ({
      number: blockNumber ?? 20000n,
      hash,
      timestamp: 1234n,
    }),
  );
  const getLogs = vi.fn(async (_query: unknown) => [structuredClone(log)]);
  const values: Record<string, unknown> = {
    state: 4,
    proposalKind: 1,
    proposalVotes: [1n, 9n, 2n],
  };
  const readContract = vi.fn(
    async ({ functionName }: { functionName: string; blockNumber?: bigint }) =>
      values[functionName],
  );
  const client = {
    getChainId,
    getBlock,
    getLogs,
    readContract,
  } as unknown as PublicClient;
  return { client, getChainId, getBlock, getLogs, readContract, log };
}
describe("bounded public classified-proposal discovery", () => {
  it("uses inclusive nonoverlapping ranges and never treats a short range as history completion", () => {
    expect(proposalRange(20000n)).toEqual({
      fromBlock: 10001n,
      toBlock: 20000n,
    });
    expect(earlierProposalRange(10001n)).toEqual({
      fromBlock: 1n,
      toBlock: 10000n,
    });
    expect(earlierProposalRange(1n)).toEqual({ fromBlock: 0n, toBlock: 0n });
    expect(earlierProposalRange(0n)).toBeUndefined();
    for (const range of [
      { fromBlock: 0n, toBlock: 10000n },
      { fromBlock: 2n, toBlock: 1n },
      { fromBlock: 0n, toBlock: 30000n },
    ])
      expect(() => proposalRange(20000n, range)).toThrow();
    expect(proposalBlockInput(" 123 ")).toBe(123n);
    for (const raw of ["01", "-1", "1.2", "1e3", (1n << 256n).toString()])
      expect(() => proposalBlockInput(raw)).toThrow();
  });
  it("reads exact source logs and all current outcomes at one block, with canonical checks", async () => {
    const f = fixture();
    const result = await readPublicProposalPage(f.client, governor, undefined, {
      now: () => 10000,
    });
    expect(result).toMatchObject({
      governor,
      chainId: 560048,
      fromBlock: "10001",
      toBlock: "20000",
      observedBlock: "20000",
      observedBlockHash: hash,
      observedAt: 10000,
    });
    expect(result.proposals).toEqual([
      {
        proposalId: "7",
        kind: 1,
        approvalNumerator: "500000",
        state: 4,
        againstVotes: "1",
        forVotes: "9",
        abstainVotes: "2",
        classifiedBlock: "15000",
        classifiedBlockHash: hash,
        transactionHash,
        logIndex: 0,
      },
    ]);
    expect(f.getLogs.mock.calls[0]![0]).toMatchObject({
      address: governor,
      fromBlock: 10001n,
      toBlock: 20000n,
      strict: true,
    });
    for (const [args] of f.readContract.mock.calls)
      expect(args.blockNumber).toBe(20000n);
    expect(f.getBlock.mock.calls.map(([query]) => query.blockNumber)).toEqual([
      undefined,
      15000n,
      20000n,
    ]);
  });
  it("preserves an empty interval without inventing a full-history completion marker", async () => {
    const f = fixture();
    f.getLogs.mockResolvedValue([]);
    const result = await readPublicProposalPage(f.client, governor);
    expect(result.proposals).toEqual([]);
    expect(result.fromBlock).toBe("10001");
    expect(f.readContract).not.toHaveBeenCalled();
  });
  it("refuses oversized or duplicate classifications rather than truncating", async () => {
    for (const oversized of [false, true]) {
      const f = fixture();
      f.getLogs.mockResolvedValue(
        oversized
          ? Array.from({ length: 101 }, () => structuredClone(f.log))
          : [f.log, f.log],
      );
      await expect(
        readPublicProposalPage(f.client, governor),
      ).rejects.toThrow();
      expect(f.readContract).not.toHaveBeenCalled();
    }
  });
  it("rejects removed, foreign, out-of-range and misclassified source events", async () => {
    for (const patch of [
      { removed: true },
      { address: "0x" + "2".repeat(40) },
      { blockNumber: 1n },
      { blockHash: "0x1" },
      { args: { proposalId: 7n, kind: 0, approvalNumerator: 0n } },
      { args: { proposalId: 7n, kind: 2, approvalNumerator: 666666n } },
    ]) {
      const f = fixture();
      f.getLogs.mockResolvedValue([{ ...f.log, ...patch }] as never);
      await expect(
        readPublicProposalPage(f.client, governor),
      ).rejects.toThrow();
    }
  });
  it("rejects canonical-block changes, chain switches and inconsistent on-chain classification", async () => {
    for (const mode of [
      "event-reorg",
      "anchor-reorg",
      "chain",
      "kind",
      "state",
      "votes",
    ]) {
      const f = fixture();
      if (mode.endsWith("reorg"))
        f.getBlock.mockImplementation(async ({ blockNumber }) => ({
          number: blockNumber ?? 20000n,
          timestamp: 1234n,
          hash:
            blockNumber === (mode === "event-reorg" ? 15000n : 20000n)
              ? "0x" + "c".repeat(64)
              : hash,
        }));
      if (mode === "chain")
        f.getChainId.mockResolvedValueOnce(560048).mockResolvedValueOnce(1);
      if (["kind", "state", "votes"].includes(mode))
        f.readContract.mockImplementation(async ({ functionName }) =>
          functionName === "state"
            ? mode === "state"
              ? 8
              : 4
            : functionName === "proposalKind"
              ? mode === "kind"
                ? 2
                : 1
              : mode === "votes"
                ? ["1", 2n, 3n]
                : [1n, 2n, 3n],
        );
      await expect(
        readPublicProposalPage(f.client, governor),
      ).rejects.toThrow();
    }
  });
  it("retires a cancelled provider request and suppresses all later reads", async () => {
    const f = fixture(),
      controller = new AbortController();
    let finish!: (logs: (typeof f.log)[]) => void;
    f.getLogs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = readPublicProposalPage(f.client, governor, undefined, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(f.getLogs).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    finish([f.log]);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.readContract).not.toHaveBeenCalled();
  });
});
