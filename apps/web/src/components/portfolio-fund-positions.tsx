"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Address, formatUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { fractionalAddress, fractionalPage } from "@/lib/fractional-records";
import {
  type FundPosition,
  fundSharePercent,
  readFundPosition,
} from "@/lib/fund-position";
import { supportedChain } from "@/lib/wagmi";

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
const pageSize = 10;
type PositionRow = { position: FundPosition } | { vault: string; name: string };
type Snapshot = {
  rows: PositionRow[];
  nextCursor: string;
  blockNumber: string;
  blockHash: string;
  blockTime: string;
  observedAt: string;
};

export function PortfolioFundPositions({
  factoryAddress,
}: {
  factoryAddress?: string;
}) {
  const { address, chainId, isConnected } = useAccount();
  const factory = factoryAddress?.toLowerCase();
  return (
    <section className="portfolio-records" aria-label="Fund token positions">
      <h2>Fund token holdings</h2>
      <p>
        Hoodi TEST_ONLY_NO_REAL_VALUE. Public read-only observations; no
        signature, approval or transfer. Token units are not an artwork
        valuation or proof of judicial ownership. Governance follows each fund's
        separate rules.
      </p>
      {!isConnected || !address ? (
        <p>Connect a wallet to read its fund token balances.</p>
      ) : chainId !== supportedChain.id ? (
        <p>Switch the connected wallet to Hoodi to view this test portfolio.</p>
      ) : !fractionalAddress(factory) ? (
        <p>
          The reviewed fund factory is not configured. No arbitrary contract is
          substituted.
        </p>
      ) : (
        <FundPages
          key={`${address.toLowerCase()}:${factory}`}
          account={address}
          factory={factory}
        />
      )}
    </section>
  );
}

function FundPages({
  account,
  factory,
}: {
  account: Address;
  factory: Address;
}) {
  const [cursors, setCursors] = useState<string[]>([""]);
  const cursor = cursors[cursors.length - 1];
  return (
    <PositionPage
      key={cursor}
      account={account}
      factory={factory}
      cursor={cursor}
      pageNumber={cursors.length}
      visited={cursors}
      back={
        cursors.length > 1
          ? () => setCursors((previous) => previous.slice(0, -1))
          : undefined
      }
      next={(value) =>
        setCursors((previous) =>
          previous.includes(value) ? previous : [...previous, value],
        )
      }
    />
  );
}

