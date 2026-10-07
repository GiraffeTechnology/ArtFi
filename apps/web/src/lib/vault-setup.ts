import {
  encodeAbiParameters,
  isAddress,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { vaultFactoryAbi } from "./contracts";
import type { SetupRecord } from "./setup-recovery";

export const vaultRecoveryAbi = parseAbi([
  "function vaultForRequest(bytes32) view returns (address)",
  "function vaultByAsset(bytes32) view returns (address)",
  "function collection() view returns (address)",
  "function tokenId() view returns (uint256)",
  "function tokenAdmin() view returns (address)",
  "function vaultName() view returns (string)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function PAUSER_ROLE() view returns (bytes32)",
  "function FRACTIONALIZER_ROLE() view returns (bytes32)",
  "function deposited() view returns (bool)",
  "function originalOwner() view returns (address)",
  "function fractionalToken() view returns (address)",
  "function fractionalSupply() view returns (uint256)",
]);
export type VaultConfiguration = {
  collectionAddress: Address;
  tokenId: string;
  vaultName: string;
  adminAddress: Address;
  pauserAddress: Address;
  fractionalizerAddress: Address;
  tokenName: string;
  tokenSymbol: string;
  tokenSupply: string;
  recipient: Address;
};
export type VaultIntent = {
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
  transactionHash?: Hex;
};
export type VaultStage =
  "configure" | "created" | "approved" | "deposited" | "complete";
export type VaultSetup = {
  chainId: number;
  walletAddress: Address;
  depositorAddress?: Address;
  factoryAddress: Address;
  idempotencyKey: string;
  configuration: VaultConfiguration;
  intent?: VaultIntent;
  stage: VaultStage;
  vaultAddress?: Address;
  fractionToken?: Address;
  creationHash?: Hex;
  submissionPending?: boolean;
};
/** A pending broadcast is never eligible for the API's immutable single-hash binding. */
export function vaultCreationSubmission(
  record: SetupRecord<VaultSetup> | undefined,
) {
  const data = record?.data;
  if (
    !data ||
    !isVaultSetup(data) ||
    data.stage === "configure" ||
    !data.vaultAddress ||
    !data.intent ||
    !data.creationHash ||
    !data.submissionPending ||
    record?.pending?.step === "create"
  )
    return;
  return { intentId: data.intent.intentId, transactionHash: data.creationHash };
}

/** Shared by the real HTTP entry point and its UI, including restored older pending records. */
export async function recordConfirmedVaultCreation(
  record: SetupRecord<VaultSetup> | undefined,
  submit: (submission: {
    intentId: string;
    transactionHash: Hex;
  }) => Promise<unknown>,
) {
  const submission = vaultCreationSubmission(record);
  if (!submission) return;
  await submit(submission);
  return submission;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (v: unknown): v is Hex =>
  typeof v === "string" && /^0x[\da-fA-F]{64}$/.test(v);
const addr = (v: unknown): v is Address =>
  typeof v === "string" && isAddress(v) && !same(v, zeroAddress);
const uint = (v: unknown): v is string =>
  typeof v === "string" &&
  /^(0|[1-9][0-9]{0,77})$/.test(v) &&
  BigInt(v) < 2n ** 256n;

export function assertVaultBinding(
  intent: VaultIntent,
  data: Pick<VaultSetup, "chainId" | "factoryAddress" | "configuration">,
) {
  const c = data.configuration;
  if (
    !intent ||
    intent.chainId !== data.chainId ||
    !addr(intent.factoryAddress) ||
    !same(intent.factoryAddress, data.factoryAddress) ||
    !hash(intent.requestId) ||
    typeof intent.intentId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(intent.intentId) ||
    !addr(intent.collectionAddress) ||
    !same(intent.collectionAddress, c.collectionAddress) ||
    intent.tokenId !== c.tokenId ||
    intent.vaultName !== c.vaultName ||
    !addr(intent.adminAddress) ||
    !same(intent.adminAddress, c.adminAddress) ||
    !addr(intent.pauserAddress) ||
    !same(intent.pauserAddress, c.pauserAddress) ||
    !addr(intent.fractionalizerAddress) ||
    !same(intent.fractionalizerAddress, c.fractionalizerAddress) ||
    (intent.transactionHash !== undefined && !hash(intent.transactionHash))
  ) {
    throw new Error(
      "The Vault intent does not match every reviewed factory, asset, name and role binding.",
    );
  }
}
export function isVaultSetup(value: unknown): value is VaultSetup {
  if (!value || typeof value !== "object") return false;
  const d = value as VaultSetup;
  const c = d.configuration;
  if (
    d.chainId !== 560048 ||
    !addr(d.walletAddress) ||
    (d.depositorAddress !== undefined && !addr(d.depositorAddress)) ||
    !addr(d.factoryAddress) ||
    !c ||
    !addr(c.collectionAddress) ||
    !addr(c.adminAddress) ||
    !addr(c.pauserAddress) ||
    !addr(c.fractionalizerAddress) ||
    !addr(c.recipient) ||
    !uint(c.tokenId) ||
    !uint(c.tokenSupply) ||
    BigInt(c.tokenSupply) < 10n ** 18n ||
    BigInt(c.tokenSupply) > 10n ** 30n ||
    !boundedText(c.vaultName, 80) ||
    !boundedText(c.tokenName, 80) ||
    !boundedText(c.tokenSymbol, 12) ||
    typeof d.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9-]{16,128}$/.test(d.idempotencyKey) ||
    !["configure", "created", "approved", "deposited", "complete"].includes(
      d.stage,
    ) ||
    (d.vaultAddress !== undefined && !addr(d.vaultAddress)) ||
    (d.fractionToken !== undefined && !addr(d.fractionToken)) ||
    (d.creationHash !== undefined && !hash(d.creationHash)) ||
    (d.submissionPending !== undefined &&
      typeof d.submissionPending !== "boolean")
  )
    return false;
  if (d.stage !== "configure" && (!d.intent || !d.vaultAddress)) return false;
  if (d.stage === "complete" && !d.fractionToken) return false;
  try {
    if (d.intent) assertVaultBinding(d.intent, d);
  } catch {
    return false;
  }
  return true;
}
function boundedText(v: unknown, max: number) {
  return typeof v === "string" && v.length >= 2 && v.length <= max;
}

/** Factory request and asset getters independently bind replay receipts without new events. */
export async function recoverCreatedVault(
  client: Pick<PublicClient, "readContract">,
  data: VaultSetup,
) {
  const intent = data.intent;
  if (!intent) throw new Error("The original Vault intent is missing.");
  assertVaultBinding(intent, data);
  const c = data.configuration;
  const vault = await client.readContract({
    abi: vaultRecoveryAbi,
    address: data.factoryAddress,
    functionName: "vaultForRequest",
    args: [intent.requestId],
  });
  if (!addr(vault))
    throw new Error("No Vault is confirmed for this exact request yet.");
  if (data.vaultAddress && !same(vault, data.vaultAddress))
    throw new Error("The saved Vault differs from the factory request.");
  const assetKey = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [c.collectionAddress, BigInt(c.tokenId)],
    ),
  );
  const [
    assetVault,
    collection,
    tokenId,
    admin,
    name,
    pauserRole,
    fractionalizerRole,
  ] = await Promise.all([
    client.readContract({
      abi: vaultRecoveryAbi,
      address: data.factoryAddress,
      functionName: "vaultByAsset",
      args: [assetKey],
    }),
    client.readContract({
      abi: vaultRecoveryAbi,
      address: vault,
      functionName: "collection",
    }),
    client.readContract({
      abi: vaultRecoveryAbi,
      address: vault,
      functionName: "tokenId",
    }),
    client.readContract({
      abi: vaultRecoveryAbi,
      address: vault,
      functionName: "tokenAdmin",
    }),
    client.readContract({
      abi: vaultRecoveryAbi,
      address: vault,
      functionName: "vaultName",
    }),
    client.readContract({
      abi: vaultRecoveryAbi,
      address: vault,
      functionName: "PAUSER_ROLE",
    }),
    client.readContract({
      abi: vaultRecoveryAbi,
      address: vault,
      functionName: "FRACTIONALIZER_ROLE",
    }),
  ]);
  const [isAdmin, isPauser, isFractionalizer] = await Promise.all([
    client.readContract({
      abi: vaultFactoryAbi,
      address: vault,
      functionName: "hasRole",
      args: [`0x${"0".repeat(64)}`, c.adminAddress],
    }),
    client.readContract({
      abi: vaultFactoryAbi,
      address: vault,
      functionName: "hasRole",
      args: [pauserRole, c.pauserAddress],
    }),
    client.readContract({
      abi: vaultFactoryAbi,
      address: vault,
      functionName: "hasRole",
      args: [fractionalizerRole, c.fractionalizerAddress],
    }),
  ]);
  if (
    !same(assetVault, vault) ||
    !same(collection, c.collectionAddress) ||
    tokenId !== BigInt(c.tokenId) ||
    !same(admin, c.adminAddress) ||
    name !== c.vaultName ||
    !isAdmin ||
    !isPauser ||
    !isFractionalizer
  )
    throw new Error(
      "The recovered Vault does not match the reviewed asset, name and roles.",
    );
  return vault;
}

/** Connecting can retain the last address and chain; its view must still be retired. */
export function vaultConnectionKey(
  address: Address | undefined,
  chainId: number,
  isConnected: boolean,
) {
  return `${isConnected}:${chainId}:${address?.toLowerCase() ?? "disconnected"}`;
}

/** Public deployment discovery must not depend on an operator cookie being present. */
export async function loadVaultAccess(
  readSession: () => Promise<{ authenticated?: boolean; address?: string }>,
  readConfig: () => Promise<{ chainId: number; vaultFactoryAddress?: string }>,
) {
  const [authentication, deployment] = await Promise.allSettled([
    readSession(),
    readConfig(),
  ]);
  if (deployment.status === "rejected") throw deployment.reason;
  const session =
    authentication.status === "fulfilled"
      ? authentication.value
      : { authenticated: false };
  const reason =
    authentication.status === "rejected" ? authentication.reason : undefined;
  const sessionError =
    reason && (typeof reason !== "object" || reason.status !== 401)
      ? reason instanceof Error
        ? reason.message
        : "The operator session could not be checked."
      : undefined;
  return { session, config: deployment.value, sessionError };
}
