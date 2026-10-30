import type { Address, PublicClient } from "viem";
import { artFiFractionMarketAbi } from "./contracts";
import { fractionIntentHash, type FractionSaleIntent } from "./fraction-intent";

type Reader = Pick<PublicClient, "getChainId" | "getBlock" | "readContract">;
type AmendmentObservation = {
  client: Reader;
  market: Address;
  original: FractionSaleIntent;
  seller: Address;
  assertCurrent: () => void;
};
const maxUint256 = (1n << 256n) - 1n;
function isUint(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n && value <= maxUint256;
}

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
}: AmendmentObservation & {
  revoke: () => Promise<unknown>;
}) {
  // The caller and provider retain their objects across awaits. Capture the reviewed terms,
  // then keep the block identity independent of later provider or revocation callbacks.
  const intent = Object.freeze({ ...original });
  if (intent.seller.toLowerCase() !== seller.toLowerCase())
    throw new Error("Only the original seller can amend this authorization.");
  const hash = fractionIntentHash(
    intent,
    { chainId: 560048, verifyingContract: market },
    560048,
  );
  const observe = async () => {
    assertCurrent();
    const chainId = await client.getChainId();
    assertCurrent();
    if (chainId !== 560048)
      throw new Error("The amendment reader is on a different chain.");
    const observed = await client.getBlock({ blockTag: "latest" });
    assertCurrent();
    const block = Object.freeze({
      number: observed.number,
      hash: observed.hash,
      timestamp: observed.timestamp,
    });
    if (
      !isUint(block.number) ||
      !isUint(block.timestamp) ||
      block.timestamp >= 1n << 48n ||
      typeof block.hash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
      /^0x0{64}$/i.test(block.hash)
    )
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
    if (!isUint(epoch) || !isUint(filled))
      throw new Error("The old authorization's chain state is unavailable.");
    const [checked, checkedChain] = await Promise.all([
      client.getBlock({ blockNumber: block.number }),
      client.getChainId(),
    ]);
    assertCurrent();
    if (
      checkedChain !== 560048 ||
      checked.number !== block.number ||
      checked.hash !== block.hash ||
      checked.timestamp !== block.timestamp
    )
      throw new Error(
        "The chain or observed block changed. Refresh before replacement signing.",
      );
    return Object.freeze({
      block,
      epoch,
      retired: epoch !== intent.epoch || filled >= intent.maxAmount,
    });
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

/** Read again inside the wallet callback, after grounding and the session gate.
 * This guard never replays a withdrawal and does not claim chain finality. */
export async function assertRetiredFractionForReplacement({
  expectedEpoch,
  ...observation
}: AmendmentObservation & { expectedEpoch: bigint }) {
  if (!isUint(expectedEpoch))
    throw new Error("The replacement authorization's epoch is invalid.");
  const snapshot = await retireFractionForAmendment({
    ...observation,
    revoke: async () => {
      throw new Error(
        "The old authorization is live again. Reconcile it before replacement signing.",
      );
    },
  });
  if (snapshot.epoch !== expectedEpoch)
    throw new Error(
      "The seller epoch changed. Refresh the replacement terms before signing.",
    );
  return snapshot;
}
