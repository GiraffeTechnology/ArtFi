"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FractionalCatalogPage,
  FractionalCatalogRecord,
} from "@giraffetechnology/artfi-api-client";
import { fractionalPage } from "@/lib/fractional-records";

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
const pageSize = 20;
type Snapshot = {
  items: FractionalCatalogRecord[];
  factory: string;
  nextCursor: string;
  fetchedAt: string;
};

type GovernanceIdentity = { vaultAddress: string; tokenAddress: string };

export function FractionalCatalog({
  governance,
}: {
  governance?: GovernanceIdentity;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const current = useRef<Snapshot | undefined>(undefined);
  const pending = useRef<AbortController | undefined>(undefined);
  const cursors = useRef(new Set<string>());

  const load = useCallback(async (cursor?: string) => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const query = new URLSearchParams({ limit: String(pageSize) });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${apiURL}/v1/fractionals?${query}`, {
        cache: "no-store",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15_000),
        ]),
      });
      if (!response.ok) throw new Error("FRACTIONAL_CATALOG_UNAVAILABLE");
      const page = (await response.json()) as FractionalCatalogPage;
      const previous = cursor ? current.current : undefined;
      if (
        !fractionalPage(page, pageSize) ||
        (page.nextCursor !== "" &&
          (!/^[A-Za-z0-9_-]+$/.test(page.nextCursor) ||
            page.data.length === 0 ||
            page.nextCursor === cursor ||
            (cursor && cursors.current.has(page.nextCursor)))) ||
        (cursor && (!previous || previous.factory !== page.factoryAddress))
      ) {
        throw new Error("FRACTIONAL_CATALOG_INVALID");
      }
      const items = [...(previous?.items ?? []), ...page.data];
      const vaults = new Set<string>();
      let lastEvent: bigint | undefined;
      for (const item of items) {
        const eventID = BigInt(item.eventId);
        if (
          vaults.has(item.vaultAddress) ||
          (lastEvent !== undefined && eventID >= lastEvent)
        ) {
          throw new Error("FRACTIONAL_CATALOG_CONFLICT");
        }
        vaults.add(item.vaultAddress);
        lastEvent = eventID;
      }
      if (controller.signal.aborted) return;
      if (!cursor) cursors.current.clear();
      if (page.nextCursor) cursors.current.add(page.nextCursor);
      const next = {
        items,
        factory: page.factoryAddress,
        nextCursor: page.nextCursor,
        fetchedAt: new Date().toISOString(),
      };
      current.current = next;
      setSnapshot(next);
    } catch {
      if (!controller.signal.aborted) {
        current.current = undefined;
        setSnapshot(undefined);
        setError(
          "Indexed fractional records are unavailable. No fixture, balance or price is substituted. Refresh to retry.",
        );
      }
    } finally {
      if (pending.current === controller) pending.current = undefined;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(initial);
      pending.current?.abort();
    };
  }, [load]);

  return (
    <section aria-label="Indexed fund-token issuances">
      <p>
        Hoodi TEST_ONLY_NO_REAL_VALUE. These are indexed issuance events, not a
        current custody check, available-for-sale quantity, valuation or
        investor balance. Governance participation follows the fund model and
        its rules; token possession alone is not a judicial-rights assertion.
      </p>
      <button type="button" disabled={loading} onClick={() => void load()}>
        {loading ? "Loading indexed issuances…" : "Refresh indexed issuances"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p role="status">Reading the issuance index…</p> : null}
      {snapshot ? (
        <>
          <p data-no-translate style={{ overflowWrap: "anywhere" }}>
            Factory {snapshot.factory} · fetched {snapshot.fetchedAt}
          </p>
          <p>
            Snapshot only. Refresh for changes or removed events; no live chain
            revalidation is implied.
          </p>
          {snapshot.items.length === 0 ? (
            <p>No linked confirmed issuances are indexed yet.</p>
          ) : null}
          <div className="artwork-grid">
            {snapshot.items.map((item) => (
              <article className="market-mirror-card" key={item.eventId}>
                <div className="market-mirror-card__body">
                  <span className="mirror-badge">
                    Indexed fund-token issuance
                  </span>
                  <h2 data-no-translate>{item.vaultName}</h2>
                  {governance?.vaultAddress === item.vaultAddress &&
                  governance.tokenAddress === item.fractionTokenAddress ? (
                    <Link
                      href={`/dao?${new URLSearchParams({ chainId: "560048", vault: item.vaultAddress, token: item.fractionTokenAddress })}`}
                    >
                      Open this fund's configured governance
                    </Link>
                  ) : (
                    <p>Governance is not configured here for this issuance.</p>
                  )}
                  <dl style={{ overflowWrap: "anywhere" }}>
                    <div>
                      <dt>Source NFT collection</dt>
                      <dd data-no-translate>{item.collectionAddress}</dd>
                    </div>
                    <div>
                      <dt>Source token ID</dt>
                      <dd data-no-translate>{item.tokenId}</dd>
                    </div>
                    <div>
                      <dt>Vault</dt>
                      <dd data-no-translate>{item.vaultAddress}</dd>
                    </div>
                    <div>
                      <dt>Fraction token</dt>
                      <dd data-no-translate>{item.fractionTokenAddress}</dd>
                    </div>
                    <div>
                      <dt>Raw issued units</dt>
                      <dd data-no-translate>{item.supply}</dd>
                    </div>
                    <div>
                      <dt>Recipient at issuance (not current holder)</dt>
                      <dd data-no-translate>{item.issuanceRecipient}</dd>
                    </div>
                    <div>
                      <dt>Issuance transaction</dt>
                      <dd data-no-translate>{item.transactionHash}</dd>
                    </div>
                    <div>
                      <dt>Block / log index</dt>
                      <dd data-no-translate>
                        {item.blockNumber} / {item.logIndex}
                      </dd>
                    </div>
                    <div>
                      <dt>Indexed observation</dt>
                      <dd data-no-translate>{item.observedAt}</dd>
                    </div>
                  </dl>
                </div>
              </article>
            ))}
          </div>
          {snapshot.nextCursor ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(snapshot.nextCursor)}
            >
              Load more indexed issuances
            </button>
          ) : (
            <p>
              End of retained indexed records. This is not proof of complete
              chain history.
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
