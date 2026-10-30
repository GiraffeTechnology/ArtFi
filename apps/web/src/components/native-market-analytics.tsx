"use client";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { rwaAssetIdentity, type RwaAsset } from "@/lib/rwa-catalog";
import {
  NativeAnalyticsError,
  nativeAnalyticsScope,
  parseNativeAnalyticsEnvelope,
  type NativeMarketAnalytics,
} from "@/lib/native-market-analytics";
import { readNativeAnalyticsJSON } from "@/lib/native-market-analytics-read";
import styles from "./native-market-analytics.module.css";

export function NativeMarketAnalyticsPanel({ asset }: { asset: RwaAsset }) {
  if (asset.section !== "fractional") return null;
  return (
    <AnalyticsView
      key={`${rwaAssetIdentity(asset)}:${asset.revision}`}
      asset={asset}
    />
  );
}
function AnalyticsView({ asset }: { asset: RwaAsset }) {
  const id = useId();
  const [paymentToken, setPaymentToken] = useState("");
  const [data, setData] = useState<NativeMarketAnalytics>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );
  let supported = true,
    validPayment = true;
  try {
    nativeAnalyticsScope(asset, paymentToken.trim());
  } catch (e) {
    supported = !(
      e instanceof NativeAnalyticsError && e.reason === "unsupported"
    );
    validPayment = false;
  }
  function change(value: string) {
    active.current?.abort();
    active.current = null;
    setLoading(false);
    setData(undefined);
    setError("");
    setPaymentToken(value);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setData(undefined);
    setError("");
    setLoading(true);
    try {
      const scope = nativeAnalyticsScope(asset, paymentToken.trim());
      const value = await readNativeAnalyticsJSON(
        `/api/rwa/assets/${encodeURIComponent(asset.slug)}/analytics?${new URLSearchParams({ paymentToken: scope.paymentToken })}`,
        controller.signal,
      );
      const result = parseNativeAnalyticsEnvelope(value, {
        scope,
        catalogIdentity: rwaAssetIdentity(asset),
        catalogRevision: asset.revision,
      });
      if (!controller.signal.aborted && active.current === controller)
        setData(result);
    } catch (reason) {
      if (!controller.signal.aborted && active.current === controller)
        setError(
          reason instanceof NativeAnalyticsError
            ? reason.message
            : "Indexed market analytics are unavailable. No sample totals are substituted.",
        );
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
      }
    }
  }
  return (
    <section className={styles.panel} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Indexed fractional market analytics</h2>
      <p>
        Inspect matched indexed trades for this source-bound fraction token and
        market. Select the payment token explicitly; different currencies are
        never combined.
      </p>
      <p>
        These are indexed observations, not a valuation, independent chain
        finality or complete market history. Trade participants are not a holder
        distribution.
      </p>
      {supported ? (
        <form onSubmit={(event) => void submit(event)} className={styles.form}>
          <label htmlFor={`${id}-payment`}>
            Payment-token address
            <input
              id={`${id}-payment`}
              value={paymentToken}
              onChange={(event) => change(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              maxLength={64}
            />
          </label>
          <button type="submit" disabled={loading || !validPayment}>
            {loading ? "Reading indexed trades…" : "Read indexed analytics"}
          </button>
        </form>
      ) : (
        <p role="status">
          This source record has no supported native fraction market binding. No
          sample analytics are substituted.
        </p>
      )}
      <div aria-live="polite">
        {loading && (
          <p role="status">
            Reading the current source record and its indexed trades…
          </p>
        )}
        {error && <p role="status">{error}</p>}
        {data && <AnalyticsResult data={data} />}
      </div>
    </section>
  );
}
function Fact({ children }: { children: ReactNode }) {
  return (
    <span data-no-translate data-translation-skip className={styles.fact}>
      {children}
    </span>
  );
}
function AnalyticsResult({ data }: { data: NativeMarketAnalytics }) {
  const available = data.quantity !== null && data.payment !== null;
  return (
    <div>
      <h3>Matched indexed observations</h3>
      <dl className={styles.scope}>
        <div>
          <dt>Chain</dt>
          <dd>
            <Fact>{data.chainId}</Fact>
          </dd>
        </div>
        <div>
          <dt>Fraction token</dt>
          <dd>
            <Fact>{data.assetToken}</Fact>
          </dd>
        </div>
        <div>
          <dt>Market</dt>
          <dd>
            <Fact>{data.marketAddress}</Fact>
          </dd>
        </div>
        <div>
          <dt>Payment token</dt>
          <dd>
            <Fact>{data.paymentToken}</Fact>
          </dd>
        </div>
      </dl>
      {!available && (
        <p role="status">
          Conflicting or excessive indexed evidence prevents analytics. No
          partial totals are presented.
        </p>
      )}
      {available && (
        <dl className={styles.metrics}>
          <div>
            <dt>Matched indexed trades</dt>
            <dd>
              <Fact>{data.tradeCount}</Fact>
            </dd>
          </div>
          <div>
            <dt>Matched quantity · token base units</dt>
            <dd>
              <Fact>{data.quantity}</Fact>
            </dd>
          </div>
          <div>
            <dt>Matched payment · payment-token base units</dt>
            <dd>
              <Fact>{data.payment}</Fact>
            </dd>
          </div>
          <div>
            <dt>Participants in matched trades</dt>
            <dd>
              <Fact>{data.distinctParticipants}</Fact>
            </dd>
          </div>
        </dl>
      )}
      <p>
        Excluded pending fills: <Fact>{data.pendingFillCount}</Fact>. Removed
        fills: <Fact>{data.removedFillCount}</Fact>. Unmatched fills:{" "}
        <Fact>{data.unmatchedFillCount}</Fact>.
      </p>
      {data.status === "incomplete_indexed_subset" && (
        <p>
          Pending or unmatched evidence is excluded. The values above cover only
          the accepted indexed subset.
        </p>
      )}
      <h3>Indexed price history</h3>
      <p>
        Exact payment-token base units per fraction-token base unit, ordered by
        block and log position. No block time or fiat conversion is guessed.
      </p>
      {data.priceHistoryTruncated && (
        <p>
          Showing the newest 200 matched observations. Aggregate values cover
          accepted records within the API evidence bound.
        </p>
      )}
      {data.priceHistory.length ? (
        <ol className={styles.history}>
          {data.priceHistory.map((point) => (
            <li key={`${point.transactionHash}:${point.logIndex}`}>
              <dl>
                <div>
                  <dt>Block / log</dt>
                  <dd>
                    <Fact>
                      {point.blockNumber} / {point.logIndex}
                    </Fact>
                  </dd>
                </div>
                <div>
                  <dt>Unit price</dt>
                  <dd>
                    <Fact>{point.unitPrice}</Fact>
                  </dd>
                </div>
                <div>
                  <dt>Quantity / payment</dt>
                  <dd>
                    <Fact>
                      {point.quantity} / {point.payment}
                    </Fact>
                  </dd>
                </div>
                <div>
                  <dt>Transaction</dt>
                  <dd>
                    <Fact>{point.transactionHash}</Fact>
                  </dd>
                </div>
                <div>
                  <dt>Block hash</dt>
                  <dd>
                    <Fact>{point.blockHash}</Fact>
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      ) : (
        <p>No matched price observations were returned for this series.</p>
      )}
      <ul data-no-translate data-translation-skip>
        {data.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <p>
        Holder distribution remains unavailable without a complete attributed
        holder snapshot.
      </p>
    </div>
  );
}
