import { encodeAbiParameters, sha256, stringToHex, type Hex } from "viem";

export type RWASourceEvidence = {
  sourceId: string;
  sourceAssetId: string;
  evidenceId: Hex;
  underlyingAssetId: string;
  section: "whole" | "fractional";
  mode: "LIVE" | "TEST_ONLY";
  sourceReference: string;
  evidenceSha256: Hex;
  rights: string;
  registryRecord?: { reference: string; version: string; observedAt: number };
  validFrom: number;
  validUntil: number;
  contextHash: Hex;
  signatureR: Hex;
  signatureS: Hex;
};
export type RWAContractEvidence = {
  sourceIdHash: Hex;
  sourceAssetHash: Hex;
  assetKey: Hex;
  evidenceId: Hex;
  claimHash: Hex;
  validFrom: number;
  validUntil: number;
  modeHash: Hex;
  sectionHash: Hex;
};
export type RWAMetadataPreparation = {
  requestId: Hex;
  recipient: string;
  registryAddress: string;
  chainId: number;
  metadataUri: string;
  metadataSha256: Hex;
  contextHash: Hex;
  executable: false;
  status: "awaiting-approved-source-evidence";
};
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const hashText = (value: string) => sha256(stringToHex(value));
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown): value is Hex =>
  typeof value === "string" &&
  hashPattern.test(value) &&
  !/^0x0{64}$/i.test(value);
export function isRWASourceEvidence(
  value: unknown,
): value is RWASourceEvidence {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "sourceId",
          "sourceAssetId",
          "evidenceId",
          "underlyingAssetId",
          "section",
          "mode",
          "sourceReference",
          "evidenceSha256",
          "rights",
          "registryRecord",
          "validFrom",
          "validUntil",
          "contextHash",
          "signatureR",
          "signatureS",
        ].includes(key),
    )
  )
    return false;
  return (
    typeof value.sourceId === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.sourceId) &&
    ["sourceAssetId", "underlyingAssetId", "rights", "sourceReference"].every(
      (key) =>
        typeof value[key] === "string" &&
        value[key].length > 0 &&
        value[key].length <= 4000,
    ) &&
    [
      "evidenceId",
      "evidenceSha256",
      "contextHash",
      "signatureR",
      "signatureS",
    ].every((key) => hash(value[key])) &&
    ["whole", "fractional"].includes(value.section as string) &&
    ["LIVE", "TEST_ONLY"].includes(value.mode as string) &&
    Number.isSafeInteger(value.validFrom) &&
    Number.isSafeInteger(value.validUntil) &&
    (value.validFrom as number) > 0 &&
    (value.validUntil as number) > (value.validFrom as number) &&
    (value.registryRecord === undefined ||
      (object(value.registryRecord) &&
        Object.keys(value.registryRecord).every((key) =>
          ["reference", "version", "observedAt"].includes(key),
        ) &&
        typeof value.registryRecord.reference === "string" &&
        typeof value.registryRecord.version === "string" &&
        Number.isSafeInteger(value.registryRecord.observedAt)))
  );
}
// Match the strict Go canonical claim encoding, including HTML and separator
// escaping. The source signs this digest, not arbitrary JSON property order.
const canonicalJSON = (value: unknown) =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
export function sourceContractEvidence(
  e: RWASourceEvidence,
): RWAContractEvidence {
  const claim = {
    sourceReference: e.sourceReference,
    evidenceSha256: e.evidenceSha256.toLowerCase(),
    rights: e.rights,
    section: e.section,
    ...(e.registryRecord
      ? {
          registryRecord: {
            reference: e.registryRecord.reference,
            version: e.registryRecord.version,
            observedAt: e.registryRecord.observedAt,
          },
        }
      : {}),
  };
  return {
    sourceIdHash: hashText(e.sourceId),
    sourceAssetHash: hashText(e.sourceAssetId),
    assetKey: hashText(e.underlyingAssetId),
    evidenceId: e.evidenceId.toLowerCase() as Hex,
    claimHash: hashText(canonicalJSON(claim)),
    validFrom: e.validFrom,
    validUntil: e.validUntil,
    modeHash: hashText(e.mode),
    sectionHash: hashText(e.section),
  };
}
export function sourceEvidencePreimage(e: RWASourceEvidence): Hex {
  const c = sourceContractEvidence(e);
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      hashText("ArtFi approved-source evidence v1"),
      c.sourceIdHash,
      c.sourceAssetHash,
      c.assetKey,
      c.evidenceId,
      c.claimHash,
      e.contextHash,
      BigInt(c.validFrom),
      BigInt(c.validUntil),
      c.modeHash,
      c.sectionHash,
    ],
  );
}
export function mintSourceContext(intent: {
  chainId: number;
  registryAddress: string;
  requestId: Hex;
  recipient: string;
  metadataSha256: Hex;
  metadataUri: string;
}): Hex {
  return sha256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        BigInt(intent.chainId),
        intent.registryAddress as `0x${string}`,
        intent.requestId,
        intent.recipient as `0x${string}`,
        intent.metadataSha256,
        hashText(intent.metadataUri),
      ],
    ),
  );
}
export function assertMintPreparation(
  value: unknown,
  wallet: string,
  registry: string,
): asserts value is RWAMetadataPreparation {
  if (
    !object(value) ||
    value.executable !== false ||
    value.status !== "awaiting-approved-source-evidence" ||
    value.chainId !== 560048 ||
    typeof value.recipient !== "string" ||
    value.recipient.toLowerCase() !== wallet.toLowerCase() ||
    typeof value.registryAddress !== "string" ||
    value.registryAddress.toLowerCase() !== registry.toLowerCase() ||
    !hash(value.requestId) ||
    !hash(value.metadataSha256) ||
    !hash(value.contextHash) ||
    typeof value.metadataUri !== "string" ||
    !/^(https|ipfs):\/\//.test(value.metadataUri) ||
    mintSourceContext(value as RWAMetadataPreparation) !== value.contextHash
  )
    throw new Error(
      "The unsigned source-review commitment does not match this wallet, metadata or registry.",
    );
}
export function assertSourceBoundMint<
  T extends {
    chainId: number;
    registryAddress: string;
    requestId: Hex;
    recipient: string;
    metadataSha256: Hex;
    metadataUri: string;
    sourceEvidence?: RWASourceEvidence;
    contractEvidence?: RWAContractEvidence;
  },
>(
  intent: T,
  now = Date.now(),
): asserts intent is T & {
  sourceEvidence: RWASourceEvidence;
  contractEvidence: RWAContractEvidence;
} {
  const e = intent.sourceEvidence;
  if (
    !isRWASourceEvidence(e) ||
    e.section !== "fractional" ||
    !intent.contractEvidence ||
    e.contextHash !== mintSourceContext(intent) ||
    now / 1000 < e.validFrom ||
    now / 1000 >= e.validUntil
  )
    throw new Error(
      "Current approved-source evidence for this exact mint is required before any wallet request.",
    );
  const expected = sourceContractEvidence(e);
  if (
    Object.keys(expected).some(
      (key) =>
        expected[key as keyof RWAContractEvidence] !==
        intent.contractEvidence?.[key as keyof RWAContractEvidence],
    )
  )
    throw new Error(
      "The contract evidence differs from the source's asset, rights or validity claim.",
    );
}
export function contractEvidenceArguments(e: RWAContractEvidence) {
  return {
    ...e,
    validFrom: BigInt(e.validFrom),
    validUntil: BigInt(e.validUntil),
  };
}
