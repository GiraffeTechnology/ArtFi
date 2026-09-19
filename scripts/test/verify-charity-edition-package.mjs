import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "artfi-charity-edition-"));
const master = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("master"),
]);
const directorDeclaration =
  "本人Michael YIP是CCHS的Director，并获授权代表CCHS行事。本人已与葉永潤签署合作。列表中全部画作已由CCHS接收代管；代管期间所有权仍归Artist。每件画作对应的100枚NFT完成首次发行并全部售出后，Artist承诺将对应实物画作独立捐赠并转移所有权给CCHS。";
const inscriptionTerms = readFileSync(
  "release/terms/ArtCCH_ArtFi_NFT_Inscription_Terms_EN_v1.txt",
);
const watermarked = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("watermarked-holder-copy"),
]);
writeFileSync(join(directory, "master.png"), master);
writeFileSync(join(directory, "watermarked.png"), watermarked);
writeFileSync(join(directory, "nft-terms.txt"), inscriptionTerms);

const packageBase = {
  schemaVersion: 1,
  chainId: 11_155_111,
  standard: "ERC-1155",
  marketplaceMode: "external-mirror",
  artfiExchangeEnabled: false,
  series: {
    artworkId: "UNIT-A01",
    editions: 100,
    unitPriceWei: "10000000000000000",
    currency: "ETH",
    immutableSupply: true,
    distributionWallet: "0x1111111111111111111111111111111111111111",
  },
  artwork: {
    title: "Authorized artwork",
    creator: "Michael Yip's team",
    rightsHolder: "ArtCCH",
    masterFile: "master.png",
    masterMimeType: "image/png",
    masterSha256: sha256(master),
    publicArtworkPreview: false,
    publicArtworkUri: null,
    unwatermarkedWebDownload: false,
  },
  holderAsset: {
    highResolution: true,
    watermarked: true,
    delivery: "token-gated-download",
    generatedPerHolder: true,
    publicUri: null,
    unwatermarkedAvailable: false,
    preview: false,
    file: "watermarked.png",
    sha256: sha256(watermarked),
  },
  rights: {
    basis: "assignment",
    authorizationBasis:
      "formal-mint-authorization-and-cchs-director-declaration",
    sourceDocumentsConfidential: true,
    sourceDocumentsProcessedByAi: false,
    attribution: "Copyright ArtCCH. Created by Michael Yip's team.",
    nftMintAuthorized: true,
    marketplaceListingEligible: false,
    listingActionConfirmed: false,
    expiresAt: null,
  },
  physicalArtwork: {
    mapped: false,
    conveysPhysicalTitle: false,
    redeemable: false,
    includedInNft: false,
    custodianBeforeSellout: "CCHS",
    ownerBeforeSellout: "Artist",
    custodyConveysTitle: false,
    transferIndependentOfNft: true,
    donationUndertakingBy: "Artist",
    undertakingSignerRole: "Artist",
    legalBasis: "cchs-director-declaration",
    directorDeclarationDeclaredBy: "Michael YIP",
    directorDeclarationCapacity: "CCHS Director and authorized representative",
    directorDeclarationTextZh: directorDeclaration,
    directorDeclarationSha256: sha256(Buffer.from(directorDeclaration, "utf8")),
    directorDeclarationAcceptedForRelease: true,
    soleProjectLegalBasis: true,
    confidentialUnderlyingDocumentsRequired: false,
    confidentialOriginalLocation: "CCHS office",
    confidentialReviewOnlyUponLawfulProcess: true,
    confidentialUnderlyingDocumentsMayBeUploadedToPublicNetworkOrAi: false,
    donationTrigger: "primary-sellout-100",
    donationRecipient: "CCHS",
    ownerAfterCompletedDonation: "CCHS",
    donationAcceptanceEvidenceRequired: true,
  },
  fundraising: {
    beneficiary: "CCHS",
    beneficiaryWebsite: "https://cchsc.ca",
    proceedsPercent: 100,
    receiptIssuer: "CCHS",
    holderContactsCchsDirectly: true,
    artfiIssuesReceipt: false,
    artfiDeterminesEligibleAmount: false,
    receiptValuationPolicy: "cchs-donation-date-eth-cad-public-market-rate",
    receiptRateTimestampBasis: "cchs-gift-received-at",
    receiptRatePair: "ETH/CAD",
    receiptRateSourceSelection: "CCHS-approved-public-market-source",
    receiptRateSnapshotSha256Required: true,
    officialReceiptAmountDeterminedBy: "CCHS",
    ethCadPriceEvidenceRequired: true,
    charityStatusReportedByAuthorizedDirector: true,
    cchsPolicyAcceptedForRelease: true,
    confirmationBasis: "cchs-director-declaration",
    publicRegistryVerified: false,
  },
  inscription: {
    type: "artcch-artfi-nft-terms",
    version: "1.0",
    language: "en",
    controllingLanguage: "en",
    translationsHaveLegalEffect: false,
    termsBytes: 15254,
    lineEndings: "LF",
    bom: false,
    termsFile: "nft-terms.txt",
    termsSha256: sha256(inscriptionTerms),
    embedFullText: true,
    immutable: true,
  },
  metadata: {
    publicURI:
      "https://io.artcch.com/nft/metadata/sepolia/ye-yongrun/UNIT-A01.json",
    description: "No preview; holder access is watermarked only.",
    attributes: [],
  },
};

