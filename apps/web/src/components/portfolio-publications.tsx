"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import { isAddress } from "viem";
import { useUserSession } from "./user-session-provider";
import { portfolioSessionKey } from "@/lib/portfolio-session";
import {
  initialPortfolioPublicationFilter,
  portfolioPublicationNavigation,
  requestPortfolioPublications,
  type PortfolioPublicationFilter,
} from "@/lib/portfolio-publications";
import type { NativeOrderPage } from "@/lib/native-order-page";

export function PortfolioPublications() {
  const wallet = useAccount();
  const auth = useUserSession();
  const key = portfolioSessionKey(auth, wallet);
  if (!key || !wallet.address || wallet.chainId !== 560048) {
    return (
      <section className="portfolio-records" aria-live="polite">
        <h2>Your published sale authorizations</h2>
        <p>
          Sign in with the connected Hoodi wallet to view its published native
          sale records.
        </p>
      </section>
    );
  }
  return (
    <ConnectedPublications key={key} address={wallet.address.toLowerCase()} />
  );
}

function ConnectedPublications({ address }: { address: string }) {
  const id = useId();
  const [filter, setFilter] = useState<PortfolioPublicationFilter>({
    ...initialPortfolioPublicationFilter,
  });
  const [assetInput, setAssetInput] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<NativeOrderPage>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    void requestPortfolioPublications(address, filter, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted && active.current === controller)
          setData(page);
      })
      .catch(() => {
        if (!controller.signal.aborted && active.current === controller)
          setError(
            "Published sale records are unavailable. Retry or sign in again if your session ended.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted && active.current === controller) {
          active.current = null;
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      if (active.current === controller) active.current = null;
    };
  }, [address, filter, attempt]);

  function change(next: PortfolioPublicationFilter) {
    active.current?.abort();
    active.current = null;
    setData(undefined);
    setError("");
    setLoading(true);
    setFilter(next);
  }
  function refresh() {
    active.current?.abort();
    active.current = null;
    setData(undefined);
    setError("");
    setLoading(true);
    setAttempt((value) => value + 1);
  }
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const assetAddress = assetInput.trim();
    // The same exact filter contract is checked again by the private route.
    if (assetAddress && !isAddress(assetAddress)) {
      setError(
        "Enter a complete asset-token or collection address, or leave it empty.",
      );
      return;
    }
    change({ ...filter, assetAddress, page: 1 });
  }
  const navigation = data ? portfolioPublicationNavigation(data) : undefined;
  return (
    <section
      className="portfolio-records"
      aria-labelledby={id}
      data-testid="portfolio-publications"
    >
      <div className="section-heading">
        <h2 id={id}>Your published sale authorizations</h2>
        <button type="button" onClick={refresh} disabled={loading}>
          Refresh published records
        </button>
      </div>
      <p>
        Native whole-artwork and fractional sale publications from the
        application index, oldest publication first. Buyer offers and
        external-venue orders are not included.
      </p>
      <p>
        A publication is not proof that an order is currently fillable,
        unrevoked, funded or settled. Review the current source and chain state
        in the native market before any action.
      </p>
      <form
        className="field-grid"
        onSubmit={apply}
        aria-label="Filter published sale records"
      >
        <label>
          Published sale kind
          <select
            aria-label="Published sale kind"
            value={filter.kind}
            onChange={(event) =>
              change({
                ...filter,
                kind: event.target.value as PortfolioPublicationFilter["kind"],
                page: 1,
              })
            }
          >
            <option value="all">All native sale kinds</option>
            <option value="whole">Whole-artwork sale authorizations</option>
            <option value="fraction">Fractional sale authorizations</option>
          </select>
        </label>
        <label>
          Published asset or collection address
          <input
            data-no-translate
            autoComplete="off"
            spellCheck={false}
            maxLength={42}
            value={assetInput}
            onChange={(event) => setAssetInput(event.target.value)}
          />
        </label>
        <button type="submit">Apply publication asset filter</button>
        <button
          type="button"
          onClick={() => {
            setAssetInput("");
            change({ ...initialPortfolioPublicationFilter });
          }}
        >
          Reset publication filters
        </button>
      </form>
      <p>
        Active asset filter:{" "}
        <span data-no-translate>{filter.assetAddress || "All assets"}</span>.
      </p>
      <div aria-live="polite">
        {loading ? (
          <p role="status">Reading published sale records...</p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {data ? <PortfolioPublicationEntries page={data} /> : null}
      </div>
      {data ? (
        <nav aria-label="Published sale record pages">
          <button
            type="button"
            disabled={loading || !navigation?.previous}
            onClick={() => change({ ...filter, page: filter.page - 1 })}
          >
            Previous publication page
          </button>
          <span> Publication page {data.page} </span>
          <button
            type="button"
            disabled={loading || !navigation?.next}
            onClick={() => change({ ...filter, page: filter.page + 1 })}
          >
            Next publication page
          </button>
        </nav>
      ) : null}
      {navigation?.queryLimitReached ? (
        <p role="status">
          The index query page limit was reached. This does not establish
          complete publication history.
        </p>
      ) : null}
    </section>
  );
}

export function PortfolioPublicationEntries({
  page,
}: {
  page: NativeOrderPage;
}) {
  const navigation = portfolioPublicationNavigation(page);
  return (
    <div style={{ overflowWrap: "anywhere" }}>
      <p>
        Returned {page.data.length} record(s) on this page. The index reported{" "}
        {page.total} publication(s) for the selected wallet and filters.
      </p>
      <p>
        Counts and pages can change as records are published; they are not a
        frozen snapshot or a count of active orders.
      </p>
      {navigation.reportedCountChanged ? (
        <p role="status">
          The returned records are newer than the reported count. Refresh to
          reconcile the index.
        </p>
      ) : null}
      {page.data.length === 0 ? (
        <p>
          No publication was returned on this page for the selected wallet and
          filters. Refresh or return to the previous page if the index changed.
        </p>
      ) : (
        <ol
          start={(page.page - 1) * page.pageSize + 1}
          className="portfolio-records__grid"
        >
          {page.data.map((order) => (
            <li
              key={`${order.chainId}:${order.marketAddress}:${order.intentHash}`}
              data-testid="portfolio-publication-record"
            >
              <article>
                <h3>
                  {order.kind === "whole"
                    ? "Whole-artwork sale authorization"
                    : "Fractional sale authorization"}
                </h3>
                <p>
                  Source: native application publication index. Execution status
                  is not established by this record.
                </p>
                <dl className="wallet-facts">
                  <div>
                    <dt>Chain</dt>
                    <dd data-no-translate>{order.chainId}</dd>
                  </div>
                  <div>
                    <dt>Seller</dt>
                    <dd data-no-translate>{order.intent.seller}</dd>
                  </div>
                  <div>
                    <dt>Market</dt>
                    <dd data-no-translate>{order.marketAddress}</dd>
                  </div>
                  <div>
                    <dt>Intent hash</dt>
                    <dd data-no-translate>{order.intentHash}</dd>
                  </div>
                  <div>
                    <dt>Asset or collection</dt>
                    <dd data-no-translate>
                      {
                        order.intent[
                          order.kind === "whole" ? "collection" : "assetToken"
                        ]
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>
                      {order.kind === "whole"
                        ? "Token ID"
                        : "Authorized maximum quantity, base units"}
                    </dt>
                    <dd data-no-translate>
                      {
                        order.intent[
                          order.kind === "whole" ? "tokenId" : "maxAmount"
                        ]
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>
                      {order.kind === "whole"
                        ? "Price, payment-token base units"
                        : "Price per fraction base unit"}
                    </dt>
                    <dd data-no-translate>
                      {
                        order.intent[
                          order.kind === "whole" ? "price" : "unitPrice"
                        ]
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>Payment token</dt>
                    <dd data-no-translate>{order.intent.paymentToken}</dd>
                  </div>
                  <div>
                    <dt>Authorized buyer (zero means unrestricted)</dt>
                    <dd data-no-translate>{order.intent.buyer}</dd>
                  </div>
                  <div>
                    <dt>Starts / ends, Unix seconds</dt>
                    <dd data-no-translate>
                      {order.intent.startsAt} / {order.intent.endsAt}
                    </dd>
                  </div>
                  <div>
                    <dt>Published at, index UTC</dt>
                    <dd data-no-translate>{order.createdAt}</dd>
                  </div>
                </dl>
              </article>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
