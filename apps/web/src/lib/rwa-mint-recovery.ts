import {
  encodeAbiParameters,
  isAddress,
  keccak256,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import {
  type RWASourceEvidence,
  type RWAContractEvidence,
  type RWAMetadataPreparation,
} from "./rwa-source-evidence";
import { rwaRegistryAbi } from "./contracts";

export type MintDraft = {
  name: string;
  artist: string;
  year: number;
  medium: string;
  location: string;
  description: string;
};
export type MintIntent = {
  sourceEvidence?: RWASourceEvidence;
  contractEvidence?: RWAContractEvidence;
  intentId: string;
  requestId: Hash;
  recipient: Address;
  registryAddress: Address;
  chainId: number;
  metadataUri: string;
  metadataSha256: Hash;
  status: string;
  transactionHash?: Hash;
};
export type MintedAsset = {
  chainId: number;
  collectionAddress: Address;
  tokenId: string;
};
export type MintRecovery = {
  wallet: Address;
  /** Actual on-chain caller, separately bound from the mint recipient. */
  executionAuthority?: Address;
  chainId: number;
  draft: MintDraft;
  digest: string;
  idempotencyKey: string;
  uploadId?: string;
  intent?: MintIntent;
  metadataPreparation?: RWAMetadataPreparation;
  hash?: Hash;
  lastFailedHash?: Hash;
  loggedHash?: Hash;
  minted?: MintedAsset;
};
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const identifier = /^[a-zA-Z0-9-]{1,128}$/;
const nonzeroAddress = (value: unknown): value is Address =>
  typeof value === "string" &&
  isAddress(value, { strict: false }) &&
  !/^0x0{40}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

export function isMintIntent(value: unknown): value is MintIntent {
  if (!record(value)) return false;
  return (
    typeof value.intentId === "string" &&
    identifier.test(value.intentId) &&
    typeof value.requestId === "string" &&
    hashPattern.test(value.requestId) &&
    nonzeroAddress(value.recipient) &&
    nonzeroAddress(value.registryAddress) &&
    value.chainId === 560048 &&
    typeof value.metadataUri === "string" &&
    /^(ipfs|https):\/\//.test(value.metadataUri) &&
    value.metadataUri.length <= 512 &&
    typeof value.metadataSha256 === "string" &&
    hashPattern.test(value.metadataSha256) &&
    typeof value.status === "string" &&
    (value.transactionHash === undefined ||
      (typeof value.transactionHash === "string" &&
        hashPattern.test(value.transactionHash)))
  );
}

export function isMintRecovery(value: unknown): value is MintRecovery {
  if (!record(value) || !record(value.draft)) return false;
  const draft = value.draft;
  return (
    nonzeroAddress(value.wallet) &&
    (value.executionAuthority === undefined ||
      nonzeroAddress(value.executionAuthority)) &&
    value.chainId === 560048 &&
    ["name", "artist", "medium", "location", "description"].every(
      (key) =>
        typeof draft[key] === "string" && (draft[key] as string).length <= 2000,
    ) &&
    Number.isInteger(draft.year) &&
    typeof value.digest === "string" &&
    /^[a-f0-9]{64}$/.test(value.digest) &&
    typeof value.idempotencyKey === "string" &&
    identifier.test(value.idempotencyKey) &&
    (value.uploadId === undefined ||
      (typeof value.uploadId === "string" &&
        identifier.test(value.uploadId))) &&
    (value.intent === undefined ||
      (isMintIntent(value.intent) &&
        value.intent.recipient.toLowerCase() === value.wallet.toLowerCase() &&
        value.intent.chainId === value.chainId)) &&
    (value.loggedHash === undefined ||
      (typeof value.loggedHash === "string" &&
        hashPattern.test(value.loggedHash) &&
        value.loggedHash === value.hash)) &&
    (value.lastFailedHash === undefined ||
      (typeof value.lastFailedHash === "string" &&
        hashPattern.test(value.lastFailedHash))) &&
    (value.hash === undefined ||
      (typeof value.hash === "string" && hashPattern.test(value.hash))) &&
    (value.minted === undefined ||
      (record(value.minted) &&
        value.minted.chainId === value.chainId &&
        nonzeroAddress(value.minted.collectionAddress) &&
        typeof value.minted.tokenId === "string" &&
        /^[1-9][0-9]{0,77}$/.test(value.minted.tokenId)))
  );
}

export function assertMintIntent(
  intent: unknown,
  wallet: Address,
  deployment: { chainId: number; registryAddress: Address },
  previous?: MintIntent,
): asserts intent is MintIntent {
  if (
    !isMintIntent(intent) ||
    deployment.chainId !== 560048 ||
    !nonzeroAddress(deployment.registryAddress) ||
    intent.recipient.toLowerCase() !== wallet.toLowerCase() ||
    intent.registryAddress.toLowerCase() !==
      deployment.registryAddress.toLowerCase()
  ) {
    throw new Error(
      "The mint intent does not match the reviewed wallet, chain or registry.",
    );
  }
  if (
    previous &&
    (intent.intentId !== previous.intentId ||
      intent.requestId.toLowerCase() !== previous.requestId.toLowerCase() ||
      intent.metadataUri !== previous.metadataUri ||
      intent.metadataSha256.toLowerCase() !==
        previous.metadataSha256.toLowerCase() ||
      intent.registryAddress.toLowerCase() !==
        previous.registryAddress.toLowerCase())
  ) {
    throw new Error(
      "The saved mint commitment changed. No new wallet request was made.",
    );
  }
}

export const rwaMintRecoveryAbi = [
  ...rwaRegistryAbi,
  {
    type: "function",
    name: "assetByRequest",
    stateMutability: "view",
    inputs: [{ name: "requestId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "creator", type: "address" },
          { name: "recipient", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "metadataHash", type: "bytes32" },
          { name: "intentHash", type: "bytes32" },
          { name: "createdAt", type: "uint64" },
          { name: "metadataURI", type: "string" },
        ],
      },
    ],
  },
] as const;

