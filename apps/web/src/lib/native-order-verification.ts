import { publicSetting } from "@/lib/public-runtime-config";
import "server-only";
import {
  verifyCanonicalEOASignature,
  verifyMarketSignature,
} from "./market-signature";
import { createPublicClient, http, isAddress } from "viem";
import { hoodi } from "viem/chains";
import { decodeNativeOrder, type NativeOrder } from "./native-order";

import { readRwaCatalog } from "./rwa-catalog-server";
import {
  assertRwaAssetBinding,
  assertLegacyWholeSettlement,
} from "./rwa-catalog";

export class OrderVerificationUnavailable extends Error {}

function contractWalletReader() {
  if (process.env.ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE?.trim() !== "sin")
    throw new OrderVerificationUnavailable(
      "Contract-wallet order verification is unavailable outside the configured SIN execution zone.",
    );
  const rpcURL = process.env.ARTFI_RPC_URL?.trim();
  if (!rpcURL)
    throw new OrderVerificationUnavailable(
      "Contract-wallet order verification is unavailable.",
    );
  return createPublicClient({ chain: hoodi, transport: http(rpcURL) });
}

/** Verify existing sale authority; publication consent is a seller-bound session POST. */
export async function verifyNativeOrderSale(order: NativeOrder) {
  const decoded = decodeNativeOrder(order);
  const configured =
    decoded.kind === "whole"
      ? publicSetting("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_MARKET_ADDRESS")?.trim()
      : publicSetting("NEXT_PUBLIC_ARTFI_FRACTION_MARKET_ADDRESS")?.trim();
  if (!configured || !isAddress(configured))
    throw new OrderVerificationUnavailable(
      "This market deployment is not configured.",
    );
  if (order.marketAddress.toLowerCase() !== configured.toLowerCase())
    throw new Error("The order targets a different market deployment.");
  if (decoded.kind === "whole") {
    // The current server-owned catalog, rather than a caller-supplied flag,
    // determines whether the legacy direct-payment market can be used.
    const binding = {
      section: "whole" as const,
      chainId: order.chainId,
      marketAddress: order.marketAddress,
      collectionAddress: decoded.intent.collection,
      tokenId: String(decoded.intent.tokenId),
    };
    try {
      const page = await readRwaCatalog(
        new URLSearchParams({
          section: "whole",
          chainId: String(order.chainId),
          collectionAddress: binding.collectionAddress,
          tokenId: binding.tokenId,
          page: "1",
          pageSize: "2",
        }),
      );
      if (page.total !== 1 || page.data.length !== 1)
        throw new Error("No unique current asset binding.");
      assertRwaAssetBinding(page.data[0], binding);
      assertLegacyWholeSettlement(page.data[0]);
    } catch {
      throw new OrderVerificationUnavailable(
        "The legacy whole-artwork market is unavailable for this current source binding.",
      );
    }
  }
  const address = decoded.intent.seller;
  // Strict local ECDSA admission does not claim the address currently has no code or that
  // settlement will succeed. The buyer performs the mandatory current-chain branch check.
  const saleValid = await verifyCanonicalEOASignature(
    address,
    order.intentHash,
    order.signature,
  );
  if (saleValid) return;
  const client = contractWalletReader();
  if ((await client.getChainId()) !== order.chainId)
    throw new OrderVerificationUnavailable(
      "Contract-wallet verification is connected to a different chain.",
    );
  const block = await client.getBlock({ blockTag: "latest" });
  if (block.number === null)
    throw new OrderVerificationUnavailable(
      "Contract-wallet verification has no mined block.",
    );
  if (
    !(await verifyMarketSignature(
      client,
      address,
      order.marketAddress,
      order.intentHash,
      order.signature,
      block.number,
    ))
  ) {
    throw new Error("The seller's sale signature is invalid.");
  }
}
