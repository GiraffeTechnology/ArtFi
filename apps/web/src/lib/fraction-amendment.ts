import type { Address, PublicClient } from "viem";
import { artFiFractionMarketAbi } from "./contracts";
import { fractionIntentHash, type FractionSaleIntent } from "./fraction-intent";

type Reader = Pick<PublicClient, "getChainId" | "getBlock" | "readContract">;

/** A new salt prevents unchanged replacement terms from reusing revoked authority. */
export function freshFractionSalt(): bigint {
  const words = crypto.getRandomValues(new Uint32Array(8));
  return words.reduce((salt, word) => (salt << 32n) | BigInt(word), 0n);
}

/** Revoke before replacement signing. A receipt alone is not proof that old authority is gone. */
export async function retireFractionForAmendment({
  client,
  market,
  original,
  seller,
  revoke,
  assertCurrent,
}: {
  client: Reader;
  market: Address;
  original: FractionSaleIntent;
  seller: Address;
  revoke: () => Promise<unknown>;
  assertCurrent: () => void;
}) {
  if (original.seller.toLowerCase() !== seller.toLowerCase())
    throw new Error("Only the original seller can amend this authorization.");
  const hash = fractionIntentHash(
    original,
    { chainId: 560048, verifyingContract: market },
    560048,
  );
  const observe = async () => {
    assertCurrent();
    if ((await client.getChainId()) !== 560048)
      throw new Error("The amendment reader is on a different chain.");
    const block = await client.getBlock({ blockTag: "latest" });
    if (block.number === null)
      throw new Error("A mined block is required before replacement signing.");
    const read = {
      address: market,
      abi: artFiFractionMarketAbi,
      blockNumber: block.number,
    } as const;
    const [epoch, filled] = await Promise.all([
      client.readContract({
        ...read,
        functionName: "sellerEpoch",
        args: [seller],
      }),
      client.readContract({
        ...read,
        functionName: "intentFilled",
        args: [hash],
      }),
    ]);
    assertCurrent();
    return {
      block,
      epoch,
      retired: epoch !== original.epoch || filled >= original.maxAmount,
    };
  };
  let snapshot = await observe();
  if (!snapshot.retired) {
    await revoke();
    assertCurrent();
    snapshot = await observe();
  }
  if (!snapshot.retired)
    throw new Error(
      "The old authorization is still live. No replacement signature was requested.",
    );
  return snapshot;
}
