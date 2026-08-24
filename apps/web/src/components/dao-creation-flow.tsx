"use client";

import { useEffect, useRef, useState } from "react";
import {
  isAddress,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSignMessage,
  useWriteContract,
} from "wagmi";

import {
  artFiVaultAbi,
  erc721VaultApprovalAbi,
  vaultFactoryAbi,
} from "@/lib/contracts";
import { supportedChain } from "@/lib/wagmi";

type OperatorStatus =
  "checking" | "unauthenticated" | "verifying" | "authenticated";
type Stage =
  | "configure"
  | "creating"
  | "created"
  | "approving"
  | "approved"
  | "depositing"
  | "deposited"
  | "fractionalizing"
  | "complete";

type VaultIntent = {
  intentId: string;
  requestId: Hex;
  factoryAddress: Address;
  collectionAddress: Address;
  tokenId: string;
  vaultName: string;
  adminAddress: Address;
  pauserAddress: Address;
  fractionalizerAddress: Address;
  chainId: number;
};

type Configuration = {
  collectionAddress: Address;
  tokenId: bigint;
  vaultName: string;
  adminAddress: Address;
  pauserAddress: Address;
  fractionalizerAddress: Address;
  tokenName: string;
  tokenSymbol: string;
  tokenSupply: bigint;
  recipient: Address;
};

