"use client";

import { useCallback, useMemo, useState } from "react";
import { isAddress, type Address, type Hex } from "viem";
import {
  useAccount,
  useReadContract,
  useSignTypedData,
  useWriteContract,
} from "wagmi";

import {
  wholeArtworkCollectionAbi,
  wholeArtworkMarketAbi,
} from "@/lib/contracts";
import { supportedChain } from "@/lib/wagmi";
import {
  anyBuyer,
  saleIntentFillable,
  saleIntentHash,
  saleIntentTypedData,
  validateSaleIntent,
  type SaleIntent,
} from "@/lib/whole-artwork-intent";

/**
 * Whole-artwork listing and fill — `PRD.md` §4.2.2, `AGENTS.md` §1.1 invariant 6.
 *
 * The screen for the settlement path in `WholeArtworkMarket.sol`. A holder authorizes a sale by
 * signing terms; a buyer settles them. The artwork never leaves the holder's wallet in between,
 * and nothing here can move it without the signature the holder produced for that fill.
 *
 * Two honesty rules this surface keeps, because the alternative would be to show a market that
 * does not exist:
 *
 *   1. **A signed intent is not published.** There is no order store yet (`STATUS.md` M2.4, M2.5
 *      are `NOT-IMPLEMENTED`), so the signature stays in the browser and the holder passes it on
 *      themselves. The panel says so rather than implying a live book.
 *   2. **Unconfigured means unavailable.** With no deployed market address the surface reports
 *      what is missing and offers nothing. It never renders a fill button that cannot settle.
 *
 * Approval is shown as its own step. Signing alone does not let the market move the artwork; the
 * seller also grants the collection-level operator approval that `fillIntent` spends. That grant
 * is not custody — the contract has no path that moves an artwork without a matching signature —
 * but it is a real authorization, so the holder is told what it does and can see whether it is in
 * place.
 */

type Stage =
  | "idle"
  | "awaiting-signature"
  | "signed"
  | "approving"
  | "filling"
  | "filled"
  | "error";

const stageLabels: Record<Stage, string> = {
  idle: "No sale authorized",
  "awaiting-signature": "Waiting for the wallet signature",
  signed: "Sale authorized, not published",
  approving: "Waiting for the approval transaction",
  filling: "Waiting for the settlement transaction",
  filled: "Settled on chain",
  error: "This step needs attention",
};

const problemLabels: Record<string, string> = {
  "seller-missing": "The seller address is missing or malformed.",
  "collection-missing": "The artwork contract address is missing or malformed.",
  "payment-token-missing": "The payment token address is missing or malformed.",
  "buyer-malformed": "The named buyer is not a valid address.",
  "price-not-positive": "Enter a price above zero.",
  "window-not-positive": "The sale must end after it starts.",
  "window-out-of-range":
    "The sale window is outside the range the contract accepts.",
  "token-id-negative": "The token id is not valid.",
  "salt-negative": "The salt is not valid.",
  "epoch-negative": "The epoch is not valid.",
  "seller-is-buyer": "A seller cannot name themselves as the buyer.",
  "market-missing": "No whole-artwork market address is configured.",
  "chain-mismatch": `Connect to ${supportedChain.name} to sign for this market.`,
};

function configuredAddress(value: string | undefined): Address | undefined {
  const trimmed = value?.trim();
  return trimmed && isAddress(trimmed) ? (trimmed as Address) : undefined;
}

function marketAddress(): Address | undefined {
  return configuredAddress(
    process.env.NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_MARKET_ADDRESS,
  );
}

