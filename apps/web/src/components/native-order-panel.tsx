"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Address, PublicClient } from "viem";
import { currentOperation } from "@/lib/current-operation";
import { useUserSession } from "@/components/user-session-provider";
import {
  assertTradingSession,
  userSessionController,
} from "@/lib/user-session-client";
import {
  decodeNativeOrder,
  nativeOrderAuthorization,
  nativeOrderFromAuthorization,
  type NativeOrder,
  type NativeOrderKind,
} from "@/lib/native-order";
import {
  readNativeOrderState,
  type NativeOrderState,
} from "@/lib/native-order-state";

/** Public immutable sale terms, with a separate seller-session publication action. */
export function NativeOrderPanel({
  kind,
  market,
  asset,
  tokenId,
  authorization,
  operationContext,
  onSelect,
  publicClient,
}: {
  kind: NativeOrderKind;
  market: Address;
  asset: Address;
  tokenId?: bigint;
  authorization?: string;
  operationContext: string;
  onSelect: (authorization: string) => void;
  publicClient?: PublicClient;
}) {
  const { authenticated, revision } = useUserSession();
  const [orders, setOrders] = useState<NativeOrder[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [detail, setDetail] = useState<string>();
  const [selected, setSelected] = useState<NativeOrder>();
  const [states, setStates] = useState<Record<string, NativeOrderState>>({});
  const [refresh, setRefresh] = useState(0);
  const [linked, setLinked] = useState<string | null>(null);
  const [published, setPublished] = useState<string>();
  const generation = useRef(0);
  const publication = useRef(currentOperation());
  useLayoutEffect(() => {
    const operation = currentOperation();
    publication.current = operation;
    return () => operation.retire();
  }, [authorization, operationContext, revision]);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  const accept = useCallback(
    (value: unknown) => {
      const decoded = decodeNativeOrder(value);
      if (
        decoded.kind !== kind ||
        decoded.order.marketAddress.toLowerCase() !== market.toLowerCase() ||
        (decoded.kind === "whole"
          ? decoded.intent.collection.toLowerCase() !== asset.toLowerCase() ||
            decoded.intent.tokenId !== tokenId
          : decoded.intent.assetToken.toLowerCase() !== asset.toLowerCase())
      ) {
        throw new Error("This order belongs to a different asset or market.");
      }
      return decoded.order;
    },
    [kind, market, asset, tokenId],
  );
  const clearSelection = useCallback(() => {
    onSelectRef.current("");
    setSelected(undefined);
    setDetail(undefined);
  }, []);
  useEffect(() => {
    const restore = () => {
      generation.current++;
      clearSelection();
      setLinked(new URL(window.location.href).searchParams.get("order"));
      setRefresh((value) => value + 1);
    };
    restore();
    window.addEventListener("popstate", restore);
    const lifetime = generation;
    return () => {
      lifetime.current++;
      window.removeEventListener("popstate", restore);
    };
  }, [clearSelection]);
  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    // Retire actionable terms before an asynchronous lookup can display different terms.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    clearSelection();
    setLoading(true);
    setOrders([]);
    setStates({});
    const scope = new URLSearchParams({
      chainId: "560048",
      marketAddress: market,
    });
    const query = new URLSearchParams({
      ...Object.fromEntries(scope),
      kind,
      assetAddress: asset,
      page: String(page),
      pageSize: "20",
    });
    if (kind === "whole" && tokenId !== undefined)
      query.set("tokenId", String(tokenId));
    const read = async (url: string) => {
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? "The linked order was not found."
            : "The order service is unavailable. Try again.",
        );
      return response.json();
    };
    const active = () =>
      !controller.signal.aborted && generation.current === current;
    void (async () => {
      try {
        // Restore the exact hash independently of the visible list page.
        if (linked !== null) {
          if (!/^0x[0-9a-fA-F]{64}$/.test(linked))
            throw new Error("The order link is malformed.");
          const order = accept(await read(`/api/orders/${linked}?${scope}`));
          if (order.intentHash.toLowerCase() !== linked.toLowerCase())
            throw new Error("The linked order returned different terms.");
          if (!active()) return;
          setSelected(order);
          onSelectRef.current(nativeOrderAuthorization(order));
        }
        const body: unknown = await read(`/api/orders?${query}`);
        if (
          !body ||
          typeof body !== "object" ||
          !("data" in body) ||
          !Array.isArray(body.data) ||
          !("total" in body) ||
          typeof body.total !== "number" ||
          !Number.isSafeInteger(body.total) ||
          body.total < 0 ||
          body.data.length > 20
        )
          throw new Error("The order list response is malformed.");
        const list = body.data.map(accept);
        if (!active()) return;
        setOrders(list);
        setTotal(body.total);
        if (publicClient) {
          await Promise.all(
            list.map(async (order) => {
              try {
                const state = await readNativeOrderState(publicClient, order);
                if (active())
                  setStates((previous) => ({
                    ...previous,
                    [order.intentHash]: state,
                  }));
              } catch {
                /* Terms remain public, with no claim of chain availability. */
              }
            }),
          );
        }
      } catch (error) {
        if (!active()) return;
        clearSelection();
        setDetail(
          error instanceof Error
            ? error.message
            : "The order could not be loaded.",
        );
      } finally {
        if (active()) setLoading(false);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [
    accept,
    asset,
    clearSelection,
    kind,
    linked,
    market,
    page,
    publicClient,
    refresh,
    tokenId,
  ]);
  const choose = (order: NativeOrder) => {
    clearSelection();
    generation.current++;
    const url = new URL(window.location.href);
    url.searchParams.set("order", order.intentHash);
    window.history.pushState(null, "", url);
    setLinked(order.intentHash);
    setRefresh((value) => value + 1);
  };
  const publish = async () => {
    if (!authorization || publishing) return;
    const current = generation.current;
    const authRevision = revision;
    const operation = publication.current;
    setPublishing(true);
    setDetail(undefined);
    const assertCurrent = () => {
      operation.assertCurrent();
      if (
        current !== generation.current ||
        userSessionController.getSnapshot().revision !== authRevision
      )
        throw new Error(
          "The screen or session changed. Publication was stopped.",
        );
    };
    try {
      const order = accept(
        nativeOrderFromAuthorization(kind, authorization, market),
      );
      await assertTradingSession(String(order.intent.seller), order.chainId);
      assertCurrent();
      const response = await fetch("/api/orders", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order }),
      });
      if (!response.ok)
        throw new Error(
          "The order was not published. Check your seller session and try again.",
        );
      const saved = accept(await response.json());
      if (
        saved.intentHash !== order.intentHash ||
        saved.signature !== order.signature
      )
        throw new Error("The published order does not match the signed terms.");
      assertCurrent();
      const url = new URL(window.location.href);
      url.searchParams.set("order", saved.intentHash);
      setPublished(url.href);
      setPage(1);
      setRefresh((value) => value + 1);
    } catch (error) {
      if (current === generation.current)
        setDetail(
          error instanceof Error ? error.message : "Publication failed.",
        );
    } finally {
      setPublishing(false);
    }
  };
  return (
    <section className="transaction-panel" aria-label="ArtFi sale orders">
      <h3>ArtFi sale orders</h3>
      <p>
        Public signed terms are immutable. Current chain state determines
        whether settlement is possible; the list does not reserve a sale.
      </p>
      {authorization && (
        <div>
          <p>
            Signing has not published these terms. Publish them explicitly to
            make the original sale authorization public.
          </p>
          <button
            type="button"
            className="primary"
            disabled={!authenticated || publishing}
            onClick={publish}
          >
            {publishing ? "Publishing sale terms" : "Publish sale terms"}
          </button>
          {!authenticated && <p>Sign in with the seller wallet to publish.</p>}
        </div>
      )}
      {published && (
        <p>
          Published. <a href={published}>Open the published order</a>
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            clearSelection();
            generation.current++;
            setRefresh((value) => value + 1);
          }}
        >
          Refresh orders
        </button>
        <button
          type="button"
          className="secondary"
          disabled={loading || page <= 1}
          onClick={() => {
            clearSelection();
            generation.current++;
            setPage((value) => value - 1);
          }}
        >
          Previous orders
        </button>
        <button
          type="button"
          className="secondary"
          disabled={loading || page * 20 >= total}
          onClick={() => {
            clearSelection();
            generation.current++;
            setPage((value) => value + 1);
          }}
        >
          Next orders
        </button>
      </div>
      <p>
        Page {page}. {total} published orders.
      </p>
      {loading && <p role="status">Loading orders and checking chain state</p>}
      {orders.map((order) => (
        <article className="transaction-panel" key={order.intentHash}>
          <p className="charity-digest">{order.intentHash}</p>
          <p>Seller: {String(order.intent.seller)}</p>
          <p>Payment token: {String(order.intent.paymentToken)}</p>
          {kind === "fraction" && (
            <p>
              Authorized maximum: {String(order.intent.maxAmount)} fractions
            </p>
          )}
          <p>
            {kind === "whole" ? "Price" : "Price per fraction"}:{" "}
            {String(order.intent.price ?? order.intent.unitPrice)} in the
            payment token&apos;s smallest unit
          </p>
          <p>
            {states[order.intentHash]?.label ??
              "Current chain state is unverified"}
            {states[order.intentHash]?.remaining !== undefined
              ? ` · Remaining: ${states[order.intentHash].remaining}`
              : ""}
          </p>
          <button
            type="button"
            className="secondary"
            onClick={() => choose(order)}
          >
            Load order
          </button>
        </article>
      ))}
      {!loading && !detail && orders.length === 0 && (
        <p>No published orders for this asset.</p>
      )}
      {selected && (
        <p className="charity-digest">Loaded order: {selected.intentHash}</p>
      )}
      {detail && (
        <p role="alert" className="dao-alert dao-alert--blocked">
          {detail}
        </p>
      )}
    </section>
  );
}
