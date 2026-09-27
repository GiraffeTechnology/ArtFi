"use client";

import { useCallback, useMemo, useState } from "react";
import { isAddress, type Address, type Hex } from "viem";
import {
  useAccount,
  useReadContract,
  useSignTypedData,
  useWriteContract,
} from "wagmi";

import { artFiFractionMarketAbi, fractionTokenAbi } from "@/lib/contracts";
import {
  anyFractionBuyer,
  fractionFillPayment,
  fractionIntentFillable,
  fractionIntentHash,
  fractionIntentRemaining,
  fractionIntentTypedData,
  validateFractionIntent,
  type FractionSaleIntent,
} from "@/lib/fraction-intent";
import { supportedChain } from "@/lib/wagmi";

/**
 * Fraction listing and fill — `PRD.md` §4.2.2, `AGENTS.md` §1.1 invariant 6.
 *
 * The screen for the signature-settled fixed-price path in `ArtFiMarket.sol`. Until this existed the
 * path was on chain with nothing reaching it, which `PRD.md` §3.2 counts as progress rather than a
 * handover: the screen is the deliverable.
 *
 * A holder authorizes a sale of up to some number of fractions by signing terms; a buyer settles
 * part or all of it. The fractions stay in the holder's own wallet in between. ArtFi is never
 * counterparty, holds no resting balance, and has no path that moves a holder's tokens without the
 * signature they produced for that fill.
 *
 * **Partial fills are why this differs from the whole-artwork surface.** One signature can settle
 * several times up to the maximum it names, so both sides need to see what is left, and the seller
 * needs a way to withdraw the remainder. Both are here: `revokeIntent` retires one authorization and
 * `incrementSellerEpoch` retires every authorization at once. Neither is blocked by an
 * administrative pause, because a pause must not keep an authorization alive that its author has
 * withdrawn.
 *
 * Four things this surface refuses to hide, because each one is a fill that would revert:
 *
 *   1. **Unconfigured means unavailable.** With no deployed market or fraction token it reports what
 *      is missing and offers nothing, rather than a settle button that cannot settle.
 *   2. **The allowlist.** `fillIntent` refuses a token pair the market does not allow, so the pair's
 *      standing is shown rather than discovered in a reverted transaction.
 *   3. **The pilot spend cap.** A buyer's payment is checked against `pilotPaymentCap` on chain. The
 *      remaining headroom is read and shown for the same reason.
 *   4. **Approval is its own step, for an exact amount.** A signature alone does not let the market
 *      move anything; each side grants an ERC-20 allowance for exactly what their leg needs. Never
 *      an unlimited approval — the seller's allowance covers the authorized maximum and the buyer's
 *      covers this fill.
 *
 * A signed authorization is not published anywhere. There is no order store yet (`STATUS.md` M2.4,
 * M2.5), so the signature stays in this browser and the holder passes it on themselves. The panel
 * says so rather than implying a live book.
 */

type Stage =
  | "idle"
  | "awaiting-signature"
  | "signed"
  | "approving"
  | "filling"
  | "filled"
  | "revoking"
  | "error";

const stageLabels: Record<Stage, string> = {
  idle: "No sale authorized",
  "awaiting-signature": "Waiting for the wallet signature",
  signed: "Sale authorized, not published",
  approving: "Waiting for the approval transaction",
  filling: "Waiting for the settlement transaction",
  filled: "Settled on chain",
  revoking: "Waiting for the withdrawal transaction",
  error: "This step needs attention",
};

const problemLabels: Record<string, string> = {
  "seller-missing": "The seller address is missing or malformed.",
  "asset-token-missing": "The fraction token address is missing or malformed.",
  "payment-token-missing": "The payment token address is missing or malformed.",
  "buyer-malformed": "The named buyer is not a valid address.",
  "max-amount-not-positive": "Authorize at least one fraction.",
  "unit-price-not-positive": "Enter a unit price above zero.",
  "window-not-positive": "The sale must end after it starts.",
  "window-out-of-range":
    "The sale window is outside the range the contract accepts.",
  "salt-negative": "The salt is not valid.",
  "epoch-negative": "The epoch is not valid.",
  "seller-is-buyer": "A seller cannot name themselves as the buyer.",
  "market-missing": "No fraction market address is configured.",
  "chain-mismatch": `Connect to ${supportedChain.name} to sign for this market.`,
};

