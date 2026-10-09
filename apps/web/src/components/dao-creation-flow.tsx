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
import {
  isAddress,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  encodeOperatorSafeSubmission,
  type SafeSubmission,
} from "@/lib/admin-safe";
import {
  assertSameSafeSubmission,
  configuredAdminSafe,
  operatorCallRoute,
  vaultRoleDefaults,
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
  artFiVaultAbi,
  erc721VaultApprovalAbi,
  vaultFactoryAbi,
} from "@/lib/contracts";
import { requireCurrentUnderlying } from "@/lib/rwa-underlying";
import { currentOperation } from "@/lib/current-operation";
import { isDaoWalletRejection } from "@/lib/dao-action-state";
import {
  confirmMarketReceipt,
  MarketReceiptFinalError,
} from "@/lib/market-transaction";
import { setupRecoverySession } from "@/lib/setup-recovery";
import {
  assertVaultBinding,
  isVaultSetup,
  loadVaultAccess,
  recoverCreatedVault,
  recordConfirmedVaultCreation,
  vaultCreationSubmission,
  vaultConnectionKey,
  vaultRecoveryAbi,
  type VaultConfiguration,
  type VaultIntent,
  type VaultSetup,
  type VaultStage,
} from "@/lib/vault-setup";
import {
  archiveCompletedVault,
  assertVaultParticipantsReady,
  listVaultContinuations,
  markVaultContinuationLogged,
  reviewVaultContinuation,
  readVaultContinuation,
  sameVaultAsset,
  saveVaultContinuation,
  type VaultContinuation,
} from "@/lib/vault-continuation";
import { supportedChain } from "@/lib/wagmi";

const apiURL = (publicSetting("NEXT_PUBLIC_API_URL") || "").replace(/\/$/, "");
type OperatorStatus =
  "checking" | "unauthenticated" | "verifying" | "authenticated";
type Selection = { collectionAddress: string; tokenId: string };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function DaoCreationFlow() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  return (
    <ConnectedDaoCreation
      key={vaultConnectionKey(address, chainId, isConnected)}
      address={isConnected ? address : undefined}
      chainId={chainId}
    />
  );
}

