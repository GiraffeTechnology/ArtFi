import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const releaseDirectory = join(repositoryRoot, "release");
const sourceDirectory = join(
  releaseDirectory,
  "artworks/ye-yongrun/unit-a01-a38",
);
const assetDirectory = join(sourceDirectory, "assets");
const descriptionPath = join(
  sourceDirectory,
  "葉永潤_UNIT-A01-A38_作品介绍.txt",
);
const batchDirectory = join(
  releaseDirectory,
  "mint-batches/ye-yongrun-unit-a01-a38",
);
const packageDirectory = join(batchDirectory, "packages");
const artFi1 = "0x75F6e1BAc9bF07a54FECc416ef76327BbD2c3089";
const inscriptionSha256 =
  "1c4e8260508e6f74c2e8bbd237e1f3d41f49d4c4ed7c7a0ca0f0df9162a66f01";
const directorDeclarationTextZh =
  "本人Michael YIP是CCHS的Director，并获授权代表CCHS行事。本人已与葉永潤签署合作。列表中全部画作已由CCHS接收代管；代管期间所有权仍归Artist。每件画作对应的100枚NFT完成首次发行并全部售出后，Artist承诺将对应实物画作独立捐赠并转移所有权给CCHS。";
const directorDeclarationSha256 =
  "ab8f2f3189528881f8c4f9a254bb93167fdf4027d44a345d2267e24fcfe4b416";
const excludedArtworkIds = new Set(["UNIT-A02"]);
const metadataBaseUrl =
  "https://io.artcch.com/nft/metadata/sepolia/ye-yongrun";

const sourceText = readFileSync(descriptionPath, "utf8");
const blocks = [
  ...sourceText.matchAll(
    /^(\d{2})｜UNIT-A(\d{2})-000\.png\r?\n([\s\S]*?)(?=^\d{2}｜UNIT-A\d{2}-000\.png|(?![\s\S]))/gm,
  ),
];
if (blocks.length !== 38) {
  throw new Error(`expected 38 artwork records, found ${blocks.length}`);
}

mkdirSync(packageDirectory, { recursive: true });
const packageRecords = [];

for (const artworkId of excludedArtworkIds) {
  const withdrawnPackagePath = join(
    packageDirectory,
    `${artworkId}.charity-edition.json`,
  );
  if (existsSync(withdrawnPackagePath)) unlinkSync(withdrawnPackagePath);
}

for (const block of blocks) {
  const [, sequence, artworkSequence, body] = block;
  if (sequence !== artworkSequence) {
    throw new Error(`record and artwork sequence differ at ${sequence}`);
  }
  const artworkId = `UNIT-A${sequence}`;
  if (excludedArtworkIds.has(artworkId)) continue;
  const masterFilename = `${artworkId}-000.png`;
  const masterPath = join(assetDirectory, masterFilename);
  const title = requiredLine(body, /^(?:建议)?题名：(.+)$/m, `${artworkId} title`);
  const about = requiredLine(
    body,
    /^About the Work: (.+)$/m,
    `${artworkId} About the Work`,
  );
  const masterSha256 = sha256(readFileSync(masterPath));
  const packagePath = join(
    packageDirectory,
    `${artworkId}.charity-edition.json`,
  );
  const manifest = {
    schemaVersion: 1,
    chainId: 11155111,
    standard: "ERC-1155",
    marketplaceMode: "external-mirror",
    artfiExchangeEnabled: false,
    series: {
      artworkId,
      editions: 100,
      unitPriceWei: "10000000000000000",
      currency: "ETH",
      immutableSupply: true,
      distributionWallet: artFi1,
    },
    artwork: {
      title,
      creator: "Ye Yong Run (葉永潤)",
      rightsHolder: "ArtCCH",
      masterFile: relative(packageDirectory, masterPath).replaceAll("\\", "/"),
      masterMimeType: "image/png",
      masterSha256,
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
    },
    rights: {
      basis: "assignment",
      authorizationBasis:
        "formal-mint-authorization-and-cchs-director-declaration",
      sourceDocumentsConfidential: true,
      sourceDocumentsProcessedByAi: false,
      attribution: "Copyright ArtCCH. Artwork by Ye Yong Run (葉永潤).",
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
      directorDeclarationCapacity:
        "CCHS Director and authorized representative",
      directorDeclarationTextZh,
      directorDeclarationSha256,
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
      termsFile:
        "../../../terms/ArtCCH_ArtFi_NFT_Inscription_Terms_EN_v1.txt",
      termsSha256: inscriptionSha256,
      embedFullText: true,
      immutable: true,
    },
    metadata: {
      publicURI: `${metadataBaseUrl}/${artworkId}.json`,
      description: `${about} Fixed ArtCCH charity edition. No artwork preview. No physical title, redemption, copyright, commercial-use, or reproduction rights. Verified holders may access a watermarked high-resolution copy.`,
      attributes: [
        { trait_type: "Artist", value: "Ye Yong Run (葉永潤)" },
        { trait_type: "Artwork ID", value: artworkId },
        { trait_type: "Decade", value: "2010s" },
        { trait_type: "Frame", value: "Not included" },
      ],
    },
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(packagePath, serialized, "utf8");
  packageRecords.push({
    artworkId,
    packageFile: basename(packagePath),
    packageSha256: sha256(Buffer.from(serialized)),
    masterFile: masterFilename,
    masterSha256,
    metadataURI: manifest.metadata.publicURI,
    editions: 100,
    distributionWallet: artFi1,
  });
}

const index = {
  schemaVersion: 1,
  batchId: "ye-yongrun-unit-a01-a38",
  status: "blocked-pre-mint",
  chainId: 11155111,
  standard: "ERC-1155",
  packageCount: packageRecords.length,
  totalUnits: packageRecords.length * 100,
  initialRecipient: artFi1,
  packages: packageRecords,
};
writeFileSync(
  join(batchDirectory, "package-index.json"),
  `${JSON.stringify(index, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  `Generated ${packageRecords.length} blocked charity-edition packages for ${index.totalUnits} units.\n`,
);

function requiredLine(value, pattern, label) {
  const match = value.match(pattern);
  if (!match?.[1]?.trim()) throw new Error(`missing ${label}`);
  return match[1].trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
