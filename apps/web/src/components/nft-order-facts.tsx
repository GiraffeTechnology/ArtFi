import { formatEther } from "viem";
import type { NftOrderView } from "@/lib/nft/model";

/** Source facts stay exact while the surrounding interface copy can translate. */
export function NftOrderFacts({ order }: { order: NftOrderView }) {
  const expires = new Date(order.expiresAt * 1000);
  return (
    <>
      <h4>
        {order.side === "listing" ? "Listing" : "Offer"} ·{" "}
        <span data-no-translate>{formatEther(BigInt(order.priceWei))}</span>{" "}
        <span data-no-translate>{order.currency}</span>
      </h4>
      <p>
        Quantity <span data-no-translate>{order.quantity}</span> · Maker{" "}
        <span data-no-translate>{order.maker}</span>
      </p>
      <p>
        Expires{" "}
        <time dateTime={expires.toISOString()} data-no-translate>
          {expires.toLocaleString()}
        </time>{" "}
        · <span data-no-translate>{order.status}</span>
      </p>
      <p className="nft-market-hash">
        Order <span data-no-translate>{order.hash}</span>
      </p>
      {order.sourceURL && (
        <p className="nft-market-hash">
          Attributed source (reference only):{" "}
          <span data-no-translate>{order.sourceURL}</span>
        </p>
      )}
    </>
  );
}