function ConnectedDaoCreation({
  address,
  chainId,
}: {
  address?: Address;
  chainId: number;
}) {
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const isConnected = Boolean(address);
  const session = useMemo(
    () =>
      setupRecoverySession<VaultSetup>(
        `vault:${chainId}:${address?.toLowerCase() ?? "disconnected"}`,
        (value): value is VaultSetup =>
          isVaultSetup(value) &&
          value.chainId === chainId &&
          Boolean(address && same(value.walletAddress, address)),
      ),
    [address, chainId],
  );
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getServerSnapshot,
  );
  const data = snapshot.record?.data;
  const configuration = data?.configuration;
  const stage = data?.stage ?? "configure";
  const vaultAddress = data?.vaultAddress;
  const fractionToken = data?.fractionToken;
  const [operatorStatus, setOperatorStatus] =
    useState<OperatorStatus>("checking");
  const [factoryAddress, setFactoryAddress] = useState<Address>();
  const [safePrepared, setSafePrepared] = useState<SafeSubmission>();
  const [message, setMessage] = useState(
    "Create the Vault first. Exact-token approval, deposit and fractionalization remain separate wallet confirmations.",
  );
  const [selected, setSelected] = useState<Selection>();
  const [owned, setOwned] = useState<Selection[]>([]);
  const [selectionNotice, setSelectionNotice] = useState("");
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [newVault, setNewVault] = useState(false);
  const [continuations, setContinuations] = useState<VaultContinuation[]>([]);
  const archiveLogBusy = useRef(false);
  const formConfiguration = newVault ? undefined : configuration;
  const view = useRef(currentOperation());
  const verificationBusy = useRef(false);
  useLayoutEffect(() => {
    const active = currentOperation();
    view.current = active;
    const navigation = () => {
      view.current.retire();
      view.current = currentOperation();
    };
    window.addEventListener("pagehide", navigation);
    window.addEventListener("popstate", navigation);
    return () => {
      view.current.retire();
      window.removeEventListener("pagehide", navigation);
      window.removeEventListener("popstate", navigation);
    };
  }, []);
  useEffect(() => {
    session.restore(() => sessionStorage);
  }, [session]);
  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (!address || chainId !== supportedChain.id) {
        if (!cancelled) setOperatorStatus("unauthenticated");
        return;
      }
      try {
        const {
          session: auth,
          config,
          sessionError,
        } = await loadVaultAccess(
          () =>
            fetchJSON<{ authenticated?: boolean; address?: string }>(
              "/api/operator/auth/session",
            ),
          () =>
            fetchJSON<{ chainId: number; vaultFactoryAddress?: string }>(
              `${apiURL}/v1/config`,
            ),
        );
        if (cancelled) return;
        setOperatorStatus(
          auth.authenticated && auth.address && same(auth.address, address)
            ? "authenticated"
            : "unauthenticated",
        );
        if (
          config.chainId !== chainId ||
          !config.vaultFactoryAddress ||
          !isAddress(config.vaultFactoryAddress) ||
          same(config.vaultFactoryAddress, zeroAddress)
        )
          throw new Error(
            "The reviewed Hoodi VaultFactory configuration is unavailable.",
          );
        setFactoryAddress(config.vaultFactoryAddress);
        if (sessionError) setMessage(sessionError);
        setContinuations(listVaultContinuations(sessionStorage));
        const query = new URLSearchParams(window.location.search);
        const collectionAddress = query.get("collectionAddress");
        const tokenId = query.get("tokenId");
        if (
          query.get("chainId") === String(supportedChain.id) &&
          collectionAddress &&
          isAddress(collectionAddress) &&
          tokenId &&
          /^(0|[1-9][0-9]{0,77})$/.test(tokenId) &&
          BigInt(tokenId) < 2n ** 256n
        ) {
          setSelected({ collectionAddress, tokenId });
          setSelectionNotice(
            "Mint continuation selected. Current on-chain ownership will be checked before signing.",
          );
        }
      } catch (error) {
        if (!cancelled) {
          setOperatorStatus("unauthenticated");
          setMessage(errorMessage(error));
        }
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, [address, chainId]);

  function retireTerms() {
    setSafePrepared(undefined);
    view.current.retire();
    view.current = currentOperation();
  }
  function beginViewOperation() {
    retireTerms();
    return view.current;
  }
  async function verifyOperator() {
    if (!address || chainId !== supportedChain.id || verificationBusy.current)
      return;
    verificationBusy.current = true;
    const active = beginViewOperation();
    try {
      setOperatorStatus("verifying");
      const challenge = await fetchJSON<{ address: string; message: string }>(
        "/api/operator/auth/challenge",
        { method: "POST", body: JSON.stringify({ address }) },
      );
      active.assertCurrent();
      if (!same(challenge.address, address))
        throw new Error("The operator challenge address did not match.");
      const signature = await signMessageAsync({ message: challenge.message });
      active.assertCurrent();
      const auth = await fetchJSON<{ authenticated: boolean; address: string }>(
        "/api/operator/auth/verify",
        { method: "POST", body: JSON.stringify({ address, signature }) },
      );
      active.assertCurrent();
      if (!auth.authenticated || !same(auth.address, address))
        throw new Error("Operator verification failed.");
      setOperatorStatus("authenticated");
      setMessage("Operator wallet verified. Review every Vault parameter.");
    } catch (error) {
      if (active.isCurrent()) {
        setOperatorStatus("unauthenticated");
        setMessage(errorMessage(error));
      }
    } finally {
      verificationBusy.current = false;
      if (!active.isCurrent()) setOperatorStatus("unauthenticated");
    }
  }

  async function loadOwned() {
    if (
      !address ||
      !publicClient ||
      selectionBusy ||
      chainId !== supportedChain.id
    )
      return;
    const active = beginViewOperation();
    setSelectionBusy(true);
    try {
      const catalog = await fetchJSON<{
        chainId: number;
        data: Array<Selection & { standard: string }>;
      }>(`${apiURL}/v1/nfts?page=1&pageSize=100`);
      active.assertCurrent();
      if (catalog.chainId !== supportedChain.id || !Array.isArray(catalog.data))
        throw new Error("The NFT discovery response is not from Hoodi.");
      const matches = await Promise.all(
        catalog.data
          .filter(
            (item) =>
              item.standard === "ERC-721" &&
              isAddress(item.collectionAddress) &&
              /^(0|[1-9][0-9]{0,77})$/.test(item.tokenId),
          )
          .map(async (item) => {
            try {
              const owner = await publicClient.readContract({
                abi: erc721VaultApprovalAbi,
                address: item.collectionAddress as Address,
                functionName: "ownerOf",
                args: [BigInt(item.tokenId)],
              });
              return same(owner, address)
                ? {
                    collectionAddress: item.collectionAddress,
                    tokenId: item.tokenId,
                  }
                : undefined;
            } catch {
              return undefined;
            }
          }),
      );
      active.assertCurrent();
      const unique = [
        ...new Map(
          matches
            .filter((item): item is Selection => Boolean(item))
            .map((item) => [
              `${item.collectionAddress.toLowerCase()}:${item.tokenId}`,
              item,
            ]),
        ).values(),
      ];
      setOwned(unique);
      setSelectionNotice(
        `${unique.length} currently owned NFT(s) found in the latest 100 indexed mints. Manual entry remains available.`,
      );
    } catch (error) {
      if (active.isCurrent()) setSelectionNotice(errorMessage(error));
    } finally {
      setSelectionBusy(false);
    }
  }

  function assertWritable(
    active: ReturnType<typeof currentOperation>,
    value: VaultSetup,
    requireOperator = false,
  ) {
    active.assertCurrent();
    if (
      !address ||
      chainId !== supportedChain.id ||
      !same(value.walletAddress, address) ||
      value.chainId !== chainId ||
      (requireOperator && operatorStatus !== "authenticated") ||
      !factoryAddress ||
      !same(value.factoryAddress, factoryAddress)
    )
      throw new Error(
        "Restore the original wallet, chain and reviewed factory before continuing.",
      );
  }

  async function logCreation(
    lease: number,
    active: ReturnType<typeof currentOperation>,
  ) {
    active.assertCurrent();
    if (operatorStatus !== "authenticated") return;
    try {
      const submission = await recordConfirmedVaultCreation(
        session.getSnapshot().record,
        ({ intentId, transactionHash }) =>
          fetchJSON(`/api/operator/v1/vault/intents/${intentId}/submission`, {
            method: "POST",
            body: JSON.stringify({ transactionHash }),
          }),
      );
      if (!submission) return;
      active.assertCurrent();
      const latest = session.getSnapshot().record?.data;
      if (
        latest?.intent?.intentId === submission.intentId &&
        latest.creationHash === submission.transactionHash
      ) {
        session.save(lease, { ...latest, submissionPending: false });
        const archived = readVaultContinuation(sessionStorage, latest);
        if (archived) markVaultContinuationLogged(sessionStorage, archived);
        setContinuations(listVaultContinuations(sessionStorage));
      }
    } catch (error) {
      if (active.isCurrent())
        session.fail(
          lease,
          new Error(
            `Vault transaction retained. Submission logging needs retry: ${errorMessage(error)}`,
          ),
        );
    }
  }

  async function reconcile(
    lease: number,
    active: ReturnType<typeof currentOperation>,
  ) {
    active.assertCurrent();
    if (!publicClient) throw new Error("Hoodi receipt access is unavailable.");
    const resolve = (data: VaultSetup) => {
      active.assertCurrent();
      session.resolved(lease, data);
      if (data.stage !== "configure") {
        saveVaultContinuation(sessionStorage, session.getSnapshot().record!);
        setContinuations(listVaultContinuations(sessionStorage));
      }
    };
    const saved = session.getSnapshot().record?.data;
    let pending = session.getSnapshot().record?.pending;
    if (!saved || !pending) return;
    if (!pending.hash) {
      if (pending.step !== "create" || !saved.intent)
        throw new Error(
          "This wallet request has no known hash. Check wallet activity; no retry is safe yet.",
        );
      let original: VaultIntent | undefined;
      try {
        original = await fetchJSON<VaultIntent>(
          `/api/operator/v1/vault/intents/${saved.intent.intentId}`,
        );
      } catch {
        /* API availability does not prevent exact read-only on-chain recovery. */
      }
      active.assertCurrent();
      if (original) {
        assertVaultBinding(original, saved);
        if (
          original.intentId !== saved.intent.intentId ||
          !same(original.requestId, saved.intent.requestId)
        )
          throw new Error(
            "The saved request identity does not match the original intent.",
          );
      }
      if (original?.transactionHash) {
        session.broadcast(lease, original.transactionHash);
      } else {
        const vault = await recoverCreatedVault(publicClient, saved);
        resolve({
          ...saved,
          vaultAddress: vault,
          stage: "created",
          creationHash: undefined,
          submissionPending: false,
        });
        return;
      }
    }
    pending = session.getSnapshot().record?.pending;
    if (!pending?.hash) return;
    let receipt;
    try {
      receipt = await confirmMarketReceipt(publicClient, pending.hash, (hash) =>
        session.repriced(lease, hash),
      );
    } catch (error) {
      if (error instanceof MarketReceiptFinalError) {
        resolve(
          pending.step === "create"
            ? {
                ...saved,
                intent: undefined,
                creationHash: undefined,
                submissionPending: false,
                idempotencyKey: crypto.randomUUID(),
              }
            : saved,
        );
      }
      throw error;
    }
    active.assertCurrent();
    const c = saved.configuration;
    if (pending.step === "create") {
      const vault = await recoverCreatedVault(publicClient, saved);
      resolve({
        ...saved,
        vaultAddress: vault,
        stage: "created",
        creationHash: receipt.transactionHash,
        submissionPending: true,
      });
      return;
    }
    const vault = await recoverCreatedVault(publicClient, saved);
    if (pending.step === "approve") {
      const [approved, owner] = await Promise.all([
        publicClient.readContract({
          abi: erc721VaultApprovalAbi,
          address: c.collectionAddress,
          functionName: "getApproved",
          args: [BigInt(c.tokenId)],
        }),
        publicClient.readContract({
          abi: erc721VaultApprovalAbi,
          address: c.collectionAddress,
          functionName: "ownerOf",
          args: [BigInt(c.tokenId)],
        }),
      ]);
      if (!same(approved, vault) || !same(owner, saved.walletAddress))
        throw new Error(
          "The current exact-token approval and owner do not match this Vault setup.",
        );
      resolve({ ...saved, stage: "approved" });
    } else if (pending.step === "deposit") {
      const [deposited, owner, originalOwner] = await Promise.all([
        publicClient.readContract({
          abi: vaultRecoveryAbi,
          address: vault,
          functionName: "deposited",
        }),
        publicClient.readContract({
          abi: erc721VaultApprovalAbi,
          address: c.collectionAddress,
          functionName: "ownerOf",
          args: [BigInt(c.tokenId)],
        }),
        publicClient.readContract({
          abi: vaultRecoveryAbi,
          address: vault,
          functionName: "originalOwner",
        }),
      ]);
      if (
        !deposited ||
        !same(owner, vault) ||
        !same(originalOwner, saved.depositorAddress ?? saved.walletAddress)
      )
        throw new Error("Vault custody could not be independently confirmed.");
      resolve({
        ...saved,
        stage: "deposited",
        depositorAddress: saved.depositorAddress ?? saved.walletAddress,
      });
    } else if (pending.step === "fractionalize") {
      const event = parseEventLogs({
        abi: artFiVaultAbi,
        eventName: "Fractionalized",
        logs: receipt.logs.filter((log) => same(log.address, vault)),
        strict: true,
      }).find(
        (entry) =>
          same(entry.args.recipient, c.recipient) &&
          entry.args.supply === BigInt(c.tokenSupply),
      );
      const [token, supply] = await Promise.all([
        publicClient.readContract({
          abi: vaultRecoveryAbi,
          address: vault,
          functionName: "fractionalToken",
        }),
        publicClient.readContract({
          abi: vaultRecoveryAbi,
          address: vault,
          functionName: "fractionalSupply",
        }),
      ]);
      if (
        !event ||
        !same(token, event.args.token) ||
        same(token, zeroAddress) ||
        supply !== BigInt(c.tokenSupply)
      )
        throw new Error(
          "The issued fraction token does not match the reviewed receipt and supply.",
        );
      resolve({
        ...saved,
        stage: "complete",
        fractionToken: token,
      });
    } else throw new Error("The saved Vault transaction step is invalid.");
  }

  async function createVault(formData: FormData) {
    if (!canConfigure || !address || !publicClient || !factoryAddress) return;
    const lease = session.begin();
    if (lease === undefined) return;
    const active = beginViewOperation();
    try {
      const configuredSafe = configuredAdminSafe();
      const creationAuthority = configuredSafe
        ? await operatorCallRoute(
            publicClient,
            "vault",
            factoryAddress,
            address,
            configuredSafe,
          )
        : address;
      active.assertCurrent();
      const value = readConfiguration(formData, address, creationAuthority);
      let saved: VaultSetup =
        data &&
        data.stage === "configure" &&
        JSON.stringify(data.configuration) === JSON.stringify(value) &&
        same(data.factoryAddress, factoryAddress)
          ? data
          : {
              chainId,
              walletAddress: address,
              factoryAddress,
              configuration: value,
              idempotencyKey: crypto.randomUUID(),
              stage: "configure",
            };
      if (data?.stage === "complete")
        saveVaultContinuation(sessionStorage, session.getSnapshot().record!);
      session.save(lease, saved);
      setNewVault(false);
      setMessage(
        "Preparing a deterministic Vault intent and checking live ownership and roles.",
      );
      if (!saved.intent) {
        const intent = await fetchJSON<VaultIntent>(
          "/api/operator/v1/vault/intents",
          {
            method: "POST",
            headers: { "Idempotency-Key": saved.idempotencyKey },
            body: JSON.stringify({
              collectionAddress: value.collectionAddress,
              tokenId: value.tokenId,
              vaultName: value.vaultName,
              adminAddress: value.adminAddress,
              pauserAddress: value.pauserAddress,
              fractionalizerAddress: value.fractionalizerAddress,
            }),
          },
        );
        active.assertCurrent();
        assertVaultBinding(intent, saved);
        saved = { ...saved, intent };
        session.save(lease, saved);
      } else {
        const original = await fetchJSON<VaultIntent>(
          `/api/operator/v1/vault/intents/${saved.intent.intentId}`,
        );
        active.assertCurrent();
        assertVaultBinding(original, saved);
        if (
          original.intentId !== saved.intent.intentId ||
          !same(original.requestId, saved.intent.requestId)
        )
          throw new Error("The original Vault request identity changed.");
        saved = { ...saved, intent: original };
        session.save(lease, saved);
        if (!original.transactionHash) {
          const existing = await publicClient.readContract({
            abi: vaultRecoveryAbi,
            address: saved.factoryAddress,
            functionName: "vaultForRequest",
            args: [original.requestId],
          });
          active.assertCurrent();
          if (!same(existing, zeroAddress)) {
            const vault = await recoverCreatedVault(publicClient, saved);
            active.assertCurrent();
            session.save(lease, {
              ...saved,
              vaultAddress: vault,
              stage: "created",
              creationHash: undefined,
              submissionPending: false,
            });
            saveVaultContinuation(
              sessionStorage,
              session.getSnapshot().record!,
            );
            setContinuations(listVaultContinuations(sessionStorage));
            setMessage(
              "The original Vault request is already confirmed. Its exact asset and roles were recovered without another wallet request.",
            );
            return;
          }
        }
      }
      const intent = saved.intent!;
      if (intent.transactionHash) {
        session.awaitWallet(lease, "create");
        session.broadcast(lease, intent.transactionHash);

        await reconcile(lease, active);
        if (active.isCurrent()) await logCreation(lease, active);
        return;
      }
      assertVaultBinding(intent, saved);
      const [role, paused, owner] = await Promise.all([
        publicClient.readContract({
          abi: vaultFactoryAbi,
          address: saved.factoryAddress,
          functionName: "CREATOR_ROLE",
        }),
        publicClient.readContract({
          abi: vaultFactoryAbi,
          address: saved.factoryAddress,
          functionName: "paused",
        }),
        publicClient.readContract({
          abi: erc721VaultApprovalAbi,
          address: value.collectionAddress,
          functionName: "ownerOf",
          args: [BigInt(value.tokenId)],
        }),
      ]);
      active.assertCurrent();
      const safe = configuredAdminSafe();
      const caller = safe
        ? await operatorCallRoute(
            publicClient,
            "vault",
            saved.factoryAddress,
            address,
            safe,
          )
        : address;
      const creator = await publicClient.readContract({
        abi: vaultFactoryAbi,
        address: saved.factoryAddress,
        functionName: "hasRole",
        args: [role, caller],
      });
      assertWritable(active, saved, true);
      if (paused || !creator || !same(owner, address))
        throw new Error(
          "The current wallet must own this NFT and hold CREATOR_ROLE on an unpaused factory.",
        );
      if (safe && same(caller, safe)) {
        setSafePrepared(vaultSafeSubmission(saved));
        setMessage(
          "The exact VaultFactory creation call is ready for multisignature review. NFT approval, custody deposit and fraction issuance remain separate existing steps.",
        );
        return;
      }
      session.awaitWallet(lease, "create");
      setMessage(
        "Confirm one VaultFactory createVault call. No ETH or NFT approval is included.",
      );
      const hash = await writeContractAsync({
        abi: vaultFactoryAbi,
        address: saved.factoryAddress,
        chainId: supportedChain.id,
        functionName: "createVault",
        args: [
          intent.requestId,
          value.vaultName,
          value.collectionAddress,
          BigInt(value.tokenId),
          value.adminAddress,
          value.pauserAddress,
          value.fractionalizerAddress,
        ],
      });
      session.broadcast(lease, hash);
      active.assertCurrent();

      await reconcile(lease, active);
      if (active.isCurrent()) {
        setMessage(
          "Vault created. The next action approves only this token ID, never the collection.",
        );
        await logCreation(lease, active);
      }
    } catch (error) {
      if (isDaoWalletRejection(error)) session.rejected(lease);
      if (active.isCurrent())
        session.fail(lease, new Error(operatorErrorText(error)));
    } finally {
      session.finish(lease);
    }
  }

  async function recoverSafeVault(hash: Hex, submission: SafeSubmission) {
    const saved = session.getSnapshot().record?.data;
    if (!saved?.intent)
      throw new Error(
        "Return to the original Vault preparation to recover this creation.",
      );
    assertSameSafeSubmission(vaultSafeSubmission(saved), submission);
    if (saved.stage !== "configure") return;
    const lease = session.begin();
    if (lease === undefined)
      throw new Error("Finish the existing Vault operation before recovery.");
    const active = beginViewOperation();
    try {
      session.awaitWallet(lease, "create");
      session.broadcast(lease, hash);
      await reconcile(lease, active);
      await logCreation(lease, active);
      setMessage(
        "Vault creation through the safe is confirmed. Continue with exact-token approval and custody.",
      );
    } finally {
      session.finish(lease);
    }
  }

  async function nextStep(step: "approve" | "deposit" | "fractionalize") {
    if (!data || !address || !publicClient || !vaultAddress) return;
    const lease = session.begin();
    if (lease === undefined) return;
    const active = beginViewOperation();
    try {
      assertWritable(active, data);
      const vault = await recoverCreatedVault(publicClient, data);
      const c = data.configuration;
      const owner = await publicClient.readContract({
        abi: erc721VaultApprovalAbi,
        address: c.collectionAddress,
        functionName: "ownerOf",
        args: [BigInt(c.tokenId)],
      });
      active.assertCurrent();
      if (step !== "fractionalize" && !same(owner, address))
        throw new Error(
          "The connected wallet is no longer the current NFT owner.",
        );
      if (step === "deposit") {
        const approved = await publicClient.readContract({
          abi: erc721VaultApprovalAbi,
          address: c.collectionAddress,
          functionName: "getApproved",
          args: [BigInt(c.tokenId)],
        });
        if (!same(approved, vault))
          throw new Error(
            "Approve this exact token to the reviewed Vault first.",
          );
      }
      if (step === "fractionalize") {
        const [token, role] = await Promise.all([
          publicClient.readContract({
            abi: vaultRecoveryAbi,
            address: vault,
            functionName: "fractionalToken",
          }),
          publicClient.readContract({
            abi: vaultRecoveryAbi,
            address: vault,
            functionName: "FRACTIONALIZER_ROLE",
          }),
        ]);
        const allowed = await publicClient.readContract({
          abi: vaultRecoveryAbi,
          address: vault,
          functionName: "hasRole",
          args: [role, address],
        });
        if (!same(owner, vault) || !same(token, zeroAddress) || !allowed)
          throw new Error(
            "The Vault must hold this NFT, have no issued fractions, and authorize the current fractionalizer.",
          );
      }
      if (step === "fractionalize") {
        await requireCurrentUnderlying(
          {
            chainId: supportedChain.id,
            collectionAddress: c.collectionAddress,
            tokenId: c.tokenId,
          },
          active.assertCurrent,
        );
      }
      assertWritable(active, data);
      assertVaultParticipantsReady(sessionStorage, data, address);
      session.awaitWallet(lease, step);
      const hash =
        step === "approve"
          ? await writeContractAsync({
              abi: erc721VaultApprovalAbi,
              address: c.collectionAddress,
              chainId: supportedChain.id,
              functionName: "approve",
              args: [vault, BigInt(c.tokenId)],
            })
          : step === "deposit"
            ? await writeContractAsync({
                abi: artFiVaultAbi,
                address: vault,
                chainId: supportedChain.id,
                functionName: "deposit",
              })
            : await writeContractAsync({
                abi: artFiVaultAbi,
                address: vault,
                chainId: supportedChain.id,
                functionName: "fractionalize",
                args: [
                  c.tokenName,
                  c.tokenSymbol,
                  BigInt(c.tokenSupply),
                  c.recipient,
                ],
              });
      session.broadcast(lease, hash);
      active.assertCurrent();
      await reconcile(lease, active);
      if (active.isCurrent())
        setMessage(
          "This step is confirmed on Hoodi. Review the next separate action.",
        );
    } catch (error) {
      if (isDaoWalletRejection(error)) session.rejected(lease);
      if (active.isCurrent())
        session.fail(lease, new Error(operatorErrorText(error)));
    } finally {
      session.finish(lease);
    }
  }

  async function checkTransaction() {
    const lease = session.begin(true);
    if (lease === undefined) return;
    const active = beginViewOperation();
    try {
      await reconcile(lease, active);
      if (active.isCurrent()) {
        setMessage(
          "The saved transaction and exact on-chain bindings were checked.",
        );
        await logCreation(lease, active);
      }
    } catch (error) {
      if (active.isCurrent())
        session.fail(lease, new Error(operatorErrorText(error)));
    } finally {
      session.finish(lease);
    }
  }
  async function retryLogging() {
    const lease = session.begin(true);
    if (lease === undefined) return;
    const active = beginViewOperation();
    try {
      await logCreation(lease, active);
    } finally {
      session.finish(lease);
    }
  }
  function prepareAnotherVault() {
    try {
      archiveCompletedVault(
        sessionStorage,
        session.getSnapshot().record,
        snapshot.busy,
        snapshot.blocked,
      );
      retireTerms();
      setNewVault(true);
      setOwned([]);
      if (
        !selected ||
        (configuration &&
          selected.collectionAddress.toLowerCase() ===
            configuration.collectionAddress.toLowerCase() &&
          selected.tokenId === configuration.tokenId)
      )
        setSelected(undefined);
      setContinuations(listVaultContinuations(sessionStorage));
      setMessage(
        "Review another NFT. The completed Vault and any outstanding submission log are saved below.",
      );
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function continueConfirmedVault(candidate: VaultContinuation) {
    if (
      !address ||
      !publicClient ||
      chainId !== supportedChain.id ||
      (data &&
        data.stage !== "complete" &&
        !sameVaultAsset(data, candidate.data))
    )
      return;
    const lease = session.begin();
    if (lease === undefined) return;
    const active = beginViewOperation();
    try {
      assertVaultParticipantsReady(sessionStorage, candidate.data, address);
      const reviewed = await reviewVaultContinuation(
        publicClient,
        candidate,
        address,
      );
      active.assertCurrent();
      assertVaultParticipantsReady(sessionStorage, candidate.data, address);
      if (data?.stage === "complete")
        saveVaultContinuation(sessionStorage, session.getSnapshot().record!);
      session.save(lease, reviewed);
      saveVaultContinuation(sessionStorage, session.getSnapshot().record!);
      setSelected({
        collectionAddress: reviewed.configuration.collectionAddress,
        tokenId: reviewed.configuration.tokenId,
      });
      setNewVault(false);
      setContinuations(listVaultContinuations(sessionStorage));
      setMessage(
        reviewed.stage === "complete"
          ? "The saved completed Vault and issued token were independently verified."
          : "Vault custody and this wallet's FRACTIONALIZER_ROLE were independently verified. Review the saved fraction terms before signing.",
      );
    } catch (error) {
      if (active.isCurrent())
        session.fail(lease, new Error(operatorErrorText(error)));
    } finally {
      session.finish(lease);
    }
  }

  async function retryArchivedLogging(candidate: VaultContinuation) {
    if (archiveLogBusy.current || operatorStatus !== "authenticated") return;
    archiveLogBusy.current = true;
    const active = beginViewOperation();
    try {
      const result = await recordConfirmedVaultCreation(
        { id: "archived-vault", data: candidate.data },
        ({ intentId, transactionHash }) =>
          fetchJSON(`/api/operator/v1/vault/intents/${intentId}/submission`, {
            method: "POST",
            body: JSON.stringify({ transactionHash }),
          }),
      );
      active.assertCurrent();
      if (result) {
        markVaultContinuationLogged(sessionStorage, candidate);
        setContinuations(listVaultContinuations(sessionStorage));
        setMessage("The saved Vault submission was recorded.");
      }
    } catch (error) {
      if (active.isCurrent()) setMessage(errorMessage(error));
    } finally {
      archiveLogBusy.current = false;
    }
  }

  const canConfigure =
    isConnected &&
    chainId === supportedChain.id &&
    operatorStatus === "authenticated" &&
    Boolean(factoryAddress) &&
    !snapshot.busy &&
    !snapshot.blocked &&
    !snapshot.record?.pending &&
    (stage === "configure" || (stage === "complete" && newVault));
  const canContinue =
    !snapshot.busy &&
    !snapshot.blocked &&
    !snapshot.record?.pending &&
    isConnected &&
    chainId === supportedChain.id &&
    Boolean(
      factoryAddress && data && same(data.factoryAddress, factoryAddress),
    );

  return (
    <section
      className="dao-create"
      aria-labelledby="dao-create-title"
      data-no-translate
    >
      <div className="section-heading">
        <p className="approved-eyebrow">Existing NFT → custody → fractions</p>
        <h2 id="dao-create-title">
          Create the asset DAO in four controlled steps.
        </h2>
      </div>
      <p>
        Each step requires its own wallet confirmation. No collection-wide
        approval is requested.
      </p>
      {factoryAddress ? (
        <p>Reviewed Hoodi VaultFactory: {factoryAddress}</p>
      ) : null}
      <button
        type="button"
        disabled={
          !address ||
          chainId !== supportedChain.id ||
          selectionBusy ||
          snapshot.busy ||
          !(stage === "configure" || (stage === "complete" && newVault))
        }
        onClick={() => void loadOwned()}
      >
        Find my owned NFTs
      </button>
      {selectionNotice ? <p role="status">{selectionNotice}</p> : null}
      {owned.length ? (
        <label>
          Currently owned NFT
          <select
            value=""
            disabled={!canConfigure}
            onChange={(event) => {
              const candidate = owned[Number(event.target.value)];
              if (candidate) {
                retireTerms();
                setSelected(candidate);
              }
            }}
          >
            <option value="">Select an NFT, or enter it manually</option>
            {owned.map((item, index) => (
              <option
                key={`${item.collectionAddress}:${item.tokenId}`}
                value={index}
              >
                {item.collectionAddress} / #{item.tokenId}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {stage === "complete" && !newVault ? (
        <button
          type="button"
          disabled={
            snapshot.busy ||
            snapshot.blocked ||
            Boolean(snapshot.record?.pending)
          }
          onClick={prepareAnotherVault}
        >
          Prepare another Vault
        </button>
      ) : null}
      <section aria-label="Saved confirmed Vaults">
        <h3>Saved confirmed Vaults</h3>
        <button
          type="button"
          onClick={() => {
            try {
              setContinuations(listVaultContinuations(sessionStorage));
            } catch (error) {
              setMessage(errorMessage(error));
            }
          }}
        >
          Refresh saved Vaults
        </button>
        {continuations.map((candidate) => (
          <article
            key={`${candidate.data.factoryAddress}:${candidate.data.vaultAddress}`}
          >
            <p>
              {candidate.data.configuration.vaultName}:{" "}
              {candidate.data.configuration.collectionAddress} / #
              {candidate.data.configuration.tokenId}
            </p>
            <a
              className="text-link"
              href={`https://hoodi.etherscan.io/address/${candidate.data.vaultAddress}`}
              target="_blank"
              rel="noreferrer"
            >
              View saved Vault ↗
            </a>
            <p>
              {candidate.data.configuration.tokenName} (
              {candidate.data.configuration.tokenSymbol}),{" "}
              {(
                BigInt(candidate.data.configuration.tokenSupply) /
                10n ** 18n
              ).toString()}{" "}
              whole tokens to {candidate.data.configuration.recipient}.
              Fractionalizer:{" "}
              {candidate.data.configuration.fractionalizerAddress}.
            </p>
            {["deposited", "complete"].includes(candidate.data.stage) ? (
              <button
                type="button"
                disabled={
                  !address ||
                  chainId !== supportedChain.id ||
                  snapshot.busy ||
                  snapshot.blocked ||
                  Boolean(snapshot.record?.pending) ||
                  Boolean(
                    data &&
                    data.stage !== "complete" &&
                    !sameVaultAsset(data, candidate.data),
                  )
                }
                onClick={() => void continueConfirmedVault(candidate)}
              >
                {candidate.data.stage === "complete"
                  ? "Review completed Vault"
                  : "Review and continue Vault"}
              </button>
            ) : null}
            {candidate.data.submissionPending && candidate.data.creationHash ? (
              <button
                type="button"
                disabled={operatorStatus !== "authenticated"}
                onClick={() => void retryArchivedLogging(candidate)}
              >
                Retry saved Vault submission
              </button>
            ) : null}
            {candidate.data.fractionToken ? (
              <a
                className="text-link"
                href={`https://hoodi.etherscan.io/token/${candidate.data.fractionToken}?a=${candidate.data.configuration.recipient}`}
                target="_blank"
                rel="noreferrer"
              >
                View saved issued token ↗
              </a>
            ) : null}
          </article>
        ))}
      </section>
      <div className="create-layout">
        <form
          key={`${snapshot.record?.id ?? "new"}:${newVault}`}
          className="rwa-form"
          onChange={retireTerms}
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
                  value={
                    selected?.collectionAddress ??
                    formConfiguration?.collectionAddress ??
                    ""
                  }
                  onChange={(event) =>
                    setSelected({
                      collectionAddress: event.target.value,
                      tokenId:
                        selected?.tokenId ?? formConfiguration?.tokenId ?? "",
                    })
                  }
                  pattern="0x[0-9a-fA-F]{40}"
                  required
                />
              </label>
              <label>
                Token ID
                <input
                  name="tokenId"
                  value={selected?.tokenId ?? formConfiguration?.tokenId ?? ""}
                  onChange={(event) =>
                    setSelected({
                      collectionAddress:
                        selected?.collectionAddress ??
                        formConfiguration?.collectionAddress ??
                        "",
                      tokenId: event.target.value,
                    })
                  }
                  inputMode="numeric"
                  pattern="0|[1-9][0-9]*"
                  required
                />
              </label>
              <label>
                Vault / DAO name
                <input
                  name="vaultName"
                  defaultValue={formConfiguration?.vaultName}
                  minLength={2}
                  maxLength={80}
                  required
                />
              </label>
              <label>
                Fraction token name
                <input
                  name="tokenName"
                  defaultValue={formConfiguration?.tokenName}
                  minLength={2}
                  maxLength={80}
                  required
                />
              </label>
              <label>
                Symbol
                <input
                  name="tokenSymbol"
                  defaultValue={formConfiguration?.tokenSymbol}
                  minLength={2}
                  maxLength={12}
                  required
                />
              </label>
              <label>
                Whole-token supply
                <input
                  name="tokenSupply"
                  defaultValue={
                    formConfiguration
                      ? (
                          BigInt(formConfiguration.tokenSupply) /
                          10n ** 18n
                        ).toString()
                      : undefined
                  }
                  type="number"
                  min="1"
                  max="1000000000000"
                  required
                />
              </label>
              <label>
                Recipient (blank = connected wallet)
                <input
                  name="recipient"
                  defaultValue={formConfiguration?.recipient}
                  pattern="0x[0-9a-fA-F]{40}"
                />
              </label>
              {(
                [
                  "adminAddress",
                  "pauserAddress",
                  "fractionalizerAddress",
                ] as const
              ).map((name) => (
                <label key={name}>
                  {name === "fractionalizerAddress"
                    ? "fractionalizer role (blank = wallet)"
                    : `${name.replace("Address", "")} role (blank = role-holding safe, otherwise wallet)`}
                  <input
                    name={name}
                    defaultValue={formConfiguration?.[name]}
                    pattern="0x[0-9a-fA-F]{40}"
                  />
                </label>
              ))}
            </div>
          </fieldset>
          {isConnected && chainId === supportedChain.id ? (
            <button
              className="secondary"
              type="button"
              disabled={operatorStatus !== "unauthenticated" || snapshot.busy}
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
          <h3>
            {snapshot.busy
              ? "Checking the current setup operation"
              : stageLabel(stage)}
          </h3>
          <p>{message}</p>
          {configuration ? (
            <p>
              Reviewed creation roles: admin {configuration.adminAddress};
              pauser {configuration.pauserAddress}; fractionalizer{" "}
              {configuration.fractionalizerAddress}. Recipient:{" "}
              {configuration.recipient}.
            </p>
          ) : null}
          {snapshot.error ? <p role="alert">{snapshot.error}</p> : null}
          {snapshot.record?.pending ? (
            <>
              <p>
                {snapshot.record.pending.hash
                  ? "A transaction is awaiting confirmation. Check it before another write."
                  : "The wallet request is unresolved. Leaving or reloading does not cancel it."}
              </p>
              <button
                type="button"
                disabled={snapshot.busy}
                onClick={() => void checkTransaction()}
              >
                Check transaction
              </button>
            </>
          ) : null}
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
          {configuration && vaultAddress ? (
            <p>
              Reviewed NFT: {configuration.collectionAddress} / #
              {configuration.tokenId}. Fractions: {configuration.tokenName} (
              {configuration.tokenSymbol}),{" "}
              {(BigInt(configuration.tokenSupply) / 10n ** 18n).toString()}{" "}
              whole tokens to {configuration.recipient}.
            </p>
          ) : null}
          {snapshot.record?.pending?.hash || data?.creationHash ? (
            <a
              className="text-link"
              href={`https://hoodi.etherscan.io/tx/${snapshot.record?.pending?.hash ?? data?.creationHash}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction ↗
            </a>
          ) : null}
          {vaultCreationSubmission(snapshot.record) ? (
            <button
              type="button"
              disabled={snapshot.busy || operatorStatus !== "authenticated"}
              onClick={() => void retryLogging()}
            >
              Retry submission logging
            </button>
          ) : null}
          {stage === "created" ? (
            <button
              type="button"
              disabled={!canContinue}
              onClick={() => void nextStep("approve")}
            >
              Step 2 · Approve this token only
            </button>
          ) : null}
          {stage === "approved" ? (
            <button
              type="button"
              disabled={!canContinue}
              onClick={() => void nextStep("deposit")}
            >
              Step 3 · Deposit into Vault
            </button>
          ) : null}
          {stage === "deposited" ? (
            <button
              type="button"
              disabled={!canContinue}
              onClick={() => void nextStep("fractionalize")}
            >
              Step 4 · Issue fixed fractions
            </button>
          ) : null}
          {fractionToken && configuration ? (
            <>
              <p>Fraction token: {fractionToken}</p>
              <a
                className="text-link"
                href={`https://hoodi.etherscan.io/token/${fractionToken}?a=${configuration.recipient}`}
                target="_blank"
                rel="noreferrer"
              >
                View this issued token and recipient holdings ↗
              </a>
              <a className="text-link" href="/portfolio">
                Continue to connected wallet portfolio →
              </a>
            </>
          ) : null}
        </aside>
      </div>
      <AdminSafeConsole
        kind="vault"
        target={factoryAddress}
        prepared={safePrepared}
        authenticated={operatorStatus === "authenticated"}
        onExecuted={recoverSafeVault}
      />
    </section>
  );
}

function readConfiguration(
  form: FormData,
  address: Address,
  executionAuthority: Address = address,
): VaultConfiguration {
  const defaults = vaultRoleDefaults(address, executionAuthority);
  const requiredAddress = (name: string, fallback?: Address) => {
    const candidate = String(form.get(name) || fallback || "").trim();
    if (!isAddress(candidate) || same(candidate, zeroAddress))
      throw new Error(`${name} must be a nonzero Ethereum address.`);
    return candidate;
  };
  const tokenId = String(form.get("tokenId") || "");
  if (!/^(0|[1-9][0-9]{0,77})$/.test(tokenId) || BigInt(tokenId) >= 2n ** 256n)
    throw new Error("Token ID must be a canonical uint256 value.");
  const text = (name: string, max: number) => {
    const value = String(form.get(name) || "").trim();
    if (value.length < 2 || value.length > max)
      throw new Error(`${name} must contain 2 to ${max} characters.`);
    return value;
  };
  const rawSupply = String(form.get("tokenSupply") || "");
  if (
    !/^[1-9][0-9]{0,12}$/.test(rawSupply) ||
    BigInt(rawSupply) > 1_000_000_000_000n
  )
    throw new Error(
      "Supply must be a positive whole-token amount, at most 1,000,000,000,000.",
    );
  return {
    collectionAddress: requiredAddress("collectionAddress"),
    tokenId,
    vaultName: text("vaultName", 80),
    adminAddress: requiredAddress("adminAddress", defaults.adminAddress),
    pauserAddress: requiredAddress("pauserAddress", defaults.pauserAddress),
    fractionalizerAddress: requiredAddress(
      "fractionalizerAddress",
      defaults.fractionalizerAddress,
    ),
    tokenName: text("tokenName", 80),
    tokenSymbol: text("tokenSymbol", 12),
    tokenSupply: parseUnits(rawSupply, 18).toString(),
    recipient: requiredAddress("recipient", defaults.recipient),
  };
}
function stageLabel(stage: VaultStage) {
  return {
    configure: "Review configuration",
    created: "Vault created",
    approved: "Exact token approved",
    deposited: "Vault custody confirmed",
    complete: "DAO asset setup confirmed",
  }[stage];
}
function errorMessage(error: unknown) {
  return operatorErrorText(error, "The Vault setup could not be completed.");
}
async function fetchJSON<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    let detail = `Request failed with status ${response.status}.`;
    try {
      detail =
        ((await response.json()) as { detail?: string }).detail || detail;
    } catch {
      /* Keep status-only failure. */
    }
    throw Object.assign(new Error(detail), { status: response.status });
  }
  return (await response.json()) as T;
}

function vaultSafeSubmission(saved: VaultSetup) {
  if (!saved.intent) throw new Error("The reviewed Vault intent is missing.");
  const value = saved.configuration;
  return encodeOperatorSafeSubmission({
    requestId: saved.intent.requestId,
    target: saved.factoryAddress,
    abi: vaultFactoryAbi,
    functionName: "createVault",
    args: [
      saved.intent.requestId,
      value.vaultName,
      value.collectionAddress,
      BigInt(value.tokenId),
      value.adminAddress,
      value.pauserAddress,
      value.fractionalizerAddress,
    ],
  });
}
