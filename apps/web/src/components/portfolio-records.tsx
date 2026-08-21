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
  const { address, isConnected } = useAccount();
  const [portfolio, setPortfolio] = useState<Portfolio>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!address || !isConnected) {
      return;
    }
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(
          `${apiURL}/v1/portfolio/${encodeURIComponent(address)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(`Portfolio API returned ${response.status}.`);
        const value = (await response.json()) as Portfolio;
        if (
          value.address.toLowerCase() !== address.toLowerCase() ||
          value.chainId !== 11155111
        ) {
          throw new Error(
            "Portfolio response did not match the connected Sepolia address.",
          );
        }
        setPortfolio(value);
        setError(undefined);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Portfolio records are unavailable.",
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [address, isConnected]);

  if (!isConnected) {
    return (
      <section className="portfolio-records" aria-live="polite">
        <h2>Runtime positions and history</h2>
        <p>
          Connect a wallet to query the indexed public records for its address.
        </p>
      </section>
    );
  }

  return (
    <section className="portfolio-records" aria-live="polite">
      <div className="section-heading">
        <p className="approved-eyebrow">Indexed Sepolia records</p>
        <h2>Runtime positions and transaction history.</h2>
      </div>
      {loading ? <p>Loading indexed records…</p> : null}
      {error ? (
        <p role="alert">{error} No fixture is shown as wallet data.</p>
      ) : null}
      {!loading && !error && portfolio ? (
        <div className="portfolio-records__grid">
          <article>
            <h3>Token positions</h3>
            {portfolio.positions.length === 0 ? (
              <p>No indexed token position is associated with this address.</p>
            ) : (
              <ul>
                {portfolio.positions.map((position) => (
                  <li key={position.assetToken}>
                    <strong>{position.symbol}</strong>
                    <span>{position.balance} units</span>
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
                {portfolio.transactions.map((transaction) => (
                  <li
                    key={`${transaction.transactionHash}:${transaction.eventName}`}
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