export function DaoCreationFlow() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const [operatorStatus, setOperatorStatus] =
    useState<OperatorStatus>("checking");
  const [stage, setStage] = useState<Stage>("configure");
  const [message, setMessage] = useState(
    "Create the Vault first. Exact-token approval, deposit and fractionalization remain separate wallet confirmations.",
  );
  const [configuration, setConfiguration] = useState<Configuration>();
  const [vaultAddress, setVaultAddress] = useState<Address>();
  const [fractionToken, setFractionToken] = useState<Address>();
  const idempotencyKey = useRef(crypto.randomUUID());

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!address || chainId !== supportedChain.id) {
        if (!cancelled) setOperatorStatus("unauthenticated");
        return;
      }
      try {
        const response = await fetch("/api/operator/auth/session", {
          cache: "no-store",
        });
        const session = (await response.json()) as {
          authenticated?: boolean;
          address?: string;
        };
        if (!cancelled) {
          setOperatorStatus(
            response.ok &&
              session.authenticated === true &&
              session.address?.toLowerCase() === address.toLowerCase()
              ? "authenticated"
              : "unauthenticated",
          );
        }
      } catch {
        if (!cancelled) setOperatorStatus("unauthenticated");
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [address, chainId]);

  async function verifyOperator() {
    if (!address || chainId !== supportedChain.id) return;
    try {
      setOperatorStatus("verifying");
      const challenge = await fetchJSON<{ address: string; message: string }>(
        "/api/operator/auth/challenge",
        { method: "POST", body: JSON.stringify({ address }) },
      );
      if (challenge.address.toLowerCase() !== address.toLowerCase()) {
        throw new Error("The operator challenge address did not match.");
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
      )
        throw new Error("Operator verification failed.");
      setOperatorStatus("authenticated");
      setMessage("Operator wallet verified. Review every Vault parameter.");
    } catch (error) {
      fail(error, "The operator wallet could not be verified.", "configure");
      setOperatorStatus("unauthenticated");
    }
  }

  async function createVault(formData: FormData) {
    if (
      !address ||
      !publicClient ||
      operatorStatus !== "authenticated" ||
      chainId !== supportedChain.id
    )
      return;
    try {
      const value = readConfiguration(formData, address);
      setStage("creating");
      setMessage(
        "Preparing a deterministic Vault intent and checking live ownership and roles.",
      );
      const prepared = await fetchJSON<VaultIntent>(
        "/api/operator/v1/vault/intents",
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey.current },
          body: JSON.stringify({
            collectionAddress: value.collectionAddress,
            tokenId: value.tokenId.toString(),
            vaultName: value.vaultName,
            adminAddress: value.adminAddress,
            pauserAddress: value.pauserAddress,
            fractionalizerAddress: value.fractionalizerAddress,
          }),
        },
      );
      if (
        prepared.chainId !== supportedChain.id ||
        prepared.collectionAddress.toLowerCase() !==
          value.collectionAddress.toLowerCase() ||
        prepared.tokenId !== value.tokenId.toString()
      ) {
        throw new Error("The Vault intent did not match the reviewed asset.");
      }
      const [creatorRole, paused, owner] = await Promise.all([
        publicClient.readContract({
          abi: vaultFactoryAbi,
          address: prepared.factoryAddress,
          functionName: "CREATOR_ROLE",
        }),
        publicClient.readContract({
          abi: vaultFactoryAbi,
          address: prepared.factoryAddress,
          functionName: "paused",
        }),
        publicClient.readContract({
          abi: erc721VaultApprovalAbi,
          address: value.collectionAddress,
          functionName: "ownerOf",
          args: [value.tokenId],
        }),
      ]);
      const creator = await publicClient.readContract({
        abi: vaultFactoryAbi,
        address: prepared.factoryAddress,
        functionName: "hasRole",
        args: [creatorRole, address],
      });
      if (paused) throw new Error("The reviewed VaultFactory is paused.");
      if (!creator)
        throw new Error("This wallet does not hold VaultFactory CREATOR_ROLE.");
      if (owner.toLowerCase() !== address.toLowerCase()) {
        throw new Error(
          "The connected wallet is not the current ERC-721 owner.",
        );
      }

      setMessage(
        "Confirm one VaultFactory createVault call. No ETH or NFT approval is included.",
      );
      const hash = await writeContractAsync({
        abi: vaultFactoryAbi,
        address: prepared.factoryAddress,
        chainId: supportedChain.id,
        functionName: "createVault",
        args: [
          prepared.requestId,
          prepared.vaultName,
          prepared.collectionAddress,
          BigInt(prepared.tokenId),
          prepared.adminAddress,
          prepared.pauserAddress,
          prepared.fractionalizerAddress,
        ],
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
      if (receipt.status !== "success")
        throw new Error("Vault creation reverted.");
      const event = parseEventLogs({
        abi: vaultFactoryAbi,
        eventName: "VaultCreated",
        logs: receipt.logs.filter(
          (log) =>
            log.address.toLowerCase() === prepared.factoryAddress.toLowerCase(),
        ),
        strict: true,
      }).find(
        (entry) =>
          entry.args.requestId.toLowerCase() ===
            prepared.requestId.toLowerCase() &&
          entry.args.collection.toLowerCase() ===
            value.collectionAddress.toLowerCase() &&
          entry.args.tokenId === value.tokenId,
      );
      if (!event)
        throw new Error("The VaultCreated receipt was missing or mismatched.");
      await fetchJSON(
        `/api/operator/v1/vault/intents/${prepared.intentId}/submission`,
        {
          method: "POST",
          body: JSON.stringify({ transactionHash: hash }),
        },
      );
      setConfiguration(value);
      setVaultAddress(event.args.vault);
      setStage("created");
      setMessage(
        "Vault created. The next action approves only this token ID, never the collection.",
      );
    } catch (error) {
      fail(error, "The Vault could not be created.", "configure");
    }
  }

  async function approveExactToken() {
    if (!publicClient || !configuration || !vaultAddress) return;
    try {
      setStage("approving");
      setMessage(
        `Approve only token #${configuration.tokenId.toString()} for the new Vault.`,
      );
      const hash = await writeContractAsync({
        abi: erc721VaultApprovalAbi,
        address: configuration.collectionAddress,
        chainId: supportedChain.id,
        functionName: "approve",
        args: [vaultAddress, configuration.tokenId],
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
      if (receipt.status !== "success")
        throw new Error("Exact-token approval reverted.");
      const approved = await publicClient.readContract({
        abi: erc721VaultApprovalAbi,
        address: configuration.collectionAddress,
        functionName: "getApproved",
        args: [configuration.tokenId],
      });
      if (approved.toLowerCase() !== vaultAddress.toLowerCase()) {
        throw new Error(
          "The exact-token approval did not resolve to this Vault.",
        );
      }
      setStage("approved");
      setMessage(
        "Exact-token approval confirmed. Deposit remains a separate transaction.",
      );
    } catch (error) {
      fail(error, "The exact-token approval failed.", "created");
    }
  }

  async function deposit() {
    if (!publicClient || !configuration || !vaultAddress || !address) return;
    try {
      setStage("depositing");
      setMessage("Deposit the selected ERC-721 into the exact Vault address.");
      const hash = await writeContractAsync({
        abi: artFiVaultAbi,
        address: vaultAddress,
        chainId: supportedChain.id,
        functionName: "deposit",
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
      if (receipt.status !== "success")
        throw new Error("Vault deposit reverted.");
      const deposited = parseEventLogs({
        abi: artFiVaultAbi,
        eventName: "NFTDeposited",
        logs: receipt.logs.filter(
          (log) => log.address.toLowerCase() === vaultAddress.toLowerCase(),
        ),
        strict: true,
      }).some(
        (entry) =>
          entry.args.collection.toLowerCase() ===
            configuration.collectionAddress.toLowerCase() &&
          entry.args.tokenId === configuration.tokenId &&
          entry.args.owner.toLowerCase() === address.toLowerCase(),
      );
      const owner = await publicClient.readContract({
        abi: erc721VaultApprovalAbi,
        address: configuration.collectionAddress,
        functionName: "ownerOf",
        args: [configuration.tokenId],
      });
      if (!deposited || owner.toLowerCase() !== vaultAddress.toLowerCase()) {
        throw new Error("Vault custody could not be independently confirmed.");
      }
      setStage("deposited");
      setMessage(
        "Vault custody confirmed. Review the fixed fraction supply before issuance.",
      );
    } catch (error) {
      fail(error, "The NFT deposit failed.", "approved");
    }
  }

  async function fractionalize() {
    if (!publicClient || !configuration || !vaultAddress) return;
    try {
      setStage("fractionalizing");
      setMessage("Issue the reviewed fixed supply to the selected recipient.");
      const hash = await writeContractAsync({
        abi: artFiVaultAbi,
        address: vaultAddress,
        chainId: supportedChain.id,
        functionName: "fractionalize",
        args: [
          configuration.tokenName,
          configuration.tokenSymbol,
          configuration.tokenSupply,
          configuration.recipient,
        ],
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
      if (receipt.status !== "success")
        throw new Error("Fractionalization reverted.");
      const event = parseEventLogs({
        abi: artFiVaultAbi,
        eventName: "Fractionalized",
        logs: receipt.logs.filter(
          (log) => log.address.toLowerCase() === vaultAddress.toLowerCase(),
        ),
        strict: true,
      }).find(
        (entry) =>
          entry.args.recipient.toLowerCase() ===
            configuration.recipient.toLowerCase() &&
          entry.args.supply === configuration.tokenSupply,
      );
      if (!event)
        throw new Error(
          "The Fractionalized receipt was missing or mismatched.",
        );
      setFractionToken(event.args.token);
      setStage("complete");
      setMessage(
        "Vault custody and fixed fraction issuance are confirmed on Base Sepolia.",
      );
      idempotencyKey.current = crypto.randomUUID();
    } catch (error) {
      fail(error, "Fractionalization failed.", "deposited");
    }
  }

  function fail(error: unknown, fallback: string, retryStage: Stage) {
    setStage(retryStage);
    setMessage(error instanceof Error ? error.message : fallback);
  }

  const canConfigure =
    isConnected &&
    chainId === supportedChain.id &&
    operatorStatus === "authenticated" &&
    stage === "configure";

  return (
    <section className="dao-create" aria-labelledby="dao-create-title">
      <header className="section-heading">
        <p className="approved-eyebrow">Vault and fraction setup</p>
        <h2 id="dao-create-title">
          Create the asset DAO in four controlled steps.
        </h2>
        <p>
          Create Vault → approve one token → deposit → issue fixed fractions. No
          collection-wide approval is requested.
        </p>
      </header>
      <div className="create-layout">
        <form
          className="rwa-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createVault(new FormData(event.currentTarget));
          }}
        >
          <fieldset disabled={!canConfigure}>
            <legend>Asset and DAO parameters</legend>
            <div className="field-grid">
              <label className="field-span">
                ERC-721 collection
                <input
                  name="collectionAddress"
                  pattern="0x[0-9a-fA-F]{40}"
                  required
                />
              </label>
              <label>
                Token ID
                <input
                  name="tokenId"
                  inputMode="numeric"
                  pattern="0|[1-9][0-9]*"
                  required
                />
              </label>
              <label>
                Vault / DAO name
                <input name="vaultName" minLength={2} maxLength={80} required />
              </label>
              <label>
                Fraction token name
                <input name="tokenName" minLength={2} maxLength={80} required />
              </label>
              <label>
                Symbol
                <input
                  name="tokenSymbol"
                  minLength={2}
                  maxLength={12}
                  required
                />
              </label>
              <label>
                Whole-token supply
                <input
                  name="tokenSupply"
                  type="number"
                  min="1"
                  max="1000000000000"
                  required
                />
              </label>
              <label>
                Recipient (blank = connected wallet)
                <input name="recipient" pattern="0x[0-9a-fA-F]{40}" />
              </label>
              {(
                [
                  "adminAddress",
                  "pauserAddress",
                  "fractionalizerAddress",
                ] as const
              ).map((name) => (
                <label key={name}>
                  {name.replace("Address", " role (blank = wallet)")}
                  <input name={name} pattern="0x[0-9a-fA-F]{40}" />
                </label>
              ))}
            </div>
          </fieldset>
          {isConnected && chainId === supportedChain.id ? (
            <button
              className="secondary"
              type="button"
              disabled={operatorStatus !== "unauthenticated"}
              onClick={() => void verifyOperator()}
            >
              {operatorStatus === "authenticated"
                ? "Operator wallet verified"
                : operatorStatus === "verifying"
                  ? "Verifying operator wallet…"
                  : "Verify operator wallet"}
            </button>
          ) : null}
          <button className="primary" type="submit" disabled={!canConfigure}>
            Step 1 · Create Vault
          </button>
        </form>
        <aside className="transaction-panel" aria-live="polite">
          <p className="eyebrow">Four-step custody lifecycle</p>
          <h3>{stageLabel(stage)}</h3>
          <p>{message}</p>
          <ol>
            <li data-complete={Boolean(vaultAddress)}>Create named Vault</li>
            <li
              data-complete={["approved", "deposited", "complete"].includes(
                stage,
              )}
            >
              Approve exact token ID
            </li>
            <li data-complete={["deposited", "complete"].includes(stage)}>
              Transfer NFT into Vault custody
            </li>
            <li data-complete={stage === "complete"}>
              Issue fixed fraction supply
            </li>
          </ol>
          {vaultAddress ? <p>Vault: {vaultAddress}</p> : null}
          {fractionToken ? <p>Fraction token: {fractionToken}</p> : null}
          {stage === "created" ? (
            <button type="button" onClick={() => void approveExactToken()}>
              Step 2 · Approve this token only
            </button>
          ) : null}
          {stage === "approved" ? (
            <button type="button" onClick={() => void deposit()}>
              Step 3 · Deposit into Vault
            </button>
          ) : null}
          {stage === "deposited" ? (
            <button type="button" onClick={() => void fractionalize()}>
              Step 4 · Issue fixed fractions
            </button>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function readConfiguration(form: FormData, address: Address): Configuration {
  const requiredAddress = (name: string, fallback?: Address) => {
    const candidate = String(form.get(name) || fallback || "").trim();
    if (!isAddress(candidate))
      throw new Error(`${name} must be an Ethereum address.`);
    return candidate;
  };
  const tokenIdText = String(form.get("tokenId") || "");
  if (!/^(0|[1-9][0-9]{0,77})$/.test(tokenIdText)) {
    throw new Error("Token ID must be a canonical uint256 value.");
  }
  const vaultName = String(form.get("vaultName") || "").trim();
  const tokenName = String(form.get("tokenName") || "").trim();
  const tokenSymbol = String(form.get("tokenSymbol") || "").trim();
  if (vaultName.length < 2 || tokenName.length < 2 || tokenSymbol.length < 2) {
    throw new Error("Vault and token names and symbol are required.");
  }
  const rawSupply = String(form.get("tokenSupply") || "");
  if (!/^[1-9][0-9]{0,12}$/.test(rawSupply)) {
    throw new Error("Supply must be a positive whole-token amount.");
  }
  return {
    collectionAddress: requiredAddress("collectionAddress"),
    tokenId: BigInt(tokenIdText),
    vaultName,
    adminAddress: requiredAddress("adminAddress", address),
    pauserAddress: requiredAddress("pauserAddress", address),
    fractionalizerAddress: requiredAddress("fractionalizerAddress", address),
    tokenName,
    tokenSymbol,
    tokenSupply: parseUnits(rawSupply, 18),
    recipient: requiredAddress("recipient", address),
  };
}

function stageLabel(stage: Stage) {
  return {
    configure: "Review configuration",
    creating: "Creating Vault",
    created: "Vault created",
    approving: "Approving exact token",
    approved: "Exact token approved",
    depositing: "Depositing NFT",
    deposited: "Vault custody confirmed",
    fractionalizing: "Issuing fixed fractions",
    complete: "DAO asset setup confirmed",
  }[stage];
}

async function fetchJSON<T = unknown>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    let detail = `Request failed with status ${response.status}.`;
    try {
      const body = (await response.json()) as { detail?: string };
      detail = body.detail || detail;
    } catch {
      // Keep the status-only error.
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}
