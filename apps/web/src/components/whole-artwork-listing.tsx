"use client";

import { reconcileCurrentView } from "@/lib/current-operation";

import { useCallback, useMemo, useRef, useState } from "react";
import { isAddress, type Address, type Hex } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSignTypedData,
  useWriteContract,
} from "wagmi";

import { NativeOrderPanel } from "./native-order-panel";
import { useUserSession } from "./user-session-provider";
import {
  assertTradingSession,
  userSessionController,
} from "@/lib/user-session-client";
import {
  decodeNativeOrder,
  nativeOrderFromAuthorization,
} from "@/lib/native-order";
import { verifyWholeArtworkSale } from "@/lib/signed-market-preflight";
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
  saleIntentHash,
  saleIntentTypedData,
  validateSaleIntent,
  type SaleIntent,
} from "@/lib/whole-artwork-intent";

/** Existing signed sale settlement, explicit publication and recoverable chain receipts. */

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
  market?: Address,
): { intent: SaleIntent; signature: Hex } | { error: string } {
  try {
    if (!market) throw new Error("The market is unavailable.");
    const decoded = decodeNativeOrder(
      nativeOrderFromAuthorization("whole", raw, market),
    );
    if (decoded.kind !== "whole") throw new Error("Wrong sale kind.");
    return { intent: decoded.intent, signature: decoded.order.signature };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "The authorization could not be read.",
    };
  }
}

export function WholeArtworkListing(
  props: Readonly<{ slug?: string; collection?: string; tokenId?: string }>,
) {
  const { address, chainId } = useAccount();
  const { revision, authenticated } = useUserSession();
  return (
    <WholeArtworkListingScreen
      key={`${address?.toLowerCase()}:${chainId}:${revision}:${authenticated}:${JSON.stringify(props)}`}
      {...props}
    />
  );
}

