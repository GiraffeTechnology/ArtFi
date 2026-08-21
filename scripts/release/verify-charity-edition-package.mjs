import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [manifestPath, mode] = process.argv.slice(2);
if (!manifestPath) {
  throw new Error(
    "usage: verify-charity-edition-package.mjs <manifest.json> [--schema-only]",
  );
}

const absoluteManifestPath = resolve(manifestPath);
const manifestDirectory = dirname(absoluteManifestPath);
const manifest = JSON.parse(readFileSync(absoluteManifestPath, "utf8"));
const hashPattern = /^[0-9a-f]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const zeroAddress = "0x0000000000000000000000000000000000000000";
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
  manifest.standard !== "ERC-1155" ||
  manifest.marketplaceMode !== "external-mirror" ||
  manifest.artfiExchangeEnabled !== false
) {
  throw new Error(
    "charity editions must target Sepolia ERC-1155 in external-mirror mode",
  );
}
if (
  !/^UNIT-A\d{2}$/.test(manifest.series?.artworkId ?? "") ||
  manifest.series?.editions !== 100 ||
  manifest.series?.unitPriceWei !== "10000000000000000" ||
  manifest.series?.currency !== "ETH" ||
  manifest.series?.immutableSupply !== true ||
  !addressPattern.test(manifest.series?.distributionWallet ?? "")
) {
  throw new Error(
    "series must be one immutable 100-edition work at 0.01 ETH with a wallet",
  );
}
if (
  typeof manifest.artwork?.title !== "string" ||
  manifest.artwork.title.trim().length < 1 ||
  typeof manifest.artwork?.creator !== "string" ||
  manifest.artwork.creator.trim().length < 1 ||
  manifest.artwork?.rightsHolder !== "ArtCCH" ||
  typeof manifest.artwork?.masterFile !== "string" ||
  !allowedMedia.has(manifest.artwork?.masterMimeType) ||
  manifest.artwork?.publicArtworkPreview !== false ||
  manifest.artwork?.publicArtworkUri !== null ||
  manifest.artwork?.unwatermarkedWebDownload !== false
) {
  throw new Error(
    "the ArtCCH master must remain private with no preview or web download",
  );
}
if (
  typeof manifest.holderAsset?.watermarkedFile !== "string" ||
  !allowedMedia.has(manifest.holderAsset?.watermarkedMimeType) ||
  manifest.holderAsset?.highResolution !== true ||
  manifest.holderAsset?.watermarked !== true ||
  manifest.holderAsset?.delivery !== "token-gated-download" ||
  manifest.holderAsset?.preview !== false
) {
  throw new Error(
    "the holder asset must be a non-previewed, token-gated watermarked high-resolution file",
  );
}
if (
  !allowedBases.has(manifest.rights?.basis) ||
  typeof manifest.rights?.evidenceFile !== "string" ||
  typeof manifest.rights?.attribution !== "string" ||
  manifest.rights.attribution.trim().length < 1 ||
  manifest.rights?.listingActionConfirmed !== false
) {
  throw new Error(
    "rights basis, evidence, attribution, and a fresh listing-action gate are required",
  );
}
if (manifest.rights.expiresAt !== null) {
  const expiresAt = Date.parse(manifest.rights.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("rights authorization is expired or invalid");
  }
}
if (
  manifest.physicalArtwork?.mapped !== true ||
  manifest.physicalArtwork?.conveysPhysicalTitle !== false ||
  manifest.physicalArtwork?.redeemable !== false ||
  manifest.physicalArtwork?.donationTrigger !== "primary-sellout-100" ||
  manifest.physicalArtwork?.donationRecipient !== "CCHS" ||
  manifest.physicalArtwork?.donationAcceptanceEvidenceRequired !== true
) {
  throw new Error(
    "physical title and redemption must be excluded; CCHS donation follows sellout",
  );
}
if (
  manifest.fundraising?.beneficiary !== "CCHS" ||
  manifest.fundraising?.beneficiaryWebsite !== "https://cchsc.ca" ||
  manifest.fundraising?.proceedsPercent !== 100 ||
  manifest.fundraising?.receiptIssuer !== "CCHS" ||
  manifest.fundraising?.holderContactsCchsDirectly !== true ||
  manifest.fundraising?.artfiIssuesReceipt !== false ||
  manifest.fundraising?.artfiDeterminesEligibleAmount !== false ||
  manifest.fundraising?.receiptValuationPolicy !==
    "cchs-donation-date-eth-cad-public-market-rate" ||
  manifest.fundraising?.receiptRateTimestampBasis !== "cchs-gift-received-at" ||
  manifest.fundraising?.receiptRatePair !== "ETH/CAD" ||
  manifest.fundraising?.receiptRateSourceSelection !==
    "CCHS-approved-public-market-source" ||
  manifest.fundraising?.receiptRateSnapshotSha256Required !== true ||
  manifest.fundraising?.officialReceiptAmountDeterminedBy !== "CCHS" ||
  manifest.fundraising?.ethCadPriceEvidenceRequired !== true ||
  typeof manifest.fundraising?.cchsEvidenceFile !== "string"
) {
  throw new Error(
    "CCHS must receive all proceeds and remain the sole receipt decision-maker using approved public donation-received-time ETH/CAD evidence",
  );
}
if (
  typeof manifest.metadata?.description !== "string" ||
  !Array.isArray(manifest.metadata?.attributes)
) {
  throw new Error("metadata description and attributes are required");
}

