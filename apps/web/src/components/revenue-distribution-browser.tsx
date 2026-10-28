"use client";
import { useEffect, useRef, useState } from "react";
import type { PublicClient } from "viem";
import {
  readRevenueDistributionInventory,
  revenueDistributionIds,
  type RevenueDistributionInventory,
} from "@/lib/revenue-distribution-discovery";
import { revenueReadDeadline, type RevenueBinding } from "@/lib/revenue-claims";

export function RevenueDistributionSelection({
  inventory,
  offset,
  disabled,
  onOffset,
  onSelect,
}: {
  inventory: RevenueDistributionInventory;
  offset: bigint;
  disabled: boolean;
  onOffset: (offset: bigint) => void;
  onSelect: (id: string) => void;
}) {
  const page = revenueDistributionIds(inventory, offset);
  return (
    <div>
      <p data-no-translate>
        {String(inventory.count)} distribution IDs observed at block{" "}
        {String(inventory.blockNumber)} ({inventory.blockHash}).
      </p>
      <p>
        This ID range is a read-only observation. Select a round to inspect its
        funded terms and your historical entitlement. New rounds appear after
        refreshing; this list confirms no payment or claim.
      </p>
      {page.ids.length === 0 ? (
        <p>No distributions existed at this observed block.</p>
      ) : (
        <ul aria-label="Observed revenue distribution IDs">
          {page.ids.map((id) => (
            <li key={String(id)}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect(String(id))}
              >
                Read distribution <span data-no-translate>{String(id)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(page.newer || page.older) && (
        <nav
          className="product-actions"
          aria-label="Revenue distribution pages"
        >
          <button
            type="button"
            disabled={disabled || !page.newer}
            onClick={() => onOffset(page.offset - 10n)}
          >
            Newer distribution IDs
          </button>
          <button
            type="button"
            disabled={disabled || !page.older}
            onClick={() => onOffset(page.offset + 10n)}
          >
            Older distribution IDs
          </button>
        </nav>
      )}
    </div>
  );
}

export function RevenueDistributionBrowser({
  client,
  binding,
  disabled,
  beforeRead,
  onSelect,
}: {
  client: PublicClient | undefined;
  binding: RevenueBinding;
  disabled: boolean;
  beforeRead: () => Promise<void>;
  onSelect: (id: string) => void;
}) {
  const [inventory, setInventory] = useState<RevenueDistributionInventory>();
  const [offset, setOffset] = useState(0n),
    [loading, setLoading] = useState(false),
    [failed, setFailed] = useState(false);
  const active = useRef(true),
    generation = useRef(0),
    gate = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
    };
  }, []);
  const { distributor, fractionToken, account } = binding;
  async function discover() {
    if (!client || disabled || gate.current) return;
    gate.current = true;
    setLoading(true);
    setFailed(false);
    setInventory(undefined);
    setOffset(0n);
    const ticket = ++generation.current;
    let reading = true;
    const current = () =>
      reading && active.current && ticket === generation.current;
    try {
      const result = await revenueReadDeadline(async () => {
        await beforeRead();
        if (!current()) throw new Error("Retired revenue discovery.");
        const result = await readRevenueDistributionInventory(client, {
          distributor,
          fractionToken,
          account,
        });
        if (!current()) throw new Error("Retired revenue discovery.");
        await beforeRead();
        if (!current()) throw new Error("Retired revenue discovery.");
        return result;
      });
      if (current()) setInventory(result);
    } catch {
      if (current()) setFailed(true);
    } finally {
      gate.current = false;
      if (current()) setLoading(false);
      reading = false;
    }
  }
  return (
    <section aria-label="Discover revenue distributions" aria-busy={loading}>
      <h3>Find a distribution</h3>
      <button
        type="button"
        disabled={!client || disabled || loading}
        onClick={() => void discover()}
      >
        Read available distribution IDs
      </button>
      {loading && <p role="status">Reading the configured distributor…</p>}
      {failed && (
        <p role="alert">
          The distribution inventory could not be verified. This does not mean
          there are no rounds. Retry the read or enter a known distribution ID.
        </p>
      )}
      {inventory && (
        <RevenueDistributionSelection
          inventory={inventory}
          offset={offset}
          disabled={disabled || loading}
          onOffset={setOffset}
          onSelect={onSelect}
        />
      )}
    </section>
  );
}
