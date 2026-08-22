import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [manifestPath, mode] = process.argv.slice(2);
if (!manifestPath) {
  throw new Error(
    "usage: verify-charity-edition-package.mjs <manifest.json> [--schema-only|--local-assets]",
  );
}

const absoluteManifestPath = resolve(manifestPath);
const manifestDirectory = dirname(absoluteManifestPath);
const manifest = JSON.parse(readFileSync(absoluteManifestPath, "utf8"));
const hashPattern = /^[0-9a-f]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const zeroAddress = "0x0000000000000000000000000000000000000000";
const authoritativeInscriptionSha256 =
  "1c4e8260508e6f74c2e8bbd237e1f3d41f49d4c4ed7c7a0ca0f0df9162a66f01";
const authoritativeInscriptionBytes = 15_254;
const authoritativeDirectorDeclarationSha256 =
  "ab8f2f3189528881f8c4f9a254bb93167fdf4027d44a345d2267e24fcfe4b416";
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
  manifest.holderAsset?.highResolution !== true ||
  manifest.holderAsset?.watermarked !== true ||
  manifest.holderAsset?.delivery !== "token-gated-download" ||
  manifest.holderAsset?.generatedPerHolder !== true ||
  manifest.holderAsset?.publicUri !== null ||
  manifest.holderAsset?.unwatermarkedAvailable !== false ||
  manifest.holderAsset?.preview !== false
) {
  throw new Error(
    "holder delivery must be per-holder, token-gated, watermarked, and unavailable publicly",
  );
}
if (
  !allowedBases.has(manifest.rights?.basis) ||
  manifest.rights?.authorizationBasis !==
    "formal-mint-authorization-and-cchs-director-declaration" ||
  manifest.rights?.sourceDocumentsConfidential !== true ||
  manifest.rights?.sourceDocumentsProcessedByAi !== false ||
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
  manifest.physicalArtwork?.mapped !== false ||
  manifest.physicalArtwork?.conveysPhysicalTitle !== false ||
  manifest.physicalArtwork?.redeemable !== false ||
  manifest.physicalArtwork?.includedInNft !== false ||
  manifest.physicalArtwork?.custodianBeforeSellout !== "CCHS" ||
  manifest.physicalArtwork?.ownerBeforeSellout !== "Artist" ||
  manifest.physicalArtwork?.custodyConveysTitle !== false ||
  manifest.physicalArtwork?.transferIndependentOfNft !== true ||
  manifest.physicalArtwork?.donationUndertakingBy !== "Artist" ||
  !new Set(["Artist", "LawfulOwner"]).has(
    manifest.physicalArtwork?.undertakingSignerRole,
  ) ||
  manifest.physicalArtwork?.legalBasis !== "cchs-director-declaration" ||
  manifest.physicalArtwork?.directorDeclarationDeclaredBy !== "Michael YIP" ||
  manifest.physicalArtwork?.directorDeclarationCapacity !==
    "CCHS Director and authorized representative" ||
  typeof manifest.physicalArtwork?.directorDeclarationTextZh !== "string" ||
  manifest.physicalArtwork?.directorDeclarationSha256 !==
    authoritativeDirectorDeclarationSha256 ||
  sha256(
    Buffer.from(manifest.physicalArtwork.directorDeclarationTextZh, "utf8"),
  ) !== authoritativeDirectorDeclarationSha256 ||
  typeof manifest.physicalArtwork?.directorDeclarationAcceptedForRelease !==
    "boolean" ||
  manifest.physicalArtwork?.soleProjectLegalBasis !== true ||
  manifest.physicalArtwork?.confidentialUnderlyingDocumentsRequired !== false ||
  manifest.physicalArtwork?.confidentialOriginalLocation !== "CCHS office" ||
  manifest.physicalArtwork?.confidentialReviewOnlyUponLawfulProcess !== true ||
  manifest.physicalArtwork
    ?.confidentialUnderlyingDocumentsMayBeUploadedToPublicNetworkOrAi !==
    false ||
  manifest.physicalArtwork?.donationTrigger !== "primary-sellout-100" ||
  manifest.physicalArtwork?.donationRecipient !== "CCHS" ||
  manifest.physicalArtwork?.ownerAfterCompletedDonation !== "CCHS" ||
  manifest.physicalArtwork?.donationAcceptanceEvidenceRequired !== true
) {
  throw new Error(
    "the NFT must not bind physical artwork; CCHS custody preserves Artist title until the Artist's separate sellout donation",
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
  manifest.fundraising?.charityStatusReportedByAuthorizedDirector !== true ||
  manifest.fundraising?.cchsPolicyAcceptedForRelease !== true ||
  manifest.fundraising?.confirmationBasis !== "cchs-director-declaration" ||
  manifest.fundraising?.publicRegistryVerified !== false
) {
  throw new Error(
    "CCHS must receive all proceeds and remain the sole receipt decision-maker using approved public donation-received-time ETH/CAD evidence",
  );
}
if (
  typeof manifest.metadata?.publicURI !== "string" ||
  !manifest.metadata.publicURI.startsWith(
    "https://io.artcch.com/nft/metadata/sepolia/ye-yongrun/UNIT-A",
  ) ||
  !manifest.metadata.publicURI.endsWith(".json") ||
  typeof manifest.metadata?.description !== "string" ||
  !Array.isArray(manifest.metadata?.attributes)
) {
  throw new Error("metadata description and attributes are required");
}
if (
  manifest.inscription?.type !== "artcch-artfi-nft-terms" ||
  manifest.inscription?.version !== "1.0" ||
  manifest.inscription?.language !== "en" ||
  manifest.inscription?.controllingLanguage !== "en" ||
  manifest.inscription?.translationsHaveLegalEffect !== false ||
  manifest.inscription?.termsBytes !== authoritativeInscriptionBytes ||
  manifest.inscription?.lineEndings !== "LF" ||
  manifest.inscription?.bom !== false ||
  typeof manifest.inscription?.termsFile !== "string" ||
  manifest.inscription?.termsSha256 !== authoritativeInscriptionSha256 ||
  manifest.inscription?.embedFullText !== true ||
  manifest.inscription?.immutable !== true
) {
  throw new Error(
    "an immutable, full-text, SHA-256-bound ArtCCH:ArtFi NFT terms inscription is required",
  );
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
  manifest.physicalArtwork.directorDeclarationAcceptedForRelease !== true ||
  !hashPattern.test(manifest.artwork.masterSha256 ?? "")
) {
  throw new Error(
    "release validation requires a non-zero wallet, mint authorization, accepted director declaration, and master hash",
  );
}

if (mode === "--local-assets") {
  const master = verifyFile(
    manifestDirectory,
    manifest.artwork.masterFile,
    manifest.artwork.masterSha256,
    10 << 20,
    "master artwork",
  );
  if (!matchesMediaSignature(master.data, manifest.artwork.masterMimeType)) {
    throw new Error(
      "master artwork signature does not match its declared media type",
    );
  }
}
const inscriptionTerms = verifyFile(
  manifestDirectory,
  manifest.inscription.termsFile,
  manifest.inscription.termsSha256,
  256 << 10,
  "NFT terms inscription",
);
if (
  inscriptionTerms.data.length !== authoritativeInscriptionBytes ||
  inscriptionTerms.data.subarray(0, 3).equals(Buffer.from("efbbbf", "hex")) ||
  inscriptionTerms.data.includes(0x0d)
) {
  throw new Error(
    "NFT terms inscription must be exactly 15,254 bytes, LF-only, and have no BOM",
  );
}
const inscriptionText = inscriptionTerms.data.toString("utf8");
if (
  inscriptionText.trim().length < 100 ||
  inscriptionText.includes("\u0000") ||
  !inscriptionText.startsWith("ArtCCH:ArtFi NFT Inscription Terms") ||
  !inscriptionText.includes(
    "This English text is the sole authoritative and controlling version",
  ) ||
  !inscriptionText.includes(
    "The initial coin offering (ICO) price of each NFT is fixed at 0.01 ETH",
  )
) {
  throw new Error("NFT terms inscription is not valid UTF-8 policy text");
}

const metadata = {
  name: `${manifest.artwork.title} — fixed charity edition`,
  description: manifest.metadata.description,
  external_url: manifest.fundraising.beneficiaryWebsite,
  attributes: [
    ...manifest.metadata.attributes,
    { trait_type: "Edition supply", value: 100 },
    { trait_type: "ICO unit price", value: "0.01 ETH" },
    { trait_type: "Artwork preview", value: "Not provided" },
    { trait_type: "Holder file", value: "Watermarked high-resolution" },
    { trait_type: "Physical title", value: "Not conveyed" },
    { trait_type: "Physical artwork binding", value: "None" },
    {
      trait_type: "Physical artwork before sellout",
      value: "CCHS custody; Artist retains ownership",
    },
    {
      trait_type: "Artist sellout donation undertaking",
      value: "Ownership transfers to CCHS after all 100 editions are sold",
    },
    { trait_type: "Primary proceeds beneficiary", value: "CCHS (100%)" },
  ],
  artfi: {
    schemaVersion: 1,
    chainId: 11_155_111,
    standard: "ERC-1155",
    artworkId: manifest.series.artworkId,
    masterArtworkSha256: manifest.artwork.masterSha256,
    editions: 100,
    unitPriceWei: "10000000000000000",
    immutableSupply: true,
    publicArtworkPreview: false,
    unwatermarkedWebDownload: false,
    physicalArtworkMapped: false,
    preSelloutCustodian: "CCHS",
    preSelloutOwner: "Artist",
    custodyConveysTitle: false,
    donationUndertakingBy: "Artist",
    directorDeclarationSha256:
      manifest.physicalArtwork.directorDeclarationSha256,
    separatePhysicalDonationAfterSellout: true,
    conveysPhysicalTitle: false,
    redeemable: false,
    attribution: manifest.rights.attribution,
  },
  inscription: {
    type: manifest.inscription.type,
    version: manifest.inscription.version,
    language: manifest.inscription.language,
    controllingLanguage: "en",
    translationsHaveLegalEffect: false,
    bytes: authoritativeInscriptionBytes,
    lineEndings: "LF",
    bom: false,
    sha256: inscriptionTerms.sha256,
    immutable: true,
    text: inscriptionText,
  },
};
const canonicalMetadata = JSON.stringify(sortObject(metadata));
const metadataSha256 = sha256(Buffer.from(canonicalMetadata));
process.stdout.write(
  `${JSON.stringify({
    artworkId: manifest.series.artworkId,
    masterArtworkSha256: manifest.artwork.masterSha256,
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
