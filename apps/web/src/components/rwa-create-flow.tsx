"use client";

import { operatorErrorText } from "@/lib/operator-error";

import { publicSetting } from "@/lib/public-runtime-config";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isAddress, type Address, type Hex } from "viem";
import {
  encodeOperatorSafeSubmission,
  type SafeSubmission,
} from "@/lib/admin-safe";
import {
  assertSameSafeSubmission,
  configuredAdminSafe,
  operatorCallRoute,
} from "@/lib/admin-safe-client";
import { AdminSafeConsole } from "./admin-safe-console";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSignMessage,
  useWriteContract,
} from "wagmi";
import {
  assertMintPreparation,
  assertSourceBoundMint,
  contractEvidenceArguments,
  isRWASourceEvidence,
  type RWASourceEvidence,
  type RWAMetadataPreparation,
} from "@/lib/rwa-source-evidence";
import { rwaRegistryAbi } from "@/lib/contracts";
import { currentOperation } from "@/lib/current-operation";
import { isDaoWalletRejection } from "@/lib/dao-action-state";
import {
  confirmMarketReceipt,
  MarketReceiptFinalError,
} from "@/lib/market-transaction";
import {
  assertMintIntent,
  isMintRecovery,
  mintedDaoHref,
  prepareMint,
  recoverMintedAsset,
  type MintDraft,
  type MintIntent,
  type MintRecovery,
} from "@/lib/rwa-mint-recovery";
import { setupRecoverySession } from "@/lib/setup-recovery";
import { supportedChain } from "@/lib/wagmi";
import { NFTWalletImport } from "./nft-wallet-import";

type FlowStatus =
  | "idle"
  | "hashing"
  | "uploading"
  | "preparing"
  | "awaiting-source"
  | "awaiting-wallet"
  | "confirming"
  | "confirmed"
  | "error";
type OperatorStatus =
  "checking" | "unauthenticated" | "verifying" | "authenticated";
type DiscoveryResult = {
  checkId: string;
  result: "discovered" | "not-found" | "unsupported-chain";
  discovered: boolean;
  marketplaceUrl?: string;
  evidenceSha256: string;
  observedAt: string;
};
const labels: Record<FlowStatus, string> = {
  idle: "Ready for review",
  hashing: "Verifying file digest",
  uploading: "Uploading immutable image",
  preparing: "Preparing metadata commitment",
  "awaiting-source": "Approved-source evidence required",
  "awaiting-wallet": "Waiting for wallet confirmation",
  confirming: "Waiting for Hoodi confirmation",
  confirmed: "Mint confirmed on Hoodi",
  error: "Action needs attention",
};
const apiURL = (publicSetting("NEXT_PUBLIC_API_URL") || "").replace(/\/$/, "");

class SourceReviewPending extends Error {}

export function RwaCreateFlow() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  return (
    <RwaCreateForm
      key={`${isConnected}:${chainId}:${address?.toLowerCase()}`}
    />
  );
}

