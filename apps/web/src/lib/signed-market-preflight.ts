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

export const signedMarketPreflightTimeoutMs = 12000;

// Retire a read result on timeout; provider RPC requests are not claimed to be cancelled.
async function boundedPreflight<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "The signed-sale preflight timed out. Refresh current sale state before continuing.",
              ),
            ),
          signedMarketPreflightTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function chainSnapshot(client: Reader, expectedChainId: number) {
  if ((await client.getChainId()) !== expectedChainId) {
    throw new Error("The market reader is connected to a different chain.");
  }
  const block = await client.getBlock({ blockTag: "latest" });
  if (
    typeof block.number !== "bigint" ||
    block.number < 0n ||
    !block.hash ||
    !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
    /^0x0{64}$/i.test(block.hash) ||
    typeof block.timestamp !== "bigint" ||
    block.timestamp < 0n ||
    block.timestamp > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("The market state could not be verified at a mined block.");
  }
  return {
    blockNumber: block.number,
    blockHash: block.hash,
    timestamp: block.timestamp,
    now: Number(block.timestamp),
  };
}

async function assertCanonicalSnapshot(
  client: Reader,
  expectedChainId: number,
  snapshot: Awaited<ReturnType<typeof chainSnapshot>>,
) {
  const [checked, chainId] = await Promise.all([
    client.getBlock({ blockNumber: snapshot.blockNumber }),
    client.getChainId(),
  ]);
  if (
    chainId !== expectedChainId ||
    checked.number !== snapshot.blockNumber ||
    checked.hash !== snapshot.blockHash ||
    checked.timestamp !== snapshot.timestamp
  ) {
    throw new Error(
      "The chain or observed sale block changed. Refresh current sale state before continuing.",
    );
  }
}

function assertPaymentBalance(balance: unknown, payment: bigint) {
  if (
    typeof balance !== "bigint" ||
    balance < 0n ||
    balance >= 1n << 256n ||
    balance < payment
  )
    throw new Error(
      "The buyer's current payment-token balance is unavailable or insufficient for this fill.",
    );
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
  return boundedPreflight(async () => {
    const digest = saleIntentHash(intent, domain, expectedChainId);
    requireBuyer(intent.seller, intent.buyer, buyer);
    const snapshot = await chainSnapshot(client, expectedChainId);
    const { blockNumber, now, blockHash } = snapshot;
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
      tokenOwner,
      approved,
      approvedToken,
      collectionAllowed,
      paymentAllowed,
      paused,
      buyerPaymentBalance,
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
      client.readContract({
        address: intent.paymentToken,
        abi: fractionTokenAbi,
        functionName: "balanceOf",
        args: [buyer],
        blockNumber,
      }),
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
    if (tokenOwner.toLowerCase() !== intent.seller.toLowerCase()) {
      throw new Error("The seller is no longer the token owner.");
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
    assertPaymentBalance(buyerPaymentBalance, intent.price);
    await assertCanonicalSnapshot(client, expectedChainId, snapshot);
    return { digest, blockNumber, blockHash };
  });
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
  return boundedPreflight(async () => {
    const digest = fractionIntentHash(intent, domain, expectedChainId);
    requireBuyer(intent.seller, intent.buyer, buyer);
    const snapshot = await chainSnapshot(client, expectedChainId);
    const { blockNumber, now, blockHash } = snapshot;
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
      buyerPaymentBalance,
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
      client.readContract({
        address: intent.paymentToken,
        abi: fractionTokenAbi,
        functionName: "balanceOf",
        args: [buyer],
        blockNumber,
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
    assertPaymentBalance(buyerPaymentBalance, payment);
    await assertCanonicalSnapshot(client, expectedChainId, snapshot);
    return {
      digest,
      blockNumber,
      blockHash,
      remaining: intent.maxAmount - filled,
    };
  });
}
