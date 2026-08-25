"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseEventLogs, type Address, type Hex } from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSignMessage,
  useWriteContract,
} from "wagmi";

import { rwaRegistryAbi } from "@/lib/contracts";
import { supportedChain } from "@/lib/wagmi";

import { NFTWalletImport } from "./nft-wallet-import";

type FlowStatus =
  | "idle"
  | "hashing"
  | "uploading"
  | "preparing"
  | "awaiting-wallet"
  | "confirming"
  | "confirmed"
  | "error";

type MintIntent = {
  intentId: string;
  requestId: Hex;
  recipient: Address;
  registryAddress: Address;
  chainId: number;
  metadataUri: string;
  metadataSha256: Hex;
  status: string;
};

type OperatorStatus =
  "checking" | "unauthenticated" | "verifying" | "authenticated";

type MintedAsset = {
  collectionAddress: Address;
  tokenId: string;
};

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
  "awaiting-wallet": "Waiting for wallet confirmation",
  confirming: "Waiting for Hoodi confirmation",
  confirmed: "Mint confirmed on Hoodi",
  error: "Action needs attention",
};

export function RwaCreateFlow() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const idempotencyKey = useRef(crypto.randomUUID());
  const [status, setStatus] = useState<FlowStatus>("idle");
  const [message, setMessage] = useState(
    "Review every field before asking your wallet to sign.",
  );
  const [transactionHash, setTransactionHash] = useState<Hex>();
  const [operatorStatus, setOperatorStatus] =
    useState<OperatorStatus>("checking");
  const [operatorAddress, setOperatorAddress] = useState<string>();
  const [mintedAsset, setMintedAsset] = useState<MintedAsset>();
  const [discovery, setDiscovery] = useState<DiscoveryResult>();
  const [discoveryPending, setDiscoveryPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!address || chainId !== supportedChain.id) {
        if (!cancelled) {
          setOperatorAddress(undefined);
          setOperatorStatus("unauthenticated");
        }
        return;
      }
      try {
        const response = await fetch("/api/operator/auth/session", {
          cache: "no-store",
        });
        const body = (await response.json()) as {
          authenticated?: boolean;
          address?: string;
        };
        const matches =
          response.ok &&
          body.authenticated === true &&
          body.address?.toLowerCase() === address.toLowerCase();
        if (!cancelled) {
          setOperatorAddress(matches ? body.address : undefined);
          setOperatorStatus(matches ? "authenticated" : "unauthenticated");
        }
      } catch {
        if (!cancelled) {
          setOperatorAddress(undefined);
          setOperatorStatus("unauthenticated");
        }
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [address, chainId]);

  const canSubmit =
    isConnected &&
    chainId === supportedChain.id &&
    operatorStatus === "authenticated" &&
    operatorAddress?.toLowerCase() === address?.toLowerCase() &&
    status !== "confirming" &&
    status !== "awaiting-wallet";
  const boundary = useMemo(() => {
    if (!isConnected) return "Connect an external wallet to continue.";
    if (chainId !== supportedChain.id)
      return "Switch the wallet network to Hoodi.";
    if (operatorStatus === "checking")
      return "Checking the current administrator-wallet session.";
    if (operatorStatus !== "authenticated")
      return "Verify that this wallet currently holds REGISTRAR_ROLE on the reviewed registry contract.";
    return "REGISTRAR_ROLE is verified on Hoodi. The browser never receives the operator API credential.";
  }, [chainId, isConnected, operatorStatus]);

  async function verifyOperator() {
    if (!address || chainId !== supportedChain.id) return;
    try {
      setOperatorStatus("verifying");
      setStatus("idle");
      setMessage(
        "Sign the administrator challenge. It creates no transaction and transfers no rights.",
      );
      const challenge = await fetchJSON<{
        address: string;
        message: string;
      }>("/api/operator/auth/challenge", {
        method: "POST",
        body: JSON.stringify({ address }),
      });
      if (challenge.address.toLowerCase() !== address.toLowerCase()) {
        throw new Error("The administrator challenge address does not match.");
      }
      const signature = await signMessageAsync({ message: challenge.message });
      const session = await fetchJSON<{
        authenticated: boolean;
        address: string;
      }>("/api/operator/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address, signature }),
      });
      if (
        !session.authenticated ||
        session.address.toLowerCase() !== address.toLowerCase()
      ) {
        throw new Error("The administrator session could not be verified.");
      }
      setOperatorAddress(session.address);
      setOperatorStatus("authenticated");
      setMessage("Administrator wallet verified. Review the asset record.");
    } catch (error) {
      setOperatorAddress(undefined);
      setOperatorStatus("unauthenticated");
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "The administrator wallet could not be verified.",
      );
    }
  }

  async function submit(formData: FormData) {
    if (!address || !canSubmit || !publicClient) return;
    const file = formData.get("image");
    if (!(file instanceof File) || file.size === 0) {
      setStatus("error");
      setMessage("Choose a PNG, JPEG, or WebP image up to 10 MiB.");
      return;
    }

    try {
      setTransactionHash(undefined);
      setMintedAsset(undefined);
      setDiscovery(undefined);
      setStatus("hashing");
      setMessage("Computing the SHA-256 commitment in this browser.");
      const digest = await sha256Hex(await file.arrayBuffer());

      setStatus("uploading");
      setMessage(
        "The API will reject any byte that differs from the reviewed digest.",
      );
      const upload = await fetchJSON<{ uploadId: string; uploadUrl: string }>(
        "/api/operator/v1/uploads/intents",
        {
          method: "POST",
          body: JSON.stringify({
            fileName: file.name,
            contentType: file.type,
            sha256: digest,
            size: file.size,
          }),
        },
      );
      const uploadResponse = await fetch(`/api/operator${upload.uploadUrl}`, {
        method: "PUT",
        headers: { "Content-Type": file.type, "Content-SHA256": digest },
        body: file,
      });
      if (!uploadResponse.ok) throw await responseError(uploadResponse);

      setStatus("preparing");
      setMessage(
        "Creating content-addressed metadata and deterministic contract arguments.",
      );
      const intent = await fetchJSON<MintIntent>(
        "/api/operator/v1/rwa/intents",
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey.current },
          body: JSON.stringify({
            uploadId: upload.uploadId,
            recipient: address,
            name: formData.get("name"),
            artist: formData.get("artist"),
            year: Number(formData.get("year")),
            medium: formData.get("medium"),
            location: formData.get("location"),
            description: formData.get("description"),
          }),
        },
      );
      if (
        intent.chainId !== supportedChain.id ||
        intent.recipient.toLowerCase() !== address.toLowerCase()
      ) {
        throw new Error("The API returned an unsafe chain or recipient.");
      }

      setStatus("awaiting-wallet");
      setMessage(
        `Confirm one call to ${shortAddress(intent.registryAddress)}. No ETH value or approval is requested.`,
      );
      const hash = await writeContractAsync({
        abi: rwaRegistryAbi,
        address: intent.registryAddress,
        chainId: supportedChain.id,
        functionName: "createAsset",
        args: [
          intent.requestId,
          intent.recipient,
          intent.metadataUri,
          intent.metadataSha256,
        ],
      });
      setTransactionHash(hash);
      await fetchJSON(
        `/api/operator/v1/rwa/intents/${intent.intentId}/submission`,
        {
          method: "POST",
          body: JSON.stringify({ transactionHash: hash }),
        },
      );

      setStatus("confirming");
      setMessage(
        "The wallet submitted the transaction. Waiting for one Hoodi confirmation.",
      );
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
      if (receipt.status !== "success")
        throw new Error("The Hoodi transaction reverted.");

      const createdEvents = parseEventLogs({
        abi: rwaRegistryAbi,
        eventName: "AssetCreated",
        logs: receipt.logs.filter(
          (log) =>
            log.address.toLowerCase() === intent.registryAddress.toLowerCase(),
        ),
        strict: true,
      });
      const created = createdEvents.find(
        (event) =>
          event.args.requestId.toLowerCase() ===
            intent.requestId.toLowerCase() &&
          event.args.recipient.toLowerCase() === address.toLowerCase(),
      );
      if (!created)
        throw new Error("The confirmed asset event is missing or mismatched.");
      const collectionAddress = await publicClient.readContract({
        abi: rwaRegistryAbi,
        address: intent.registryAddress,
        functionName: "nft",
      });
      setMintedAsset({
        collectionAddress,
        tokenId: created.args.tokenId.toString(),
      });

      setStatus("confirmed");
      setMessage(
        "The registry commitment and NFT mint are confirmed. OpenSea discovery is a separate evidence check.",
      );
      idempotencyKey.current = crypto.randomUUID();
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "The mint flow could not be completed.",
      );
    }
  }

  async function checkDiscovery() {
    if (!mintedAsset || operatorStatus !== "authenticated") return;
    try {
      setDiscoveryPending(true);
      const result = await fetchJSON<DiscoveryResult>(
        "/api/operator/v1/rwa/discovery-checks",
        {
          method: "POST",
          body: JSON.stringify({
            source: "opensea",
            chain: "sepolia",
            contractAddress: mintedAsset.collectionAddress,
            tokenId: mintedAsset.tokenId,
          }),
        },
      );
      setDiscovery(result);
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "OpenSea discovery could not be checked.",
      );
    } finally {
      setDiscoveryPending(false);
    }
  }

  return (
    <div className="create-layout">
      <form
        className="rwa-form"
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
              <input name="name" minLength={2} maxLength={120} required />
            </label>
            <label>
              Artist or maker
              <input name="artist" minLength={2} maxLength={120} required />
            </label>
            <label>
              Year
              <input
                name="year"
                type="number"
                min="1000"
                max={new Date().getUTCFullYear() + 1}
                required
              />
            </label>
            <label>
              Medium
              <input name="medium" minLength={2} maxLength={160} required />
            </label>
            <label className="field-span">
              Location
              <input name="location" minLength={2} maxLength={160} required />
            </label>
            <label className="field-span">
              Description
              <textarea
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
                required
              />
              <small>
                Maximum 10 MiB. The browser and API independently verify
                SHA-256.
              </small>
            </label>
          </div>
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
      </form>

      <aside
        className={`transaction-panel transaction-panel--${status}`}
        aria-live="polite"
      >
        <p className="eyebrow">Transaction lifecycle</p>
        <h2>{labels[status]}</h2>
        <p>{message}</p>
        <ol>
          <li>Hash and validate upload</li>
          <li>Persist immutable metadata</li>
          <li>Review wallet call</li>
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
                disabled={discoveryPending}
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
                <a
                  className="text-link"
                  href={discovery.marketplaceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Verify discovered NFT on OpenSea ↗
                </a>
              ) : null}
              <a className="text-link" href="/dao">
                Continue to Vault and DAO verification →
              </a>
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}

async function sha256Hex(value: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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