/** An exact registry request is also recoverable after an idempotent replay emits no event. */
export async function recoverMintedAsset(
  client: Pick<PublicClient, "readContract">,
  intent: MintIntent,
  wallet: Address,
  assertCurrent: () => void,
  blockNumber?: bigint,
  executionAuthority: Address = wallet,
): Promise<MintedAsset> {
  assertCurrent();
  const asset = await client.readContract({
    abi: rwaMintRecoveryAbi,
    address: intent.registryAddress,
    functionName: "assetByRequest",
    args: [intent.requestId],
    blockNumber,
  });
  assertCurrent();
  const expectedHash = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "string" }, { type: "bytes32" }],
      [intent.recipient, intent.metadataUri, intent.metadataSha256],
    ),
  );
  if (
    asset.tokenId <= 0n ||
    asset.creator.toLowerCase() !== executionAuthority.toLowerCase() ||
    asset.recipient.toLowerCase() !== intent.recipient.toLowerCase() ||
    asset.metadataHash.toLowerCase() !== intent.metadataSha256.toLowerCase() ||
    asset.metadataURI !== intent.metadataUri ||
    asset.intentHash.toLowerCase() !== expectedHash.toLowerCase()
  ) {
    throw new Error(
      "The on-chain mint does not match the saved request and metadata commitment.",
    );
  }
  const collectionAddress = await client.readContract({
    abi: rwaMintRecoveryAbi,
    address: intent.registryAddress,
    functionName: "nft",
    blockNumber,
  });
  assertCurrent();
  if (!nonzeroAddress(collectionAddress))
    throw new Error("The mint registry returned an invalid NFT collection.");
  return {
    chainId: intent.chainId,
    collectionAddress,
    tokenId: asset.tokenId.toString(),
  };
}

export function mintedDaoHref(asset: MintedAsset) {
  return `/dao?${new URLSearchParams({ chainId: String(asset.chainId), collectionAddress: asset.collectionAddress, tokenId: asset.tokenId })}`;
}

export async function prepareMint({
  previous,
  draft,
  file,
  wallet,
  chainId,
  assertCurrent,
  save,
  stage,
  upload,
  prepare,
}: {
  previous?: MintRecovery;
  draft: MintDraft;
  file?: File;
  wallet: Address;
  chainId: number;
  assertCurrent: () => void;
  save: (data: MintRecovery) => void;
  stage: (stage: "hashing" | "uploading" | "preparing") => void;
  upload: (file: File, digest: string) => Promise<string>;
  prepare: (data: MintRecovery) => Promise<MintIntent>;
}): Promise<MintRecovery> {
  assertCurrent();
  let digest = previous?.digest;
  if (file && file.size > 0) {
    stage("hashing");
    const bytes = await file.arrayBuffer();
    assertCurrent();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    assertCurrent();
    digest = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  if (!digest || (!file && !previous?.uploadId))
    throw new Error(
      "Reselect the original image so its SHA-256 digest can be checked before upload.",
    );
  if (
    previous &&
    !previous.uploadId &&
    JSON.stringify(previous.draft) === JSON.stringify(draft) &&
    digest !== previous.digest
  )
    throw new Error(
      "The reselected image does not match the saved digest. Restore the original image before retrying this preparation.",
    );
  const same =
    previous &&
    !previous.minted &&
    previous.wallet.toLowerCase() === wallet.toLowerCase() &&
    previous.chainId === chainId &&
    previous.digest === digest &&
    JSON.stringify(previous.draft) === JSON.stringify(draft);
  let data: MintRecovery = same
    ? previous
    : {
        wallet,
        chainId,
        draft,
        digest,
        idempotencyKey: crypto.randomUUID(),
        uploadId: previous?.digest === digest ? previous.uploadId : undefined,
      };
  save(data);
  if (!data.uploadId) {
    if (!file)
      throw new Error(
        "Reselect the original image before retrying its upload.",
      );
    stage("uploading");
    const uploadId = await upload(file, digest);
    assertCurrent();
    data = { ...data, uploadId };
    save(data);
  }
  if (!data.intent) {
    stage("preparing");
    const intent = await prepare(data);
    assertCurrent();
    data = { ...data, intent };
    save(data);
  }
  return data;
}