function WholeArtworkListingScreen({
  slug,
  collection,
  tokenId,
}: Readonly<{ slug?: string; collection?: string; tokenId?: string }>) {
  const { address, chainId, isConnected } = useAccount();
  const { authenticated, revision } = useUserSession();
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
    authenticated &&
    isConnected &&
    chainId === supportedChain.id &&
    Boolean(publicClient);
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

  const beforeWrite = useCallback(async () => {
    if (!address || chainId !== supportedChain.id)
      throw new Error("Connect the supported wallet and chain.");
    await assertTradingSession(address, chainId);
    if (userSessionController.getSnapshot().revision !== revision)
      throw new Error(
        "The session changed. Start again from the current screen.",
      );
  }, [address, chainId, revision]);
  const { pending, begin, reconcile, captureReadContext } =
    useMarketTransactions(
      publicClient,
      `${supportedChain.id}:${market?.toLowerCase()}:${collectionAddress?.toLowerCase()}:${artworkId}:${address?.toLowerCase()}`,
      setTransactionHash,
      {
        operationContext: JSON.stringify([
          pasted,
          price,
          paymentToken,
          namedBuyer,
          durationHours,
        ]),
        beforeWrite,
      },
    );
  const visibleAuthorization = authorization
    ? decodeAuthorization(authorization, market)
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
    const decoded = decodeAuthorization(pasted, market);
    return "error" in decoded ? undefined : decoded;
  }, [pasted, market]);

  const pastedDigest = useMemo(() => {
    if (!pastedAuthorization || !market) return undefined;
    return saleIntentHash(
      pastedAuthorization.intent,
      { chainId: supportedChain.id, verifyingContract: market },
      supportedChain.id,
    );
  }, [pastedAuthorization, market]);

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
    setAuthorization(undefined);
    actionPending.current = true;
    let operation: ReturnType<typeof begin> | undefined;
    try {
      operation = begin();
      setStage("awaiting-signature");
      if ((await publicClient.getChainId()) !== supportedChain.id)
        throw new Error("The market reader is on a different chain.");
      const block = await publicClient.getBlock({ blockTag: "latest" });
      if (
        block.number === null ||
        block.timestamp > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new Error("The current chain time is unavailable.");
      const draft = buildIntent(Number(block.timestamp));
      if (!draft) throw new Error("Enter valid sale terms.");
      draft.epoch = await publicClient.readContract({
        abi: wholeArtworkMarketAbi,
        address: market,
        functionName: "sellerEpoch",
        args: [address],
        blockNumber: block.number,
      });
      operation.assertCurrent();
      const domain = { chainId: supportedChain.id, verifyingContract: market };
      // Throws on terms that would be refused, so the wallet is never asked to sign them.
      const hash = saleIntentHash(draft, domain, supportedChain.id);
      const signature = await operation.authorize(() =>
        signTypedDataAsync({
          ...saleIntentTypedData(draft, domain),
          account: address,
        }),
      );
      operation.assertCurrent();
      setDigest(hash);
      setAuthorization(encodeAuthorization(draft, signature));
      setStage("signed");
    } catch (error) {
      if (operation && !operation.isCurrent()) return;
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
    begin,
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
    let operation: ReturnType<typeof begin> | undefined;
    try {
      operation = begin();
      setStage("approving");
      await operation.write("approval", () =>
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
      operation.assertCurrent();
      setStage(authorization ? "signed" : "idle");
    } catch (error) {
      if (operation && !operation.isCurrent()) return;
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
    let operation: ReturnType<typeof begin> | undefined;
    try {
      operation = begin();
      setStage("revoking");
      await operation.write("withdrawal", () =>
        writeContractAsync({
          abi: wholeArtworkMarketAbi,
          address: market,
          functionName: "incrementEpoch",
          chainId: supportedChain.id,
          account: address,
        }),
      );
      await refetchEpoch();
      operation.assertCurrent();
      setAuthorization(undefined);
      setDigest(undefined);
      setStage("idle");
    } catch (error) {
      if (operation && !operation.isCurrent()) return;
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
    const decoded = decodeAuthorization(pasted, market);
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
    actionPending.current = true;
    let operation: ReturnType<typeof begin> | undefined;
    try {
      operation = begin(
        saleIntentHash(
          intent,
          { chainId: supportedChain.id, verifyingContract: market },
          supportedChain.id,
        ),
      );
      setStage("approving");
      await verifyWholeArtworkSale({
        client: publicClient,
        intent,
        signature,
        buyer: address,
        expectedChainId: supportedChain.id,
        domain: { chainId: supportedChain.id, verifyingContract: market },
      });
      operation.assertCurrent();
      await operation.settle({
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
      operation.assertCurrent();
      setStage("filled");
    } catch (error) {
      if (operation && !operation.isCurrent()) return;
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
    market,
    pasted,
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
        The receipt token stays in your wallet until it sells.
      </h2>
      <p>
        A token sale is authorized by signature. The receipt token moves in the
        transaction that pays you, only against the terms you signed. Physical
        pickup and registry-confirmed rights remain separate from this chain
        settlement. You can withdraw the authorization before settlement.
      </p>

      <NativeOrderPanel
        kind="whole"
        market={market}
        asset={collectionAddress}
        tokenId={artworkId}
        authorization={ownsAuthorization ? authorization : undefined}
        operationContext={JSON.stringify([
          pasted,
          price,
          paymentToken,
          namedBuyer,
          durationHours,
        ])}
        publicClient={publicClient}
        onSelect={(value) => {
          setPasted(value);
          setStage("idle");
          setDetail(undefined);
          setTransactionHash(undefined);
        }}
      />
      {isConnected && !authenticated && (
        <p className="dao-alert dao-alert--warning">
          Sign in with your connected wallet before signing, publishing,
          approving or settling a sale.
        </p>
      )}

      <dl className="contract-facts">
        <div>
          <dt>Status</dt>
          <dd>{stageLabels[stage]}</dd>
        </div>
        <div>
          <dt>Chain token holder</dt>
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
                disabled={busy}
                onChange={(event) => setPrice(event.target.value)}
                inputMode="numeric"
                placeholder="1000000"
              />
            </label>
            <label>
              Payment token
              <input
                value={paymentToken}
                disabled={busy}
                onChange={(event) => setPaymentToken(event.target.value)}
                placeholder="0x…"
              />
            </label>
            <label>
              Open for, in hours
              <input
                value={durationHours}
                disabled={busy}
                onChange={(event) => setDurationHours(event.target.value)}
                inputMode="numeric"
              />
            </label>
            <label>
              Buyer, or blank for anyone
              <input
                value={namedBuyer}
                disabled={busy}
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
                <strong>Signed sale terms.</strong> Signing does not publish or
                transfer anything. Use Publish sale terms to make this original
                authorization public. Withdrawal on chain retires its authority.
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
          Settled. The receipt token and payment moved in the same chain
          transaction. Physical pickup and registry rights remain separate.
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
            disabled={busy || !publicClient}
            onClick={async () => {
              if (actionPending.current) return;
              actionPending.current = true;
              setStage("filling");
              setDetail(undefined);
              const isCurrent = captureReadContext();
              try {
                await reconcileCurrentView({
                  isCurrent,
                  read: reconcile,
                  refresh: () =>
                    Promise.all([
                      refetchEpoch(),
                      refetchHolder(),
                      refetchApproval(),
                    ]),
                  publish: (checked) => {
                    if (checked?.kind === "withdrawal") {
                      setAuthorization(undefined);
                      setDigest(undefined);
                    }
                    setStage(
                      checked?.kind === "fill" &&
                        checked.intentHash === pastedDigest
                        ? "filled"
                        : "idle",
                    );
                  },
                  fail: (error) => {
                    setDetail(
                      error instanceof Error
                        ? error.message
                        : "The transaction is not confirmed.",
                    );
                    setStage("error");
                  },
                });
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
