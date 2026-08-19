"use client";

import { useMemo, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useWriteContract,
} from "wagmi";

import { rwaRegistryAbi } from "@/lib/contracts";
import { supportedChain } from "@/lib/wagmi";

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

const apiURL = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080"
).replace(/\/$/, "");

const labels: Record<FlowStatus, string> = {
  idle: "Ready for review",
  hashing: "Verifying file digest",
  uploading: "Uploading immutable image",
  preparing: "Preparing metadata commitment",
  "awaiting-wallet": "Waiting for wallet confirmation",
  confirming: "Waiting for Sepolia confirmation",
  confirmed: "Mint confirmed on Sepolia",
  error: "Action needs attention",
};

export function RwaCreateFlow() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const idempotencyKey = useRef(crypto.randomUUID());
  const [status, setStatus] = useState<FlowStatus>("idle");
  const [message, setMessage] = useState(
    "Review every field before asking your wallet to sign.",
  );
  const [transactionHash, setTransactionHash] = useState<Hex>();

  const canSubmit =
    isConnected &&
    chainId === supportedChain.id &&
    status !== "confirming" &&
    status !== "awaiting-wallet";
  const boundary = useMemo(() => {
    if (!isConnected) return "Connect an external wallet to continue.";
    if (chainId !== supportedChain.id)
      return "Switch the wallet network to Sepolia.";
    return "The connected account must hold REGISTRAR_ROLE on the reviewed registry contract.";
  }, [chainId, isConnected]);

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
      setStatus("hashing");
      setMessage("Computing the SHA-256 commitment in this browser.");
      const digest = await sha256Hex(await file.arrayBuffer());

      setStatus("uploading");
      setMessage(
        "The API will reject any byte that differs from the reviewed digest.",
      );
      const upload = await fetchJSON<{ uploadId: string; uploadUrl: string }>(
        "/v1/uploads/intents",
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
      const uploadResponse = await fetch(apiURL + upload.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type, "Content-SHA256": digest },
        body: file,
      });
      if (!uploadResponse.ok) throw await responseError(uploadResponse);

      setStatus("preparing");
      setMessage(
        "Creating content-addressed metadata and deterministic contract arguments.",
      );
      const intent = await fetchJSON<MintIntent>("/v1/rwa/intents", {
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
      });
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
      await fetchJSON(`/v1/rwa/intents/${intent.intentId}/submission`, {
        method: "POST",
        body: JSON.stringify({ transactionHash: hash }),
      });

      setStatus("confirming");
      setMessage(
        "The wallet submitted the transaction. Waiting for one Sepolia confirmation.",
      );
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
      if (receipt.status !== "success")
        throw new Error("The Sepolia transaction reverted.");

      setStatus("confirmed");
      setMessage(
        "The registry commitment and NFT mint are confirmed. Index reconciliation follows in Stage 3.",
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
        <button
          className="primary submit-mint"
          type="submit"
          disabled={!canSubmit}
        >
          Review and mint on Sepolia
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
          <li>Confirm on Sepolia</li>
        </ol>
        {transactionHash ? (
          <a
            className="text-link"
            href={`https://sepolia.etherscan.io/tx/${transactionHash}`}
            target="_blank"
            rel="noreferrer"
          >
            View transaction ↗
          </a>
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
  const response = await fetch(apiURL + path, {
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
