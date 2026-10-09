"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useUserSession } from "@/components/user-session-provider";
import { portfolioSessionKey } from "@/lib/portfolio-session";

import {
  loadPortfolioRecords,
  type Portfolio,
  type PortfolioState,
} from "@/lib/portfolio-records-state";

export function PortfolioRecords() {
  const wallet = useAccount();
  const auth = useUserSession();
  const sessionKey = portfolioSessionKey(auth, wallet);
  if (!sessionKey || !wallet.address) {
    return (
      <section className="portfolio-records" aria-live="polite">
        <h2>Runtime positions and history</h2>
        <p>
          Sign in with the connected wallet to view its holdings and history.
        </p>
      </section>
    );
  }

  return (
    <ConnectedPortfolioRecords key={sessionKey} address={wallet.address} />
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
        <button
          type="button"
          disabled={loading}
          onClick={() => setAttempt((value) => value + 1)}
        >
          Refresh positions, P&L and notifications
        </button>
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
        <PortfolioDetails portfolio={portfolio} />
      ) : null}
    </section>
  );
}

export function PortfolioDetails({ portfolio }: { portfolio: Portfolio }) {
  return (
    <div
      data-no-translate
      className="portfolio-records__grid"
      style={{ overflowWrap: "anywhere" }}
    >
      <article>
        <h3>Token positions</h3>
        <p>
          Balances are raw indexed transfer values. Token decimals have not been
          applied. Pending transfers are included; removed transfers are
          excluded.
        </p>
        {portfolio.positions.length === 0 ? (
          <p>No indexed token position is associated with this address.</p>
        ) : (
          <ul>
            {portfolio.positions.map((position) => (
              <li key={position.assetToken}>
                <strong>{position.symbol}</strong>
                <span>{position.balance} base units (unscaled)</span>
                <small>{shortAddress(position.assetToken)}</small>
                {position.balance.startsWith("-") ? (
                  <small>
                    Incomplete indexed history: this is not a verified wallet
                    balance.
                  </small>
                ) : null}
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
                key={
                  transaction.id ??
                  `${transaction.transactionHash}:${transaction.logIndex}:${transaction.eventName}`
                }
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
      <article>
        <h3>Indexed trade P&L</h3>
        <p>
          FIFO cost basis and realized P&L for confirmed native fractional
          trades only. Values are exact payment-token base units, without gas
          costs or fiat conversion. Current market value and unrealized P&L are
          unknown.
        </p>
        {!portfolio.performance ? (
          <p>Performance evidence is unavailable. P&L is unknown.</p>
        ) : (
          <>
            {portfolio.performance.reasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
            {portfolio.performance.unmappedTradeCount > 0 ? (
              <p>
                {portfolio.performance.unmappedTradeCount} fill event(s) lack
                supported fractional sale terms. Their P&L is unknown.
              </p>
            ) : null}
            {portfolio.performance.pendingEventCount > 0 ? (
              <p>
                {portfolio.performance.pendingEventCount} pending event(s) are
                excluded from confirmed calculations.
              </p>
            ) : null}
            {portfolio.performance.items.length === 0 ? (
              <p>No supported performance calculation is available.</p>
            ) : (
              <ul>
                {portfolio.performance.items.map((item) => (
                  <li key={item.assetToken}>
                    <strong title={item.assetToken}>
                      Token {shortAddress(item.assetToken)}
                    </strong>
                    <small>Asset token: {item.assetToken}</small>
                    <span>
                      Confirmed indexed quantity:{" "}
                      {item.confirmedQuantity ?? "Unknown"} base units
                    </span>
                    {item.paymentToken ? (
                      <small title={item.paymentToken}>
                        Payment token: {item.paymentToken}
                      </small>
                    ) : null}
                    <span>
                      Remaining cost basis:{" "}
                      {item.status === "known"
                        ? `${item.costBasis} payment-token base units`
                        : "Unknown"}
                    </span>
                    <span>
                      Realized P&L:{" "}
                      {item.status === "known"
                        ? `${item.realizedPnl} payment-token base units`
                        : "Unknown"}
                    </span>
                    <small>
                      {item.buyCount} matched buy fill(s) · {item.sellCount}{" "}
                      matched sell fill(s)
                    </small>
                    {item.reasons.map((reason) => (
                      <small key={reason}>{reason}</small>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </article>
      <article>
        <h3>Wallet notifications</h3>
        <p>
          The latest 100 directly wallet-relevant indexed events. Refresh to
          check confirmations and removals. A removed event supersedes its
          earlier confirmation.
        </p>
        {portfolio.notifications.length === 0 ? (
          <p>No indexed wallet notification is available.</p>
        ) : (
          <ol>
            {portfolio.notifications.map((notification) => (
              <li key={notification.id}>
                <strong>
                  {notification.eventName} · {notification.status}
                </strong>
                <span>{notification.message}</span>
                <small>
                  Block {notification.blockNumber} · log {notification.logIndex}
                </small>
                <small title={notification.transactionHash}>
                  {shortHash(notification.transactionHash)}
                </small>
                <small>Last indexed update: {notification.observedAt}</small>
              </li>
            ))}
          </ol>
        )}
      </article>
    </div>
  );
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function shortHash(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}
