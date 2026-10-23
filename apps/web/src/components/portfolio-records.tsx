"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type Portfolio = {
  address: string;
  chainId: number;
  network: string;
  positions: Array<{
    assetToken: string;
    symbol: string;
    balance: string;
    updatedAt: string;
  }>;
  transactions: Array<{
    transactionHash: string;
    eventName: string;
    blockNumber: number;
    status: string;
    observedAt: string;
  }>;
  offers: unknown[];
  notifications: unknown[];
};

export function PortfolioRecords() {
  const { address, chainId, isConnected } = useAccount();
  if (!isConnected || !address || chainId !== 560048) {
    return (
      <section className="portfolio-records">
        <h2>Indexed transaction history</h2>
        <p>
          Connect a Hoodi wallet to read its indexed records. No other account's
          records are retained in this view.
        </p>
      </section>
    );
  }
  return (
    <ConnectedPortfolioRecords key={address.toLowerCase()} address={address} />
  );
}

function ConnectedPortfolioRecords({ address }: { address: string }) {
  const [portfolio, setPortfolio] = useState<Portfolio>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(
          `${apiURL}/v1/portfolio/${encodeURIComponent(address)}`,
          {
            cache: "no-store",
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15_000),
            ]),
          },
        );
        if (!response.ok)
          throw new Error(`Portfolio API returned ${response.status}.`);
        const value = (await response.json()) as Portfolio;
        if (
          !value ||
          typeof value.address !== "string" ||
          value.address.toLowerCase() !== address.toLowerCase() ||
          value.chainId !== 560048 ||
          !Array.isArray(value.positions) ||
          !Array.isArray(value.transactions)
        ) {
          throw new Error(
            "Portfolio response did not match the connected Hoodi address.",
          );
        }
        if (controller.signal.aborted) return;
        setPortfolio(value);
        setError(undefined);
      } catch {
        if (controller.signal.aborted) return;
        setError(
          "Portfolio records are unavailable or do not match this wallet.",
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    const initial = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(initial);
      controller.abort();
    };
  }, [address]);

  return (
    <section className="portfolio-records" aria-live="polite">
      <div className="section-heading">
        <p className="approved-eyebrow">Indexed Hoodi records</p>
        <h2>Retained transfer projections and transaction history.</h2>
        <p>
          Index observations are not a complete wallet history or current chain
          balance. Token amounts below are raw integer units, not prices or
          profit/loss.
        </p>
      </div>
      {loading ? <p>Loading indexed records…</p> : null}
      {error ? (
        <p role="alert">{error} No fixture is shown as wallet data.</p>
      ) : null}
      {!loading && !error && portfolio ? (
        <div className="portfolio-records__grid">
          <article>
            <h3>Indexed transfer totals</h3>
            {portfolio.positions.length === 0 ? (
              <p>No indexed token position is associated with this address.</p>
            ) : (
              <ul>
                {portfolio.positions.map((position) => (
                  <li key={position.assetToken}>
                    <strong>{position.symbol}</strong>
                    <span data-no-translate>{position.balance} raw units</span>
                    <small>{shortAddress(position.assetToken)}</small>
                  </li>
                ))}
              </ul>
            )}
          </article>
          <article>
            <h3>Transaction history</h3>
            {portfolio.transactions.length === 0 ? (
              <p>No indexed transaction is associated with this address.</p>
            ) : (
              <ol>
                {portfolio.transactions.map((transaction, index) => (
                  <li
                    key={`${transaction.transactionHash}:${transaction.eventName}:${index}`}
                  >
                    <strong>{transaction.eventName}</strong>
                    <span>
                      {transaction.status} · block {transaction.blockNumber}
                    </span>
                    <small>{shortHash(transaction.transactionHash)}</small>
                  </li>
                ))}
              </ol>
            )}
          </article>
        </div>
      ) : null}
    </section>
  );
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function shortHash(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}
