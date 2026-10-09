"use client";

import { operatorErrorText } from "@/lib/operator-error";

import { publicSetting } from "@/lib/public-runtime-config";

import { FormEvent, useMemo, useState } from "react";
import {
  formatEther,
  decodeFunctionData,
  isAddress,
  parseEventLogs,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from "wagmi";

import { charityEditionsAbi, artFiAdminSafeAbi } from "@/lib/contracts";
import {
  encodeOperatorSafeSubmission,
  type SafeSubmission,
} from "@/lib/admin-safe";
import {
  configuredAdminSafe,
  operatorCallRoute,
  reviewSafeSubmission,
} from "@/lib/admin-safe-client";
import { AdminSafeConsole } from "./admin-safe-console";
import { supportedChain } from "@/lib/wagmi";

import { CharityEditionRightsNotice } from "./charity-edition-rights-notice";
import { NFTWalletImport } from "./nft-wallet-import";

type EditionStatus =
  "idle" | "awaiting-wallet" | "confirming" | "confirmed" | "error";

type MintedEdition = {
  collectionAddress: Address;
  distributionWallet: Address;
  quantity: bigint;
  tokenId: string;
};

const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const labels: Record<EditionStatus, string> = {
  idle: "Package ready for review",
  "awaiting-wallet": "Waiting for wallet confirmation",
  confirming: "Waiting for Hoodi confirmation",
  confirmed: "ERC-1155 series confirmed",
  error: "Action needs attention",
};

export function CharityEditionCreateFlow() {
  const configuredAddress = publicSetting(
    "NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS",
  );
  const configured = isAddress(configuredAddress ?? "");
  const contractAddress = (configured ? configuredAddress : undefined) as
    Address | undefined;
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [status, setStatus] = useState<EditionStatus>("idle");
  const [message, setMessage] = useState(
    "Use only a fully verified, rights-cleared package. No artwork master is uploaded here.",
  );
  const [transactionHash, setTransactionHash] = useState<Hex>();
  const [mintedEdition, setMintedEdition] = useState<MintedEdition>();
  const [safePrepared, setSafePrepared] = useState<SafeSubmission>();
  const rawSafe = publicSetting("NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS");
  const safe =
    rawSafe && isAddress(rawSafe) && rawSafe !== zeroAddress
      ? rawSafe
      : undefined;

  const readsEnabled = Boolean(contractAddress);
  const { data: creatorRole } = useReadContract({
    abi: charityEditionsAbi,
    address: contractAddress,
    functionName: "SERIES_CREATOR_ROLE",
    query: { enabled: readsEnabled },
  });
  const { data: hasCreatorRole = false } = useReadContract({
    abi: charityEditionsAbi,
    address: contractAddress,
    functionName: "hasRole",
    args: [creatorRole ?? zeroHash, address ?? zeroAddress],
    query: {
      enabled: readsEnabled && Boolean(address) && Boolean(creatorRole),
    },
  });
  const { data: safeHasRole = false } = useReadContract({
    abi: charityEditionsAbi,
    address: contractAddress,
    functionName: "hasRole",
    args: [creatorRole ?? zeroHash, safe ?? zeroAddress],
    query: { enabled: readsEnabled && Boolean(creatorRole) && Boolean(safe) },
  });
  const { data: safeOwner = false } = useReadContract({
    abi: artFiAdminSafeAbi,
    address: safe,
    functionName: "isOwner",
    args: [address ?? zeroAddress],
    query: { enabled: Boolean(safe && address) },
  });
  const authorizedCreator = safeHasRole ? safeOwner : hasCreatorRole;
  const { data: editionsPerArtwork } = useReadContract({
    abi: charityEditionsAbi,
    address: contractAddress,
    functionName: "EDITIONS_PER_ARTWORK",
    query: { enabled: readsEnabled },
  });
  const { data: primaryPriceWei } = useReadContract({
    abi: charityEditionsAbi,
    address: contractAddress,
    functionName: "PRIMARY_PRICE_WEI",
    query: { enabled: readsEnabled },
  });
  const { data: seriesCount } = useReadContract({
    abi: charityEditionsAbi,
    address: contractAddress,
    functionName: "seriesCount",
    query: { enabled: readsEnabled },
  });
  const { data: paused = false } = useReadContract({
    abi: charityEditionsAbi,
    address: contractAddress,
    functionName: "paused",
    query: { enabled: readsEnabled },
  });

  const correctChain = chainId === supportedChain.id;
  const constantsVerified =
    editionsPerArtwork === 100n && primaryPriceWei === 10_000_000_000_000_000n;
  const canSubmit =
    configured &&
    isConnected &&
    correctChain &&
    authorizedCreator &&
    (!rawSafe || Boolean(safe)) &&
    constantsVerified &&
    !paused &&
    status !== "awaiting-wallet" &&
    status !== "confirming";
  const boundary = useMemo(() => {
    if (!configured)
      return "The reviewed Hoodi ERC-1155 contract is not configured. Writes fail closed.";
    if (!isConnected) return "Connect the authorized series-creator wallet.";
    if (!correctChain) return "Switch the wallet network to Hoodi.";
    if (paused) return "The ERC-1155 contract is paused.";
    if (!authorizedCreator)
      return "Connect a SERIES_CREATOR_ROLE holder or an owner of its configured safe.";
    if (!constantsVerified)
      return "The contract does not match the approved 100-edition / 0.01 ETH policy.";
    return "Series-creator role and fixed contract constants are verified on Hoodi.";
  }, [
    configured,
    constantsVerified,
    correctChain,
    authorizedCreator,
    isConnected,
    paused,
  ]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!contractAddress || !publicClient || !canSubmit) return;
    const formData = new FormData(event.currentTarget);
    const artworkId = String(formData.get("artworkId") ?? "");
    const masterArtworkHash = String(formData.get("masterArtworkHash") ?? "");
    const metadataHash = String(formData.get("metadataHash") ?? "");
    const distributionWallet = String(formData.get("distributionWallet") ?? "");
    const metadataURI = String(formData.get("metadataURI") ?? "").trim();
    const packageApproved = formData.get("packageApproved") === "on";

    try {
      if (
        !bytes32Pattern.test(artworkId) ||
        !bytes32Pattern.test(masterArtworkHash) ||
        !bytes32Pattern.test(metadataHash)
      ) {
        throw new Error(
          "Artwork and metadata commitments must be bytes32 values.",
        );
      }
      if (!isAddress(distributionWallet))
        throw new Error("A valid distribution-wallet address is required.");
      if (
        !metadataURI.startsWith("ipfs://") &&
        !metadataURI.startsWith("https://")
      ) {
        throw new Error("Metadata URI must use IPFS or HTTPS.");
      }
      if (!packageApproved)
        throw new Error(
          "Confirm the reviewed package and no-preview boundary.",
        );

      const reviewedSafe = configuredAdminSafe();
      const caller = reviewedSafe
        ? await operatorCallRoute(
            publicClient,
            "charity",
            contractAddress,
            address!,
            reviewedSafe,
          )
        : address!;
      if (reviewedSafe && caller.toLowerCase() === reviewedSafe.toLowerCase()) {
        const call = {
          abi: charityEditionsAbi,
          functionName: "createSeries" as const,
          args: [
            artworkId as Hex,
            masterArtworkHash as Hex,
            metadataHash as Hex,
            distributionWallet,
            metadataURI,
          ] as const,
        };
        await publicClient.simulateContract({
          ...call,
          address: contractAddress,
          account: reviewedSafe,
        });
        setSafePrepared(
          encodeOperatorSafeSubmission({
            ...call,
            target: contractAddress,
            requestId: artworkId as Hex,
          }),
        );
        setStatus("idle");
        setMessage(
          "The reviewed charity-edition call is ready for multisignature review. It publishes no artwork master and attaches no ETH value.",
        );
        return;
      }
      setSafePrepared(undefined);
      setMintedEdition(undefined);
      setTransactionHash(undefined);
      setStatus("awaiting-wallet");
      setMessage(
        `Confirm one createSeries call to ${shortAddress(contractAddress)}. It mints exactly 100 units to ${shortAddress(distributionWallet)}.`,
      );
      const hash = await writeContractAsync({
        abi: charityEditionsAbi,
        address: contractAddress,
        chainId: supportedChain.id,
        functionName: "createSeries",
        args: [
          artworkId as Hex,
          masterArtworkHash as Hex,
          metadataHash as Hex,
          distributionWallet,
          metadataURI,
        ],
      });
      setTransactionHash(hash);
      setStatus("confirming");
      setMessage(
        "Waiting for one Hoodi confirmation and exact event matching.",
      );
      await confirmEdition(hash, {
        artworkId,
        masterArtworkHash,
        metadataHash,
        distributionWallet,
        metadataURI,
      });
    } catch (error) {
      setStatus("error");
      setMessage(
        operatorErrorText(error, "The ERC-1155 series could not be created."),
      );
    }
  }

  async function confirmEdition(
    hash: Hex,
    fields: {
      artworkId: string;
      masterArtworkHash: string;
      metadataHash: string;
      distributionWallet: Address;
      metadataURI: string;
    },
  ) {
    if (!publicClient || !contractAddress)
      throw new Error("The reviewed edition contract is unavailable.");
    const {
      artworkId,
      masterArtworkHash,
      metadataHash,
      distributionWallet,
      metadataURI,
    } = fields;
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });
    if (receipt.status !== "success")
      throw new Error("The Hoodi transaction reverted.");

    const createdEvents = parseEventLogs({
      abi: charityEditionsAbi,
      eventName: "SeriesCreated",
      logs: receipt.logs.filter(
        (log) => log.address.toLowerCase() === contractAddress.toLowerCase(),
      ),
      strict: true,
    });
    const created = createdEvents.find(
      (eventLog) =>
        eventLog.args.artworkId.toLowerCase() === artworkId.toLowerCase() &&
        eventLog.args.masterArtworkHash.toLowerCase() ===
          masterArtworkHash.toLowerCase() &&
        eventLog.args.metadataHash.toLowerCase() ===
          metadataHash.toLowerCase() &&
        eventLog.args.distributionWallet.toLowerCase() ===
          distributionWallet.toLowerCase() &&
        eventLog.args.metadataURI === metadataURI,
    );
    if (!created)
      throw new Error("The confirmed series event is missing or mismatched.");

    const [totalSupply, distributionBalance] = await Promise.all([
      publicClient.readContract({
        abi: charityEditionsAbi,
        address: contractAddress,
        functionName: "totalSupply",
        args: [created.args.tokenId],
      }),
      publicClient.readContract({
        abi: charityEditionsAbi,
        address: contractAddress,
        functionName: "balanceOf",
        args: [distributionWallet, created.args.tokenId],
      }),
    ]);
    if (totalSupply !== 100n || distributionBalance !== 100n) {
      throw new Error(
        "The confirmed series does not hold the required 100 units.",
      );
    }

    setMintedEdition({
      collectionAddress: contractAddress,
      distributionWallet,
      quantity: distributionBalance,
      tokenId: created.args.tokenId.toString(),
    });
    setStatus("confirmed");
    setMessage(
      "The fixed ERC-1155 supply is confirmed. Marketplace listing remains a separate wallet action.",
    );
  }

  async function recoverSafeEdition(hash: Hex, submission: SafeSubmission) {
    if (!contractAddress)
      throw new Error("The reviewed edition contract is unavailable.");
    reviewSafeSubmission("charity", contractAddress, submission);
    const call = decodeFunctionData({
      abi: charityEditionsAbi,
      data: submission.data,
    });
    if (call.functionName !== "createSeries")
      throw new Error("The confirmed call is not a charity edition creation.");
    const [
      artworkId,
      masterArtworkHash,
      metadataHash,
      distributionWallet,
      metadataURI,
    ] = call.args;
    setTransactionHash(hash);
    await confirmEdition(hash, {
      artworkId,
      masterArtworkHash,
      metadataHash,
      distributionWallet,
      metadataURI,
    });
  }

  return (
    <div className="create-layout" data-no-translate>
      <form
        className="rwa-form"
        onSubmit={submit}
        onChange={() => setSafePrepared(undefined)}
      >
        <fieldset disabled={!canSubmit}>
          <legend>Fixed ERC-1155 series</legend>
          <div
            className="contract-facts"
            aria-label="ERC-1155 contract controls"
          >
            <div>
              <span>Supply per work</span>
              <strong>{editionsPerArtwork?.toString() ?? "—"}</strong>
            </div>
            <div>
              <span>Recorded unit price</span>
              <strong>
                {primaryPriceWei === undefined
                  ? "—"
                  : `${formatEther(primaryPriceWei)} ETH`}
              </strong>
            </div>
            <div>
              <span>Existing series</span>
              <strong>{seriesCount?.toString() ?? "—"}</strong>
            </div>
          </div>
          <div className="field-grid">
            <label className="field-span">
              Artwork ID commitment (bytes32)
              <input name="artworkId" pattern="^0x[0-9a-fA-F]{64}$" required />
            </label>
            <label className="field-span">
              Private master SHA-256 commitment (bytes32)
              <input
                name="masterArtworkHash"
                pattern="^0x[0-9a-fA-F]{64}$"
                required
              />
            </label>
            <label className="field-span">
              Public metadata SHA-256 commitment (bytes32)
              <input
                name="metadataHash"
                pattern="^0x[0-9a-fA-F]{64}$"
                required
              />
            </label>
            <label className="field-span">
              Distribution wallet
              <input
                name="distributionWallet"
                defaultValue={address ?? ""}
                pattern="^0x[0-9a-fA-F]{40}$"
                required
              />
            </label>
            <label className="field-span">
              No-preview metadata URI
              <input
                name="metadataURI"
                placeholder="ipfs://… or https://…"
                maxLength={512}
                required
              />
            </label>
            <label className="field-span edition-approval">
              <input name="packageApproved" type="checkbox" required />
              <span>
                I verified the off-repository rights package, beneficiary wallet
                and no-preview metadata. No unwatermarked master is published.
              </span>
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
          Review and mint ERC-1155 on Hoodi
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
          <li>Verify off-repository package</li>
          <li>Verify creator role and constants</li>
          <li>Review one wallet call</li>
          <li>Confirm supply and recipient balance</li>
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
        {mintedEdition ? (
          <>
            <NFTWalletImport
              collectionAddress={mintedEdition.collectionAddress}
              quantity={mintedEdition.quantity}
              standard="ERC-1155"
              tokenId={mintedEdition.tokenId}
            />
            {address?.toLowerCase() !==
            mintedEdition.distributionWallet.toLowerCase() ? (
              <p className="nft-wallet-import__status">
                Switch to the distribution wallet to display its 100-unit
                balance.
              </p>
            ) : null}
          </>
        ) : null}
        <CharityEditionRightsNotice className="nft-wallet-import__status" />
      </aside>
      <AdminSafeConsole
        kind="charity"
        target={contractAddress}
        prepared={safePrepared}
        onExecuted={recoverSafeEdition}
      />
    </div>
  );
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