if (mode === "--schema-only") {
  process.stdout.write(
    "Charity edition package validation passed (schema only).\n",
  );
  process.exit(0);
}

if (
  manifest.series.distributionWallet.toLowerCase() === zeroAddress ||
  manifest.rights.nftMintAuthorized !== true ||
  manifest.rights.marketplaceListingEligible !== true ||
  manifest.fundraising.charityStatusConfirmed !== true ||
  manifest.fundraising.cchsPolicyConfirmed !== true ||
  !hashPattern.test(manifest.artwork.masterSha256 ?? "") ||
  !hashPattern.test(manifest.holderAsset.watermarkedSha256 ?? "") ||
  !hashPattern.test(manifest.rights.evidenceSha256 ?? "") ||
  !hashPattern.test(manifest.fundraising.cchsEvidenceSha256 ?? "")
) {
  throw new Error(
    "full validation requires a non-zero confirmed wallet and complete authorization evidence",
  );
}

const master = verifyFile(
  manifestDirectory,
  manifest.artwork.masterFile,
  manifest.artwork.masterSha256,
  10 << 20,
  "master artwork",
);
const watermarked = verifyFile(
  manifestDirectory,
  manifest.holderAsset.watermarkedFile,
  manifest.holderAsset.watermarkedSha256,
  10 << 20,
  "watermarked holder artwork",
);
if (master.sha256 === watermarked.sha256) {
  throw new Error(
    "watermarked holder artwork must be distinct from the unwatermarked master",
  );
}
if (!matchesMediaSignature(master.data, manifest.artwork.masterMimeType)) {
  throw new Error(
    "master artwork signature does not match its declared media type",
  );
}
if (
  !matchesMediaSignature(
    watermarked.data,
    manifest.holderAsset.watermarkedMimeType,
  )
) {
  throw new Error(
    "watermarked artwork signature does not match its declared media type",
  );
}
verifyFile(
  manifestDirectory,
  manifest.rights.evidenceFile,
  manifest.rights.evidenceSha256,
  25 << 20,
  "rights evidence",
);
verifyFile(
  manifestDirectory,
  manifest.fundraising.cchsEvidenceFile,
  manifest.fundraising.cchsEvidenceSha256,
  25 << 20,
  "CCHS status and policy evidence",
);

const metadata = {
  name: `${manifest.artwork.title} — fixed charity edition`,
  description: manifest.metadata.description,
  external_url: manifest.fundraising.beneficiaryWebsite,
  attributes: [
    ...manifest.metadata.attributes,
    { trait_type: "Edition supply", value: 100 },
    { trait_type: "Primary unit price", value: "0.01 ETH" },
    { trait_type: "Artwork preview", value: "Not provided" },
    { trait_type: "Holder file", value: "Watermarked high-resolution" },
    { trait_type: "Physical title", value: "Not conveyed" },
    {
      trait_type: "Physical donation trigger",
      value: "After 100 primary subscriptions",
    },
    { trait_type: "Primary proceeds beneficiary", value: "CCHS (100%)" },
  ],
  artfi: {
    schemaVersion: 1,
    chainId: 11_155_111,
    standard: "ERC-1155",
    artworkId: manifest.series.artworkId,
    masterArtworkSha256: master.sha256,
    watermarkedArtworkSha256: watermarked.sha256,
    editions: 100,
    unitPriceWei: "10000000000000000",
    immutableSupply: true,
    publicArtworkPreview: false,
    unwatermarkedWebDownload: false,
    conveysPhysicalTitle: false,
    redeemable: false,
    attribution: manifest.rights.attribution,
  },
};
const canonicalMetadata = JSON.stringify(sortObject(metadata));
const metadataSha256 = sha256(Buffer.from(canonicalMetadata));
process.stdout.write(
  `${JSON.stringify({
    artworkId: manifest.series.artworkId,
    masterArtworkSha256: master.sha256,
    watermarkedArtworkSha256: watermarked.sha256,
    metadataSha256,
    canonicalMetadata,
  })}\n`,
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
  if (mimeType === "image/png") {
    return data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  if (mimeType === "image/jpeg") {
    return (
      data.length >= 3 &&
      data[0] === 0xff &&
      data[1] === 0xd8 &&
      data[2] === 0xff
    );
  }
  if (mimeType === "image/webp") {
    return (
      data.subarray(0, 4).toString("ascii") === "RIFF" &&
      data.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
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
