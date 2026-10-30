"use client";

import { formatEther } from "viem";
import { nftRights, type NftPlan } from "@/lib/nft/model";

export type NftReviewOperation = {
  id: string;
  status: string;
  walletStarted?: boolean;
  plan: NftPlan;
  transactionHash?: string;
  orderHash?: string;
};
type Props = {
  operation: NftReviewOperation;
  busy: boolean;
  attempted?: boolean;
  onConfirm(): void;
  onAbandon(): void;
  onDiscardUnsubmittedSignature(): void;
  onCancelAccepted(): void;
  onClose(): void;
};
const reviewTitles = {
  list: "Review listing",
  offer: "Review offer",
  buy: "Review purchase",
  accept: "Review offer acceptance",
  cancel: "Review order cancellation",
} as const;
/** Fixed UI copy may be translated; authoritative facts and the original review
 * summary remain exact and are never submitted to the page translator. */
export function NftActionReview({
  operation,
  busy,
  attempted,
  onConfirm,
  onAbandon,
  onDiscardUnsubmittedSignature,
  onCancelAccepted,
  onClose,
}: Props) {
  const { plan } = operation;
  return (
    <section
      className="nft-review"
      aria-label="Wallet action review"
      data-testid="nft-action-review"
    >
      <h3>{reviewTitles[plan.request.action]}</h3>
      <p data-no-translate>{plan.summary}</p>
      <p>
        Collection <span data-no-translate>{plan.scope.label}</span> ·{" "}
        <span data-no-translate>{plan.scope.chain}</span>
      </p>
      <p>
        Contract <span data-no-translate>{plan.scope.contract}</span> · Token{" "}
        <span data-no-translate>{plan.request.tokenId}</span> · Quantity{" "}
        <span data-no-translate>{plan.request.quantity}</span>
      </p>
      <p>
        Order total{" "}
        <span data-no-translate>
          {formatEther(BigInt(plan.orderTotalWei ?? plan.request.priceWei))}{" "}
          {plan.paymentToken ||
            (["offer", "accept"].includes(plan.request.action)
              ? "WETH"
              : "ETH")}
        </span>
        {plan.request.action === "accept" ? " before the fees below" : ""}.
        {plan.request.action === "cancel"
          ? " Cancellation sends no purchase payment."
          : " Wallet-estimated gas is additional."}
      </p>
      <p>
        Order expiry{" "}
        <time data-no-translate>
          {new Date(
            (plan.orderExpiresAt ?? plan.request.expiresAt) * 1000,
          ).toLocaleString()}
        </time>
      </p>
      {plan.kind === "approval" &&
        ["list", "offer"].includes(plan.request.action) && (
          <p>
            This approval does not publish an order. Review the venue fees in
            the next signing step.
          </p>
        )}
      <p>
        Wallet <span data-no-translate>{plan.request.account}</span> · Chain{" "}
        <span data-no-translate>{plan.chainId}</span>
      </p>
      <p>{nftRights(plan.scope.charity)}</p>
      {plan.fees.map((fee, index) => (
        <p key={index}>
          Fee{" "}
          <span data-no-translate>
            {formatEther(BigInt(fee.amountWei))} ETH/WETH
          </span>{" "}
          to <span data-no-translate>{fee.recipient}</span>
        </p>
      ))}
      <p>
        Status: <span data-no-translate>{operation.status}</span>
      </p>
      {operation.transactionHash && (
        <p className="nft-market-hash">
          Transaction <span data-no-translate>{operation.transactionHash}</span>
        </p>
      )}
      {operation.orderHash && (
        <p className="nft-market-hash">
          Order <span data-no-translate>{operation.orderHash}</span>
        </p>
      )}
      <button
        disabled={
          busy ||
          operation.status !== "awaiting-wallet" ||
          operation.walletStarted ||
          attempted
        }
        onClick={onConfirm}
      >
        Confirm in wallet
      </button>
      {operation.status === "awaiting-wallet" &&
        !operation.walletStarted &&
        !attempted && (
          <button disabled={busy} onClick={onAbandon}>
            Discard unsigned review
          </button>
        )}
      {operation.status === "awaiting-wallet" &&
        operation.walletStarted &&
        plan.kind === "signature" && (
          <button disabled={busy} onClick={onDiscardUnsubmittedSignature}>
            Discard unsubmitted signature review
          </button>
        )}
      {operation.status === "accepted" && (
        <button disabled={busy} onClick={onCancelAccepted}>
          Cancel this order on chain
        </button>
      )}
      {plan.sourceURL && (
        <p className="nft-market-hash">
          Attributed source (reference only):{" "}
          <span data-no-translate>{plan.sourceURL}</span>
        </p>
      )}
      <button disabled={busy} onClick={onClose}>
        Close review
      </button>
    </section>
  );
}