const fillReasonLabels: Record<string, string> = {
  "not-yet-open": "This authorization has not opened yet.",
  expired: "This authorization has expired.",
  superseded:
    "The seller has withdrawn every authorization signed against this epoch.",
  exhausted:
    "This authorization has nothing left — it was filled in full or withdrawn.",
  "amount-not-positive": "Enter an amount above zero.",
  "amount-exceeds-remaining":
    "That is more than this authorization has left. Settle the remainder or less.",
};

function configuredAddress(value: string | undefined): Address | undefined {
  const trimmed = value?.trim();
  return trimmed && isAddress(trimmed) ? (trimmed as Address) : undefined;
}

/** Serializes an intent plus its signature for the holder to hand to a buyer. */
function encodeAuthorization(intent: FractionSaleIntent, signature: Hex) {
  return JSON.stringify(
    {
      intent: {
        ...intent,
        maxAmount: intent.maxAmount.toString(),
        unitPrice: intent.unitPrice.toString(),
        salt: intent.salt.toString(),
        epoch: intent.epoch.toString(),
      },
      signature,
    },
    null,
    2,
  );
}

function decodeAuthorization(
  raw: string,
): { intent: FractionSaleIntent; signature: Hex } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "That is not the authorization text a seller produces." };
  }
  const body = parsed as {
    intent?: Record<string, unknown>;
    signature?: unknown;
  };
  if (!body?.intent || typeof body.signature !== "string") {
    return {
      error: "The authorization is missing its terms or its signature.",
    };
  }
  const source = body.intent;
  try {
    const intent: FractionSaleIntent = {
      seller: String(source.seller) as Address,
      assetToken: String(source.assetToken) as Address,
      paymentToken: String(source.paymentToken) as Address,
      maxAmount: BigInt(String(source.maxAmount)),
      unitPrice: BigInt(String(source.unitPrice)),
      buyer: String(source.buyer) as Address,
      salt: BigInt(String(source.salt)),
      startsAt: Number(source.startsAt),
      endsAt: Number(source.endsAt),
      epoch: BigInt(String(source.epoch)),
    };
    return { intent, signature: body.signature as Hex };
  } catch {
    return { error: "The authorization's terms could not be read." };
  }
}

function parseAmount(value: string): bigint | undefined {
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  return BigInt(trimmed);
}

