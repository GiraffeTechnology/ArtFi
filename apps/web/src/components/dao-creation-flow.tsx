"use client";

import { useEffect, useRef, useState } from "react";
import {
  encodeFunctionData,
  formatUnits,
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
  | "submission-pending"
  | "reconciling"
  | "created"
  | "approving"
  | "approved"
  | "depositing"
  | "deposited"
  | "fractionalizing"
  | "action-pending"
  | "action-reconciling"
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
  ownerAddress: Address;
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

type CreationAttempt = {
  intent: VaultIntent;
  configuration: Configuration;
  transactionHash: Hex;
};

type VaultActionKind = "approval" | "deposit" | "fractionalization";
type VaultActionAttempt = {
  kind: VaultActionKind;
  configuration: Configuration;
  vaultAddress: Address;
  transactionHash: Hex;
};

// ArtFiVault.MAX_FRACTION_SUPPLY / 10**18; preserve the source contract limit.
const maxWholeFractionSupply = 1_000_000_000_000n;

export function DaoCreationFlow() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: supportedChain.id });
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const [operatorStatus, setOperatorStatus] =
    useState<OperatorStatus>("checking");
  const [authenticatedAddress, setAuthenticatedAddress] = useState<string>();
  const operatorAuthenticated =
    isConnected &&
    chainId === supportedChain.id &&
    operatorStatus === "authenticated" &&
    Boolean(address) &&
    authenticatedAddress === address?.toLowerCase();
  const [stage, setStage] = useState<Stage>("configure");
  const [message, setMessage] = useState(
    "Create the Vault first. Exact-token approval, deposit and fractionalization remain separate wallet confirmations.",
  );
  const [configuration, setConfiguration] = useState<Configuration>();
  const [vaultAddress, setVaultAddress] = useState<Address>();
  const [fractionToken, setFractionToken] = useState<Address>();
  const [creationAttempt, setCreationAttempt] = useState<CreationAttempt>();
  const pendingCreation = useRef<CreationAttempt | undefined>(undefined);
  const creationBusy = useRef(false);
  const [vaultActionAttempt, setVaultActionAttempt] =
    useState<VaultActionAttempt>();
  const pendingVaultAction = useRef<VaultActionAttempt | undefined>(undefined);
  const vaultActionBusy = useRef(false);
  const preparedRequest = useRef<
    { identity: string; idempotencyKey: string } | undefined
  >(undefined);

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
          setAuthenticatedAddress(
            response.ok &&
              session.authenticated === true &&
              session.address?.toLowerCase() === address.toLowerCase()
              ? address.toLowerCase()
              : undefined,
          );
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
      const signature = await signMessageAsync({
        account: address,
        message: challenge.message,
      });
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
      setAuthenticatedAddress(address.toLowerCase());
      setMessage("Operator wallet verified. Review every Vault parameter.");
    } catch (error) {
      fail(
        error,
        "The operator wallet could not be verified.",
        pendingCreation.current
          ? "submission-pending"
          : pendingVaultAction.current
            ? "action-pending"
            : stage,
      );
      setOperatorStatus("unauthenticated");
    }
  }

  async function createVault(formData: FormData) {
    if (
      !address ||
      !publicClient ||
      !operatorAuthenticated ||
      chainId !== supportedChain.id ||
      stage !== "configure" ||
      creationBusy.current ||
      pendingCreation.current ||
      vaultActionBusy.current ||
      pendingVaultAction.current
    )
      return;
    creationBusy.current = true;
    try {
      const value = readConfiguration(formData, address);
      const requestBody = JSON.stringify({
        collectionAddress: value.collectionAddress,
        tokenId: value.tokenId.toString(),
        vaultName: value.vaultName,
        adminAddress: value.adminAddress,
        pauserAddress: value.pauserAddress,
        fractionalizerAddress: value.fractionalizerAddress,
      });
      // Keep an ambiguous API retry idempotent. A changed, unsubmitted review
      // needs a different key; pendingCreation prevents this after submission.
      const requestIdentity = JSON.stringify([
        supportedChain.id,
        value.ownerAddress.toLowerCase(),
        requestBody,
      ]);
      if (preparedRequest.current?.identity !== requestIdentity) {
        preparedRequest.current = {
          identity: requestIdentity,
          idempotencyKey: crypto.randomUUID(),
        };
      }
      setStage("creating");
      setMessage(
        "Preparing a deterministic Vault intent and checking live ownership and roles.",
      );
      const prepared = await fetchJSON<VaultIntent>(
        "/api/operator/v1/vault/intents",
        {
          method: "POST",
          headers: {
            "Idempotency-Key": preparedRequest.current.idempotencyKey,
          },
          body: requestBody,
        },
      );
      if (!matchesReviewedVaultIntent(prepared, value)) {
        throw new Error(
          "The Vault intent did not match the reviewed asset, name and roles.",
        );
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
        account: address,
        abi: vaultFactoryAbi,
        address: prepared.factoryAddress,
        chainId: supportedChain.id,
        functionName: "createVault",
        args: [
          prepared.requestId,
          value.vaultName,
          value.collectionAddress,
          value.tokenId,
          value.adminAddress,
          value.pauserAddress,
          value.fractionalizerAddress,
        ],
      });
      const attempt = {
        intent: prepared,
        configuration: value,
        transactionHash: hash,
      };
      pendingCreation.current = attempt;
      setCreationAttempt(attempt);
      await reconcileCreation(attempt);
    } catch (error) {
      fail(
        error,
        "The Vault could not be created.",
        pendingCreation.current ? "submission-pending" : "configure",
      );
    } finally {
      creationBusy.current = false;
    }
  }

  async function reconcileCreation(attempt: CreationAttempt) {
    if (!publicClient) throw new Error("Hoodi reader unavailable.");
    const {
      intent: prepared,
      configuration: value,
      transactionHash: hash,
    } = attempt;
    setStage("reconciling");
    setMessage(
      "Checking the existing creation transaction. No new wallet transaction is requested.",
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      timeout: 60_000,
    });
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error(
        "The creation transaction was replaced; its outcome requires review. Do not resubmit.",
      );
    }
    const [transaction, block] = await Promise.all([
      publicClient.getTransaction({ hash }),
      publicClient.getBlock({ blockNumber: receipt.blockNumber }),
    ]);
    const expectedInput = encodeFunctionData({
      abi: vaultFactoryAbi,
      functionName: "createVault",
      args: [
        prepared.requestId,
        value.vaultName,
        value.collectionAddress,
        value.tokenId,
        value.adminAddress,
        value.pauserAddress,
        value.fractionalizerAddress,
      ],
    });
    if (
      transaction.to?.toLowerCase() !== prepared.factoryAddress.toLowerCase() ||
      transaction.from.toLowerCase() !== value.ownerAddress.toLowerCase() ||
      transaction.value !== 0n ||
      transaction.input.toLowerCase() !== expectedInput.toLowerCase() ||
      transaction.blockHash !== receipt.blockHash ||
      block.hash !== receipt.blockHash
    ) {
      throw new Error(
        "Creation transaction evidence does not match the reviewed intent.",
      );
    }
    if (receipt.status !== "success") {
      pendingCreation.current = undefined;
      setCreationAttempt(undefined);
      throw new Error("Vault creation reverted.");
    }
    const events = parseEventLogs({
      abi: vaultFactoryAbi,
      eventName: "VaultCreated",
      logs: receipt.logs.filter(
        (log) =>
          log.address.toLowerCase() === prepared.factoryAddress.toLowerCase() &&
          !log.removed &&
          log.transactionHash === receipt.transactionHash &&
          log.blockHash === receipt.blockHash &&
          log.blockNumber === receipt.blockNumber,
      ),
      strict: true,
    }).filter(
      (entry) =>
        entry.args.requestId.toLowerCase() ===
          prepared.requestId.toLowerCase() &&
        entry.args.collection.toLowerCase() ===
          value.collectionAddress.toLowerCase() &&
        entry.args.tokenId === value.tokenId &&
        entry.args.vaultName === value.vaultName &&
        nonzeroAddress(entry.args.vault),
    );
    if (events.length !== 1)
      throw new Error("The VaultCreated receipt was missing or mismatched.");
    const event = events[0];
    await fetchJSON(
      `/api/operator/v1/vault/intents/${prepared.intentId}/submission`,
      {
        method: "POST",
        body: JSON.stringify({ transactionHash: hash }),
      },
    );
    setConfiguration(value);
    setVaultAddress(event.args.vault);
    pendingCreation.current = undefined;
    setCreationAttempt(undefined);
    setStage("created");
    setMessage(
      "Vault created. The next action approves only this token ID, never the collection.",
    );
  }

  async function retryCreationReconciliation() {
    const attempt = pendingCreation.current;
    if (
      !attempt ||
      creationBusy.current ||
      !operatorAuthenticated ||
      address?.toLowerCase() !==
        attempt.configuration.ownerAddress.toLowerCase()
    )
      return;
    creationBusy.current = true;
    try {
      await reconcileCreation(attempt);
    } catch {
      setStage(pendingCreation.current ? "submission-pending" : "configure");
      setMessage(
        pendingCreation.current
          ? "The submitted transaction or API record is still unconfirmed. Retry this check only; no new creation will be sent."
          : "The creation transaction reverted. Review before a new attempt.",
      );
    } finally {
      creationBusy.current = false;
    }
  }

  async function approveExactToken() {
    if (
      !publicClient ||
      !configuration ||
      !vaultAddress ||
      !canOwnerAct ||
      stage !== "created" ||
      vaultActionBusy.current ||
      pendingVaultAction.current
    )
      return;
    vaultActionBusy.current = true;
    try {
      setStage("approving");
      const owner = await publicClient.readContract({
        abi: erc721VaultApprovalAbi,
        address: configuration.collectionAddress,
        functionName: "ownerOf",
        args: [configuration.tokenId],
      });
      if (owner.toLowerCase() !== configuration.ownerAddress.toLowerCase()) {
        throw new Error(
          "The reviewed wallet no longer owns this NFT. No approval was requested.",
        );
      }
      setMessage(
        `Approve only token #${configuration.tokenId.toString()} for the new Vault.`,
      );
      const hash = await writeContractAsync({
        account: configuration.ownerAddress,
        abi: erc721VaultApprovalAbi,
        address: configuration.collectionAddress,
        chainId: supportedChain.id,
        functionName: "approve",
        args: [vaultAddress, configuration.tokenId],
      });
      await recordAndReconcileVaultAction(
        "approval",
        configuration,
        vaultAddress,
        hash,
      );
    } catch (error) {
      fail(
        error,
        "The exact-token approval could not be confirmed.",
        pendingVaultAction.current ? "action-pending" : "created",
      );
    } finally {
      vaultActionBusy.current = false;
    }
  }

  async function deposit() {
    if (
      !publicClient ||
      !configuration ||
      !vaultAddress ||
      !canOwnerAct ||
      stage !== "approved" ||
      vaultActionBusy.current ||
      pendingVaultAction.current
    )
      return;
    vaultActionBusy.current = true;
    try {
      setStage("depositing");
      setMessage("Deposit the selected ERC-721 into the exact Vault address.");
      const hash = await writeContractAsync({
        account: configuration.ownerAddress,
        abi: artFiVaultAbi,
        address: vaultAddress,
        chainId: supportedChain.id,
        functionName: "deposit",
      });
      await recordAndReconcileVaultAction(
        "deposit",
        configuration,
        vaultAddress,
        hash,
      );
    } catch (error) {
      fail(
        error,
        "The NFT deposit could not be confirmed.",
        pendingVaultAction.current ? "action-pending" : "approved",
      );
    } finally {
      vaultActionBusy.current = false;
    }
  }

  async function fractionalize() {
    if (
      !publicClient ||
      !configuration ||
      !vaultAddress ||
      !canIssue ||
      stage !== "deposited" ||
      vaultActionBusy.current ||
      pendingVaultAction.current
    )
      return;
    vaultActionBusy.current = true;
    try {
      setStage("fractionalizing");
      setMessage("Issue the reviewed fixed supply to the selected recipient.");
      const hash = await writeContractAsync({
        account: configuration.fractionalizerAddress,
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
      await recordAndReconcileVaultAction(
        "fractionalization",
        configuration,
        vaultAddress,
        hash,
      );
    } catch (error) {
      fail(
        error,
        "Fractionalization could not be confirmed.",
        pendingVaultAction.current ? "action-pending" : "deposited",
      );
    } finally {
      vaultActionBusy.current = false;
    }
  }

  async function recordAndReconcileVaultAction(
    kind: VaultActionKind,
    reviewed: Configuration,
    vault: Address,
    hash: Hex,
  ) {
    const attempt = {
      kind,
      configuration: reviewed,
      vaultAddress: vault,
      transactionHash: hash,
    };
    pendingVaultAction.current = attempt;
    setVaultActionAttempt(attempt);
    await reconcileVaultAction(attempt);
  }

  async function reconcileVaultAction(attempt: VaultActionAttempt) {
    if (!publicClient) throw new Error("Hoodi reader unavailable.");
    const { kind, configuration: reviewed, vaultAddress: vault } = attempt;
    const hash = attempt.transactionHash;
    setStage("action-reconciling");
    setMessage(
      "Checking the submitted transaction without another wallet request.",
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      timeout: 60_000,
    });
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error(
        "The transaction was replaced. Do not resubmit this action.",
      );
    }
    const [transaction, block] = await Promise.all([
      publicClient.getTransaction({ hash }),
      publicClient.getBlock({ blockNumber: receipt.blockNumber }),
    ]);
    const target = kind === "approval" ? reviewed.collectionAddress : vault;
    if (
      transaction.hash.toLowerCase() !== hash.toLowerCase() ||
      transaction.to?.toLowerCase() !== target.toLowerCase() ||
      transaction.from.toLowerCase() !==
        vaultActionSender(attempt).toLowerCase() ||
      transaction.value !== 0n ||
      transaction.input.toLowerCase() !==
        vaultActionCalldata(attempt).toLowerCase() ||
      transaction.blockHash !== receipt.blockHash ||
      block.hash !== receipt.blockHash
    ) {
      throw new Error(
        "Transaction evidence does not match the reviewed Vault action.",
      );
    }
    if (receipt.status !== "success") {
      pendingVaultAction.current = undefined;
      setVaultActionAttempt(undefined);
      throw new Error(
        "The reviewed transaction reverted. Review before retrying.",
      );
    }

    const logs = receipt.logs.filter(
      (log) =>
        log.address.toLowerCase() === vault.toLowerCase() &&
        !log.removed &&
        log.transactionHash === receipt.transactionHash &&
        log.blockHash === receipt.blockHash &&
        log.blockNumber === receipt.blockNumber,
    );
    let issuedToken: Address | undefined;
    if (kind === "approval") {
      const [approved, owner] = await Promise.all([
        publicClient.readContract({
          abi: erc721VaultApprovalAbi,
          address: reviewed.collectionAddress,
          functionName: "getApproved",
          args: [reviewed.tokenId],
        }),
        publicClient.readContract({
          abi: erc721VaultApprovalAbi,
          address: reviewed.collectionAddress,
          functionName: "ownerOf",
          args: [reviewed.tokenId],
        }),
      ]);
      if (
        approved.toLowerCase() !== vault.toLowerCase() ||
        owner.toLowerCase() !== reviewed.ownerAddress.toLowerCase()
      ) {
        throw new Error(
          "The NFT owner or exact-token approval no longer matches.",
        );
      }
    } else if (kind === "deposit") {
      const events = parseEventLogs({
        abi: artFiVaultAbi,
        eventName: "NFTDeposited",
        logs,
        strict: true,
      }).filter(
        (entry) =>
          entry.args.collection.toLowerCase() ===
            reviewed.collectionAddress.toLowerCase() &&
          entry.args.tokenId === reviewed.tokenId &&
          entry.args.owner.toLowerCase() ===
            reviewed.ownerAddress.toLowerCase(),
      );
      const owner = await publicClient.readContract({
        abi: erc721VaultApprovalAbi,
        address: reviewed.collectionAddress,
        functionName: "ownerOf",
        args: [reviewed.tokenId],
      });
      if (events.length !== 1 || owner.toLowerCase() !== vault.toLowerCase()) {
        throw new Error(
          "The deposit event or current Vault custody does not match.",
        );
      }
    } else {
      const events = parseEventLogs({
        abi: artFiVaultAbi,
        eventName: "Fractionalized",
        logs,
        strict: true,
      }).filter(
        (entry) =>
          entry.args.recipient.toLowerCase() ===
            reviewed.recipient.toLowerCase() &&
          entry.args.supply === reviewed.tokenSupply &&
          nonzeroAddress(entry.args.token),
      );
      if (events.length !== 1) {
        throw new Error("The Fractionalized receipt is missing or mismatched.");
      }
      issuedToken = events[0].args.token;
    }
    const currentBlock = await publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (currentBlock.hash !== receipt.blockHash) {
      throw new Error(
        "The transaction block changed while checking the action.",
      );
    }
    pendingVaultAction.current = undefined;
    setVaultActionAttempt(undefined);
    if (kind === "approval") {
      setStage("approved");
      setMessage(
        "Exact-token approval confirmed. Deposit is a separate transaction.",
      );
    } else if (kind === "deposit") {
      setStage("deposited");
      setMessage(
        "Vault custody confirmed. Review the fixed supply before issuance.",
      );
    } else {
      setFractionToken(issuedToken);
      setStage("complete");
      setMessage("The reviewed fixed fraction issuance is confirmed on Hoodi.");
      preparedRequest.current = undefined;
    }
  }

  async function retryVaultActionReconciliation() {
    const attempt = pendingVaultAction.current;
    if (
      !attempt ||
      vaultActionBusy.current ||
      !isConnected ||
      chainId !== supportedChain.id ||
      address?.toLowerCase() !== vaultActionSender(attempt).toLowerCase()
    )
      return;
    vaultActionBusy.current = true;
    try {
      await reconcileVaultAction(attempt);
    } catch {
      setStage(
        pendingVaultAction.current
          ? "action-pending"
          : vaultActionRetryStage(attempt.kind),
      );
      setMessage(
        pendingVaultAction.current
          ? "The submitted action is still unconfirmed or its evidence mismatches. Check this transaction only; do not resubmit."
          : "The reviewed transaction reverted. You can review and retry that step.",
      );
    } finally {
      vaultActionBusy.current = false;
    }
  }

  function fail(error: unknown, fallback: string, retryStage: Stage) {
    setStage(retryStage);
    setMessage(error instanceof Error ? error.message : fallback);
  }

  const correctWalletChain = isConnected && chainId === supportedChain.id;
  const canOwnerAct =
    correctWalletChain &&
    Boolean(configuration) &&
    address?.toLowerCase() === configuration?.ownerAddress.toLowerCase();
  const canIssue =
    correctWalletChain &&
    Boolean(configuration) &&
    address?.toLowerCase() ===
      configuration?.fractionalizerAddress.toLowerCase();
  const canConfigure =
    operatorAuthenticated &&
    stage === "configure" &&
    !creationAttempt &&
    !vaultActionAttempt;
  const completedStage = vaultActionAttempt
    ? vaultActionRetryStage(vaultActionAttempt.kind)
    : stage;

  return (
    <section className="dao-create" aria-labelledby="dao-create-title">
      <header className="section-heading">
        <p className="approved-eyebrow">Vault and fraction setup</p>
        <h2 id="dao-create-title">
          Create the fund Vault and fixed fractions in four controlled steps.
        </h2>
        <p>
          Create Vault → approve one token → deposit → issue fixed fractions. No
          collection-wide approval is requested. This flow does not deploy a
          Governor or establish governance authority.
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
                Vault / fund name (2–80 UTF-8 bytes)
                <input name="vaultName" minLength={1} maxLength={80} required />
              </label>
              <label>
                Fraction token name (2–80 UTF-8 bytes)
                <input name="tokenName" minLength={1} maxLength={80} required />
              </label>
              <label>
                Symbol (2–12 UTF-8 bytes)
                <input
                  name="tokenSymbol"
                  minLength={1}
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
                  max={maxWholeFractionSupply.toString()}
                  step="1"
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
              disabled={operatorAuthenticated || operatorStatus === "verifying"}
              onClick={() => void verifyOperator()}
            >
              {operatorAuthenticated
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
                completedStage,
              )}
            >
              Approve exact token ID
            </li>
            <li
              data-complete={["deposited", "complete"].includes(completedStage)}
            >
              Transfer NFT into Vault custody
            </li>
            <li data-complete={stage === "complete"}>
              Issue fixed fraction supply
            </li>
          </ol>
          {vaultAddress ? <p>Vault: {vaultAddress}</p> : null}
          {fractionToken ? <p>Fraction token: {fractionToken}</p> : null}
          {configuration ? (
            <dl
              aria-label="Reviewed fixed issuance"
              style={{ overflowWrap: "anywhere" }}
            >
              <div>
                <dt>Reviewed NFT identity</dt>
                <dd data-no-translate>
                  Hoodi {supportedChain.id} · {configuration.collectionAddress}{" "}
                  / {configuration.tokenId.toString()}
                </dd>
              </div>
              <div>
                <dt>Reviewed token name / symbol</dt>
                <dd data-no-translate>
                  {configuration.tokenName} / {configuration.tokenSymbol}
                </dd>
              </div>
              <div>
                <dt>Fixed supply (18 decimals)</dt>
                <dd data-no-translate>
                  {formatUnits(configuration.tokenSupply, 18)} whole tokens ·{" "}
                  {configuration.tokenSupply.toString()} raw units
                </dd>
              </div>
              <div>
                <dt>Reviewed issuance recipient</dt>
                <dd data-no-translate>{configuration.recipient}</dd>
              </div>
            </dl>
          ) : null}
          {creationAttempt ? (
            <div>
              <p data-no-translate style={{ overflowWrap: "anywhere" }}>
                Submitted creation: {creationAttempt.transactionHash}
              </p>
              <p>
                Do not create again while this outcome is unresolved. This page
                retains the public transaction reference only for this session;
                keep the hash before leaving.
              </p>
              <button
                type="button"
                disabled={
                  stage !== "submission-pending" ||
                  !operatorAuthenticated ||
                  address?.toLowerCase() !==
                    creationAttempt.configuration.ownerAddress.toLowerCase()
                }
                onClick={() => void retryCreationReconciliation()}
              >
                Check existing transaction and retry API record
              </button>
            </div>
          ) : null}
          {vaultActionAttempt ? (
            <div>
              <p data-no-translate style={{ overflowWrap: "anywhere" }}>
                Submitted {vaultActionAttempt.kind}:{" "}
                {vaultActionAttempt.transactionHash}
              </p>
              <p>
                Keep this public hash before leaving. Recovery here is limited
                to this page session; checking it never requests another
                transaction.
              </p>
              <button
                type="button"
                disabled={
                  stage !== "action-pending" ||
                  !correctWalletChain ||
                  address?.toLowerCase() !==
                    vaultActionSender(vaultActionAttempt).toLowerCase()
                }
                onClick={() => void retryVaultActionReconciliation()}
              >
                Check submitted action without resending
              </button>
            </div>
          ) : null}
          {configuration && stage !== "complete" ? (
            <p>
              Continue on Hoodi using the reviewed NFT owner for
              approval/deposit, or the reviewed fractionalizer for issuance.
              Switching wallets does not transfer the earlier wallet's
              verification or change the reviewed recipient.
              <br />
              NFT owner:{" "}
              <span data-no-translate>{configuration.ownerAddress}</span>
              <br />
              Fractionalizer:{" "}
              <span data-no-translate>
                {configuration.fractionalizerAddress}
              </span>
            </p>
          ) : null}
          {stage === "created" ? (
            <button
              type="button"
              disabled={!canOwnerAct}
              onClick={() => void approveExactToken()}
            >
              Step 2 · Approve this token only
            </button>
          ) : null}
          {stage === "approved" ? (
            <button
              type="button"
              disabled={!canOwnerAct}
              onClick={() => void deposit()}
            >
              Step 3 · Deposit into Vault
            </button>
          ) : null}
          {stage === "deposited" ? (
            <button
              type="button"
              disabled={!canIssue}
              onClick={() => void fractionalize()}
            >
              Step 4 · Issue fixed fractions
            </button>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function nonzeroAddress(value: unknown): value is Address {
  return (
    typeof value === "string" &&
    isAddress(value) &&
    value.toLowerCase() !== "0x0000000000000000000000000000000000000000"
  );
}

function vaultActionSender(attempt: VaultActionAttempt): Address {
  return attempt.kind === "fractionalization"
    ? attempt.configuration.fractionalizerAddress
    : attempt.configuration.ownerAddress;
}

function vaultActionRetryStage(kind: VaultActionKind): Stage {
  return kind === "approval"
    ? "created"
    : kind === "deposit"
      ? "approved"
      : "deposited";
}

function vaultActionCalldata(attempt: VaultActionAttempt): Hex {
  const { kind, configuration: reviewed, vaultAddress: vault } = attempt;
  if (kind === "approval") {
    return encodeFunctionData({
      abi: erc721VaultApprovalAbi,
      functionName: "approve",
      args: [vault, reviewed.tokenId],
    });
  }
  if (kind === "deposit") {
    return encodeFunctionData({ abi: artFiVaultAbi, functionName: "deposit" });
  }
  return encodeFunctionData({
    abi: artFiVaultAbi,
    functionName: "fractionalize",
    args: [
      reviewed.tokenName,
      reviewed.tokenSymbol,
      reviewed.tokenSupply,
      reviewed.recipient,
    ],
  });
}

function matchesReviewedVaultIntent(
  intent: VaultIntent,
  reviewed: Configuration,
): boolean {
  return (
    Boolean(intent) &&
    typeof intent.intentId === "string" &&
    /^[0-9a-f]{32}$/.test(intent.intentId) &&
    typeof intent.requestId === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(intent.requestId) &&
    intent.requestId.toLowerCase() !== `0x${"0".repeat(64)}` &&
    nonzeroAddress(intent.factoryAddress) &&
    intent.chainId === supportedChain.id &&
    intent.vaultName === reviewed.vaultName &&
    intent.tokenId === reviewed.tokenId.toString() &&
    (
      [
        "collectionAddress",
        "adminAddress",
        "pauserAddress",
        "fractionalizerAddress",
      ] as const
    ).every(
      (key) =>
        nonzeroAddress(intent[key]) &&
        intent[key].toLowerCase() === reviewed[key].toLowerCase(),
    )
  );
}

function readConfiguration(form: FormData, address: Address): Configuration {
  const requiredAddress = (name: string, fallback?: Address) => {
    const candidate = String(form.get(name) || fallback || "").trim();
    if (!nonzeroAddress(candidate))
      throw new Error(`${name} must be a nonzero Ethereum address.`);
    return candidate;
  };
  const tokenIdText = String(form.get("tokenId") || "");
  if (
    !/^(0|[1-9][0-9]{0,77})$/.test(tokenIdText) ||
    BigInt(tokenIdText) >= 2n ** 256n
  ) {
    throw new Error("Token ID must be a canonical uint256 value.");
  }
  // HTML maxLength measures UTF-16 units, while the contracts use bytes(string).
  // Validate every issuance parameter before preparing or submitting a Vault.
  const boundedText = (name: string, maximum: number) => {
    const value = String(form.get(name) || "").trim();
    const length = new TextEncoder().encode(value).byteLength;
    if (length < 2 || length > maximum) {
      throw new Error(`${name} must contain 2–${maximum} UTF-8 bytes.`);
    }
    return value;
  };
  const vaultName = boundedText("vaultName", 80);
  const tokenName = boundedText("tokenName", 80);
  const tokenSymbol = boundedText("tokenSymbol", 12);
  const rawSupply = String(form.get("tokenSupply") || "");
  if (!/^[1-9][0-9]{0,12}$/.test(rawSupply)) {
    throw new Error("Supply must be a positive whole-token amount.");
  }
  if (BigInt(rawSupply) > maxWholeFractionSupply) {
    throw new Error(
      "Supply exceeds the Vault limit of 1,000,000,000,000 whole tokens.",
    );
  }
  return {
    ownerAddress: address,
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
    "submission-pending": "Creation outcome or API record pending",
    reconciling: "Checking the existing creation transaction",
    created: "Vault created",
    approving: "Approving exact token",
    approved: "Exact token approved",
    depositing: "Depositing NFT",
    deposited: "Vault custody confirmed",
    fractionalizing: "Issuing fixed fractions",
    "action-pending": "Submitted Vault action is awaiting confirmation",
    "action-reconciling": "Checking the submitted Vault action",
    complete: "Vault and fixed fraction issuance confirmed",
  }[stage];
}

async function fetchJSON<T = unknown>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(15_000),
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
