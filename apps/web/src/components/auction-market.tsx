"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import {
  isAddress,
  formatUnits,
  toHex,
  decodeEventLog,
  type Address,
  type Hex,
} from "viem";
import {
  assertRwaTradingEvidence,
  rwaAssetIdentity,
  type RwaAsset,
} from "@/lib/rwa-catalog";
import { publicSetting } from "@/lib/public-runtime-config";
import { supportedChain } from "@/lib/wagmi";
import { useUserSession } from "./user-session-provider";
import {
  assertTradingSession,
  userSessionController,
} from "@/lib/user-session-client";
import { useMarketTransactions } from "@/lib/use-market-transactions";
import {
  auctionAbi,
  auctionTokenAbi,
  auctionAmount,
  auctionID,
  auctionActions,
  auctionMinimumBid,
  auctionBidPreflight,
  auctionEvents,
  loadAuction,
  type AuctionSnapshot,
} from "@/lib/auction";

type Metadata = { symbol: string; decimals: number | null };
function configuredMarket() {
  const value = publicSetting("NEXT_PUBLIC_ARTFI_FRACTION_MARKET_ADDRESS");
  return value && isAddress(value) ? value : undefined;
}
export function AuctionMarket() {
  const wallet = useAccount(),
    auth = useUserSession();
  return (
    <AuctionWorkbench
      key={`${wallet.address}:${wallet.chainId}:${auth.revision}`}
    />
  );
}
function AuctionWorkbench() {
  const { address, chainId, isConnected } = useAccount();
  const auth = useUserSession();
  const client = usePublicClient({ chainId: supportedChain.id });
  const { writeContractAsync } = useWriteContract();
  const market = configuredMarket();
  const [sourceRecord, setSourceRecord] = useState<RwaAsset | null>(null);
  const [id, setID] = useState("1"),
    [snapshot, setSnapshot] = useState<AuctionSnapshot | null>(null),
    [history, setHistory] = useState<string[]>([]),
    [recent, setRecent] = useState<string[]>([]),
    [credit, setCredit] = useState<bigint | null>(null);
  const [paymentMeta, setPaymentMeta] = useState<Metadata>({
      symbol: "payment base units",
      decimals: null,
    }),
    [assetMeta, setAssetMeta] = useState<Metadata>({
      symbol: "fraction base units",
      decimals: null,
    });
  const [bid, setBid] = useState(""),
    [hash, setHash] = useState<Hex>(),
    [detail, setDetail] = useState(""),
    [busy, setBusy] = useState(false);
  const actionLock = useRef(false),
    life = useRef(true);
  const [asset, setAsset] = useState(
      publicSetting("NEXT_PUBLIC_ARTFI_FRACTION_TOKEN_ADDRESS") || "",
    ),
    [payment, setPayment] = useState(""),
    [amount, setAmount] = useState(""),
    [opening, setOpening] = useState(""),
    [reserve, setReserve] = useState(""),
    [increment, setIncrement] = useState(""),
    [duration, setDuration] = useState("24"),
    [acceptedEscrow, setAcceptedEscrow] = useState(false);
  const [creation, setCreation] = useState<{
    source: RwaAsset;
    requestId: Hex;
    asset: Address;
    payment: Address;
    amount: bigint;
    opening: bigint;
    reserve: bigint;
    increment: bigint;
    starts: number;
    ends: number;
    extension: number;
  } | null>(null);
  useEffect(() => {
    life.current = true;
    return () => {
      life.current = false;
    };
  }, []);
  const beforeWrite = useCallback(async () => {
    if (!address || chainId !== 560048)
      throw new Error("Connect your wallet on Hoodi.");
    await assertTradingSession(address, chainId);
    if (
      userSessionController.getSnapshot().revision !== auth.revision ||
      !life.current
    )
      throw new Error("The session or screen changed. Start again.");
  }, [address, chainId, auth.revision]);
  const transactions = useMarketTransactions(
    client,
    `auction:${market}:${address}`,
    setHash,
    {
      operationContext: JSON.stringify([id, creation?.requestId]),
      beforeWrite,
    },
  );
  const ready =
    auth.authenticated &&
    isConnected &&
    chainId === 560048 &&
    !!client &&
    !!market;
  const privateReady = ready && !!address;
  const run = async (work: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      if (life.current)
        setDetail(
          error instanceof Error ? error.message : "The auction action failed.",
        );
    } finally {
      actionLock.current = false;
      if (life.current) setBusy(false);
    }
  };
  async function metadata(token: Address): Promise<Metadata> {
    if (!client) return { symbol: "base units", decimals: null };
    try {
      const [symbol, decimals] = await Promise.all([
        client.readContract({
          address: token,
          abi: auctionTokenAbi,
          functionName: "symbol",
        }),
        client.readContract({
          address: token,
          abi: auctionTokenAbi,
          functionName: "decimals",
        }),
      ]);
      if (decimals > 36) throw new Error();
      return { symbol: symbol.slice(0, 32), decimals };
    } catch {
      return { symbol: "base units (metadata unavailable)", decimals: null };
    }
  }
  function display(value: bigint, meta: Metadata) {
    return `${formatUnits(value, meta.decimals ?? 0)} ${meta.symbol}`;
  }
  async function refresh(selected = id) {
    if (!client || !market)
      throw new Error(
        "Configure the existing fractional-market contract and Hoodi RPC first.",
      );
    const observed = await loadAuction(client, market, selected);
    let source: RwaAsset | null = null;
    try {
      source = await assertRwaTradingEvidence({
        section: "fractional",
        chainId: 560048,
        marketAddress: market,
        fractionTokenAddress: observed.asset,
      });
    } catch {
      /* Source outage stops new bids, never settlement or owner exits. */
    }
    const [pm, am] = await Promise.all([
      metadata(observed.payment),
      metadata(observed.asset),
    ]);
    let entries: string[];
    try {
      const events = await auctionEvents(client, market, selected);
      entries = events.logs.map(
        (log) =>
          `${log.eventName} · block ${log.blockNumber} · ${log.transactionHash}`,
      );
    } catch {
      entries = [
        "Bid history is unavailable. Current on-chain auction terms are shown separately.",
      ];
    }
    const available = privateReady
      ? await client.readContract({
          address: market,
          abi: auctionAbi,
          functionName: "credits",
          args: [address!, observed.payment],
          blockNumber: observed.blockNumber,
        })
      : null;
    if (!life.current) return;
    setID(selected);
    setSnapshot(observed);
    setSourceRecord(source);
    setPaymentMeta(pm);
    setAssetMeta(am);
    setCredit(available);
    setHistory(entries);
    setBid(formatUnits(auctionMinimumBid(observed), pm.decimals ?? 0));
    setDetail(`Auction observed at block ${observed.blockNumber}.`);
  }
  async function discover() {
    if (!client || !market)
      throw new Error(
        "Auction discovery requires its configured chain connection.",
      );
    const result = await auctionEvents(client, market);
    if (!life.current) return;
    setRecent([
      ...new Set(
        result.logs
          .filter((log) => log.eventName === "ListingCreated")
          .map((log) => String((log.args as { listingId?: bigint }).listingId)),
      ),
    ]);
    setDetail(
      `Discovery covers blocks ${result.fromBlock} to ${result.toBlock}. Older auctions remain accessible by ID.`,
    );
  }
  async function placeBid() {
    if (!ready || !address || !client || !market || !snapshot || !sourceRecord)
      throw new Error(
        "Sign in and load an auction with current approved-source evidence first.",
      );
    const reviewed = snapshot;
    const value = auctionAmount(bid, paymentMeta.decimals ?? 0);
    const action = transactions.begin();
    await assertRwaTradingEvidence({
      section: "fractional",
      chainId: 560048,
      marketAddress: market,
      fractionTokenAddress: reviewed.asset,
      slug: sourceRecord.slug,
      identity: rwaAssetIdentity(sourceRecord),
    });
    await auctionBidPreflight(client, reviewed, address, value);
    action.assertCurrent();
    const allowance = await client.readContract({
      address: reviewed.payment,
      abi: auctionTokenAbi,
      functionName: "allowance",
      args: [address, market],
    });
    if (allowance < value) {
      setDetail("Confirm the exact payment-token allowance in your wallet.");
      await action.write("approval", () =>
        writeContractAsync({
          address: reviewed.payment,
          abi: auctionTokenAbi,
          functionName: "approve",
          args: [market, value],
          chainId: 560048,
          account: address,
        }),
      );
    }
    await assertRwaTradingEvidence({
      section: "fractional",
      chainId: 560048,
      marketAddress: market,
      fractionTokenAddress: reviewed.asset,
      slug: sourceRecord.slug,
      identity: rwaAssetIdentity(sourceRecord),
    });
    await auctionBidPreflight(client, reviewed, address, value);
    action.assertCurrent();
    const prepared = await client.simulateContract({
      address: market,
      abi: auctionAbi,
      functionName: "placeBid",
      args: [auctionID(reviewed.id), value],
      account: address,
    });
    action.assertCurrent();
    setDetail(
      "Confirm the escrowed bid in your wallet. A late bid may extend the end time.",
    );
    await action.write("fill", () =>
      writeContractAsync({ ...prepared.request, chainId: 560048 }),
    );
    action.assertCurrent();
    await refresh(reviewed.id);
    if (action.isCurrent())
      setDetail(
        "Bid transaction confirmed. Refreshed auction terms and bid history are shown.",
      );
  }
  async function auctionExit(kind: "settle" | "cancel" | "withdraw") {
    if (!ready || !address || !client || !market || !snapshot)
      throw new Error("Sign in and load an auction first.");
    const action = transactions.begin();
    const current = await loadAuction(client, market, snapshot.id);
    action.assertCurrent();
    const flags = auctionActions(current, address);
    if (kind === "settle" && !flags.settle)
      throw new Error("The current auction end has not been reached.");
    if (kind === "cancel" && !flags.cancel)
      throw new Error(
        "Only the seller of an active auction without a bid may cancel. An active bid remains protected until settlement.",
      );
    if (kind === "withdraw") {
      const value = await client.readContract({
        address: market,
        abi: auctionAbi,
        functionName: "credits",
        args: [address, current.payment],
      });
      if (value <= 0n)
        throw new Error(
          "No withdrawable credit exists for this payment token.",
        );
      const request = await client.simulateContract({
        address: market,
        abi: auctionAbi,
        functionName: "withdrawCredit",
        args: [current.payment],
        account: address,
      });
      await action.write("withdrawal", () =>
        writeContractAsync({ ...request.request, chainId: 560048 }),
      );
    } else {
      const request = await client.simulateContract({
        address: market,
        abi: auctionAbi,
        functionName: kind === "settle" ? "settleAuction" : "cancelListing",
        args: [auctionID(current.id)],
        account: address,
      });
      await action.write("fill", () =>
        writeContractAsync({ ...request.request, chainId: 560048 }),
      );
    }
    action.assertCurrent();
    await refresh(current.id);
    if (action.isCurrent())
      setDetail(
        `${kind === "withdraw" ? "Credit withdrawal" : kind === "cancel" ? "Seller cancellation" : "Auction settlement"} confirmed on chain.`,
      );
  }
  async function reviewCreation() {
    if (
      !ready ||
      !client ||
      !market ||
      !address ||
      !isAddress(asset) ||
      !isAddress(payment)
    )
      throw new Error(
        "Sign in and enter valid fraction and payment token addresses.",
      );
    const source = await assertRwaTradingEvidence({
      section: "fractional",
      chainId: 560048,
      marketAddress: market,
      fractionTokenAddress: asset,
    });
    const [am, pm, allowedAsset, allowedPayment, paused] = await Promise.all([
      metadata(asset),
      metadata(payment),
      client.readContract({
        address: market,
        abi: auctionAbi,
        functionName: "allowedAssetToken",
        args: [asset],
      }),
      client.readContract({
        address: market,
        abi: auctionAbi,
        functionName: "allowedPaymentToken",
        args: [payment],
      }),
      client.readContract({
        address: market,
        abi: auctionAbi,
        functionName: "paused",
      }),
    ]);
    if (!allowedAsset || !allowedPayment || paused)
      throw new Error(
        "This token pair is unavailable or the market is paused.",
      );
    const values = {
      amount: auctionAmount(amount, am.decimals ?? 0),
      opening: auctionAmount(opening, pm.decimals ?? 0),
      reserve: auctionAmount(reserve, pm.decimals ?? 0),
      increment: auctionAmount(increment, pm.decimals ?? 0),
    };
    const hours = Number(duration);
    if (
      values.amount <= 0n ||
      values.opening <= 0n ||
      values.reserve < values.opening ||
      values.increment <= 0n ||
      !Number.isSafeInteger(hours) ||
      hours < 1
    )
      throw new Error(
        "Use positive amounts, a reserve at least equal to the opening bid, and a whole-hour duration.",
      );
    const block = await client.getBlock();
    const starts = Number(block.timestamp) + 60,
      ends = starts + hours * 3600;
    if (!Number.isSafeInteger(ends) || ends > 2 ** 48 - 1)
      throw new Error(
        "The auction duration exceeds the supported chain timestamp.",
      );
    const balance = await client.readContract({
      address: asset,
      abi: auctionTokenAbi,
      functionName: "balanceOf",
      args: [address],
    });
    if (balance < values.amount)
      throw new Error(
        "Your wallet has insufficient fraction units for this escrow.",
      );
    if (!life.current) return;
    setAssetMeta(am);
    setPaymentMeta(pm);
    setAcceptedEscrow(false);
    setCreation({
      source,
      ...values,
      asset,
      payment,
      starts,
      ends,
      extension: 300,
      requestId: toHex(crypto.getRandomValues(new Uint8Array(32))),
    });
    setDetail(
      "Review the escrow amount, reserve, duration and extension before confirming.",
    );
  }
  async function create() {
    if (
      !creation ||
      !acceptedEscrow ||
      !ready ||
      !market ||
      !client ||
      !address
    )
      throw new Error("Review and accept the auction escrow terms first.");
    const reviewed = creation,
      action = transactions.begin(reviewed.requestId);
    await assertRwaTradingEvidence({
      section: "fractional",
      chainId: 560048,
      marketAddress: market,
      fractionTokenAddress: reviewed.asset,
      slug: reviewed.source.slug,
      identity: rwaAssetIdentity(reviewed.source),
    });
    action.assertCurrent();
    const allowance = await client.readContract({
      address: reviewed.asset,
      abi: auctionTokenAbi,
      functionName: "allowance",
      args: [address, market],
    });
    action.assertCurrent();
    if (allowance < reviewed.amount)
      await action.write("approval", () =>
        writeContractAsync({
          address: reviewed.asset,
          abi: auctionTokenAbi,
          functionName: "approve",
          args: [market, reviewed.amount],
          chainId: 560048,
          account: address,
        }),
      );
    action.assertCurrent();
    await assertRwaTradingEvidence({
      section: "fractional",
      chainId: 560048,
      marketAddress: market,
      fractionTokenAddress: reviewed.asset,
      slug: reviewed.source.slug,
      identity: rwaAssetIdentity(reviewed.source),
    });
    action.assertCurrent();
    const request = await client.simulateContract({
      address: market,
      abi: auctionAbi,
      functionName: "createAuctionListing",
      args: [
        reviewed.requestId,
        reviewed.asset,
        reviewed.payment,
        reviewed.amount,
        reviewed.opening,
        reviewed.starts,
        reviewed.ends,
        reviewed.reserve,
        reviewed.increment,
        reviewed.extension,
        reviewed.extension,
      ],
      account: address,
    });
    action.assertCurrent();
    const receipt = await action.write("fill", () =>
      writeContractAsync({ ...request.request, chainId: 560048 }),
    );
    let created: string | undefined;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== market.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: auctionAbi,
          data: log.data,
          topics: log.topics,
        });
        if (
          decoded.eventName === "ListingCreated" &&
          decoded.args.requestId === reviewed.requestId &&
          decoded.args.seller.toLowerCase() === address.toLowerCase()
        )
          created = decoded.args.listingId.toString();
      } catch {}
    }
    if (!created)
      throw new Error(
        "The receipt did not contain the expected auction creation. Inspect the transaction before retrying.",
      );
    action.assertCurrent();
    setCreation(null);
    await refresh(created);
  }
  const flags = snapshot ? auctionActions(snapshot, address) : null;
  const blocked = busy || !!transactions.pending;
  return (
    <section
      className="product-tools"
      aria-labelledby="auction-workbench-title"
    >
      <h2 id="auction-workbench-title">On-chain fraction auctions</h2>
      <p data-no-translate>TESTNET / NO REAL-WORLD VALUE / NO LEGAL EFFECT</p>
      <p>
        Hoodi test chain. Auctions hold fraction tokens and bid payments in the
        existing auction contract until settlement. They do not transfer
        physical title. Pause stops new activity while settlement and credit
        withdrawal remain available.
      </p>
      {!market && (
        <p>
          The existing fractional-market address is not configured. No sample
          auction is presented as live.
        </p>
      )}
      <div className="product-actions">
        <button disabled={busy || !market} onClick={() => void run(discover)}>
          Find recent auctions
        </button>
        <label>
          Auction ID{" "}
          <input
            value={id}
            disabled={busy}
            onChange={(event) => {
              setID(event.target.value);
              setSnapshot(null);
              setCreation(null);
            }}
          />
        </label>
        <button
          disabled={busy || !market}
          onClick={() => void run(() => refresh())}
        >
          Load auction
        </button>
      </div>
      {recent.length > 0 && (
        <nav aria-label="Recent auction IDs">
          {recent.map((value) => (
            <button
              key={value}
              disabled={busy}
              onClick={() => void run(() => refresh(value))}
            >
              Auction {value}
            </button>
          ))}
        </nav>
      )}
      {snapshot && (
        <article className="nft-market-card">
          <h3>Auction {snapshot.id}</h3>
          {sourceRecord ? (
            <p>
              {sourceRecord.grounding.mode} · source-bound asset:{" "}
              {sourceRecord.title}. {sourceRecord.rights}
            </p>
          ) : (
            <p>
              Approved-source correspondence evidence is unavailable or
              inactive. New bids are unavailable; existing settlement and
              ownership exits remain available.
            </p>
          )}
          <p>Seller {snapshot.seller}</p>
          <p>
            Fraction token {snapshot.asset} ·{" "}
            {display(snapshot.amount, assetMeta)}
          </p>
          <p>Payment token {snapshot.payment}</p>
          <p>
            Opening {display(snapshot.openingBid, paymentMeta)} · reserve{" "}
            {display(snapshot.reserve, paymentMeta)} · increment{" "}
            {display(snapshot.increment, paymentMeta)}
          </p>
          <p>
            Highest bid {display(snapshot.highestBid, paymentMeta)} by{" "}
            {snapshot.highestBidder}
          </p>
          <p>
            Starts {new Date(snapshot.startsAt * 1000).toLocaleString()} · ends{" "}
            {new Date(snapshot.endsAt * 1000).toLocaleString()} · state{" "}
            {snapshot.state === 1
              ? "active"
              : snapshot.state === 2
                ? "settled"
                : "cancelled"}
            {snapshot.paused ? " · market paused" : ""}
          </p>
          <p>
            Bids inside the final {snapshot.extensionWindow} seconds extend the
            end by {snapshot.extensionDuration} seconds.
          </p>
          <label>
            Bid ({paymentMeta.symbol}){" "}
            <input
              value={bid}
              disabled={blocked}
              onChange={(event) => setBid(event.target.value)}
            />
          </label>
          <div className="product-actions">
            <button
              disabled={blocked || !ready || !flags?.bid || !sourceRecord}
              onClick={() => void run(placeBid)}
            >
              Review and place bid
            </button>
            <button
              disabled={blocked || !ready || !flags?.settle}
              onClick={() => void run(() => auctionExit("settle"))}
            >
              Settle ended auction
            </button>
            <button
              disabled={blocked || !ready || !flags?.cancel}
              onClick={() => void run(() => auctionExit("cancel"))}
            >
              Cancel as seller
            </button>
          </div>
          {privateReady && (
            <p>
              Withdrawable credit:{" "}
              {credit === null ? "unavailable" : display(credit, paymentMeta)}{" "}
              <button
                disabled={blocked || credit === null || credit === 0n}
                onClick={() => void run(() => auctionExit("withdraw"))}
              >
                Withdraw credit
              </button>
            </p>
          )}
          <h4>Attributed bid and auction history</h4>
          {history.length ? (
            <ol>
              {history.map((entry, index) => (
                <li key={index} className="nft-market-hash">
                  {entry}
                </li>
              ))}
            </ol>
          ) : (
            <p>
              No auction event was observed in the selected recent block window.
            </p>
          )}
        </article>
      )}
      <details>
        <summary>Create a fraction auction</summary>
        <p>
          Enter human token amounts when metadata is available; an unavailable
          metadata response requires base units. All terms are reviewed before
          wallet approval.
        </p>
        {[
          ["Fraction token address", asset, setAsset],
          ["Payment token address", payment, setPayment],
          ["Fraction amount", amount, setAmount],
          ["Opening bid", opening, setOpening],
          ["Reserve", reserve, setReserve],
          ["Minimum bid increment", increment, setIncrement],
          ["Duration (whole hours)", duration, setDuration],
        ].map(([label, value, setter]) => (
          <label key={String(label)} className="auction-field">
            {String(label)}
            <input
              value={String(value)}
              disabled={blocked}
              onChange={(event) => {
                (setter as (value: string) => void)(event.target.value);
                setCreation(null);
              }}
            />
          </label>
        ))}
        <button
          disabled={blocked || !ready}
          onClick={() => void run(reviewCreation)}
        >
          Review auction terms
        </button>
        {creation && (
          <section aria-label="Auction escrow review" data-no-translate>
            <h3>Review auction escrow</h3>
            <p>
              {creation.source.grounding.mode} · {creation.source.title}.{" "}
              {creation.source.rights}
            </p>
            <p>
              Lock {display(creation.amount, assetMeta)} from {creation.asset}.
              Opening {display(creation.opening, paymentMeta)}, reserve{" "}
              {display(creation.reserve, paymentMeta)}, increment{" "}
              {display(creation.increment, paymentMeta)} paid in{" "}
              {creation.payment}.
            </p>
            <p>
              {new Date(creation.starts * 1000).toLocaleString()} to{" "}
              {new Date(creation.ends * 1000).toLocaleString()}. Each bid in the
              final five minutes extends the auction by five minutes.
            </p>
            <p>
              Only the seller may cancel before a bid. Once a bid exists, the
              escrow remains until the auction ends, including during a pause;
              settlement and credit withdrawal remain available.
            </p>
            <label>
              <input
                type="checkbox"
                checked={acceptedEscrow}
                disabled={blocked}
                onChange={(event) => setAcceptedEscrow(event.target.checked)}
              />
              I accept these bounded auction escrow terms.
            </label>
            <button
              disabled={blocked || !acceptedEscrow || !ready}
              onClick={() => void run(create)}
            >
              Confirm auction in wallet
            </button>
          </section>
        )}
      </details>
      {!ready && (
        <p>
          Connect and sign in on Hoodi to create, bid, settle or withdraw.
          Public auction inspection remains available.
        </p>
      )}
      {transactions.pending && (
        <p>
          A transaction is pending.{" "}
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await transactions.reconcile();
                if (snapshot) await refresh(snapshot.id);
                setDetail(
                  "The transaction receipt was reconciled. Inspect the refreshed auction before another action.",
                );
              })
            }
          >
            Check transaction
          </button>
        </p>
      )}
      {hash && <p className="nft-market-hash">Transaction {hash}</p>}
      {detail && <p role="status">{detail}</p>}
    </section>
  );
}
