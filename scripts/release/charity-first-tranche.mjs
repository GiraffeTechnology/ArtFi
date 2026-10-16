import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const FIRST_CHARITY_TRANCHE_ARTWORK_IDS = Object.freeze([
  "UNIT-A01", "UNIT-A04", "UNIT-A05", "UNIT-A11", "UNIT-A14", "UNIT-A15",
  "UNIT-A16", "UNIT-A17", "UNIT-A20", "UNIT-A21", "UNIT-A22", "UNIT-A23", "UNIT-A24",
]);

const formalArtworkIds = Object.freeze([
  "UNIT-A01",
  ...Array.from({ length: 36 }, (_, offset) => `UNIT-A${String(offset + 3).padStart(2, "0")}`),
]);
const sha256Pattern = /^[a-f0-9]{64}$/;
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const metadataPrefixes = new Map([
  [11155111, "https://io.artcch.com/nft/metadata/sepolia/ye-yongrun/"],
  [560048, "https://io.artcch.com/nft/metadata/hoodi/ye-yongrun/"],
]);

/**
 * Select references to the first fixed tranche from an unchanged formal index.
 * This checks selection consistency, not release eligibility or on-chain state.
 * readPackage receives only a checked basename and must return its original bytes.
 */
export function selectFirstCharityTranche({ indexBytes, readPackage }) {
  requireValue(typeof readPackage === "function", "package reader is required");
  const originalIndex = bytes(indexBytes, "index");
  const index = parse(originalIndex, "index");
  const metadataPrefix = metadataPrefixes.get(index.chainId);
  requireValue(index.schemaVersion === 1, "unsupported index schema");
  requireValue(index.batchId === "ye-yongrun-unit-a01-a38", "unexpected source batch");
  requireValue(metadataPrefix !== undefined, "unsupported source chain");
  requireValue(index.standard === "ERC-1155", "unexpected token standard");
  requireValue(index.status === "blocked-pre-mint", "unexpected source index status");
  requireValue(index.packageCount === 37 && index.totalUnits === 3700, "formal set totals differ");
  requireValue(addressPattern.test(index.initialRecipient) && !/^0x0{40}$/i.test(index.initialRecipient), "invalid distribution wallet");
  requireValue(Array.isArray(index.packages) && index.packages.length === 37, "formal set must contain 37 records");

  const records = new Map();
  const masterHashes = new Set();
  for (const record of index.packages) {
    requireValue(record !== null && typeof record === "object" && !Array.isArray(record), "invalid index record");
    const id = record.artworkId;
    requireValue(formalArtworkIds.includes(id) && !records.has(id), "unexpected or duplicate artwork");
    requireValue(record.packageFile === `${id}.charity-edition.json`, `${id}: package filename differs`);
    requireValue(record.masterFile === `${id}-000.png`, `${id}: master filename differs`);
    requireValue(typeof record.packageSha256 === "string" && sha256Pattern.test(record.packageSha256), `${id}: invalid package hash`);
    requireValue(typeof record.masterSha256 === "string" && sha256Pattern.test(record.masterSha256) && !masterHashes.has(record.masterSha256), `${id}: invalid or duplicate master hash`);
    requireValue(record.editions === 100, `${id}: edition supply differs`);
    requireValue(record.distributionWallet === index.initialRecipient, `${id}: distribution wallet differs`);
    requireValue(record.metadataURI === `${metadataPrefix}${id}.json`, `${id}: metadata URI differs`);
    masterHashes.add(record.masterSha256);
    records.set(id, record);
  }
  requireValue(formalArtworkIds.every((id) => records.has(id)), "formal set is incomplete");

  const selected = FIRST_CHARITY_TRANCHE_ARTWORK_IDS.map((id) => {
    const record = records.get(id);
    const packageBytes = bytes(readPackage(record.packageFile), id);
    requireValue(sha256(packageBytes) === record.packageSha256, `${id}: package byte hash differs`);
    const manifest = parse(packageBytes, id);
    requireValue(manifest.schemaVersion === 1 && manifest.chainId === index.chainId && manifest.standard === index.standard, `${id}: package identity differs`);
    requireValue(manifest.series?.artworkId === id && manifest.series.editions === 100 && manifest.series.immutableSupply === true, `${id}: immutable series differs`);
    requireValue(manifest.series.distributionWallet === index.initialRecipient && manifest.series.unitPriceWei === "10000000000000000" && manifest.series.currency === "ETH", `${id}: series terms differ`);
    requireValue(manifest.artwork?.masterSha256 === record.masterSha256 && manifest.metadata?.publicURI === record.metadataURI, `${id}: source binding differs`);
    requireValue(manifest.artwork.publicArtworkPreview === false && manifest.artwork.publicArtworkUri === null && manifest.artwork.unwatermarkedWebDownload === false, `${id}: master privacy policy differs`);
    requireValue(manifest.holderAsset?.preview === false && manifest.holderAsset.publicUri === null && manifest.holderAsset.unwatermarkedAvailable === false && manifest.holderAsset.watermarked === true && manifest.holderAsset.delivery === "token-gated-download", `${id}: holder privacy policy differs`);
    requireValue(manifest.rights?.listingActionConfirmed === false, `${id}: listing confirmation must remain pending`);
    return Object.freeze({
      artworkId: id,
      packageFile: record.packageFile,
      packageSha256: record.packageSha256,
      masterSha256: record.masterSha256,
      metadataURI: record.metadataURI,
      editions: record.editions,
      distributionWallet: record.distributionWallet,
    });
  });

  return Object.freeze({
    schemaVersion: 1,
    selectionId: "ye-yongrun-first-fixed-tranche",
    status: "selection-only",
    executionAuthorized: false,
    releaseEligibility: "not-evaluated",
    onChainState: "not-evaluated",
    sourceBatchId: index.batchId,
    sourceIndexSha256: sha256(originalIndex),
    sourceIndexStatus: index.status,
    chainId: index.chainId,
    standard: index.standard,
    packageCount: selected.length,
    editionsPerArtwork: 100,
    totalUnits: selected.length * 100,
    initialRecipient: index.initialRecipient,
    packages: Object.freeze(selected),
  });
}

function bytes(value, label) {
  requireValue(value instanceof Uint8Array, `${label}: original bytes are required`);
  return Buffer.from(value);
}

function parse(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch {
    throw new Error(`${label}: invalid UTF-8 JSON`);
  }
  requireValue(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), `${label}: JSON object required`);
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
