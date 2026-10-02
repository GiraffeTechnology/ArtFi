"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { isAddress, type Address, type Hex } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSignTypedData,
  useWriteContract,
} from "wagmi";

import { assetDeploymentBinding } from "@/lib/asset-binding";
import {
  fractionTokenAbi,
  wholeArtworkCollectionAbi,
  wholeArtworkMarketAbi,
} from "@/lib/contracts";
import { supportedChain } from "@/lib/wagmi";
import { useMarketTransactions } from "@/lib/use-market-transactions";
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
  | "revoking"
  | "error";

const stageLabels: Record<Stage, string> = {
  idle: "No sale authorized",
  "awaiting-signature": "Waiting for the wallet signature",
  signed: "Sale authorized, not published",
  approving: "Waiting for the approval transaction",
  filling: "Waiting for the settlement transaction",
  filled: "Settled on chain",
  revoking: "Waiting for the withdrawal receipt",
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
  slug,
  collection,
  tokenId,
}: Readonly<{ slug?: string; collection?: string; tokenId?: string }>) {
  const { address, chainId, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: supportedChain.id });
  const actionPending = useRef(false);
  const [transactionHash, setTransactionHash] = useState<Hex>();

  const [stage, setStage] = useState<Stage>("idle");
  const busy = [
    "awaiting-signature",
    "approving",
    "filling",
    "revoking",
  ].includes(stage);
  const canTransact =
    isConnected && chainId === supportedChain.id && Boolean(publicClient);
  const [detail, setDetail] = useState<string>();
  const [authorization, setAuthorization] = useState<string>();
  const [digest, setDigest] = useState<Hex>();
  const [pasted, setPasted] = useState("");

  const [price, setPrice] = useState("");
  const [paymentToken, setPaymentToken] = useState("");
  const [namedBuyer, setNamedBuyer] = useState("");
  const [durationHours, setDurationHours] = useState("24");

  const market = marketAddress();

  /**
   * **The deployment artwork belongs to one route, not to every page that renders this.**
   *
   * `AssetDetail` is shared by every slug in `lib/catalog.ts`, six invented artworks that map to no
   * deployed token. A collection and token id read from the environment alone would appear beneath
   * all six titles at once, and a holder could authorize a sale of a real artwork from a page
   * describing a different one. `ACCEPTANCE.md` §3 and `AGENTS.md` §5 both refuse that.
   *
   * So the props win, and the environment's artwork applies only to the one slug the environment
   * names. Every other route stays inert and says why. Without a fallback of some kind the surface
   * could never be switched on at all — nothing passes a collection — so the fallback stays, bound.
   */
  const configuredCollection =
    process.env.NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS;
  const binding = assetDeploymentBinding(
    slug,
    process.env.NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG,
    configuredCollection,
  );
  const collectionAddress =
    configuredAddress(collection) ??
    (binding.bound ? configuredAddress(configuredCollection) : undefined);
  const configuredTokenId = (
    tokenId ??
    (binding.bound
      ? process.env.NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID
      : undefined)
  )?.trim();
  // Told apart from "nothing is deployed at all", so the page can say which of the two it is.
  const boundElsewhere = !collectionAddress && binding.boundElsewhere;
  const artworkId = /^[0-9]+$/.test(configuredTokenId ?? "")
    ? BigInt(configuredTokenId!)
    : undefined;

  const { data: holder, refetch: refetchHolder } = useReadContract({
    abi: wholeArtworkCollectionAbi,
    address: collectionAddress,
    functionName: "ownerOf",
    args: artworkId === undefined ? undefined : [artworkId],
    chainId: supportedChain.id,
    query: { enabled: Boolean(collectionAddress && artworkId !== undefined) },
  });

  const { pending, begin, reconcile } = useMarketTransactions(
    publicClient,
    `${chainId}:${market}:${collectionAddress}:${artworkId}:${address}`,
    setTransactionHash,
  );
  const visibleAuthorization = authorization
    ? decodeAuthorization(authorization)
    : undefined;
  const ownsAuthorization =
    visibleAuthorization &&
    !("error" in visibleAuthorization) &&
    visibleAuthorization.intent.seller.toLowerCase() ===
      address?.toLowerCase() &&
    visibleAuthorization.intent.collection.toLowerCase() ===
      collectionAddress?.toLowerCase() &&
    visibleAuthorization.intent.tokenId === artworkId;

  const { data: epoch, refetch: refetchEpoch } = useReadContract({
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
  const pastedAuthorization = useMemo(() => {
    if (!pasted.trim()) return undefined;
    const decoded = decodeAuthorization(pasted);
    return "error" in decoded ? undefined : decoded;
  }, [pasted]);

  const { data: pastedSellerEpoch } = useReadContract({
    abi: wholeArtworkMarketAbi,
    address: market,
    functionName: "sellerEpoch",
    args: pastedAuthorization ? [pastedAuthorization.intent.seller] : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(market && pastedAuthorization) },
  });

  const { data: paymentAllowed } = useReadContract({
    abi: wholeArtworkMarketAbi,
    address: market,
    functionName: "allowedPaymentToken",
    args: pastedAuthorization
      ? [pastedAuthorization.intent.paymentToken]
      : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(market && pastedAuthorization) },
  });
  const { data: collectionAllowed } = useReadContract({
    abi: wholeArtworkMarketAbi,
    address: market,
    functionName: "allowedCollection",
    args: collectionAddress ? [collectionAddress] : undefined,
    chainId: supportedChain.id,
    query: { enabled: Boolean(market && collectionAddress) },
  });
  const { data: marketPaused } = useReadContract({
    abi: wholeArtworkMarketAbi,
    address: market,
    functionName: "paused",
    chainId: supportedChain.id,
    query: { enabled: Boolean(market) },
  });

  /**
   * The terms, given the instant the sale opens.
   *
   * The clock is deliberately a parameter rather than something read here: `startsAt` and the
   * salt derived from it are fixed when the holder signs, not re-rolled on every render.
   */
  const buildIntent = useCallback(
    (startsAt: number): SaleIntent | undefined => {
      if (
        !address ||
        !collectionAddress ||
        artworkId === undefined ||
        epoch === undefined
      ) {
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
        // A blank field stays blank rather than becoming the zero address, which would sign
        // terms no market can settle. See the same note in `fraction-listing.tsx`.
        paymentToken: paymentToken.trim() as Address,
        price: priceValue,
        buyer: (namedBuyer.trim() || anyBuyer) as Address,
        // Distinguishes otherwise identical terms, so a holder can authorize the same artwork
        // twice -- which the settlement path allows, since neither authorization moves it.
        salt: BigInt(startsAt),
        startsAt,
        endsAt:
          startsAt + (Number.isFinite(hours) ? Math.round(hours * 3600) : 0),
        epoch,
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
    if (
      !canTransact ||
      !address ||
      !publicClient ||
      actionPending.current ||
      pending
    )
      return;
    setDetail(undefined);
    setAuthorization(undefined);
    actionPending.current = true;
    try {
      setStage("awaiting-signature");
      const domain = { chainId: supportedChain.id, verifyingContract: market };
      // Throws on terms that would be refused, so the wallet is never asked to sign them.
      const hash = saleIntentHash(draft, domain, supportedChain.id);
      const signature = await signTypedDataAsync({
        ...saleIntentTypedData(draft, domain),
        account: address,
      });
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
    } finally {
      actionPending.current = false;
    }
  }, [
    pending,
    address,
    buildIntent,
    canTransact,
    market,
    publicClient,
    signTypedDataAsync,
  ]);

  const grantApproval = useCallback(async () => {
    if (!collectionAddress || !market) return;
    if (
      !canTransact ||
      !address ||
      !publicClient ||
      actionPending.current ||
      pending
    )
      return;
    setDetail(undefined);
    actionPending.current = true;
    try {
      setStage("approving");
      await begin().write("approval", () =>
        writeContractAsync({
          abi: wholeArtworkCollectionAbi,
          address: collectionAddress,
          functionName: "setApprovalForAll",
          args: [market, true],
          chainId: supportedChain.id,
          account: address,
        }),
      );
      await refetchApproval();
      setStage(authorization ? "signed" : "idle");
    } catch (error) {
      setDetail(
        error instanceof Error ? error.message : "The approval was not sent.",
      );
      setStage("error");
    } finally {
      actionPending.current = false;
    }
  }, [
    pending,
    begin,
    address,
    authorization,
    canTransact,
    publicClient,
    collectionAddress,
    market,
    refetchApproval,
    writeContractAsync,
  ]);

  const revokeAll = useCallback(async () => {
    if (!market) return;
    if (
      !canTransact ||
      !address ||
      !publicClient ||
      actionPending.current ||
      pending
    )
      return;
    setDetail(undefined);
    actionPending.current = true;
    try {
      setStage("revoking");
      await begin().write("withdrawal", () =>
        writeContractAsync({
          abi: wholeArtworkMarketAbi,
          address: market,
          functionName: "incrementEpoch",
          chainId: supportedChain.id,
          account: address,
        }),
      );
      await refetchEpoch();
      setAuthorization(undefined);
      setDigest(undefined);
      setStage("idle");
    } catch (error) {
      setDetail(
        error instanceof Error ? error.message : "The revocation was not sent.",
      );
      setStage("error");
    } finally {
      actionPending.current = false;
    }
  }, [
    pending,
    begin,
    address,
    canTransact,
    market,
    publicClient,
    refetchEpoch,
    writeContractAsync,
  ]);

  const fill = useCallback(async () => {
    if (!market) return;
    if (
      !canTransact ||
      !address ||
      !publicClient ||
      actionPending.current ||
      pending
    )
      return;
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
    if (
      !collectionAddress ||
      intent.collection.toLowerCase() !== collectionAddress.toLowerCase() ||
      intent.tokenId !== artworkId
    ) {
      setDetail(
        "These terms refer to a different artwork. No payment approval was requested.",
      );
      setStage("error");
      return;
    }
    if (
      intent.seller.toLowerCase() === address.toLowerCase() ||
      (intent.buyer !== anyBuyer &&
        intent.buyer.toLowerCase() !== address.toLowerCase())
    ) {
      setDetail("These terms are not fillable by the connected buyer.");
      setStage("error");
      return;
    }
    if (
      paymentAllowed !== true ||
      collectionAllowed !== true ||
      marketPaused !== false ||
      pastedSellerEpoch === undefined
    ) {
      setDetail(
        "Confirm the market is active, both tokens are allowed, and the seller epoch is readable before approving payment.",
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
      pastedSellerEpoch,
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
    actionPending.current = true;
    try {
      await begin().settle({
        onStage: setStage,
        approvePayment: () =>
          writeContractAsync({
            abi: fractionTokenAbi,
            address: intent.paymentToken,
            functionName: "approve",
            args: [market, intent.price],
            chainId: supportedChain.id,
            account: address,
          }),
        settle: () =>
          writeContractAsync({
            abi: wholeArtworkMarketAbi,
            address: market,
            functionName: "fillIntent",
            args: [intent, signature],
            chainId: supportedChain.id,
            account: address,
          }),
      });
      await refetchHolder();
      setStage("filled");
    } catch (error) {
      setDetail(
        error instanceof Error ? error.message : "The settlement was not sent.",
      );
      setStage("error");
    } finally {
      actionPending.current = false;
    }
  }, [
    pending,
    begin,
    address,
    artworkId,
    canTransact,
    collectionAddress,
    collectionAllowed,
    market,
    marketPaused,
    pasted,
    pastedSellerEpoch,
    paymentAllowed,
    publicClient,
    refetchHolder,
    writeContractAsync,
  ]);

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
          {boundElsewhere
            ? "The deployed artwork belongs to a different page, so it is not offered here. "
            : ""}
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
                disabled={!canTransact || busy || Boolean(pending)}
              >
                Approve the market
              </button>
            )}
            <button
              type="button"
              className="primary"
              onClick={authorize}
              disabled={
                !canTransact ||
                busy ||
                Boolean(pending) ||
                epoch === undefined ||
                problems.length > 0
              }
            >
              Sign the sale terms
            </button>
            <button
              type="button"
              className="secondary"
              onClick={revokeAll}
              disabled={!canTransact || busy || Boolean(pending)}
            >
              Withdraw every authorization
            </button>
          </div>

          {authorization && ownsAuthorization && (
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
            neither moves. You will first approve exactly the signed price in
            the named payment token, then confirm settlement after that approval
            succeeds on chain. Each wallet request is a separate transaction.
          </p>
          <div className="field-grid">
            <label className="field-span">
              Seller&apos;s authorization
              <textarea
                rows={10}
                value={pasted}
                disabled={busy}
                onChange={(event) => {
                  setPasted(event.target.value);
                  setStage("idle");
                  setDetail(undefined);
                  setTransactionHash(undefined);
                }}
                placeholder="Paste the signed terms here"
              />
            </label>
          </div>
          {pastedAuthorization && (
            <dl className="contract-facts">
              <div>
                <dt>Payment token</dt>
                <dd>{pastedAuthorization.intent.paymentToken}</dd>
              </div>
              <div>
                <dt>Exact payment, in smallest units</dt>
                <dd>{String(pastedAuthorization.intent.price)}</dd>
              </div>
              <div>
                <dt>Payment token allowed</dt>
                <dd>
                  {paymentAllowed === undefined
                    ? "Reading from chain"
                    : paymentAllowed
                      ? "Yes"
                      : "No"}
                </dd>
              </div>
            </dl>
          )}
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={fill}
              disabled={
                !canTransact || busy || Boolean(pending) || !pastedAuthorization
              }
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

      {pending && (
        <div className="dao-alert dao-alert--warning">
          <p>
            A {pending.kind} transaction is awaiting confirmation. No new
            transaction can be submitted until it is checked.
          </p>
          <p className="charity-digest">{pending.hash}</p>
          <button
            type="button"
            className="secondary"
            disabled={busy || !canTransact}
            onClick={async () => {
              if (actionPending.current) return;
              actionPending.current = true;
              setStage("filling");
              setDetail(undefined);
              try {
                const kind = await reconcile();
                await Promise.all([
                  refetchEpoch(),
                  refetchHolder(),
                  refetchApproval(),
                ]);
                if (kind === "withdrawal") {
                  setAuthorization(undefined);
                  setDigest(undefined);
                }
                setStage(kind === "fill" ? "filled" : "idle");
              } catch (error) {
                setDetail(
                  error instanceof Error
                    ? error.message
                    : "The transaction is not confirmed.",
                );
                setStage("error");
              } finally {
                actionPending.current = false;
              }
            }}
          >
            Check transaction
          </button>
        </div>
      )}

      {transactionHash && (
        <p className="charity-digest">
          <span>Latest transaction</span> {transactionHash}
        </p>
      )}

      {detail && <p className="dao-alert dao-alert--blocked">{detail}</p>}
    </section>
  );
}
