"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { formatEther, type Hex } from "viem";
import { useAccount, useWalletClient } from "wagmi";
import { assertSameNftReview } from "@/lib/nft/client";
import { useUserSession } from "@/components/user-session-provider";
import {
  NFT_CHAINS,
  nftRights,
  nftPriceWei,
  type NftScope,
  type NftView,
  type NftOrderView,
  type NftRequest,
  type NftPlan,
  type NftOperationHistory,
} from "@/lib/nft/model";

type Operation = {
  id: string;
  status: string;
  walletStarted?: boolean;
  plan: NftPlan;
  transactionHash?: string;
  orderHash?: string;
};
type Detail = {
  nft: NftView;
  scope: NftScope;
  orders: NftOrderView[];
  ordersUnavailable: boolean;
  observedAt: string;
};
type Recovery = { id: string; hash?: Hex; attempted?: boolean };
class NftAPIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function api<T>(
  action: string,
  body?: unknown,
  query?: URLSearchParams,
): Promise<T> {
  const response = await fetch(
    `/api/nft/${action}${query ? `?${query}` : ""}`,
    {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    },
  );
  const value = await response.json();
  if (!response.ok)
    throw new NftAPIError(
      response.status,
      typeof value.detail === "string"
        ? value.detail
        : "The NFT service is unavailable.",
    );
  return value as T;
}
export function NftMarket() {
  const auth = useUserSession();
  const wallet = useAccount();
  return (
    <NftMarketSession
      key={`${wallet.address || ""}:${wallet.chainId || ""}:${auth.session?.id || ""}:${auth.authenticated}`}
    />
  );
}
function NftMarketSession() {
  const auth = useUserSession();
  const wallet = useAccount();
  const { data: walletClient } = useWalletClient();
  const [scopes, setScopes] = useState<NftScope[]>([]),
    [enabled, setEnabled] = useState(false),
    [collection, setCollection] = useState("");
  const [items, setItems] = useState<NftView[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [detail, setDetail] = useState<Detail | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null),
    [recovery, setRecovery] = useState<Recovery | null>(null);
  const [history, setHistory] = useState<NftOperationHistory | null>(null);
  const [lookupHash, setLookupHash] = useState("");
  const [owned, setOwned] = useState<{
    data: NftView[];
    next: string | null;
    observedAt: string;
  } | null>(null);
  const [recoveryHash, setRecoveryHash] = useState("");
  const [price, setPrice] = useState("0.01"),
    [quantity, setQuantity] = useState("1"),
    [hours, setHours] = useState("24");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const locked = useRef(false),
    generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const context = `${wallet.address || ""}:${wallet.chainId || ""}:${auth.session?.id || ""}:${auth.authenticated}`;
  const liveContext = useRef(context);
  useLayoutEffect(() => {
    liveContext.current = context;
    return () => {
      liveContext.current = "";
      invalidate();
    };
  }, [context, invalidate]);
  const storageKey = `artfi:nft:recovery:${wallet.chainId}:${wallet.address?.toLowerCase()}`;
  const visibleOperation =
    operation &&
    auth.authenticated &&
    operation.plan.request.account.toLowerCase() ===
      wallet.address?.toLowerCase() &&
    operation.plan.chainId === wallet.chainId
      ? operation
      : null;
  const scope = scopes.find((item) => item.slug === collection);
  const ready =
    enabled &&
    auth.authenticated &&
    scope &&
    wallet.chainId === NFT_CHAINS[scope.chain];
  useEffect(() => {
    let active = true;
    api<{ collections: NftScope[]; tradingEnabled: boolean }>("config")
      .then((value) => {
        if (active) {
          setScopes(value.collections);
          setEnabled(value.tradingEnabled);
          setCollection(value.collections[0]?.slug || "");
        }
      })
      .catch((error) => {
        if (active) setMessage(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active || !auth.authenticated) return;
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const value = JSON.parse(saved) as Recovery;
          if (
            /^[a-zA-Z0-9_-]{16,80}$/.test(value.id) &&
            (!value.hash || /^0x[a-fA-F0-9]{64}$/.test(value.hash))
          )
            setRecovery(value);
        }
      } catch {
        setMessage(
          "Transaction recovery storage is unavailable. Enable browser storage before trading.",
        );
      }
    });
    return () => {
      active = false;
    };
  }, [storageKey, auth.authenticated]);
  const run = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    const captured = context;
    try {
      await work();
    } catch (error) {
      if (
        captured === liveContext.current &&
        error instanceof NftAPIError &&
        [401, 403].includes(error.status)
      ) {
        setOwned(null);
        setHistory(null);
        setOperation(null);
        setRecovery(null);
        // Keep only the local durable operation ID/hash for recovery after a fresh sign-in.
      }
      if (captured === liveContext.current)
        setMessage(
          error instanceof Error
            ? error.message
            : "The operation could not be completed.",
        );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const browse = useCallback(
    async (next?: string) => {
      if (!collection) return;
      const current = ++generation.current;
      const query = new URLSearchParams({ collection });
      if (next) query.set("cursor", next);
      const response = await api<{ data: NftView[]; next: string | null }>(
        "catalog",
        undefined,
        query,
      );
      if (current !== generation.current) return;
      setItems((previous) =>
        next
          ? [
              ...previous,
              ...response.data.filter(
                (item) => !previous.some((old) => old.tokenId === item.tokenId),
              ),
            ]
          : response.data,
      );
      setCursor(response.next);
      setMessage(
        response.data.length
          ? ""
          : "No NFTs were returned for this configured collection.",
      );
    },
    [collection],
  );
  useEffect(() => {
    let active = true;
    void browse().catch((error) => {
      if (active) setMessage(error.message);
    });
    return () => {
      active = false;
      invalidate();
    };
  }, [browse, invalidate]);
  async function loadHistory(page = 1) {
    if (
      !auth.authenticated ||
      !wallet.address ||
      ![1, 8453].includes(wallet.chainId || 0)
    )
      throw new Error("Sign in on an NFT chain to view private history.");
    const captured = context;
    const response = await api<NftOperationHistory>(
      "history",
      undefined,
      new URLSearchParams({
        account: wallet.address,
        chainId: String(wallet.chainId),
        page: String(page),
      }),
    );
    if (captured !== liveContext.current) return;
    if (
      response.wallet.toLowerCase() !== wallet.address.toLowerCase() ||
      response.chainId !== wallet.chainId
    )
      throw new Error("The private history belongs to another wallet.");
    setHistory(response);
  }
  async function recoverHistory(id: string) {
    const captured = context;
    if (recovery && recovery.id !== id) {
      const current = await api<Operation>("status", authPayload(recovery.id));
      if (
        !["confirmed", "accepted", "failed", "rejected", "cancelled"].includes(
          current.status,
        )
      )
        throw new Error(
          "Finish or discard the current operation before selecting another history record.",
        );
    }
    const value = await api<Operation>("status", authPayload(id));
    if (captured !== liveContext.current) return;
    save({
      id,
      ...(value.transactionHash ? { hash: value.transactionHash as Hex } : {}),
      attempted: !!value.walletStarted,
    });
    setCollection(value.plan.scope.slug);
    setDetail(null);
    setOperation(value);
    setMessage(
      `Recovered recorded operation: ${value.status}. Review its current status before another wallet action.`,
    );
  }
  async function inspect(tokenId: string) {
    const current = ++generation.current;
    const value = await api<Detail>(
      "detail",
      undefined,
      new URLSearchParams({ collection, tokenId }),
    );
    if (current === generation.current) {
      setDetail(value);
      setMessage("");
    }
  }
  async function loadOwned(next?: string) {
    if (
      !auth.authenticated ||
      !wallet.address ||
      !scope ||
      wallet.chainId !== NFT_CHAINS[scope.chain]
    )
      throw new Error(
        "Sign in with this collection's wallet and chain to view holdings.",
      );
    const current = ++generation.current;
    const captured = context;
    const query = new URLSearchParams({ collection, account: wallet.address });
    if (next) query.set("cursor", next);
    const response = await api<{
      data: NftView[];
      next: string | null;
      observedAt: string;
      wallet: string;
      chainId: number;
    }>("owned", undefined, query);
    if (current !== generation.current || captured !== liveContext.current)
      return;
    if (
      response.wallet.toLowerCase() !== wallet.address.toLowerCase() ||
      response.chainId !== wallet.chainId
    )
      throw new Error(
        "The holdings response belongs to another wallet or chain.",
      );
    setOwned(response);
  }
  function save(value: Recovery) {
    localStorage.setItem(storageKey, JSON.stringify(value));
    setRecovery(value);
  }
  async function prepare(
    now: number,
    action: NftRequest["action"],
    order?: NftOrderView,
  ) {
    if (!ready || !detail || !wallet.address)
      throw new Error("Connect and sign in on this collection's chain first.");
    if (recovery && !visibleOperation)
      throw new Error(
        "Recover the previous operation before creating another.",
      );
    if (
      visibleOperation &&
      !["confirmed", "accepted", "failed", "rejected", "cancelled"].includes(
        visibleOperation.status,
      )
    )
      throw new Error(
        "Finish or discard the previous review before creating another. Reconcile any wallet request already started.",
      );
    const captured = context;
    const id = crypto.randomUUID();
    const qty = order
      ? action === "cancel"
        ? order.quantity
        : quantity
      : quantity;
    let total = order ? "0" : nftPriceWei(price);
    if (order) {
      const q = BigInt(qty),
        size = BigInt(order.quantity);
      if (q < 1n || q > size || (BigInt(order.priceWei) * q) % size !== 0n)
        throw new Error("Select a valid integral fill quantity.");
      total = ((BigInt(order.priceWei) * q) / size).toString();
    }
    const request: NftRequest = {
      action,
      collection,
      tokenId: detail.nft.tokenId,
      account: wallet.address,
      quantity: qty,
      priceWei: total,
      expiresAt: Math.floor(now / 1000) + Number(hours) * 3600,
      ...(order ? { orderHash: order.hash } : {}),
    };
    // Persist an operation ID before preparation. A response timeout can then be reconciled.
    save({ id });
    const value = await api<Operation>("prepare", { operationId: id, request });
    if (liveContext.current !== captured) return;
    setOperation(value);
    setMessage("Review the exact wallet action below.");
  }
  function authPayload(id: string) {
    return {
      operationId: id,
      account: wallet.address,
      chainId: wallet.chainId,
    };
  }
  async function status() {
    if (!recovery || !auth.authenticated) return;
    const captured = context;
    let value: Operation;
    try {
      value = await api<Operation>(recovery.hash ? "broadcast" : "status", {
        ...authPayload(recovery.id),
        ...(recovery.hash ? { transactionHash: recovery.hash } : {}),
      });
    } catch (error) {
      // A rejected preparation may never have created a journal record. Only
      // an unattempted review can be cleared; unknown wallet outcomes stay recoverable.
      if (
        error instanceof NftAPIError &&
        error.status === 404 &&
        !recovery.attempted &&
        !recovery.hash
      ) {
        if (captured !== liveContext.current) return;
        localStorage.removeItem(storageKey);
        setRecovery(null);
        setOperation(null);
        setMessage(
          "No saved wallet operation was found. You can prepare a new review.",
        );
        return;
      }
      throw error;
    }
    if (captured !== liveContext.current) return;
    setOperation(value);
    setMessage(
      value.status === "confirmed" && value.plan.kind === "approval"
        ? "Approval confirmed. Prepare the same action again to review the next step."
        : value.status === "accepted"
          ? "OpenSea accepted this order. Check current order availability; acceptance is not settlement."
          : `Operation status: ${value.status}.`,
    );
  }
  async function confirm() {
    if (
      !visibleOperation ||
      !walletClient ||
      !wallet.address ||
      !auth.authenticated
    )
      throw new Error("Sign in with the selected wallet first.");
    const captured = context,
      id = visibleOperation.id;
    const current = await api<Operation>("review", authPayload(id));
    assertSameNftReview(
      visibleOperation.plan,
      current.plan,
      wallet.address,
      wallet.chainId!,
    );
    const assertCurrent = async () => {
      if (captured !== liveContext.current)
        throw new Error(
          "The wallet or session changed. No further request was made.",
        );
      const [addresses, chain] = await Promise.all([
        walletClient.getAddresses(),
        walletClient.getChainId(),
      ]);
      if (
        captured !== liveContext.current ||
        chain !== current.plan.chainId ||
        !addresses.some(
          (value) =>
            value.toLowerCase() === current.plan.request.account.toLowerCase(),
        )
      )
        throw new Error("The wallet account or chain changed. Prepare again.");
    };
    await assertCurrent();
    const started = await api<Operation>("wallet-start", authPayload(id));
    assertSameNftReview(
      current.plan,
      started.plan,
      wallet.address,
      wallet.chainId!,
    );
    let walletPrompted = false;
    try {
      if (captured !== liveContext.current)
        throw new Error(
          "The wallet or session changed before the wallet request.",
        );
      setOperation(started);
      save({ id, attempted: true });
      await assertCurrent();
      if (current.plan.kind === "signature") {
        const typed = current.plan.typedData;
        if (!typed) throw new Error("The signing request is unavailable.");
        walletPrompted = true;
        const signature = await walletClient.signTypedData({
          ...typed,
          account: current.plan.request.account,
        });
        await assertCurrent();
        const result = await api<Operation>("sign", {
          ...authPayload(id),
          signature,
        });
        if (captured === liveContext.current) {
          setOperation(result);
          setMessage(
            result.status === "accepted"
              ? "OpenSea accepted the order. This does not confirm settlement."
              : result.status === "rejected"
                ? "OpenSea rejected this order. No accepted listing or offer was confirmed."
                : "Submission outcome needs reconciliation. Check status before retrying.",
          );
        }
      } else {
        const tx = current.plan.transaction;
        if (!tx) throw new Error("The transaction is unavailable.");
        walletPrompted = true;
        const hash = await walletClient.sendTransaction({
          account: current.plan.request.account,
          chain: walletClient.chain,
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value),
        });
        // Retain the original wallet's recovery key even if the account changed during the prompt.
        localStorage.setItem(storageKey, JSON.stringify({ id, hash }));
        if (captured !== liveContext.current) return;
        setRecovery({ id, hash });
        const result = await api<Operation>("broadcast", {
          ...authPayload(id),
          transactionHash: hash,
        });
        if (captured === liveContext.current) {
          setOperation(result);
          setMessage(
            "Transaction broadcast recorded. Confirmation requires a matching receipt and two canonical blocks.",
          );
        }
      }
    } catch (error) {
      const reason = error as { code?: number; cause?: { code?: number } };
      const rejected =
        !walletPrompted ||
        reason?.code === 4001 ||
        reason?.cause?.code === 4001;
      try {
        const result = await api<Operation>(
          rejected ? "wallet-rejected" : "wallet-uncertain",
          authPayload(id),
        );
        if (captured === liveContext.current) setOperation(result);
      } catch {
        /* Keep durable attempt recovery; never prompt twice after uncertainty. */
      }
      throw error;
    }
  }
  async function lookupOrder() {
    if (!detail) return;
    const current = ++generation.current;
    const result = await api<{ order: NftOrderView; observedAt: string }>(
      "order",
      undefined,
      new URLSearchParams({
        collection: detail.scope.slug,
        tokenId: detail.nft.tokenId,
        orderHash: lookupHash.trim(),
      }),
    );
    if (current === generation.current)
      setDetail({
        ...detail,
        orders: [
          result.order,
          ...detail.orders.filter((order) => order.hash !== result.order.hash),
        ],
        observedAt: result.observedAt,
      });
  }
  async function abandon() {
    if (!visibleOperation || visibleOperation.status !== "awaiting-wallet")
      return;
    const captured = context;
    const result = await api<Operation>(
      "abandon",
      authPayload(visibleOperation.id),
    );
    if (captured === liveContext.current) {
      setOperation(result);
      setMessage(
        "The unsigned review was discarded. No venue order or blockchain transaction was cancelled.",
      );
    }
  }
  async function discardUnsubmittedSignature() {
    if (
      !visibleOperation ||
      visibleOperation.plan.kind !== "signature" ||
      visibleOperation.status !== "awaiting-wallet" ||
      !visibleOperation.walletStarted
    )
      return;
    const captured = context;
    const result = await api<Operation>(
      "wallet-uncertain",
      authPayload(visibleOperation.id),
    );
    if (captured === liveContext.current) {
      setOperation(result);
      setMessage(
        "The unsubmitted signature review was discarded. This does not revoke a signature already held by your wallet.",
      );
    }
  }
  async function cancelAcceptedOrder() {
    if (!visibleOperation || visibleOperation.status !== "accepted") return;
    const original = visibleOperation.plan;
    const id = crypto.randomUUID();
    const request = {
      ...original.request,
      action: "cancel",
      orderHash: visibleOperation.orderHash || original.orderHash,
      expiresAt: 0,
    };
    save({ id });
    const captured = context;
    const result = await api<Operation>("prepare", {
      operationId: id,
      request,
    });
    if (captured === liveContext.current) setOperation(result);
  }
  async function recoverKnownHash() {
    if (!recovery || !/^0x[a-fA-F0-9]{64}$/.test(recoveryHash.trim()))
      throw new Error("Paste the transaction hash from the original wallet.");
    const captured = context;
    const hash = recoveryHash.trim() as Hex;
    const result = await api<Operation>("broadcast", {
      ...authPayload(recovery.id),
      transactionHash: hash,
    });
    if (captured === liveContext.current) {
      save({ id: recovery.id, hash, attempted: true });
      setOperation(result);
    }
  }
  function dismiss() {
    if (busy) return;
    setOperation(null);
    setMessage(
      "Review closed. Its recovery record remains available; closing does not cancel a blockchain transaction or an accepted venue order.",
    );
  }
  const terminal =
    visibleOperation &&
    ["confirmed", "accepted", "failed", "rejected", "cancelled"].includes(
      visibleOperation.status,
    );
  return (
    <section className="product-tools" aria-labelledby="native-nft-title">
      <header className="section-heading">
        <p className="approved-eyebrow">OpenSea venue / ArtFi experience</p>
        <h2 id="native-nft-title">NFT marketplace</h2>
        <p>
          Browse digital collections, review fees and sign with your own wallet.
          Artwork files are never previewed here.
        </p>
      </header>
      {!scopes.length ? (
        <p>
          No approved digital NFT collections are configured. Charity editions
          remain available below.
        </p>
      ) : (
        <>
          <label>
            Collection{" "}
            <select
              value={collection}
              disabled={busy}
              onChange={(event) => {
                setItems([]);
                setDetail(null);
                setCursor(null);
                setOwned(null);
                setCollection(event.target.value);
              }}
            >
              {scopes.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.label} · {item.chain}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => browse())}
          >
            Refresh collections
          </button>
          {scope && <p className="product-note">{nftRights(scope.charity)}</p>}
          <section aria-label="My venue-indexed NFTs" data-no-translate>
            <h3>My venue-indexed NFTs</h3>
            <p>
              Sign in to inspect this wallet&apos;s NFTs in the selected
              collection. OpenSea&apos;s indexed holdings can lag chain state
              and exclude hidden items; they are not a live balance or a
              physical-title record.
            </p>
            <button
              type="button"
              disabled={
                busy ||
                !auth.authenticated ||
                !scope ||
                wallet.chainId !== NFT_CHAINS[scope.chain]
              }
              onClick={() => void run(() => loadOwned())}
            >
              Load my NFT holdings
            </button>
            {owned && auth.authenticated && (
              <>
                <p>
                  Source: OpenSea. Observed{" "}
                  {new Date(owned.observedAt).toLocaleString()}.
                </p>
                {owned.data.length ? (
                  <ul>
                    {owned.data.map((item) => (
                      <li key={item.tokenId}>
                        {item.name} · token {item.tokenId}{" "}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(() => inspect(item.tokenId))}
                        >
                          Inspect owned NFT
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    No matching configured NFT is present on this
                    account-history page.
                  </p>
                )}
                {owned.next && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => loadOwned(owned.next!))}
                  >
                    Next holdings page
                  </button>
                )}
              </>
            )}
          </section>
          {!enabled && (
            <p>
              Trading is not enabled for this installation. Public browsing
              remains available.
            </p>
          )}
          <div className="nft-market-grid">
            {items.map((item) => (
              <article key={item.tokenId} className="nft-market-card">
                <h3>{item.name}</h3>
                <p>
                  Token {item.tokenId} · {item.standard.toUpperCase()}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => inspect(item.tokenId))}
                >
                  Inspect NFT
                </button>
              </article>
            ))}
          </div>
          {cursor && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => browse(cursor))}
            >
              Load more NFTs
            </button>
          )}
        </>
      )}
      <section aria-label="My NFT operation history" data-no-translate>
        <h3>My NFT operation history</h3>
        <p>
          Recover an earlier listing, offer or transaction even after changing
          browsers. These are recorded operation results; venue acceptance is
          not confirmation of settlement or current order availability.
        </p>
        <button
          type="button"
          disabled={
            busy ||
            !auth.authenticated ||
            ![1, 8453].includes(wallet.chainId || 0)
          }
          onClick={() => void run(() => loadHistory())}
        >
          Load my NFT operations
        </button>
        {history && auth.authenticated && (
          <>
            <ol>
              {history.data.map((item) => (
                <li key={item.id}>
                  <p>
                    {item.action} · {item.collection} · token {item.tokenId} ·{" "}
                    {item.status} · {new Date(item.updatedAt).toLocaleString()}
                  </p>
                  {item.orderHash && (
                    <p className="nft-market-hash">Order {item.orderHash}</p>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => recoverHistory(item.id))}
                  >
                    Recover this NFT operation
                  </button>
                </li>
              ))}
            </ol>
            {!history.data.length && (
              <p>No recorded NFT operation is present on this page.</p>
            )}
            <button
              disabled={busy || history.page === 1}
              onClick={() => void run(() => loadHistory(history.page - 1))}
            >
              Previous NFT operations
            </button>
            <span>Page {history.page}</span>
            <button
              disabled={busy || !history.hasMore}
              onClick={() => void run(() => loadHistory(history.page + 1))}
            >
              Next NFT operations
            </button>
          </>
        )}
      </section>
      {detail && (
        <section className="nft-market-detail" aria-label="Selected NFT">
          <h3>{detail.nft.name}</h3>
          <p>
            Contract {detail.nft.contract} · Token {detail.nft.tokenId}
          </p>
          <p>{nftRights(detail.scope.charity)}</p>
          <p>
            Source: OpenSea. Observed{" "}
            {new Date(detail.observedAt).toLocaleString()}.
          </p>
          <label>
            Quantity{" "}
            <input
              inputMode="numeric"
              value={quantity}
              disabled={busy}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </label>
          <label>
            Total price (ETH for listings, WETH for offers){" "}
            <input
              inputMode="decimal"
              value={price}
              disabled={busy}
              onChange={(event) => setPrice(event.target.value)}
            />
          </label>
          <label>
            Valid for (hours){" "}
            <input
              type="number"
              min="1"
              max="4320"
              value={hours}
              disabled={busy}
              onChange={(event) => setHours(event.target.value)}
            />
          </label>
          <div className="product-actions">
            <button
              disabled={!ready || busy}
              onClick={() => void run(() => prepare(Date.now(), "list"))}
            >
              Create listing
            </button>
            <button
              disabled={!ready || busy}
              onClick={() => void run(() => prepare(Date.now(), "offer"))}
            >
              Make offer
            </button>
          </div>
          {!ready && (
            <p>
              To trade, connect and sign in on {detail.scope.chain}. A connected
              address alone does not establish a session.
            </p>
          )}
          <label>
            Find a specific OpenSea order by hash{" "}
            <input
              value={lookupHash}
              onChange={(event) => setLookupHash(event.target.value)}
              disabled={busy}
            />
          </label>
          <button
            type="button"
            disabled={busy || !lookupHash.trim()}
            onClick={() => void run(lookupOrder)}
          >
            Inspect order
          </button>
          <p>
            Supported order display: fixed-price ETH listings and WETH offers
            for this NFT. A venue record does not prove current executable
            availability.
          </p>
          {detail.nft.sourceURL && (
            <p className="nft-market-hash">
              Attributed source (reference only): {detail.nft.sourceURL}
            </p>
          )}
          {detail.ordersUnavailable && (
            <p role="status">
              Some order data is unavailable. Refresh before deciding.
            </p>
          )}
          {detail.orders.map((order) => (
            <article key={order.hash} className="nft-market-card">
              <h4>
                {order.side === "listing" ? "Listing" : "Offer"} ·{" "}
                {formatEther(BigInt(order.priceWei))} {order.currency}
              </h4>
              <p>
                Quantity {order.quantity} · Maker {order.maker}
              </p>
              <p>
                Expires {new Date(order.expiresAt * 1000).toLocaleString()} ·{" "}
                {order.status}
              </p>
              <p className="nft-market-hash">Order {order.hash}</p>
              <button
                disabled={!ready || busy}
                onClick={() =>
                  void run(() =>
                    prepare(
                      Date.now(),
                      order.side === "listing" ? "buy" : "accept",
                      order,
                    ),
                  )
                }
              >
                {order.side === "listing" ? "Buy" : "Accept offer"}
              </button>
              {order.maker.toLowerCase() === wallet.address?.toLowerCase() && (
                <button
                  disabled={!ready || busy}
                  onClick={() =>
                    void run(() => prepare(Date.now(), "cancel", order))
                  }
                >
                  Cancel order on chain
                </button>
              )}
            </article>
          ))}
        </section>
      )}
      {auth.authenticated && recovery && (
        <div className="product-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(status)}
          >
            Check / recover operation
          </button>
          {terminal && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                localStorage.removeItem(storageKey);
                setRecovery(null);
                setOperation(null);
              }}
            >
              Finish this review
            </button>
          )}
        </div>
      )}
      {auth.authenticated &&
        recovery &&
        (recovery.attempted || visibleOperation?.walletStarted) &&
        !recovery.hash &&
        visibleOperation?.plan.kind !== "signature" && (
          <div>
            <p>
              An earlier wallet transaction may still be pending. Do not send it
              again. Paste its hash from the original wallet to reconcile it.
            </p>
            <label>
              Original wallet transaction hash{" "}
              <input
                value={recoveryHash}
                onChange={(event) => setRecoveryHash(event.target.value)}
                disabled={busy}
              />
            </label>
            <button disabled={busy} onClick={() => void run(recoverKnownHash)}>
              Recover transaction
            </button>
          </div>
        )}
      {visibleOperation && (
        <section
          className="nft-review"
          aria-label="Wallet action review"
          data-no-translate
        >
          <h3>Review {visibleOperation.plan.request.action}</h3>
          <p>{visibleOperation.plan.summary}</p>
          <p>
            Collection {visibleOperation.plan.scope.label} ·{" "}
            {visibleOperation.plan.scope.chain}
          </p>
          <p>
            Contract {visibleOperation.plan.scope.contract} · Token{" "}
            {visibleOperation.plan.request.tokenId} · Quantity{" "}
            {visibleOperation.plan.request.quantity}
          </p>
          <p>
            Order total{" "}
            {formatEther(
              BigInt(
                visibleOperation.plan.orderTotalWei ??
                  visibleOperation.plan.request.priceWei,
              ),
            )}{" "}
            {visibleOperation.plan.paymentToken ||
              (["offer", "accept"].includes(
                visibleOperation.plan.request.action,
              )
                ? "WETH"
                : "ETH")}
            {visibleOperation.plan.request.action === "accept"
              ? " before the fees below"
              : ""}
            .
            {visibleOperation.plan.request.action === "cancel"
              ? " Cancellation sends no purchase payment."
              : " Wallet-estimated gas is additional."}
          </p>
          <p>
            Order expiry{" "}
            {new Date(
              (visibleOperation.plan.orderExpiresAt ??
                visibleOperation.plan.request.expiresAt) * 1000,
            ).toLocaleString()}
          </p>
          {visibleOperation.plan.kind === "approval" &&
            ["list", "offer"].includes(
              visibleOperation.plan.request.action,
            ) && (
              <p>
                This approval does not publish an order. Review the venue fees
                in the next signing step.
              </p>
            )}
          <p>
            Wallet {visibleOperation.plan.request.account} · Chain{" "}
            {visibleOperation.plan.chainId}
          </p>
          <p>{nftRights(visibleOperation.plan.scope.charity)}</p>
          {visibleOperation.plan.fees.map((fee, index) => (
            <p key={index}>
              Fee {formatEther(BigInt(fee.amountWei))} ETH/WETH to{" "}
              {fee.recipient}
            </p>
          ))}
          <p>Status: {visibleOperation.status}</p>
          {visibleOperation.transactionHash && (
            <p className="nft-market-hash">
              Transaction {visibleOperation.transactionHash}
            </p>
          )}
          {visibleOperation.orderHash && (
            <p className="nft-market-hash">
              Order {visibleOperation.orderHash}
            </p>
          )}
          <button
            disabled={
              busy ||
              visibleOperation.status !== "awaiting-wallet" ||
              visibleOperation.walletStarted ||
              recovery?.attempted
            }
            onClick={() => void run(confirm)}
          >
            Confirm in wallet
          </button>
          {visibleOperation.status === "awaiting-wallet" &&
            !visibleOperation.walletStarted &&
            !recovery?.attempted && (
              <button disabled={busy} onClick={() => void run(abandon)}>
                Discard unsigned review
              </button>
            )}
          {visibleOperation.status === "awaiting-wallet" &&
            visibleOperation.walletStarted &&
            visibleOperation.plan.kind === "signature" && (
              <button
                disabled={busy}
                onClick={() => void run(discardUnsubmittedSignature)}
              >
                Discard unsubmitted signature review
              </button>
            )}
          {visibleOperation.status === "accepted" && (
            <button
              disabled={busy}
              onClick={() => void run(cancelAcceptedOrder)}
            >
              Cancel this order on chain
            </button>
          )}
          {visibleOperation.plan.sourceURL && (
            <p className="nft-market-hash">
              Attributed source (reference only):{" "}
              {visibleOperation.plan.sourceURL}
            </p>
          )}
          <button disabled={busy} onClick={dismiss}>
            Close review
          </button>
        </section>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
