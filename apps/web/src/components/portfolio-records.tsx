"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

import {
  loadPortfolioRecords,
  type PortfolioState,
} from "@/lib/portfolio-records-state";

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

export function PortfolioRecords() {
  const { address, isConnected } = useAccount();
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

  if (!address) return null;
  return (
    <ConnectedPortfolioRecords key={address.toLowerCase()} address={address} />
  );
}

function ConnectedPortfolioRecords({ address }: { address: string }) {
  const [{ portfolio, loading, error }, setState] = useState<PortfolioState>({
    loading: true,
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void loadPortfolioRecords({
      address,
      apiURL,
      signal: controller.signal,
      update: setState,
    });
    return () => controller.abort();
  }, [address, attempt]);

  return (
    <section className="portfolio-records" aria-live="polite">
      <div className="section-heading">
        <p className="approved-eyebrow">Indexed Hoodi records</p>
        <h2>Runtime positions and transaction history.</h2>
      </div>
      {loading ? <p>Loading indexed records…</p> : null}
      {error ? (
        <div>
          <p role="alert">{error} No fixture is shown as wallet data.</p>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry indexed records
          </button>
        </div>
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