export function FractionListing({
  assetToken,
}: Readonly<{ assetToken?: string }>) {
  const { address, chainId, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();

  const [stage, setStage] = useState<Stage>("idle");
  const [detail, setDetail] = useState<string>();
  const [authorization, setAuthorization] = useState<string>();
  const [signed, setSigned] = useState<FractionSaleIntent>();
  const [digest, setDigest] = useState<Hex>();
  const [pasted, setPasted] = useState("");
  const [fillAmount, setFillAmount] = useState("");

  const [maxAmount, setMaxAmount] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [paymentToken, setPaymentToken] = useState("");
  const [namedBuyer, setNamedBuyer] = useState("");
  const [durationHours, setDurationHours] = useState("24");

  const market = configuredAddress(
    process.env.NEXT_PUBLIC_ARTFI_FRACTION_MARKET_ADDRESS,
  );
  const token =
    configuredAddress(assetToken) ??
    configuredAddress(process.env.NEXT_PUBLIC_ARTFI_FRACTION_TOKEN_ADDRESS);

  const { data: epoch } = useReadContract({
    abi: artFiFractionMarketAbi,
    address: market,
    functionName: "sellerEpoch",
    args: address ? [address] : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(market && address) },
  });

  const { data: marketPaused } = useReadContract({
    abi: artFiFractionMarketAbi,
    address: market,
    functionName: "paused",
    chainId: supportedChain.id,
    query: { enabled: Boolean(market) },
  });

  const { data: assetAllowed } = useReadContract({
    abi: artFiFractionMarketAbi,
    address: market,
    functionName: "allowedAssetToken",
    args: token ? [token] : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(market && token) },
  });

  const { data: holding } = useReadContract({
    abi: fractionTokenAbi,
    address: token,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(token && address) },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    abi: fractionTokenAbi,
    address: token,
    functionName: "allowance",
    args: address && market ? [address, market] : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(token && address && market) },
  });

  const holdsFractions = (holding ?? 0n) > 0n;

  /**
   * The buyer's half is read from chain, not assumed from the text they pasted.
   *
   * An authorization is a claim about terms, never about what is left of them. Another buyer may
   * have taken part of the same signature, and the seller may have withdrawn it or bumped their
   * epoch, since this text was written. So the cumulative fill counter and the seller's current
   * epoch are both read against the digest and the seller in the pasted terms.
   */
  const pastedAuthorization = useMemo(() => {
    if (!pasted.trim()) return undefined;
    const decoded = decodeAuthorization(pasted);
    return "error" in decoded ? undefined : decoded;
  }, [pasted]);

  const pastedDigest = useMemo(() => {
    if (!pastedAuthorization || !market) return undefined;
    try {
      return fractionIntentHash(
        pastedAuthorization.intent,
        { chainId: supportedChain.id, verifyingContract: market },
        supportedChain.id,
      );
    } catch {
      return undefined;
    }
  }, [market, pastedAuthorization]);

  const { data: alreadyFilled } = useReadContract({
    abi: artFiFractionMarketAbi,
    address: market,
    functionName: "intentFilled",
    args: pastedDigest ? [pastedDigest] : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(market && pastedDigest) },
  });

  const { data: pastedSellerEpoch } = useReadContract({
    abi: artFiFractionMarketAbi,
    address: market,
    functionName: "sellerEpoch",
    args: pastedAuthorization ? [pastedAuthorization.intent.seller] : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(market && pastedAuthorization) },
  });

  const { data: pilotCap } = useReadContract({
    abi: artFiFractionMarketAbi,
    address: market,
    functionName: "pilotPaymentCap",
    args:
      address && pastedAuthorization
        ? [address, pastedAuthorization.intent.paymentToken]
        : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(market && address && pastedAuthorization) },
  });

  const { data: pilotUsed } = useReadContract({
    abi: artFiFractionMarketAbi,
    address: market,
    functionName: "pilotPaymentUsed",
    args:
      address && pastedAuthorization
        ? [address, pastedAuthorization.intent.paymentToken]
        : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(market && address && pastedAuthorization) },
  });

  const pilotHeadroom =
    pilotCap === undefined || pilotUsed === undefined
      ? undefined
      : pilotCap > pilotUsed
        ? pilotCap - pilotUsed
        : 0n;

  /**
   * What this fill would cost and what is left of the authorization.
   *
   * Deliberately free of the clock. Whether the sale window is open changes between renders without
   * anything on this page changing, so it is decided in the click handler against the instant of the
   * click — not here, where it would make the render impure and the answer stale.
   */
  const fillPreview = useMemo(() => {
    if (!pastedAuthorization) return undefined;
    const { intent } = pastedAuthorization;
    const amount = parseAmount(fillAmount);
    return {
      remaining: fractionIntentRemaining(intent, alreadyFilled ?? 0n),
      payment:
        amount === undefined ? undefined : fractionFillPayment(intent, amount),
      superseded:
        pastedSellerEpoch !== undefined && intent.epoch !== pastedSellerEpoch,
      opensAt: intent.startsAt,
      closesAt: intent.endsAt,
    };
  }, [alreadyFilled, fillAmount, pastedAuthorization, pastedSellerEpoch]);

  /**
   * The terms, given the instant the sale opens.
   *
   * The clock is a parameter rather than something read here: `startsAt` and the salt derived from
   * it are fixed when the holder signs, not re-rolled on every render.
   */
  const buildIntent = useCallback(
    (startsAt: number): FractionSaleIntent | undefined => {
      if (!address || !token) return undefined;
      const authorized = parseAmount(maxAmount);
      const price = parseAmount(unitPrice);
      if (authorized === undefined || price === undefined) return undefined;
      const hours = Number(durationHours);
      return {
        seller: address,
        assetToken: token,
        paymentToken: (paymentToken.trim() || anyFractionBuyer) as Address,
        maxAmount: authorized,
        unitPrice: price,
        buyer: (namedBuyer.trim() || anyFractionBuyer) as Address,
        // Distinguishes otherwise identical terms, so a holder can keep two live authorizations
        // over the same fractions — which the settlement path allows, since neither moves them and
        // the cumulative counter is per signature.
        salt: BigInt(startsAt),
        startsAt,
        endsAt:
          startsAt + (Number.isFinite(hours) ? Math.round(hours * 3600) : 0),
        epoch: epoch ?? 0n,
      };
    },
    [
      address,
      durationHours,
      epoch,
      maxAmount,
      namedBuyer,
      paymentToken,
      token,
      unitPrice,
    ],
  );

  /**
   * Validation runs against a fixed reference instant. Everything it reports — the amounts, the
   * addresses, the length of the window — is a term the holder entered, and none of them depend on
   * what the clock reads while they are typing.
   */
  const problems = useMemo(() => {
    if (!market) return ["market-missing"];
    const probe = buildIntent(1_000_000_000);
    if (!probe) return [];
    return validateFractionIntent(
      probe,
      { chainId: supportedChain.id, verifyingContract: market },
      supportedChain.id,
    );
  }, [buildIntent, market]);

  const authorize = useCallback(async () => {
    const draft = buildIntent(Math.floor(Date.now() / 1000));
    if (!draft || !market) return;
    setDetail(undefined);
    setAuthorization(undefined);
    try {
      setStage("awaiting-signature");
      const domain = { chainId: supportedChain.id, verifyingContract: market };
      // Throws on terms that would be refused, so the wallet is never asked to sign them.
      const hash = fractionIntentHash(draft, domain, supportedChain.id);
      const signature = await signTypedDataAsync(
        fractionIntentTypedData(draft, domain),
      );
      setDigest(hash);
      setSigned(draft);
      setAuthorization(encodeAuthorization(draft, signature));
      setStage("signed");
    } catch (error) {
      setDetail(
        error instanceof Error
          ? error.message
          : "The signature was not produced.",
      );
      setStage("error");
    }
  }, [buildIntent, market, signTypedDataAsync]);

  /** Approves exactly the authorized maximum. Never unlimited. */
  const approveFractions = useCallback(async () => {
    const authorized = parseAmount(maxAmount);
    if (!token || !market || authorized === undefined) return;
    setDetail(undefined);
    try {
      setStage("approving");
      await writeContractAsync({
        abi: fractionTokenAbi,
        address: token,
        functionName: "approve",
        args: [market, authorized],
        chainId: supportedChain.id,
      });
      await refetchAllowance();
      setStage(authorization ? "signed" : "idle");
    } catch (error) {
      setDetail(
        error instanceof Error ? error.message : "The approval was not sent.",
      );
      setStage("error");
    }
  }, [
    authorization,
    market,
    maxAmount,
    refetchAllowance,
    token,
    writeContractAsync,
  ]);

  const revokeOne = useCallback(async () => {
    if (!market || !signed) return;
    setDetail(undefined);
    try {
      setStage("revoking");
      await writeContractAsync({
        abi: artFiFractionMarketAbi,
        address: market,
        functionName: "revokeIntent",
        args: [signed],
        chainId: supportedChain.id,
      });
      setAuthorization(undefined);
      setSigned(undefined);
      setDigest(undefined);
      setStage("idle");
    } catch (error) {
      setDetail(
        error instanceof Error ? error.message : "The withdrawal was not sent.",
      );
      setStage("error");
    }
  }, [market, signed, writeContractAsync]);

  const revokeAll = useCallback(async () => {
    if (!market) return;
    setDetail(undefined);
    try {
      setStage("revoking");
      await writeContractAsync({
        abi: artFiFractionMarketAbi,
        address: market,
        functionName: "incrementSellerEpoch",
        chainId: supportedChain.id,
      });
      setAuthorization(undefined);
      setSigned(undefined);
      setDigest(undefined);
      setStage("idle");
    } catch (error) {
      setDetail(
        error instanceof Error ? error.message : "The withdrawal was not sent.",
      );
      setStage("error");
    }
  }, [market, writeContractAsync]);

  const fill = useCallback(async () => {
    if (!market) return;
    setDetail(undefined);
    const decoded = decodeAuthorization(pasted);
    if ("error" in decoded) {
      setDetail(decoded.error);
      setStage("error");
      return;
    }
    const { intent, signature } = decoded;
    const domain = { chainId: supportedChain.id, verifyingContract: market };
    const invalid = validateFractionIntent(intent, domain, supportedChain.id);
    if (invalid.length > 0) {
      setDetail(
        invalid.map((problem) => problemLabels[problem] ?? problem).join(" "),
      );
      setStage("error");
      return;
    }
    const amount = parseAmount(fillAmount);
    if (amount === undefined) {
      setDetail("Enter the number of fractions to settle.");
      setStage("error");
      return;
    }
    // Checked against the chain's own counters and the instant of the click, not against what the
    // pasted text claims: another buyer may have taken part of this authorization, and the seller
    // may have withdrawn it, since it was written.
    const state = fractionIntentFillable(
      intent,
      Math.floor(Date.now() / 1000),
      pastedSellerEpoch ?? intent.epoch,
      alreadyFilled ?? 0n,
      amount,
    );
    if (!state.fillable) {
      setDetail(fillReasonLabels[state.reason] ?? "This fill was refused.");
      setStage("error");
      return;
    }
    const payment = fractionFillPayment(intent, amount);
    if (pilotHeadroom !== undefined && payment > pilotHeadroom) {
      setDetail(
        "This fill is above your remaining pilot spend cap for that payment token, so the market would refuse it.",
      );
      setStage("error");
      return;
    }
    try {
      setStage("approving");
      // Exactly this fill's payment, never an unlimited allowance.
      await writeContractAsync({
        abi: fractionTokenAbi,
        address: intent.paymentToken,
        functionName: "approve",
        args: [market, payment],
        chainId: supportedChain.id,
      });
      setStage("filling");
      await writeContractAsync({
        abi: artFiFractionMarketAbi,
        address: market,
        functionName: "fillIntent",
        args: [intent, signature, amount],
        chainId: supportedChain.id,
      });
      setStage("filled");
    } catch (error) {
      setDetail(
        error instanceof Error ? error.message : "The settlement was not sent.",
      );
      setStage("error");
    }
  }, [
    alreadyFilled,
    fillAmount,
    market,
    pasted,
    pastedSellerEpoch,
    pilotHeadroom,
    writeContractAsync,
  ]);

  if (!market || !token) {
    return (
      <section
        className="market-intent-panel"
        aria-labelledby="fraction-listing"
      >
        <p className="eyebrow">Fractions, sold by signature</p>
        <h2 id="fraction-listing">
          Settlement on ArtFi is not configured for these fractions.
        </h2>
        <p>
          Settling a fraction sale here needs a deployed fraction market and the
          fraction token&apos;s own contract address.{" "}
          {market ? "" : "No market address is configured. "}
          {token ? "" : "No fraction token is configured. "}
          Until both are present this surface offers nothing, rather than
          showing a sale it could not settle.
        </p>
        <p>
          This is about settlement on ArtFi, not about the asset. Fractions
          trade on ArtFi and on OpenSea both, and the external market records on
          this site carry a link out to the venue.
        </p>
      </section>
    );
  }

  return (
    <section className="market-intent-panel" aria-labelledby="fraction-listing">
      <p className="eyebrow">Fractions, sold by signature</p>
      <h2 id="fraction-listing">
        Your fractions stay in your wallet until they sell.
      </h2>
      <p>
        A sale is authorized by signature, not by handing the fractions over.
        One authorization names a maximum and can settle more than once, up to
        that maximum, and only against the terms you signed. You can withdraw
        what is left at any time.
      </p>

      <dl className="contract-facts">
        <div>
          <dt>Status</dt>
          <dd>{stageLabels[stage]}</dd>
        </div>
        <div>
          <dt>Your fractions</dt>
          <dd>
            {holding === undefined ? "Reading from chain" : String(holding)}
          </dd>
        </div>
        <div>
          <dt>Market may move</dt>
          <dd>
            {allowance === undefined ? "Reading from chain" : String(allowance)}
          </dd>
        </div>
        <div>
          <dt>Token allowlisted</dt>
          <dd>
            {assetAllowed === undefined
              ? "Reading from chain"
              : assetAllowed
                ? "Yes"
                : "No"}
          </dd>
        </div>
      </dl>

      {marketPaused && (
        <p className="dao-alert dao-alert--warning">
          The market is paused, so no new fill can settle. Withdrawing an
          authorization still works — a pause never keeps one alive.
        </p>
      )}

      {assetAllowed === false && (
        <p className="dao-alert dao-alert--blocked">
          This fraction token is not on the market&apos;s allowlist, so a fill
          would be refused on chain.
        </p>
      )}

      {!isConnected && (
        <p className="dao-note">
          Connect the wallet that holds these fractions to authorize a sale, or
          any wallet to settle one.
        </p>
      )}

      {isConnected && chainId !== supportedChain.id && (
        <p className="dao-alert dao-alert--warning">
          This market is on {supportedChain.name}. Switch networks to continue.
        </p>
      )}

      {isConnected && holdsFractions && (
        <div className="dao-composer">
          <div className="field-grid">
            <label>
              Fractions to authorize, at most
              <input
                value={maxAmount}
                onChange={(event) => setMaxAmount(event.target.value)}
                inputMode="numeric"
                placeholder="100"
              />
            </label>
            <label>
              Price per fraction, in the payment token&apos;s smallest unit
              <input
                value={unitPrice}
                onChange={(event) => setUnitPrice(event.target.value)}
                inputMode="numeric"
                placeholder="1000000"
              />
            </label>
            <label>
              Payment token
              <input
                value={paymentToken}
                onChange={(event) => setPaymentToken(event.target.value)}
                placeholder="0x…"
              />
            </label>
            <label>
              Open for, in hours
              <input
                value={durationHours}
                onChange={(event) => setDurationHours(event.target.value)}
                inputMode="numeric"
              />
            </label>
            <label>
              Buyer, or blank for anyone
              <input
                value={namedBuyer}
                onChange={(event) => setNamedBuyer(event.target.value)}
                placeholder="0x…"
              />
            </label>
          </div>

          {problems.length > 0 && (
            <ul className="dao-error">
              {problems.map((problem) => (
                <li key={problem}>{problemLabels[problem] ?? problem}</li>
              ))}
            </ul>
          )}

          <p className="dao-alert dao-alert--warning">
            Before a sale can settle, this market needs permission to move
            exactly the fractions you authorized — not an unlimited allowance,
            and no other way to move them. You can change it from your wallet at
            any time.
          </p>

          <div className="actions">
            <button
              type="button"
              className="secondary"
              onClick={approveFractions}
              disabled={stage === "approving" || !parseAmount(maxAmount)}
            >
              Approve exactly this many
            </button>
            <button
              type="button"
              className="primary"
              onClick={authorize}
              disabled={problems.length > 0 || stage === "awaiting-signature"}
            >
              Sign the sale terms
            </button>
            <button
              type="button"
              className="secondary"
              onClick={revokeOne}
              disabled={!signed || stage === "revoking"}
            >
              Withdraw this authorization
            </button>
            <button
              type="button"
              className="secondary"
              onClick={revokeAll}
              disabled={stage === "revoking"}
            >
              Withdraw every authorization
            </button>
          </div>

          {authorization && (
            <div className="transaction-panel">
              <p>
                <strong>Signed, and published nowhere.</strong> ArtFi has no
                order store yet, so this authorization exists only in this
                browser. Send it to a buyer yourself. It settles only against
                the terms above, up to the maximum you named, and withdrawing it
                on chain makes it unusable even to someone holding this text.
              </p>
              {digest && (
                <p className="charity-digest">
                  <span>Intent hash</span> {digest}
                </p>
              )}
              <textarea readOnly rows={12} value={authorization} />
            </div>
          )}
        </div>
      )}

      {/*
        Open to anyone connected, including a holder. A fraction holder is a plausible buyer of more
        of the same asset, which is not true of a whole artwork, so this half is not hidden behind
        holding nothing.
      */}
      {isConnected && (
        <div className="dao-composer">
          <p className="dao-note">
            Paste a seller&apos;s authorization and say how many fractions to
            take. Payment leaves your wallet and the fractions arrive in the
            same transaction, or neither moves. One authorization can be settled
            in parts, so you need not take all of it.
          </p>
          <div className="field-grid">
            <label className="field-span">
              Seller&apos;s authorization
              <textarea
                rows={10}
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                placeholder="Paste the signed terms here"
              />
            </label>
            <label>
              Fractions to settle
              <input
                value={fillAmount}
                onChange={(event) => setFillAmount(event.target.value)}
                inputMode="numeric"
                placeholder="10"
              />
            </label>
          </div>

          {fillPreview && (
            <dl className="contract-facts" data-testid="fraction-fill-preview">
              <div>
                <dt>Left on this authorization</dt>
                <dd>{String(fillPreview.remaining)}</dd>
              </div>
              <div>
                <dt>You would pay</dt>
                <dd>
                  {fillPreview.payment === undefined
                    ? "Enter an amount"
                    : String(fillPreview.payment)}
                </dd>
              </div>
              <div>
                <dt>Your remaining pilot cap</dt>
                <dd>
                  {pilotHeadroom === undefined
                    ? "Reading from chain"
                    : String(pilotHeadroom)}
                </dd>
              </div>
              <div>
                <dt>Sale window, in seconds</dt>
                <dd>
                  {fillPreview.opensAt} to {fillPreview.closesAt}
                </dd>
              </div>
            </dl>
          )}

          {fillPreview?.superseded && (
            <p className="dao-alert dao-alert--blocked">
              {fillReasonLabels.superseded}
            </p>
          )}

          {fillPreview && fillPreview.remaining === 0n && (
            <p className="dao-alert dao-alert--blocked">
              {fillReasonLabels.exhausted}
            </p>
          )}

          {pasted.trim() && !pastedAuthorization && (
            <p className="dao-alert dao-alert--blocked">
              That is not the authorization text a seller produces.
            </p>
          )}

          <p className="dao-note">
            Settling takes two transactions: an allowance for exactly this
            fill&apos;s payment, then the fill itself. A pilot spend cap applies
            to the payment token, so a fill above your remaining cap is refused
            on chain.
          </p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={fill}
              disabled={
                !pastedAuthorization ||
                !fillAmount.trim() ||
                stage === "filling" ||
                stage === "approving"
              }
            >
              Settle this amount
            </button>
          </div>
        </div>
      )}

      {stage === "filled" && (
        <p className="dao-alert">
          Settled. The fractions and the payment moved in the same transaction.
        </p>
      )}

      {detail && <p className="dao-alert dao-alert--blocked">{detail}</p>}
    </section>
  );
}
