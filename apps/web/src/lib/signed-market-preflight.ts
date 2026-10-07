import type { Address, Hex, PublicClient } from "viem";
import { verifyMarketSignature } from "./market-signature";

import {
  artFiFractionMarketAbi,
  fractionTokenAbi,
  wholeArtworkCollectionAbi,
  wholeArtworkMarketAbi,
} from "./contracts";
import {
  fractionIntentFillable,
  fractionIntentHash,
  type FractionIntentDomain,
  type FractionSaleIntent,
} from "./fraction-intent";
import {
  saleIntentFillable,
  saleIntentHash,
  type SaleIntent,
  type SaleIntentDomain,
} from "./whole-artwork-intent";

type Reader = Pick<
  PublicClient,
  "getChainId" | "getBlock" | "readContract" | "getCode" | "call"
>;

type Context = {
  client: Reader;
  buyer: Address;
  signature: Hex;
  expectedChainId: number;
};

function requireBuyer(seller: Address, namedBuyer: Address, buyer: Address) {
  if (
    seller.toLowerCase() === buyer.toLowerCase() ||
    (namedBuyer !== "0x0000000000000000000000000000000000000000" &&
      namedBuyer.toLowerCase() !== buyer.toLowerCase())
  ) {
    throw new Error("These terms are not fillable by the connected buyer.");
  }
}

async function chainSnapshot(client: Reader, expectedChainId: number) {
  if ((await client.getChainId()) !== expectedChainId) {
    throw new Error("The market reader is connected to a different chain.");
  }
  const block = await client.getBlock({ blockTag: "latest" });
  if (
    block.number === null ||
    block.timestamp > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("The market state could not be verified at a mined block.");
  }
  return { blockNumber: block.number, now: Number(block.timestamp) };
}

/**
 * Read-only preflight immediately before the buyer's payment approval. React query snapshots
 * and unverified pasted signatures are insufficient authorization evidence. Verification uses
 * the same EOA/EIP-1271 branch as the deployed contract, without permissive signature fallback.
 *
 * All reads use one observed block. This reduces stale-state mistakes; it cannot reserve the
 * order or replace the contract's atomic checks if another fill wins the race afterward.
 */
export async function verifyWholeArtworkSale({
  client,
  intent,
  domain,
  signature,
  buyer,
  expectedChainId,
}: Context & { intent: SaleIntent; domain: SaleIntentDomain }) {
  const digest = saleIntentHash(intent, domain, expectedChainId);
  requireBuyer(intent.seller, intent.buyer, buyer);
  const { blockNumber, now } = await chainSnapshot(client, expectedChainId);
  const valid = await verifyMarketSignature(
    client,
    intent.seller,
    domain.verifyingContract,
    digest,
    signature,
    blockNumber,
  );
  if (!valid)
    throw new Error(
      "The seller's signature is invalid. No payment approval was requested.",
    );

  const market = {
    address: domain.verifyingContract,
    abi: wholeArtworkMarketAbi,
    blockNumber,
  } as const;
  const collection = {
    address: intent.collection,
    abi: wholeArtworkCollectionAbi,
    blockNumber,
  } as const;
  const [
    used,
    epoch,
    holder,
    approved,
    approvedToken,
    collectionAllowed,
    paymentAllowed,
    paused,
  ] = await Promise.all([
    client.readContract({
      ...market,
      functionName: "intentUsed",
      args: [digest],
    }),
    client.readContract({
      ...market,
      functionName: "sellerEpoch",
      args: [intent.seller],
    }),
    client.readContract({
      ...collection,
      functionName: "ownerOf",
      args: [intent.tokenId],
    }),
    client.readContract({
      ...collection,
      functionName: "isApprovedForAll",
      args: [intent.seller, domain.verifyingContract],
    }),
    client.readContract({
      ...collection,
      functionName: "getApproved",
      args: [intent.tokenId],
    }),
    client.readContract({
      ...market,
      functionName: "allowedCollection",
      args: [intent.collection],
    }),
    client.readContract({
      ...market,
      functionName: "allowedPaymentToken",
      args: [intent.paymentToken],
    }),
    client.readContract({ ...market, functionName: "paused" }),
  ]);
  if (used)
    throw new Error(
      "This authorization has already been settled or withdrawn.",
    );
  if (!saleIntentFillable(intent, now, epoch).fillable) {
    throw new Error(
      "This authorization is not open or its seller epoch has changed.",
    );
  }
  if (holder.toLowerCase() !== intent.seller.toLowerCase()) {
    throw new Error("The seller no longer holds this artwork.");
  }
  if (
    !approved &&
    approvedToken.toLowerCase() !== domain.verifyingContract.toLowerCase()
  )
    throw new Error(
      "The seller has not approved this market to transfer the artwork.",
    );
  if (!collectionAllowed || !paymentAllowed || paused) {
    throw new Error(
      "The market or token pair is not currently available for settlement.",
    );
  }
  return { digest, blockNumber };
}

