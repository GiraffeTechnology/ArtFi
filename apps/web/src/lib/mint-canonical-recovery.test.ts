import { describe, it, expect, vi } from "vitest";
import { encodeAbiParameters, keccak256, type PublicClient } from "viem";
import {
  recoverMintedAsset,
  mintRecoveryReadTimeoutMs,
  type MintIntent,
} from "./rwa-mint-recovery";
const wallet = "0x1000000000000000000000000000000000000010" as const,
  registry = "0x1000000000000000000000000000000000000001" as const,
  collection = "0x1000000000000000000000000000000000000002" as const;
const hash = `0x${"1".repeat(64)}` as const,
  otherHash = `0x${"2".repeat(64)}` as const;
const intent: MintIntent = {
  intentId: "intent-test",
  requestId: hash,
  recipient: wallet,
  registryAddress: registry,
  chainId: 560048,
  metadataUri: "ipfs://TEST_ONLY-metadata",
  metadataSha256: otherHash,
  status: "prepared",
};
function fixture() {
  const getChainId = vi.fn(async () => 560048),
    getBlock = vi.fn(async () => ({ number: 100n, hash }));
  const readContract = vi.fn(
    async ({ functionName }: { functionName: string }) =>
      functionName === "nft"
        ? collection
        : {
            creator: wallet,
            recipient: wallet,
            tokenId: 7n,
            metadataHash: intent.metadataSha256,
            metadataURI: intent.metadataUri,
            intentHash: keccak256(
              encodeAbiParameters(
                [{ type: "address" }, { type: "string" }, { type: "bytes32" }],
                [wallet, intent.metadataUri, intent.metadataSha256],
              ),
            ),
            createdAt: 1n,
          },
  );
  return {
    getChainId,
    getBlock,
    readContract,
    client: { getChainId, getBlock, readContract } as unknown as PublicClient,
  };
}
describe("canonical mint registry recovery", () => {
  it("pins both contract reads to one observed block and checks that exact block twice", async () => {
    const f = fixture();
    expect(
      await recoverMintedAsset(f.client, intent, wallet, () => {}),
    ).toMatchObject({ chainId: 560048, tokenId: "7" });
    expect(f.getBlock.mock.calls).toEqual([
      [{ blockTag: "latest" }],
      [{ blockNumber: 100n }],
    ]);
    expect(
      f.readContract.mock.calls.map(
        (c) => (c[0] as unknown as { blockNumber: bigint }).blockNumber,
      ),
    ).toEqual([100n, 100n]);
    expect(f.getChainId).toHaveBeenCalledTimes(2);
  });
  it("regression mint: refuses a different reader chain even when the request mapping matches", async () => {
    const f = fixture();
    f.getChainId.mockResolvedValue(1);
    await expect(
      recoverMintedAsset(f.client, intent, wallet, () => {}),
    ).rejects.toThrow(/chain/);
    expect(f.readContract).not.toHaveBeenCalled();
  });
  it("regression mint: refuses registry evidence from a block that reorganizes during recovery", async () => {
    const f = fixture();
    f.getBlock
      .mockResolvedValueOnce({ number: 100n, hash })
      .mockResolvedValueOnce({ number: 100n, hash: otherHash });
    await expect(
      recoverMintedAsset(f.client, intent, wallet, () => {}),
    ).rejects.toThrow(/changed/);
  });
  it("regression mint: binds registry reads to the already confirmed receipt block hash", async () => {
    const f = fixture();
    await expect(
      recoverMintedAsset(
        f.client,
        intent,
        wallet,
        () => {},
        100n,
        wallet,
        otherHash,
      ),
    ).rejects.toThrow(/block/);
    expect(f.readContract).not.toHaveBeenCalled();
  });
  it("refuses a chain change after both reads", async () => {
    const f = fixture();
    f.getChainId.mockResolvedValueOnce(560048).mockResolvedValueOnce(1);
    await expect(
      recoverMintedAsset(f.client, intent, wallet, () => {}),
    ).rejects.toThrow(/changed/);
  });
  for (const block of [
    { number: null, hash },
    { number: -1n, hash },
    { number: 100n, hash: null },
    { number: 100n, hash: "0x" + "0".repeat(64) },
    { number: 100n, hash: "0xabcd" },
  ])
    it(`rejects unmined/malformed snapshot ${String(block.number)}:${block.hash}`, async () => {
      const f = fixture();
      f.getBlock.mockResolvedValue(block as never);
      await expect(
        recoverMintedAsset(f.client, intent, wallet, () => {}),
      ).rejects.toThrow(/block/);
      expect(f.readContract).not.toHaveBeenCalled();
    });
  it("refuses a different block number from a pinned receipt", async () => {
    const f = fixture();
    await expect(
      recoverMintedAsset(f.client, intent, wallet, () => {}, 101n),
    ).rejects.toThrow(/block/);
  });
  it("accepts a stable receipt-bound snapshot", async () => {
    const f = fixture();
    expect(
      (
        await recoverMintedAsset(
          f.client,
          intent,
          wallet,
          () => {},
          100n,
          wallet,
          hash,
        )
      ).tokenId,
    ).toBe("7");
  });
  it("retires a hanging chain read and never starts late block or asset reads", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let release!: (value: number) => void;
      f.getChainId.mockImplementation(
        () => new Promise<number>((done) => (release = done)),
      );
      const pending = recoverMintedAsset(f.client, intent, wallet, () => {});
      const outcome = expect(pending).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(mintRecoveryReadTimeoutMs + 1);
      await outcome;
      release(560048);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.getBlock).not.toHaveBeenCalled();
      expect(f.readContract).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("retires a hanging collection read before any late final block check", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let release!: (value: unknown) => void;
      const actual = f.readContract.getMockImplementation()!;
      f.readContract.mockImplementation((input) =>
        input.functionName === "nft"
          ? (new Promise((done) => (release = done)) as never)
          : actual(input),
      );
      const pending = recoverMintedAsset(f.client, intent, wallet, () => {});
      const outcome = expect(pending).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(mintRecoveryReadTimeoutMs);
      await outcome;
      release(collection);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.getBlock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