function PositionPage({
  account,
  factory,
  cursor,
  pageNumber,
  visited,
  back,
  next,
}: {
  account: Address;
  factory: Address;
  cursor: string;
  pageNumber: number;
  visited: string[];
  back?: () => void;
  next: (cursor: string) => void;
}) {
  const client = usePublicClient({ chainId: supportedChain.id });
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const load = useCallback(async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setUnavailable(false);
    // A previous page/observation is not a current balance while refreshing.
    setSnapshot(undefined);
    try {
      if (!client || (await client.getChainId()) !== supportedChain.id)
        throw new Error("HOODI_RPC_UNAVAILABLE");
      const query = new URLSearchParams({ limit: String(pageSize) });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${apiURL}/v1/fractionals?${query}`, {
        cache: "no-store",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15_000),
        ]),
      });
      if (!response.ok) throw new Error("INDEX_UNAVAILABLE");
      const page: unknown = await response.json();
      if (
        !fractionalPage(page, pageSize) ||
        page.factoryAddress !== factory ||
        (page.nextCursor && visited.includes(page.nextCursor))
      ) {
        throw new Error("INDEX_IDENTITY_MISMATCH");
      }
      const block = await client.getBlock({ blockTag: "finalized" });
      if (block.number === null || block.hash === null)
        throw new Error("FINALIZED_BLOCK_UNAVAILABLE");
      const blockNumber = block.number;
      const rows: PositionRow[] = [];
      // Bound discovery to one page and two simultaneous funds, not the entire index.
      for (let offset = 0; offset < page.data.length; offset += 2) {
        if (controller.signal.aborted) return;
        rows.push(
          ...(await Promise.all(
            page.data
              .slice(offset, offset + 2)
              .map(async (item): Promise<PositionRow> => {
                try {
                  return {
                    position: await readFundPosition(
                      client,
                      factory,
                      account,
                      item,
                      blockNumber,
                    ),
                  };
                } catch {
                  return { vault: item.vaultAddress, name: item.vaultName };
                }
              }),
          )),
        );
      }
      const canonical = await client.getBlock({ blockNumber });
      if (canonical.hash !== block.hash) throw new Error("SNAPSHOT_REORG");
      if (controller.signal.aborted) return;
      setSnapshot({
        rows,
        nextCursor: page.nextCursor,
        blockNumber: block.number.toString(),
        blockHash: block.hash,
        blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
        observedAt: new Date().toISOString(),
      });
    } catch {
      if (!controller.signal.aborted) setUnavailable(true);
    } finally {
      if (pending.current === controller) pending.current = undefined;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [account, client, cursor, factory, visited]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const refresh = window.setInterval(() => void load(), 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(refresh);
      pending.current?.abort();
    };
  }, [load]);

  return (
    <div aria-busy={loading}>
      <p data-no-translate style={{ overflowWrap: "anywhere" }}>
        Wallet {account} · factory {factory}
      </p>
      <p>
        Page {pageNumber}. Only indexed fund issuances are discoverable here. An
        empty page does not prove that this wallet has no other assets.
      </p>
      <button type="button" disabled={loading} onClick={() => void load()}>
        Refresh fund balances
      </button>
      {loading ? (
        <p role="status">Reading a finalized Hoodi snapshot…</p>
      ) : null}
      {unavailable ? (
        <p role="alert">
          Fund observations are unavailable or inconsistent. No zero balance,
          price or profit is substituted. Refresh to retry.
        </p>
      ) : null}
      {snapshot ? (
        <>
          <p data-no-translate style={{ overflowWrap: "anywhere" }}>
            Finalized block {snapshot.blockNumber} · {snapshot.blockHash}
            <br />
            Block time {snapshot.blockTime} · observed {snapshot.observedAt}
          </p>
          <p>
            Balances are snapshots at this block, not pending transactions. This
            page refreshes once a minute. Cost basis, market value and
            profit/loss are unavailable without complete priced acquisition and
            market records.
          </p>
          {snapshot.rows.length === 0 ? (
            <p>No indexed issuances on this page.</p>
          ) : null}
          <div className="portfolio-records__grid">
            {snapshot.rows.map((row) => {
              if (!("position" in row))
                return (
                  <article key={row.vault}>
                    <h3 data-no-translate>{row.name}</h3>
                    <p role="status">
                      This fund could not be reconciled with chain state.
                      Balance unknown, not zero.
                    </p>
                    <p data-no-translate style={{ overflowWrap: "anywhere" }}>
                      {row.vault}
                    </p>
                  </article>
                );
              const { issuance, balance, supply, nftHeldByVault } =
                row.position;
              return (
                <article key={issuance.vaultAddress}>
                  <h3 data-no-translate>{issuance.vaultName}</h3>
                  <dl style={{ overflowWrap: "anywhere" }}>
                    <div>
                      <dt>Your token units</dt>
                      <dd data-no-translate>{formatUnits(balance, 18)}</dd>
                    </div>
                    <div>
                      <dt>Fixed total token units</dt>
                      <dd data-no-translate>{formatUnits(supply, 18)}</dd>
                    </div>
                    <div>
                      <dt>Share of token supply (rounded down)</dt>
                      <dd data-no-translate>
                        {fundSharePercent(balance, supply)}%
                      </dd>
                    </div>
                    <div>
                      <dt>Fraction token</dt>
                      <dd data-no-translate>{issuance.fractionTokenAddress}</dd>
                    </div>
                    <div>
                      <dt>Vault</dt>
                      <dd data-no-translate>{issuance.vaultAddress}</dd>
                    </div>
                    <div>
                      <dt>Underlying NFT</dt>
                      <dd data-no-translate>
                        {issuance.collectionAddress} / {issuance.tokenId}
                      </dd>
                    </div>
                  </dl>
                  <p>
                    {nftHeldByVault
                      ? "The underlying NFT was held by this vault at the displayed block. This is not a judicial-rights or governance-eligibility determination."
                      : "Custody mismatch: the underlying NFT was not confirmed in this vault. Token balance alone does not establish backing or membership."}
                  </p>
                  <Link href="/market/fractionals">
                    View indexed fund issuances
                  </Link>
                </article>
              );
            })}
          </div>
          {snapshot.nextCursor ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => next(snapshot.nextCursor)}
            >
              Next fund page
            </button>
          ) : (
            <p>
              End of the retained issuance index, not proof of complete wallet
              history.
            </p>
          )}
        </>
      ) : null}
      {back ? (
        <button type="button" disabled={loading} onClick={back}>
          Previous fund page
        </button>
      ) : null}
    </div>
  );
}
