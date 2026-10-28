"use client";
import { useEffect, useRef, useState } from "react";
import styles from "./revenue-claims.module.css";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { type Address, type Hash } from "viem";
import { useUserSession } from "./user-session-provider";
import { RevenueDistributionBrowser } from "./revenue-distribution-browser";
import { publicSetting } from "@/lib/public-runtime-config";
import {
  assertTradingSession,
  userSessionController,
} from "@/lib/user-session-client";
import { portfolioSessionKey } from "@/lib/portfolio-session";
import { useMarketTransactions } from "@/lib/use-market-transactions";
import {
  revenueAddress,
  revenueRoundId,
  readRevenueRound,
  verifyRevenueClaimAtWallet,
  revenueReadDeadline,
  revenueDistributorAbi,
  type RevenueRound,
} from "@/lib/revenue-claims";

export function RevenueClaims() {
  const wallet = useAccount(),
    auth = useUserSession();
  const distributor = revenueAddress(
    publicSetting("NEXT_PUBLIC_ARTFI_REVENUE_DISTRIBUTOR_ADDRESS"),
  );
  const token = revenueAddress(
    publicSetting("NEXT_PUBLIC_ARTFI_FRACTION_TOKEN_ADDRESS"),
  );
  const sessionKey = portfolioSessionKey(auth, wallet);
  if (!distributor || !token)
    return (
      <section className={`product-tools ${styles.root}`}>
        <h2>Snapshot revenue claims</h2>
        <p>
          A per-asset revenue distributor and its fraction token are not
          configured. No distribution or entitlement is assumed.
        </p>
      </section>
    );
  if (!sessionKey || wallet.chainId !== 560048 || !wallet.address)
    return (
      <section className={`product-tools ${styles.root}`}>
        <h2>Snapshot revenue claims</h2>
        <p>
          Sign in with the connected Hoodi wallet to inspect its historical
          entitlement.
        </p>
      </section>
    );
  return (
    <ConnectedRevenueClaims
      key={sessionKey + distributor + token + ":" + auth.revision}
      distributor={distributor}
      fractionToken={token}
      account={wallet.address}
      revision={auth.revision}
    />
  );
}
function ConnectedRevenueClaims({
  distributor,
  fractionToken,
  account,
  revision,
}: {
  distributor: Address;
  fractionToken: Address;
  account: Address;
  revision: number;
}) {
  const client = usePublicClient({ chainId: 560048 });
  const { writeContractAsync } = useWriteContract();
  const [id, setId] = useState("1"),
    [round, setRound] = useState<RevenueRound>(),
    [busy, setBusy] = useState(false),
    [detail, setDetail] = useState(""),
    [hash, setHash] = useState<Hash>();
  const active = useRef(true),
    gate = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
    };
  }, []);
  const { pending, begin, reconcile } = useMarketTransactions(
    client,
    `revenue:560048:${distributor.toLowerCase()}:${fractionToken.toLowerCase()}:${account.toLowerCase()}`,
    setHash,
    {
      operationContext: String(revision),
      beforeWrite: async () => {
        await assertTradingSession(account, 560048);
        if (
          !active.current ||
          userSessionController.getSnapshot().revision !== revision
        )
          throw new Error("The signed-in wallet changed.");
      },
    },
  );
  const binding = { distributor, fractionToken, account };
  async function inspect(selectedId = id) {
    if (!client || gate.current) return;
    gate.current = true;
    setBusy(true);
    setRound(undefined);
    setDetail("");
    const ticket = ++generation.current;
    try {
      await assertTradingSession(account, 560048);
      const result = await revenueReadDeadline(() =>
        readRevenueRound(client, binding, revenueRoundId(selectedId)),
      );
      if (
        active.current &&
        ticket === generation.current &&
        userSessionController.getSnapshot().revision === revision
      )
        setRound(result);
    } catch {
      if (active.current && ticket === generation.current)
        setDetail(
          "This distribution could not be read for the current wallet. Check the ID, configured binding and RPC, then retry.",
        );
    } finally {
      gate.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function claim() {
    if (!client || !round || pending || gate.current) return;
    gate.current = true;
    setBusy(true);
    setDetail("");
    const reviewed = round;
    setRound(undefined);
    const ticket = ++generation.current;
    try {
      const operation = begin();
      await operation.write("claim", async () => {
        // The original transaction hook authenticates before entering this
        // callback. Do not carry business evidence across that asynchronous wait.
        await verifyRevenueClaimAtWallet(
          client,
          reviewed,
          operation.assertCurrent,
        );
        operation.assertCurrent();
        return writeContractAsync({
          address: distributor,
          abi: revenueDistributorAbi,
          functionName: "claim",
          args: [reviewed.id],
          account,
          chainId: 560048,
        });
      });
      if (active.current && ticket === generation.current)
        setDetail(
          "The claim transaction confirmed. Read the round again to inspect current on-chain claim state.",
        );
    } catch {
      if (active.current && ticket === generation.current)
        setDetail(
          "The claim did not reach a verified completion here. Check any pending transaction before retrying; a wallet rejection or changed entitlement does not count as a claim.",
        );
    } finally {
      gate.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function checkPending() {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setRound(undefined);
    setDetail("");
    try {
      await reconcile();
      if (active.current)
        setDetail(
          "The pending transaction is confirmed. Read the round again for its current claim state.",
        );
    } catch {
      if (active.current)
        setDetail(
          "The transaction could not be confirmed. Preserve its hash and check again before another submission.",
        );
    } finally {
      gate.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <section
      className={`product-tools ${styles.root}`}
      aria-label="Snapshot revenue claims"
    >
      <h2>Snapshot revenue claims</h2>
      <p>
        Funded rounds use the fraction token&apos;s historical balances,
        independently of delegated voting power. Current holdings are not the
        entitlement basis. Values below are payout-token base units, without
        fiat conversion or a promise of future income.
      </p>
      <p data-no-translate>
        Hoodi 560048 · Distributor {distributor} · Fraction token{" "}
        {fractionToken}
      </p>
      <RevenueDistributionBrowser
        client={client}
        binding={binding}
        disabled={busy || Boolean(pending)}
        beforeRead={async () => {
          await assertTradingSession(account, 560048);
          if (
            !active.current ||
            userSessionController.getSnapshot().revision !== revision
          )
            throw new Error("The signed-in wallet changed.");
        }}
        onSelect={(selectedId) => {
          setId(selectedId);
          void inspect(selectedId);
        }}
      />
      <form
        className="product-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label>
          Distribution ID{" "}
          <input
            value={id}
            maxLength={78}
            inputMode="numeric"
            disabled={busy}
            onChange={(event) => {
              generation.current++;
              setId(event.target.value);
              setRound(undefined);
              setDetail("");
            }}
          />
        </label>
        <button disabled={busy || !client}>Read distribution</button>
      </form>
      {round && (
        <div data-no-translate>
          <p>
            Round {String(round.id)} of {String(round.count)} · payout token{" "}
            {round.payoutToken}
          </p>
          <p>
            Funded {String(round.revenueAmount)} · claimed across all accounts{" "}
            {String(round.totalClaimed)}
          </p>
          <p>
            Snapshot timepoint {round.snapshotTimepoint} · supply{" "}
            {String(round.snapshotSupply)} · your historical balance{" "}
            {String(round.snapshotBalance)}
          </p>
          <p>
            Your claimable amount: {String(round.claimable)}. Already claimed:{" "}
            {round.claimed ? "yes" : "no"}.
          </p>
          <p>
            Observed at block {String(round.blockNumber)} ({round.blockHash}),
            browser time {new Date(round.observedAt).toISOString()}. This
            observation reserves nothing.
          </p>
          <button
            type="button"
            disabled={
              busy ||
              Boolean(pending) ||
              round.claimed ||
              round.claimable === 0n
            }
            onClick={() => void claim()}
          >
            Confirm claim in wallet
          </button>
        </div>
      )}
      {pending && (
        <p role="status">
          A revenue transaction is unresolved. No new claim can be requested.{" "}
          <button
            type="button"
            disabled={busy || !client}
            onClick={() => void checkPending()}
          >
            Check pending claim transaction
          </button>
        </p>
      )}
      {hash && <p data-no-translate>Latest transaction: {hash}</p>}
      {busy && (
        <p role="status">Reading or awaiting wallet / chain confirmation…</p>
      )}
      {detail && <p role="status">{detail}</p>}
      <p>
        Unclaimed revenue and rounding dust remain in the existing distributor;
        this page has no sweep, funding or administrator action. A confirmed
        token payment does not establish physical title or delivery.
      </p>
    </section>
  );
}
