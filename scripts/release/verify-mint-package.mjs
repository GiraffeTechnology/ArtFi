import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [manifestPath, mode] = process.argv.slice(2);
if (!manifestPath) {
  throw new Error(
    "usage: verify-mint-package.mjs <manifest.json> [--schema-only]",
  );
}

const absoluteManifestPath = resolve(manifestPath);
const manifestDirectory = dirname(absoluteManifestPath);
const manifest = JSON.parse(readFileSync(absoluteManifestPath, "utf8"));
const hashPattern = /^[0-9a-f]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const allowedBases = new Set([
  "creator",
  "assignment",
  "exclusive-license",
  "non-exclusive-license",
  "public-domain",
]);
const allowedMedia = new Set(["image/jpeg", "image/png", "image/webp"]);

if (
  manifest.schemaVersion !== 1 ||
  manifest.chainId !== 11_155_111 ||
  !addressPattern.test(manifest.recipient ?? "") ||
  manifest.marketplaceMode !== "external-mirror" ||
  manifest.artfiExchangeEnabled !== false
) {
  throw new Error(
    "mint packages must target Sepolia, external-mirror mode, and a valid recipient",
  );
}
if (
  typeof manifest.artwork?.title !== "string" ||
  manifest.artwork.title.trim().length < 1 ||
  typeof manifest.artwork?.creator !== "string" ||
  manifest.artwork.creator.trim().length < 1 ||
  !allowedMedia.has(manifest.artwork?.mimeType) ||
  typeof manifest.artwork?.file !== "string" ||
  typeof manifest.artwork?.uri !== "string"
) {
  throw new Error(
    "artwork title, creator, supported media type, file, and immutable URI are required",
  );
}
if (
  typeof manifest.rights?.rightsHolder !== "string" ||
  manifest.rights.rightsHolder.trim().length < 1 ||
  !allowedBases.has(manifest.rights?.basis) ||
  typeof manifest.rights?.evidenceFile !== "string" ||
  typeof manifest.rights?.attribution !== "string" ||
  manifest.rights.attribution.trim().length < 1 ||
  manifest.rights?.listingActionConfirmed !== false
) {
  throw new Error(
    "rights holder, basis, evidence, attribution, and a fresh listing-action gate are required",
  );
}
if (manifest.rights.expiresAt !== null) {
  const expiresAt = Date.parse(manifest.rights.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("rights authorization is expired or invalid");
  }
}

if (mode === "--schema-only") {
  process.stdout.write("Mint package validation passed (schema only).\n");
  process.exit(0);
}
if (
  manifest.rights.nftMintAuthorized !== true ||
  manifest.rights.marketplaceListingEligible !== true ||
  !hashPattern.test(manifest.artwork.sha256 ?? "") ||
  !hashPattern.test(manifest.rights.evidenceSha256 ?? "")
) {
  throw new Error(
    "full validation requires explicit NFT mint rights, listing eligibility, and file hashes",
  );
}

const artwork = verifyFile(
  manifestDirectory,
  manifest.artwork.file,
  manifest.artwork.sha256,
  10 << 20,
  "artwork",
);
if (!matchesMediaSignature(artwork.data, manifest.artwork.mimeType)) {
  throw new Error(
    "artwork file signature does not match its declared media type",
  );
}
verifyFile(
  manifestDirectory,
  manifest.rights.evidenceFile,
  manifest.rights.evidenceSha256,
  25 << 20,
  "rights evidence",
);
if (!isImmutableArtworkURI(manifest.artwork.uri, artwork.sha256)) {
  throw new Error(
    "artwork URI must be content-addressed and include the verified artwork SHA-256",
  );
}

const metadata = {
  name: manifest.artwork.title,
  description: manifest.metadata?.description ?? "",
  image: manifest.artwork.uri,
  attributes: manifest.metadata?.attributes ?? [],
  artfi: {
    schemaVersion: 1,
    chainId: 11_155_111,
    imageSha256: artwork.sha256,
    rightsBasis: manifest.rights.basis,
    rightsEvidenceSha256: manifest.rights.evidenceSha256,
    attribution: manifest.rights.attribution,
  },
};
const canonicalMetadata = JSON.stringify(sortObject(metadata));
const metadataSha256 = sha256(Buffer.from(canonicalMetadata));
process.stdout.write(
  `${JSON.stringify({ artworkSha256: artwork.sha256, metadataSha256 })}\n`,
);

function verifyFile(base, relativePath, expectedHash, maxBytes, label) {
  const filePath = resolve(base, relativePath);
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
    throw new Error(`${label} file size is invalid`);
  }
  const data = readFileSync(filePath);
  const digest = sha256(data);
  if (digest !== expectedHash) {
    throw new Error(`${label} SHA-256 does not match the manifest`);
  }
  return { data, sha256: digest };
}

function matchesMediaSignature(data, mimeType) {
  if (mimeType === "image/png")
    return data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mimeType === "image/jpeg")
    return (
      data.length >= 3 &&
      data[0] === 0xff &&
      data[1] === 0xd8 &&
      data[2] === 0xff
    );
  if (mimeType === "image/webp")
    return (
      data.subarray(0, 4).toString("ascii") === "RIFF" &&
      data.subarray(8, 12).toString("ascii") === "WEBP"
    );
  return false;
}

function isImmutableArtworkURI(uri, digest) {
  return (
    (uri.startsWith("ipfs://") ||
      uri.startsWith("ar://") ||
      uri.startsWith("https://")) &&
    uri.toLowerCase().includes(digest)
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortObject(value[key])]),
    );
  }
  return value;
}
