"use client";

import { assertRwaTradingEvidence } from "@/lib/rwa-catalog";
import { useLayoutEffect, useRef, useState } from "react";
import { isAddress, type Address, type Hex, type PublicClient } from "viem";
import { useWriteContract } from "wagmi";
import { useUserSession } from "./user-session-provider";
import {
  assertTradingSession,
  userSessionController,
} from "@/lib/user-session-client";
import { currentOperation } from "@/lib/current-operation";
import { useMarketTransactions } from "@/lib/use-market-transactions";
import { artFiFractionMarketAbi, fractionTokenAbi } from "@/lib/contracts";
import {
  readFractionMatchPlan,
  type FractionMatchRequest,
  type ObservedFractionMatchPlan,
} from "@/lib/fraction-matching";
import { executeFractionMatches } from "@/lib/fraction-match-execution";
import { verifyFractionSale } from "@/lib/signed-market-preflight";

export function FractionOrderBook({
  catalogSlug,
  catalogIdentity,
  market,
  asset,
  buyer,
  chainId,
  client,
  disabled,
  onBusy,
  onSettled,
  operationContext,
}: {
  catalogSlug?: string;
  catalogIdentity?: string;
  market: Address;
  asset: Address;
  buyer?: Address;
  chainId?: number;
  client?: PublicClient;
  operationContext: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onSettled: () => Promise<unknown>;
}) {
  const { authenticated, revision } = useUserSession();
  const { writeContractAsync } = useWriteContract();
  const [paymentToken, setPaymentToken] = useState("");
  const [quantity, setQuantity] = useState("");
  const [maxPayment, setMaxPayment] = useState("");
  const [limit, setLimit] = useState("");
  const [mode, setMode] = useState<"market" | "limit">("market");
  const [plan, setPlan] = useState<ObservedFractionMatchPlan>();
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<string>();
  const [progress, setProgress] = useState("");
  const [hash, setHash] = useState<Hex>();
  const gate = useRef(false);
  const life = useRef(currentOperation());
  const context = JSON.stringify([
    operationContext,
    market,
    asset,
    buyer,
    chainId,
    revision,
    paymentToken,
    quantity,
    maxPayment,
    limit,
    mode,
  ]);
  useLayoutEffect(() => {
    const active = currentOperation();
    life.current = active;
    return () => active.retire();
  }, [context]);
  const { pending, begin, reconcile } = useMarketTransactions(
    client,
    `560048:${market.toLowerCase()}:${asset.toLowerCase()}:${buyer?.toLowerCase()}`,
    setHash,
    {
      operationContext: context,
      beforeWrite: async () => {
        if (!buyer || chainId !== 560048)
          throw new Error("Connect the supported buyer wallet and chain.");
        await assertTradingSession(buyer, 560048);
        if (userSessionController.getSnapshot().revision !== revision)
          throw new Error("Your trading session changed.");
      },
    },
  );
  const changed = (change: () => void) => {
    life.current.retire();
    setPlan(undefined);
    setDetail(undefined);
    setProgress("");
    change();
  };
  const lock = (value: boolean) => {
    gate.current = value;
    setBusy(value);
    onBusy(value);
  };
  const request = (): FractionMatchRequest => {
    if (
      !buyer ||
      !isAddress(paymentToken) ||
      !/^[1-9][0-9]{0,77}$/.test(quantity) ||
      !/^[1-9][0-9]{0,77}$/.test(maxPayment) ||
      (mode === "limit" && !/^[1-9][0-9]{0,77}$/.test(limit))
    )
      throw new Error(
        "Enter the payment token, positive quantity, total payment limit and any limit price.",
      );
    return {
      market,
      asset,
      buyer,
      paymentToken,
      amount: BigInt(quantity),
      maxPayment: BigInt(maxPayment),
      maxUnitPrice: mode === "limit" ? BigInt(limit) : undefined,
    };
  };
  const preview = async () => {
    if (!client || gate.current || disabled || pending) return;
    const active = life.current;
    lock(true);
    setPlan(undefined);
    setDetail(undefined);
    setProgress("Checking signed orders at one chain block");
    try {
      await assertRwaTradingEvidence({
        section: "fractional",
        chainId: 560048,
        marketAddress: market,
        fractionTokenAddress: asset,
        slug: catalogSlug,
        identity: catalogIdentity,
      });
      const terms = request();
      const observed = await readFractionMatchPlan(
        client,
        terms,
        async (at) => {
          const query = new URLSearchParams({
            chainId: "560048",
            marketAddress: market,
            assetAddress: asset,
            paymentToken: terms.paymentToken,
            at: String(at),
          });
          const response = await fetch(`/api/orders/fraction-book?${query}`, {
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok)
            throw new Error(
              response.status === 422
                ? "This pair exceeds the supported complete book snapshot. No truncated match was prepared."
                : "The fraction book is unavailable.",
            );
          return response.json();
        },
      );
      active.assertCurrent();
      setPlan(observed);
      setProgress("Review the exact fills before requesting wallet approval.");
    } catch (error) {
      if (active.isCurrent()) {
        setDetail(
          error instanceof Error
            ? error.message
            : "The match plan is unavailable.",
        );
        setProgress("");
      }
    } finally {
      lock(false);
    }
  };
  const execute = async () => {
    if (
      !client ||
      !buyer ||
      !plan ||
      !plan.matches.length ||
      !authenticated ||
      chainId !== 560048 ||
      gate.current ||
      disabled ||
      pending
    )
      return;
    const active = life.current;
    const reviewed = plan;
    lock(true);
    setDetail(undefined);
    setPlan(undefined);
    let count = 0;
    try {
      await executeFractionMatches(reviewed, {
        assertCurrent: active.assertCurrent,
        settle: async (match) => {
          const operation = begin(match.order.intentHash);
          const check = async () => {
            await assertRwaTradingEvidence({
              section: "fractional",
              chainId: 560048,
              marketAddress: market,
              fractionTokenAddress: asset,
              slug: catalogSlug,
              identity: catalogIdentity,
            });
            return verifyFractionSale({
              client,
              intent: match.intent,
              signature: match.order.signature,
              buyer,
              amount: match.amount,
              expectedChainId: 560048,
              domain: { chainId: 560048, verifyingContract: market },
            });
          };
          await check();
          operation.assertCurrent();
          await operation.settle({
            onStage: (stage) =>
              setProgress(
                `${count + 1} of ${reviewed.matches.length}: ${stage === "approving" ? "confirm the exact payment allowance" : "confirm this signed fill"}`,
              ),
            approvePayment: () =>
              writeContractAsync({
                address: match.intent.paymentToken,
                abi: fractionTokenAbi,
                functionName: "approve",
                args: [market, match.payment],
                chainId: 560048,
                account: buyer,
              }),
            settle: async () => {
              // Revocation, partial fills, or loss of allowance while approving must stop execution.
              await check();
              operation.assertCurrent();
              return writeContractAsync({
                address: market,
                abi: artFiFractionMarketAbi,
                functionName: "fillIntent",
                args: [match.intent, match.order.signature, match.amount],
                chainId: 560048,
                account: buyer,
              });
            },
          });
        },
        onConfirmed: (_, completed) => {
          count = completed;
          setProgress(
            `${completed} of ${reviewed.matches.length} fills confirmed on chain.`,
          );
        },
      });
      await onSettled();
      active.assertCurrent();
      setProgress(
        `${count} fills confirmed. Bought ${reviewed.matched} fractions for ${reviewed.payment} payment units. Unfilled: ${reviewed.unfilled}.`,
      );
    } catch (error) {
      if (active.isCurrent()) {
        setDetail(
          error instanceof Error ? error.message : "Execution stopped.",
        );
        setProgress(
          `${count} fills confirmed. Execution stopped; refresh the book before requesting any remaining fills.`,
        );
      }
    } finally {
      lock(false);
    }
  };
  return (
    <section
      className="transaction-panel"
      aria-label="Fraction price-time matching"
    >
      <h3>Buy from the fractional order book</h3>
      <p>
        Lowest price first, then original publication time, then intent hash.
        Seller identity gives no priority. Orders stay in their owners&apos;
        wallets until each signed fill settles.
      </p>
      <fieldset
        disabled={busy || disabled || Boolean(pending)}
        className="field-grid"
      >
        <label>
          Execution mode
          <select
            value={mode}
            onChange={(e) =>
              changed(() => setMode(e.target.value as "market" | "limit"))
            }
          >
            <option value="market">Market, with a total payment limit</option>
            <option value="limit">Limit, with a maximum unit price</option>
          </select>
        </label>
        <label>
          Payment token
          <input
            value={paymentToken}
            onChange={(e) => changed(() => setPaymentToken(e.target.value))}
            placeholder="0x…"
          />
        </label>
        <label>
          Fractions to buy
          <input
            inputMode="numeric"
            value={quantity}
            onChange={(e) => changed(() => setQuantity(e.target.value))}
          />
        </label>
        <label>
          Maximum total payment, smallest units
          <input
            inputMode="numeric"
            value={maxPayment}
            onChange={(e) => changed(() => setMaxPayment(e.target.value))}
          />
        </label>
        {mode === "limit" && (
          <label>
            Maximum price per fraction
            <input
              inputMode="numeric"
              value={limit}
              onChange={(e) => changed(() => setLimit(e.target.value))}
            />
          </label>
        )}
      </fieldset>
      <p>
        Any unmatched quantity remains unfilled. A limit here applies to this
        execution only; it does not create an unsigned resting buy order.
      </p>
      <button
        className="secondary"
        type="button"
        disabled={
          !client ||
          !buyer ||
          !authenticated ||
          chainId !== 560048 ||
          busy ||
          disabled ||
          Boolean(pending)
        }
        onClick={preview}
      >
        Preview price-time matches
      </button>
      {plan && (
        <div>
          <p>
            Matched: {String(plan.matched)} / {String(plan.requested)}. Total
            payment: {String(plan.payment)}. Unfilled: {String(plan.unfilled)}.
          </p>
          <p>
            Observed at block {String(plan.blockNumber)}. This preview reserves
            nothing; each fill is checked again before approval and settlement.
          </p>
          <ol>
            {plan.matches.map((match) => (
              <li key={match.order.intentHash}>
                {String(match.amount)} fractions ×{" "}
                {String(match.intent.unitPrice)} = {String(match.payment)}{" "}
                payment units
                <p className="charity-digest">
                  Seller: {match.intent.seller}
                  <br />
                  Intent: {match.order.intentHash}
                </p>
              </li>
            ))}
          </ol>
          <details>
            <summary>Replay evidence</summary>
            <p className="charity-digest">
              Block: {plan.blockHash}
              <br />
              Order log: {plan.logHash}
            </p>
          </details>
          <p>
            Each fill is atomic. Multiple fills are separate transactions; a
            later failure leaves earlier confirmed fills in place.
          </p>
          <button
            type="button"
            className="primary"
            disabled={
              !plan.matches.length ||
              busy ||
              disabled ||
              Boolean(pending) ||
              !authenticated
            }
            onClick={execute}
          >
            Settle reviewed matches
          </button>
        </div>
      )}
      {pending && (
        <p>
          A {pending.kind} transaction is pending.{" "}
          <button
            className="secondary"
            type="button"
            disabled={busy || disabled}
            onClick={async () => {
              if (gate.current) return;
              const active = life.current;
              lock(true);
              setPlan(undefined);
              try {
                await reconcile();
                await onSettled();
                active.assertCurrent();
                setProgress(
                  "The transaction is confirmed. Refresh the book to match only the remaining quantity.",
                );
              } catch (error) {
                if (active.isCurrent())
                  setDetail(
                    error instanceof Error
                      ? error.message
                      : "The transaction is unconfirmed.",
                  );
              } finally {
                lock(false);
              }
            }}
          >
            Check pending transaction
          </button>
        </p>
      )}
      {progress && <p role="status">{progress}</p>}
      {hash && <p className="charity-digest">Latest transaction: {hash}</p>}
      {detail && (
        <p role="alert" className="dao-alert dao-alert--blocked">
          {detail}
        </p>
      )}
    </section>
  );
}