export async function verifyFractionSale({
  client,
  intent,
  domain,
  signature,
  buyer,
  amount,
  expectedChainId,
}: Context & {
  intent: FractionSaleIntent;
  domain: FractionIntentDomain;
  amount: bigint;
}) {
  const digest = fractionIntentHash(intent, domain, expectedChainId);
  requireBuyer(intent.seller, intent.buyer, buyer);
  const { blockNumber, now } = await chainSnapshot(client, expectedChainId);
  const valid = await verifyMarketSignature(
    client,
    intent.seller,
    domain.verifyingContract,
    digest,
    signature,
    blockNumber,
  );
  if (!valid)
    throw new Error(
      "The seller's signature is invalid. No payment approval was requested.",
    );

  const market = {
    address: domain.verifyingContract,
    abi: artFiFractionMarketAbi,
    blockNumber,
  } as const;
  const token = {
    address: intent.assetToken,
    abi: fractionTokenAbi,
    blockNumber,
  } as const;
  const [
    filled,
    epoch,
    balance,
    allowance,
    assetAllowed,
    paymentAllowed,
    paused,
    cap,
    spent,
  ] = await Promise.all([
    client.readContract({
      ...market,
      functionName: "intentFilled",
      args: [digest],
    }),
    client.readContract({
      ...market,
      functionName: "sellerEpoch",
      args: [intent.seller],
    }),
    client.readContract({
      ...token,
      functionName: "balanceOf",
      args: [intent.seller],
    }),
    client.readContract({
      ...token,
      functionName: "allowance",
      args: [intent.seller, domain.verifyingContract],
    }),
    client.readContract({
      ...market,
      functionName: "allowedAssetToken",
      args: [intent.assetToken],
    }),
    client.readContract({
      ...market,
      functionName: "allowedPaymentToken",
      args: [intent.paymentToken],
    }),
    client.readContract({ ...market, functionName: "paused" }),
    client.readContract({
      ...market,
      functionName: "pilotPaymentCap",
      args: [buyer, intent.paymentToken],
    }),
    client.readContract({
      ...market,
      functionName: "pilotPaymentUsed",
      args: [buyer, intent.paymentToken],
    }),
  ]);
  if (!fractionIntentFillable(intent, now, epoch, filled, amount).fillable) {
    throw new Error(
      "This authorization is not open, was withdrawn, or has insufficient remaining quantity.",
    );
  }
  if (balance < amount || allowance < amount) {
    throw new Error(
      "The seller's balance or market allowance is insufficient for this fill.",
    );
  }
  if (!assetAllowed || !paymentAllowed || paused) {
    throw new Error(
      "The market or token pair is not currently available for settlement.",
    );
  }
  const payment = amount * intent.unitPrice;
  if (payment > (1n << 256n) - 1n || spent > cap || payment > cap - spent) {
    throw new Error(
      "This fill exceeds the buyer's remaining pilot payment cap.",
    );
  }
  return { digest, blockNumber, remaining: intent.maxAmount - filled };
}