const manifestPath = join(directory, "package.json");
writeFileSync(manifestPath, JSON.stringify(packageBase));
const output = execFileSync(
  process.execPath,
  [
    "scripts/release/verify-charity-edition-package.mjs",
    manifestPath,
    "--local-assets",
  ],
  { encoding: "utf8" },
);
const result = JSON.parse(output);
if (
  result.masterArtworkSha256 !== sha256(master) ||
  !/^[0-9a-f]{64}$/.test(result.metadataSha256) ||
  result.canonicalMetadata.includes('"image"') ||
  !result.canonicalMetadata.includes('"inscription"') ||
  !result.canonicalMetadata.includes(
    `"sha256":"${sha256(inscriptionTerms)}"`,
  ) ||
  !result.canonicalMetadata.includes(
    "Artist's sellout-contingent donation undertaking",
  ) ||
  // CH.11's packaging half, proven rather than assumed: the holder file was read and hashed, and
  // its digest is not the master's.
  result.holderAssetSha256 !== sha256(watermarked) ||
  result.holderAssetDistinctFromMaster !== true
) {
  throw new Error(
    "charity edition verifier did not reproduce private, no-preview metadata",
  );
}

for (const mutate of [
  (value) => (value.series.editions = 101),
  (value) => (value.artwork.publicArtworkPreview = true),
  (value) => (value.artwork.unwatermarkedWebDownload = true),
  (value) => (value.holderAsset.publicUri = "https://example.test/file.png"),
  (value) => (value.holderAsset.generatedPerHolder = false),
  (value) => (value.rights.sourceDocumentsProcessedByAi = true),
  (value) => (value.fundraising.proceedsPercent = 99),
  (value) =>
    (value.fundraising.receiptValuationPolicy =
      "cchs-issue-date-eth-cad-public-market-rate"),
  (value) =>
    (value.fundraising.receiptRateTimestampBasis = "cchs-receipt-issued-at"),
  (value) => (value.fundraising.receiptRatePair = "ETH/USD"),
  (value) => (value.fundraising.receiptRateSnapshotSha256Required = false),
  (value) => (value.fundraising.officialReceiptAmountDeterminedBy = "ArtFi"),
  (value) =>
    (value.fundraising.confirmationBasis = "uploaded-confidential-file"),
  (value) => (value.fundraising.publicRegistryVerified = true),
  (value) => (value.physicalArtwork.conveysPhysicalTitle = true),
  (value) => (value.physicalArtwork.mapped = true),
  (value) => (value.physicalArtwork.includedInNft = true),
  (value) => (value.physicalArtwork.ownerBeforeSellout = "CCHS"),
  (value) => (value.physicalArtwork.custodyConveysTitle = true),
  (value) => (value.physicalArtwork.donationUndertakingBy = "ArtFi"),
  (value) =>
    (value.physicalArtwork.directorDeclarationAcceptedForRelease = false),
  (value) => (value.physicalArtwork.directorDeclarationSha256 = "0".repeat(64)),
  (value) => (value.physicalArtwork.soleProjectLegalBasis = false),
  (value) =>
    (value.physicalArtwork.confidentialUnderlyingDocumentsRequired = true),
  (value) =>
    (value.physicalArtwork.confidentialReviewOnlyUponLawfulProcess = false),
  (value) =>
    (value.physicalArtwork.confidentialUnderlyingDocumentsMayBeUploadedToPublicNetworkOrAi = true),
  (value) => (value.physicalArtwork.transferIndependentOfNft = false),
  (value) => (value.inscription.embedFullText = false),
  (value) => (value.inscription.immutable = false),
  (value) => (value.inscription.controllingLanguage = "fr"),
  (value) => (value.inscription.translationsHaveLegalEffect = true),
  (value) => (value.inscription.termsSha256 = "0".repeat(64)),
  (value) => (value.rights.listingActionConfirmed = true),
  // The formal set (PRD §8.4). A02 is withdrawn and must be hard-rejected; the other three name
  // no work at all. `^UNIT-A\d{2}$` accepted every one of them.
  (value) => {
    value.series.artworkId = "UNIT-A02";
    value.metadata.publicURI =
      "https://io.artcch.com/nft/metadata/sepolia/ye-yongrun/UNIT-A02.json";
  },
  (value) => {
    value.series.artworkId = "UNIT-A00";
    value.metadata.publicURI =
      "https://io.artcch.com/nft/metadata/sepolia/ye-yongrun/UNIT-A00.json";
  },
  (value) => {
    value.series.artworkId = "UNIT-A39";
    value.metadata.publicURI =
      "https://io.artcch.com/nft/metadata/sepolia/ye-yongrun/UNIT-A39.json";
  },
  (value) => {
    value.series.artworkId = "UNIT-A99";
    value.metadata.publicURI =
      "https://io.artcch.com/nft/metadata/sepolia/ye-yongrun/UNIT-A99.json";
  },
  // CH.11's packaging half: the holder file must not be the master.
  (value) => (value.holderAsset.sha256 = value.artwork.masterSha256),
  (value) => delete value.holderAsset.sha256,
  (value) => delete value.holderAsset.file,
  (value) => (value.holderAsset.sha256 = "not-a-digest"),
  // A package that declares one work and publishes another work's metadata.
  (value) =>
    (value.metadata.publicURI =
      "https://io.artcch.com/nft/metadata/sepolia/ye-yongrun/UNIT-A07.json"),
]) {
  const invalid = structuredClone(packageBase);
  mutate(invalid);
  writeFileSync(manifestPath, JSON.stringify(invalid));
  let rejected = false;
  try {
    execFileSync(
      process.execPath,
      ["scripts/release/verify-charity-edition-package.mjs", manifestPath],
      { stdio: "pipe" },
    );
  } catch {
    rejected = true;
  }
  if (!rejected)
    throw new Error("invalid charity edition package was accepted");
}

process.stdout.write("Charity edition verifier regression tests passed.\n");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