function RwaCreateForm() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const session = useMemo(
    () =>
      setupRecoverySession<MintRecovery>(
        `mint:${chainId}:${address?.toLowerCase() ?? "disconnected"}`,
        (value): value is MintRecovery =>
          isMintRecovery(value) &&
          value.chainId === chainId &&
          value.wallet.toLowerCase() === address?.toLowerCase(),
      ),
    [chainId, address],
  );
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getServerSnapshot,
  );
  const active = useRef<ReturnType<typeof currentOperation> | undefined>(
    undefined,
  );
  const view = useRef(currentOperation());
  const form = useRef<HTMLFormElement>(null);
  const authBusy = useRef(false);
  const logBusy = useRef(false);
  const [localStatus, setStatus] = useState<FlowStatus>("idle");
  const [message, setMessage] = useState(
    "Review every field before asking your wallet to sign.",
  );
  const [operatorStatus, setOperatorStatus] =
    useState<OperatorStatus>("checking");
  const [operatorAddress, setOperatorAddress] = useState<string>();
  const [discovery, setDiscovery] = useState<DiscoveryResult>();
  const [discoveryPending, setDiscoveryPending] = useState(false);
  const [logging, setLogging] = useState(false);
  const [newMint, setNewMint] = useState(false);
  const [logMessage, setLogMessage] = useState("");
  const [sourceInput, setSourceEvidenceText] = useState<string>();
  const [draftChanged, setDraftChanged] = useState(false);
  const [safePrepared, setSafePrepared] = useState<SafeSubmission>();
  const [safeTarget, setSafeTarget] = useState<Address>();
  const data = snapshot.record?.data;
  const pending = snapshot.record?.pending;
  const sourceEvidenceText =
    sourceInput ??
    (data?.intent?.sourceEvidence
      ? JSON.stringify(data.intent.sourceEvidence, null, 2)
      : "");
  const mintedAsset = data?.minted;
  const transactionHash = pending?.hash ?? data?.hash;
  const status: FlowStatus = mintedAsset
    ? "confirmed"
    : snapshot.error
      ? "error"
      : pending
        ? pending.hash
          ? "confirming"
          : "awaiting-wallet"
        : localStatus;

  useLayoutEffect(() => {
    session.restore(() => sessionStorage);
    view.current = currentOperation();
    const screen = view.current;
    const retire = () => active.current?.retire();
    window.addEventListener("pagehide", retire);
    window.addEventListener("popstate", retire);
    return () => {
      screen.retire();
      retire();
      window.removeEventListener("pagehide", retire);
      window.removeEventListener("popstate", retire);
    };
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    const screen = view.current;
    void (async () => {
      if (!address || chainId !== supportedChain.id) {
        setOperatorStatus("unauthenticated");
        return;
      }
      try {
        const body = await fetchJSON<{
          authenticated?: boolean;
          address?: string;
        }>("/api/operator/auth/session", { cache: "no-store" });
        if (cancelled || !screen.isCurrent()) return;
        const matches =
          body.authenticated === true &&
          body.address?.toLowerCase() === address.toLowerCase();
        setOperatorAddress(matches ? body.address : undefined);
        setOperatorStatus(matches ? "authenticated" : "unauthenticated");
      } catch {
        if (!cancelled && screen.isCurrent()) {
          setOperatorAddress(undefined);
          setOperatorStatus("unauthenticated");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, chainId]);

  useEffect(() => {
    let cancelled = false;
    if (publicSetting("NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS")) {
      void deployment()
        .then((config) => {
          if (
            !cancelled &&
            config.chainId === supportedChain.id &&
            isAddress(config.registryAddress)
          )
            setSafeTarget(config.registryAddress);
        })
        .catch(() => {
          /* The safe console remains unavailable without the deployment target. */
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const authorized =
    isConnected &&
    chainId === supportedChain.id &&
    operatorStatus === "authenticated" &&
    operatorAddress?.toLowerCase() === address?.toLowerCase();
  const canSubmit =
    authorized &&
    !snapshot.busy &&
    !snapshot.blocked &&
    !pending &&
    (!mintedAsset || newMint);
  const boundary = !isConnected
    ? "Connect an external wallet to continue."
    : chainId !== supportedChain.id
      ? "Switch the wallet network to Hoodi."
      : operatorStatus === "checking"
        ? "Checking the current administrator-wallet session."
        : !authorized
          ? "Verify this registrar wallet or an owner of the configured registrar safe."
          : "Registrar authority is verified on Hoodi. Safe ownership does not grant the wallet the target role.";

  function operation() {
    active.current?.retire();
    // A newer action owns its own indicators; retired callbacks cannot clear them later.
    setLogging(false);
    setDiscoveryPending(false);
    const token = currentOperation();
    const screen = view.current;
    active.current = token;
    return {
      isCurrent: () => screen.isCurrent() && token.isCurrent(),
      assertCurrent() {
        screen.assertCurrent();
        token.assertCurrent();
      },
    };
  }

  async function verifyOperator() {
    if (!address || chainId !== supportedChain.id || authBusy.current) return;
    authBusy.current = true;
    const op = operation();
    try {
      setOperatorStatus("verifying");
      setMessage(
        "Sign the administrator challenge. It creates no transaction and transfers no rights.",
      );
      const challenge = await fetchJSON<{ address: string; message: string }>(
        "/api/operator/auth/challenge",
        { method: "POST", body: JSON.stringify({ address }) },
      );
      op.assertCurrent();
      if (challenge.address.toLowerCase() !== address.toLowerCase())
        throw new Error("The administrator challenge address does not match.");
      const signature = await signMessageAsync({ message: challenge.message });
      op.assertCurrent();
      const verified = await fetchJSON<{
        authenticated: boolean;
        address: string;
      }>("/api/operator/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address, signature }),
      });
      op.assertCurrent();
      if (
        !verified.authenticated ||
        verified.address.toLowerCase() !== address.toLowerCase()
      )
        throw new Error("The administrator session could not be verified.");
      setOperatorAddress(verified.address);
      setOperatorStatus("authenticated");
      setMessage("Administrator wallet verified. Review the asset record.");
    } catch (error) {
      if (op.isCurrent()) {
        setOperatorAddress(undefined);
        setOperatorStatus("unauthenticated");
        setStatus("error");
        setMessage(errorText(error));
      }
    } finally {
      authBusy.current = false;
    }
  }

  async function deployment() {
    return fetchJSON<{ chainId: number; registryAddress: Address }>(
      `${apiURL}/v1/config`,
      { cache: "no-store" },
    );
  }

  // Logging is deliberately independent of chain confirmation. A slow/failed API cannot hide the saved hash.
  async function logSubmission(
    intent: MintIntent,
    hash: Hex,
    op: ReturnType<typeof operation>,
    lease: number,
  ) {
    if (!authorized || logBusy.current || !op.isCurrent()) return;
    logBusy.current = true;
    setLogging(true);
    try {
      await fetchJSON(
        `/api/operator/v1/rwa/intents/${intent.intentId}/submission`,
        {
          method: "POST",
          body: JSON.stringify({ transactionHash: hash }),
          signal: AbortSignal.timeout(12_000),
        },
      );
      if (op.isCurrent()) {
        const latest = session.getSnapshot().record?.data;
        if (
          latest?.intent?.intentId === intent.intentId &&
          latest.hash === hash
        )
          session.save(lease, { ...latest, loggedHash: hash });
        setLogMessage("Transaction submission recorded by the API.");
      }
    } catch {
      if (op.isCurrent())
        setLogMessage(
          "API submission recording is incomplete. You can retry it independently of chain confirmation.",
        );
    } finally {
      logBusy.current = false;
      if (op.isCurrent()) setLogging(false);
    }
  }

  async function confirm(
    lease: number,
    saved: MintRecovery,
    hash: Hex | undefined,
    op: ReturnType<typeof operation>,
  ) {
    if (!saved.intent || !publicClient) return;
    let confirmedHash = hash;
    let blockNumber: bigint | undefined;
    if (hash) {
      const receipt = await confirmMarketReceipt(publicClient, hash, (next) =>
        session.repriced(lease, next),
      );
      op.assertCurrent();
      confirmedHash = receipt.transactionHash;
      blockNumber = receipt.blockNumber;
    }
    const executionAuthority = saved.executionAuthority ?? saved.wallet;
    if (
      executionAuthority.toLowerCase() !== saved.wallet.toLowerCase() &&
      executionAuthority.toLowerCase() !== configuredAdminSafe()?.toLowerCase()
    )
      throw new Error(
        "The saved mint execution authority no longer matches the configured safe.",
      );
    const minted = await recoverMintedAsset(
      publicClient,
      saved.intent,
      saved.wallet,
      op.assertCurrent,
      blockNumber,
      executionAuthority,
    );
    op.assertCurrent();
    session.resolved(lease, { ...saved, hash: confirmedHash, minted });
    setStatus("confirmed");
    setMessage(
      "The registry commitment and NFT mint are confirmed. OpenSea discovery is a separate evidence check.",
    );
    if (confirmedHash)
      await logSubmission(saved.intent, confirmedHash, op, lease);
  }

  async function retryLogging() {
    if (!data?.intent || !data.hash) return;
    const lease = session.begin(true);
    if (lease === undefined) return;
    const op = operation();
    try {
      await logSubmission(data.intent, data.hash, op, lease);
    } finally {
      session.finish(lease);
    }
  }

  async function submit(formData: FormData, metadataOnly = false) {
    if (!address || !canSubmit || !publicClient) return;
    const lease = session.begin();
    if (lease === undefined) return;
    const op = operation();
    let walletRequested = false;
    let saved: MintRecovery | undefined;
    try {
      setDiscovery(undefined);
      setLogMessage("");
      setNewMint(false);
      const selected = formData.get("image");
      const file =
        selected instanceof File && selected.size > 0 ? selected : undefined;
      if (
        file &&
        (file.size > 10 * 1024 * 1024 ||
          !["image/png", "image/jpeg", "image/webp"].includes(file.type))
      )
        throw new Error("Choose a PNG, JPEG, or WebP image up to 10 MiB.");
      const draft: MintDraft = {
        name: String(formData.get("name") ?? ""),
        artist: String(formData.get("artist") ?? ""),
        year: Number(formData.get("year")),
        medium: String(formData.get("medium") ?? ""),
        location: String(formData.get("location") ?? ""),
        description: String(formData.get("description") ?? ""),
      };
      const sourceText = String(formData.get("sourceEvidence") ?? "").trim();
      let sourceEvidence: RWASourceEvidence | undefined;
      if (sourceText && !metadataOnly) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(sourceText);
        } catch {
          throw new Error(
            "Import the approved source's evidence as a valid JSON object.",
          );
        }
        if (!isRWASourceEvidence(parsed))
          throw new Error(
            "The source evidence envelope is incomplete or malformed.",
          );
        sourceEvidence = parsed;
      }
      saved = await prepareMint({
        previous: session.getSnapshot().record?.data,
        draft,
        file,
        wallet: address,
        chainId,
        assertCurrent: op.assertCurrent,
        save: (value) => session.save(lease, value),
        stage: (next) => {
          setStatus(next);
          setMessage(labels[next]);
        },
        upload: async (image, digest) => {
          op.assertCurrent();
          const upload = await fetchJSON<{
            uploadId: string;
            uploadUrl: string;
          }>("/api/operator/v1/uploads/intents", {
            method: "POST",
            body: JSON.stringify({
              fileName: image.name,
              contentType: image.type,
              sha256: digest,
              size: image.size,
            }),
          });
          op.assertCurrent();
          if (!/^\/v1\/uploads\/[a-zA-Z0-9-]+$/.test(upload.uploadUrl))
            throw new Error("The API returned an invalid upload destination.");
          const response = await fetch(`/api/operator${upload.uploadUrl}`, {
            method: "PUT",
            headers: { "Content-Type": image.type, "Content-SHA256": digest },
            body: image,
          });
          op.assertCurrent();
          if (!response.ok) throw await responseError(response);
          return upload.uploadId;
        },
        prepare: async (value) => {
          const config = await deployment();
          op.assertCurrent();
          if (metadataOnly || !sourceEvidence) {
            const preparation = await fetchJSON<RWAMetadataPreparation>(
              "/api/operator/v1/rwa/metadata-preparations",
              {
                method: "POST",
                headers: { "Idempotency-Key": value.idempotencyKey },
                body: JSON.stringify({
                  uploadId: value.uploadId,
                  recipient: address,
                  ...value.draft,
                }),
              },
            );
            op.assertCurrent();
            assertMintPreparation(preparation, address, config.registryAddress);
            session.save(lease, { ...value, metadataPreparation: preparation });
            setSourceEvidenceText("");
            throw new SourceReviewPending(
              "The metadata commitment is ready for an approved source to review. Import that source's signed correspondence evidence below before minting. No wallet transaction was requested.",
            );
          }
          const intent = await fetchJSON<MintIntent>(
            "/api/operator/v1/rwa/intents",
            {
              method: "POST",
              headers: { "Idempotency-Key": value.idempotencyKey },
              body: JSON.stringify({
                uploadId: value.uploadId,
                recipient: address,
                ...value.draft,
                evidence: sourceEvidence,
              }),
            },
          );
          op.assertCurrent();
          assertMintIntent(intent, address, config);
          return intent;
        },
      });
      op.assertCurrent();
      setDraftChanged(false);
      const config = await deployment();
      op.assertCurrent();
      assertMintIntent(saved.intent, address, config);
      if (
        sourceEvidence &&
        JSON.stringify(sourceEvidence) !==
          JSON.stringify(saved.intent.sourceEvidence)
      ) {
        const renewed = await fetchJSON<MintIntent>(
          `/api/operator/v1/rwa/intents/${saved.intent.intentId}/evidence`,
          {
            method: "POST",
            body: JSON.stringify({ evidence: sourceEvidence }),
          },
        );
        op.assertCurrent();
        assertMintIntent(renewed, address, config, saved.intent);
        saved = { ...saved, intent: renewed };
        session.save(lease, saved);
      }
      assertMintIntent(saved.intent, address, config);
      const intent = await fetchJSON<MintIntent>(
        `/api/operator/v1/rwa/intents/${saved.intent.intentId}`,
        { cache: "no-store" },
      );
      op.assertCurrent();
      assertMintIntent(intent, address, config, saved.intent);
      if (intent.transactionHash) {
        session.awaitWallet(lease, "mint");
        session.broadcast(lease, intent.transactionHash);
        await confirm(lease, saved, intent.transactionHash, op);
        return;
      }
      assertSourceBoundMint(intent);
      const evidenceArgs = contractEvidenceArguments(intent.contractEvidence);
      const safe = configuredAdminSafe();
      const caller = safe
        ? await operatorCallRoute(
            publicClient,
            "rwa",
            intent.registryAddress,
            address,
            safe,
          )
        : address;
      op.assertCurrent();
      await publicClient.simulateContract({
        abi: rwaRegistryAbi,
        address: intent.registryAddress,
        account: caller,
        functionName: "createAssetWithEvidence",
        args: [
          intent.requestId,
          intent.recipient,
          intent.metadataUri,
          intent.metadataSha256,
          evidenceArgs,
          intent.sourceEvidence.signatureR,
          intent.sourceEvidence.signatureS,
        ],
      });
      op.assertCurrent();
      if (safe && caller.toLowerCase() === safe.toLowerCase()) {
        saved = { ...saved, executionAuthority: safe };
        session.save(lease, saved);
        setSafeTarget(intent.registryAddress);
        setSafePrepared(mintSafeSubmission(intent));
        setStatus("preparing");
        setMessage(
          "The exact zero-value RWA call is ready in the multisignature console. Review it before submitting a proposal. Source evidence must remain valid at execution.",
        );
        return;
      }
      saved = { ...saved, executionAuthority: address };
      session.save(lease, saved);
      setSafePrepared(undefined);
      setStatus("awaiting-wallet");
      setMessage(
        `Confirm one call to ${shortAddress(intent.registryAddress)}. No ETH value or approval is requested.`,
      );
      op.assertCurrent();
      session.awaitWallet(lease, "mint");
      walletRequested = true;
      const hash = await writeContractAsync({
        abi: rwaRegistryAbi,
        address: intent.registryAddress,
        chainId: supportedChain.id,
        functionName: "createAssetWithEvidence",
        args: [
          intent.requestId,
          intent.recipient,
          intent.metadataUri,
          intent.metadataSha256,
          evidenceArgs,
          intent.sourceEvidence.signatureR,
          intent.sourceEvidence.signatureS,
        ],
      });
      // A late wallet result is still the original operation's public evidence.
      session.broadcast(lease, hash);
      op.assertCurrent();
      saved = { ...saved, hash };
      session.save(lease, saved);
      setStatus("confirming");
      setMessage(
        "The wallet submitted the transaction. Waiting for Hoodi confirmation.",
      );
      await confirm(lease, saved, hash, op);
    } catch (error) {
      if (error instanceof SourceReviewPending) {
        if (op.isCurrent()) {
          setStatus("awaiting-source");
          setMessage(error.message);
        }
        return;
      }
      if (walletRequested && isDaoWalletRejection(error))
        session.rejected(lease);
      if (op.isCurrent()) {
        if (error instanceof MarketReceiptFinalError && saved)
          session.resolved(lease, {
            ...saved,
            lastFailedHash:
              session.getSnapshot().record?.pending?.hash ?? saved.hash,
            hash: undefined,
            loggedHash: undefined,
          });
        session.fail(lease, new Error(operatorErrorText(error)));
        setStatus("error");
        setMessage(errorText(error));
      }
    } finally {
      session.finish(lease);
    }
  }

  async function recoverSafeMint(hash: Hex, submission: SafeSubmission) {
    const saved = session.getSnapshot().record?.data;
    if (!saved?.intent)
      throw new Error(
        "Return to the original mint preparation to recover this asset.",
      );
    assertSameSafeSubmission(mintSafeSubmission(saved.intent), submission);
    const lease = session.begin();
    if (lease === undefined)
      throw new Error("Finish the existing mint operation before recovery.");
    const op = operation();
    try {
      const safe = configuredAdminSafe();
      if (!safe)
        throw new Error(
          "The original safe configuration is required to recover this mint.",
        );
      const recovered = { ...saved, executionAuthority: safe };
      session.save(lease, recovered);
      session.awaitWallet(lease, "mint");
      session.broadcast(lease, hash);
      await confirm(lease, recovered, hash, op);
    } finally {
      session.finish(lease);
    }
  }

  async function checkTransaction() {
    if (!address || chainId !== supportedChain.id || !publicClient) return;
    const lease = session.begin(true);
    if (lease === undefined) return;
    const op = operation();
    const saved = session.getSnapshot().record?.data;
    try {
      if (!saved?.intent) throw new Error("The saved mint intent is missing.");
      const reviewed = {
        chainId: saved.chainId,
        registryAddress: saved.intent.registryAddress,
      };
      assertMintIntent(saved.intent, address, reviewed);
      let hash = session.getSnapshot().record?.pending?.hash ?? saved.hash;
      if (!hash) {
        // Intent lookup is optional evidence; an API outage must not suppress independent chain recovery.
        const intent = await fetchJSON<MintIntent>(
          `/api/operator/v1/rwa/intents/${saved.intent.intentId}`,
          { cache: "no-store", signal: AbortSignal.timeout(8_000) },
        ).catch(() => undefined);
        op.assertCurrent();
        if (intent) {
          assertMintIntent(intent, address, reviewed, saved.intent);
          hash = intent.transactionHash;
          if (hash) session.broadcast(lease, hash);
        }
      }
      op.assertCurrent();
      await confirm(lease, saved, hash, op);
    } catch (error) {
      if (op.isCurrent()) {
        if (error instanceof MarketReceiptFinalError && saved)
          session.resolved(lease, {
            ...saved,
            lastFailedHash:
              session.getSnapshot().record?.pending?.hash ?? saved.hash,
            hash: undefined,
            loggedHash: undefined,
          });
        session.fail(lease, new Error(operatorErrorText(error)));
        setStatus("error");
        setMessage(errorText(error));
      }
    } finally {
      session.finish(lease);
    }
  }

  async function checkDiscovery() {
    if (!mintedAsset || !authorized || discoveryPending) return;
    const op = operation();
    try {
      setDiscoveryPending(true);
      const result = await fetchJSON<DiscoveryResult>(
        "/api/operator/v1/rwa/discovery-checks",
        {
          method: "POST",
          body: JSON.stringify({
            source: "opensea",
            chain: "hoodi",
            contractAddress: mintedAsset.collectionAddress,
            tokenId: mintedAsset.tokenId,
          }),
        },
      );
      op.assertCurrent();
      setDiscovery(result);
    } catch (error) {
      if (op.isCurrent()) setMessage(errorText(error));
    } finally {
      if (op.isCurrent()) setDiscoveryPending(false);
    }
  }

  return (
    <div
      className="create-layout"
      data-no-translate="true"
      data-translation-skip="true"
    >
      <form
        className="rwa-form"
        ref={form}
        onChange={(event) => {
          if (
            (event.target as unknown as HTMLInputElement).name !==
            "sourceEvidence"
          )
            setDraftChanged(true);
          setSafePrepared(undefined);
          active.current?.retire();
          setLogging(false);
          setDiscoveryPending(false);
          setStatus("idle");
          setMessage(
            "Review the changed asset record before preparing a new mint.",
          );
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(new FormData(event.currentTarget));
        }}
      >
        <fieldset disabled={!canSubmit}>
          <legend>Asset record</legend>
          <div className="field-grid">
            <label>
              Work title
              <input
                defaultValue={data?.draft.name}
                name="name"
                minLength={2}
                maxLength={120}
                required
              />
            </label>
            <label>
              Artist or maker
              <input
                defaultValue={data?.draft.artist}
                name="artist"
                minLength={2}
                maxLength={120}
                required
              />
            </label>
            <label>
              Year
              <input
                defaultValue={data?.draft.year}
                name="year"
                type="number"
                min="1000"
                max={new Date().getUTCFullYear() + 1}
                required
              />
            </label>
            <label>
              Medium
              <input
                defaultValue={data?.draft.medium}
                name="medium"
                minLength={2}
                maxLength={160}
                required
              />
            </label>
            <label className="field-span">
              Location
              <input
                defaultValue={data?.draft.location}
                name="location"
                minLength={2}
                maxLength={160}
                required
              />
            </label>
            <label className="field-span">
              Description
              <textarea
                defaultValue={data?.draft.description}
                name="description"
                minLength={20}
                maxLength={2000}
                rows={6}
                required
              />
            </label>
            <label className="field-span file-field">
              Rights-cleared image
              <input
                name="image"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                required={!data?.uploadId}
              />
              <small>
                Maximum 10 MiB. The browser and API independently verify
                SHA-256.
              </small>
            </label>
          </div>
        </fieldset>
        <fieldset disabled={!canSubmit}>
          <legend>Approved-source correspondence</legend>
          <p>
            A registrar role and an image hash do not establish real-asset
            authenticity. An approved custody, warehouse, registry, certificate
            or provenance source must sign this exact underlying-asset mint
            commitment.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={
              !canSubmit || Boolean(data?.intent && !draftChanged && !newMint)
            }
            onClick={() => {
              if (form.current?.reportValidity())
                void submit(new FormData(form.current), true);
            }}
          >
            Prepare source-review commitment
          </button>
          {data?.metadataPreparation ? (
            <label>
              Unsigned source-review commitment
              <textarea
                readOnly
                rows={9}
                value={JSON.stringify(data.metadataPreparation, null, 2)}
              />
            </label>
          ) : null}
          <label>
            Signed source evidence (JSON)
            <textarea
              name="sourceEvidence"
              rows={9}
              maxLength={16000}
              value={sourceEvidenceText}
              onChange={(event) => setSourceEvidenceText(event.target.value)}
              readOnly={Boolean(pending || (mintedAsset && !newMint))}
              spellCheck={false}
            />
          </label>
          <small>
            For an expired prepared request, import renewed evidence signed for
            the same commitment, source, asset and rights. Retrying preserves
            the original issuance request. The source’s private signing key
            never enters ArtFi. TEST_ONLY means TESTNET · NO REAL-WORLD VALUE ·
            NO LEGAL EFFECT.
          </small>
        </fieldset>
        <div className="form-boundary" role="note">
          <strong>Authorization boundary</strong>
          <span>{boundary}</span>
        </div>
        {isConnected && chainId === supportedChain.id ? (
          <button
            className="secondary"
            type="button"
            disabled={
              operatorStatus === "checking" ||
              operatorStatus === "verifying" ||
              operatorStatus === "authenticated"
            }
            onClick={() => void verifyOperator()}
          >
            {operatorStatus === "authenticated"
              ? "Administrator wallet verified"
              : operatorStatus === "verifying"
                ? "Verifying administrator wallet…"
                : "Verify administrator wallet"}
          </button>
        ) : null}
        <button
          className="primary submit-mint"
          type="submit"
          disabled={!canSubmit}
        >
          Review and mint on Hoodi
        </button>
        {mintedAsset && !newMint ? (
          <button
            className="secondary"
            type="button"
            disabled={!authorized || snapshot.busy}
            onClick={() => {
              setNewMint(true);
              setSourceEvidenceText("");
              setDraftChanged(true);
              setSafePrepared(undefined);
              setMessage(
                "Review a new asset record before asking the wallet to mint again.",
              );
            }}
          >
            Prepare another mint
          </button>
        ) : null}
        {data?.intent && !mintedAsset && !pending ? (
          <button
            className="secondary"
            type="button"
            disabled={!canSubmit}
            onClick={() => {
              if (form.current?.reportValidity())
                void submit(new FormData(form.current));
            }}
          >
            Retry prepared mint
          </button>
        ) : null}
      </form>

      <aside
        className={`transaction-panel transaction-panel--${status}`}
        aria-live="polite"
      >
        <p className="eyebrow">Transaction lifecycle</p>
        <h2>{labels[status]}</h2>
        <p>{snapshot.error || message}</p>
        {pending ? (
          <button
            className="secondary"
            type="button"
            disabled={
              !isConnected || chainId !== supportedChain.id || snapshot.busy
            }
            onClick={() => void checkTransaction()}
          >
            Check mint transaction
          </button>
        ) : null}
        {mintedAsset &&
        data?.intent &&
        transactionHash &&
        data.loggedHash !== transactionHash ? (
          <button
            className="secondary"
            type="button"
            disabled={!authorized || logging || snapshot.busy}
            onClick={() => void retryLogging()}
          >
            {logging ? "Recording submission…" : "Retry submission record"}
          </button>
        ) : null}
        {logMessage ? <p>{logMessage}</p> : null}
        <ol>
          <li>Hash and validate upload</li>
          <li>Persist immutable metadata</li>
          <li>Verify approved-source correspondence</li>
          <li>Review source-guarded wallet call</li>
          <li>Confirm on Hoodi</li>
        </ol>
        {transactionHash ? (
          <a
            className="text-link"
            href={`https://hoodi.etherscan.io/tx/${transactionHash}`}
            target="_blank"
            rel="noreferrer"
          >
            View transaction ↗
          </a>
        ) : null}
        {mintedAsset ? (
          <>
            <NFTWalletImport
              collectionAddress={mintedAsset.collectionAddress}
              standard="ERC-721"
              tokenId={mintedAsset.tokenId}
            />
            <div className="form-boundary" role="status">
              <strong>
                NFT {shortAddress(mintedAsset.collectionAddress)} / #
                {mintedAsset.tokenId}
              </strong>
              <span>
                OpenSea discovery, DAO deposit and listing are independent from
                mint confirmation.
              </span>
              <button
                className="secondary"
                type="button"
                disabled={discoveryPending || snapshot.busy}
                onClick={() => void checkDiscovery()}
              >
                {discoveryPending
                  ? "Checking OpenSea discovery…"
                  : "Check OpenSea discovery"}
              </button>
              {discovery ? (
                <span>
                  {discovery.discovered
                    ? `Discovered at ${new Date(discovery.observedAt).toLocaleString()}.`
                    : discovery.result === "unsupported-chain"
                      ? "OpenSea currently reports this chain as unsupported. No acceptance is claimed."
                      : "Not discovered at the recorded check time. No acceptance is claimed."}
                </span>
              ) : null}
              {discovery?.discovered && discovery.marketplaceUrl ? (
                <details className="market-source-reference">
                  <summary>OpenSea discovery source</summary>
                  <p data-no-translate>{discovery.marketplaceUrl}</p>
                </details>
              ) : null}
              <a className="text-link" href={mintedDaoHref(mintedAsset)}>
                Continue to Vault and DAO verification →
              </a>
            </div>
          </>
        ) : null}
      </aside>
      <AdminSafeConsole
        kind="rwa"
        target={safeTarget}
        prepared={safePrepared}
        authenticated={authorized}
        onExecuted={recoverSafeMint}
      />
    </div>
  );
}

function errorText(error: unknown) {
  return operatorErrorText(error, "The mint flow could not be completed.");
}

async function fetchJSON<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as T;
}
async function responseError(response: Response) {
  const fallback = `Request failed with status ${response.status}.`;
  try {
    const body = (await response.json()) as { detail?: string };
    return new Error(body.detail || fallback);
  } catch {
    return new Error(fallback);
  }
}
function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function mintSafeSubmission(intent: MintIntent) {
  assertSourceBoundMint(intent);
  return encodeOperatorSafeSubmission({
    requestId: intent.requestId,
    target: intent.registryAddress,
    abi: rwaRegistryAbi,
    functionName: "createAssetWithEvidence",
    args: [
      intent.requestId,
      intent.recipient,
      intent.metadataUri,
      intent.metadataSha256,
      contractEvidenceArguments(intent.contractEvidence),
      intent.sourceEvidence.signatureR,
      intent.sourceEvidence.signatureS,
    ],
  });
}