/** Serializes an intent plus its signature for the holder to hand to a buyer. */
function encodeAuthorization(intent: SaleIntent, signature: Hex) {
  return JSON.stringify(
    {
      intent: {
        ...intent,
        tokenId: intent.tokenId.toString(),
        price: intent.price.toString(),
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
): { intent: SaleIntent; signature: Hex } | { error: string } {
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
    const intent: SaleIntent = {
      seller: String(source.seller) as Address,
      collection: String(source.collection) as Address,
      tokenId: BigInt(String(source.tokenId)),
      paymentToken: String(source.paymentToken) as Address,
      price: BigInt(String(source.price)),
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

export function WholeArtworkListing({
  collection,
  tokenId,
}: Readonly<{ collection?: string; tokenId?: string }>) {
  const { address, chainId, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();

  const [stage, setStage] = useState<Stage>("idle");
  const [detail, setDetail] = useState<string>();
  const [authorization, setAuthorization] = useState<string>();
  const [digest, setDigest] = useState<Hex>();
  const [pasted, setPasted] = useState("");

  const [price, setPrice] = useState("");
  const [paymentToken, setPaymentToken] = useState("");
  const [namedBuyer, setNamedBuyer] = useState("");
  const [durationHours, setDurationHours] = useState("24");

  const market = marketAddress();
  // The props win, and deployment configuration is the fallback. Without the fallback this surface
  // could never be switched on at all: nothing passes a collection, so it would stay in its
  // unconfigured branch however the market itself were deployed.
  const collectionAddress =
    configuredAddress(collection) ??
    configuredAddress(
      process.env.NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS,
    );
  const configuredTokenId = (
    tokenId ?? process.env.NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID
  )?.trim();
  const artworkId = /^[0-9]+$/.test(configuredTokenId ?? "")
    ? BigInt(configuredTokenId!)
    : undefined;

  const { data: holder } = useReadContract({
    abi: wholeArtworkCollectionAbi,
    address: collectionAddress,
    functionName: "ownerOf",
    args: artworkId === undefined ? undefined : [artworkId],
    chainId: supportedChain.id,
    query: { enabled: Boolean(collectionAddress && artworkId !== undefined) },
  });

  const { data: epoch } = useReadContract({
    abi: wholeArtworkMarketAbi,
    address: market,
    functionName: "sellerEpoch",
    args: address ? [address] : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(market && address) },
  });

  const { data: approved, refetch: refetchApproval } = useReadContract({
    abi: wholeArtworkCollectionAbi,
    address: collectionAddress,
    functionName: "isApprovedForAll",
    args: address && market ? [address, market] : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(collectionAddress && address && market) },
  });

  const isHolder = Boolean(
    address && holder && address.toLowerCase() === holder.toLowerCase(),
  );

  /**
   * The buyer's copy of the seller's current epoch, read from chain rather than taken from the text
   * they were handed. A withdrawal happens after an authorization is written, so the terms can never
   * report it.
   */
  const pastedSeller = useMemo(() => {
    if (!pasted.trim()) return undefined;
    const decoded = decodeAuthorization(pasted);
    return "error" in decoded ? undefined : decoded.intent.seller;
  }, [pasted]);

  const { data: pastedSellerEpoch } = useReadContract({
    abi: wholeArtworkMarketAbi,
    address: market,
    functionName: "sellerEpoch",
    args: pastedSeller ? [pastedSeller] : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(market && pastedSeller) },
  });

  /**
   * The terms, given the instant the sale opens.
   *
   * The clock is deliberately a parameter rather than something read here: `startsAt` and the
   * salt derived from it are fixed when the holder signs, not re-rolled on every render.
   */
  const buildIntent = useCallback(
    (startsAt: number): SaleIntent | undefined => {
      if (!address || !collectionAddress || artworkId === undefined) {
        return undefined;
      }
      const hours = Number(durationHours);
      let priceValue: bigint;
      try {
        priceValue = BigInt(price || "0");
      } catch {
        return undefined;
      }
      return {
        seller: address,
        collection: collectionAddress,
        tokenId: artworkId,
        paymentToken: (paymentToken.trim() || anyBuyer) as Address,
        price: priceValue,
        buyer: (namedBuyer.trim() || anyBuyer) as Address,
        // Distinguishes otherwise identical terms, so a holder can authorize the same artwork
        // twice -- which the settlement path allows, since neither authorization moves it.
        salt: BigInt(startsAt),
        startsAt,
        endsAt:
          startsAt + (Number.isFinite(hours) ? Math.round(hours * 3600) : 0),
        epoch: epoch ?? 0n,
      };
    },
    [
      address,
      artworkId,
      collectionAddress,
      durationHours,
      epoch,
      namedBuyer,
      paymentToken,
      price,
    ],
  );

  /**
   * Validation runs against a fixed reference instant. Everything it reports -- the price, the
   * addresses, the length of the window -- is a term the holder entered, and none of them depend
   * on what the clock reads while they are typing.
   */
  const problems = useMemo(() => {
    if (!market) return ["market-missing"];
    const probe = buildIntent(1_000_000_000);
    if (!probe) return [];
    return validateSaleIntent(
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
      const hash = saleIntentHash(draft, domain, supportedChain.id);
      const signature = await signTypedDataAsync(
        saleIntentTypedData(draft, domain),
      );
      setDigest(hash);
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

  const grantApproval = useCallback(async () => {
    if (!collectionAddress || !market) return;
    setDetail(undefined);
    try {
      setStage("approving");
      await writeContractAsync({
        abi: wholeArtworkCollectionAbi,
        address: collectionAddress,
        functionName: "setApprovalForAll",
        args: [market, true],
        chainId: supportedChain.id,
      });
      await refetchApproval();
      setStage(authorization ? "signed" : "idle");
    } catch (error) {
      setDetail(
        error instanceof Error ? error.message : "The approval was not sent.",
      );
      setStage("error");
    }
  }, [
    authorization,
    collectionAddress,
    market,
    refetchApproval,
    writeContractAsync,
  ]);

  const revokeAll = useCallback(async () => {
    if (!market) return;
    setDetail(undefined);
    try {
      setStage("filling");
      await writeContractAsync({
        abi: wholeArtworkMarketAbi,
        address: market,
        functionName: "incrementEpoch",
        chainId: supportedChain.id,
      });
      setAuthorization(undefined);
      setDigest(undefined);
      setStage("idle");
    } catch (error) {
      setDetail(
        error instanceof Error ? error.message : "The revocation was not sent.",
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
    const invalid = validateSaleIntent(
      intent,
      { chainId: supportedChain.id, verifyingContract: market },
      supportedChain.id,
    );
    if (invalid.length > 0) {
      setDetail(
        invalid.map((problem) => problemLabels[problem] ?? problem).join(" "),
      );
      setStage("error");
      return;
    }
    // The seller's epoch is read from chain, not taken from the pasted terms. Comparing the terms
    // against themselves would always agree, and the one thing this check exists to catch is a
    // seller who has withdrawn every authorization since that text was written.
    const state = saleIntentFillable(
      intent,
      Math.floor(Date.now() / 1000),
      pastedSellerEpoch ?? intent.epoch,
    );
    if (!state.fillable) {
      setDetail(
        state.reason === "expired"
          ? "This authorization has expired."
          : state.reason === "superseded"
            ? "The seller has withdrawn every authorization signed against this epoch."
            : "This authorization is not open for settlement.",
      );
      setStage("error");
      return;
    }
    try {
      setStage("filling");
      await writeContractAsync({
        abi: wholeArtworkMarketAbi,
        address: market,
        functionName: "fillIntent",
        args: [intent, signature],
        chainId: supportedChain.id,
      });
      setStage("filled");
    } catch (error) {
      setDetail(
        error instanceof Error ? error.message : "The settlement was not sent.",
      );
      setStage("error");
    }
  }, [market, pasted, pastedSellerEpoch, writeContractAsync]);

  if (!market || !collectionAddress || artworkId === undefined) {
    return (
      <section
        className="market-intent-panel"
        aria-labelledby="whole-artwork-listing"
      >
        <p className="eyebrow">Sale by signature</p>
        <h2 id="whole-artwork-listing">
          Settlement on ArtFi is not configured for this artwork.
        </h2>
        <p>
          Settling a sale here needs a deployed whole-artwork market and the
          artwork&apos;s own contract address.{" "}
          {market ? "" : "No market address is configured. "}
          {collectionAddress ? "" : "No artwork contract is configured. "}
          Until both are present this surface offers nothing, rather than
          showing a sale it could not settle.
        </p>
        <p>
          This is about settlement on ArtFi, not about the artwork. Whole
          artworks trade on ArtFi and on OpenSea both, and the external market
          records on this site carry a link out to the venue.
        </p>
      </section>
    );
  }

  return (
    <section
      className="market-intent-panel"
      aria-labelledby="whole-artwork-listing"
    >
      <p className="eyebrow">Sale by signature</p>
      <h2 id="whole-artwork-listing">
        The artwork stays in your wallet until it sells.
      </h2>
      <p>
        A sale is authorized by signature, not by handing the artwork over. It
        moves once, in the transaction that pays you, and only against the terms
        you signed. You can withdraw the authorization at any time before then.
      </p>

      <dl className="contract-facts">
        <div>
          <dt>Status</dt>
          <dd>{stageLabels[stage]}</dd>
        </div>
        <div>
          <dt>Holder</dt>
          <dd>{holder ?? "Reading from chain"}</dd>
        </div>
        <div>
          <dt>Market can move it</dt>
          <dd>{approved ? "Approved" : "Not approved"}</dd>
        </div>
      </dl>

      {!isConnected && (
        <p className="dao-note">
          Connect the wallet that holds this artwork to authorize a sale, or any
          wallet to settle one.
        </p>
      )}

      {isConnected && chainId !== supportedChain.id && (
        <p className="dao-alert dao-alert--warning">
          This market is on {supportedChain.name}. Switch networks to continue.
        </p>
      )}

      {isConnected && isHolder && (
        <div className="dao-composer">
          <div className="field-grid">
            <label>
              Price, in the payment token&apos;s smallest unit
              <input
                value={price}
                onChange={(event) => setPrice(event.target.value)}
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

          {!approved && (
            <p className="dao-alert dao-alert--warning">
              Before a sale can settle, this market needs permission to move the
              artwork in the fill you signed. It gets no other way to move it,
              and you can withdraw the permission from your wallet at any time.
            </p>
          )}

          <div className="actions">
            {!approved && (
              <button
                type="button"
                className="secondary"
                onClick={grantApproval}
                disabled={stage === "approving"}
              >
                Approve the market
              </button>
            )}
            <button
              type="button"
              className="primary"
              onClick={authorize}
              disabled={problems.length > 0 || stage === "awaiting-signature"}
            >
              Sign the sale terms
            </button>
            <button type="button" className="secondary" onClick={revokeAll}>
              Withdraw every authorization
            </button>
          </div>

          {authorization && (
            <div className="transaction-panel">
              <p>
                <strong>Signed, and published nowhere.</strong> ArtFi has no
                order store yet, so this authorization exists only in this
                browser. Send it to a buyer yourself. It settles only against
                the terms above, and withdrawing it on chain makes it unusable
                even to someone holding this text.
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

      {isConnected && !isHolder && (
        <div className="dao-composer">
          <p className="dao-note">
            Paste a seller&apos;s authorization to settle it. Payment leaves
            your wallet and the artwork arrives in the same transaction, or
            neither moves.
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
          </div>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={fill}
              disabled={!pasted.trim() || stage === "filling"}
            >
              Settle this sale
            </button>
          </div>
        </div>
      )}

      {stage === "filled" && (
        <p className="dao-alert">
          Settled. The artwork and the payment moved in the same transaction.
        </p>
      )}

      {detail && <p className="dao-alert dao-alert--blocked">{detail}</p>}
    </section>
  );
}
