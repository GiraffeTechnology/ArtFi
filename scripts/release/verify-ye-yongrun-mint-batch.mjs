import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const releaseDirectory = join(repositoryRoot, "release");
const batchDirectory = join(
  releaseDirectory,
  "mint-batches/ye-yongrun-unit-a01-a38",
);
const packageDirectory = join(batchDirectory, "packages");
const assetDirectory = join(
  releaseDirectory,
  "artworks/ye-yongrun/unit-a01-a38/assets",
);
const descriptionPath = join(
  releaseDirectory,
  "artworks/ye-yongrun/unit-a01-a38/葉永潤_UNIT-A01-A38_作品介绍.txt",
);
const inscriptionPath = join(
  releaseDirectory,
  "terms/ArtCCH_ArtFi_NFT_Inscription_Terms_EN_v1.txt",
);
const artFi1 = "0x75F6e1BAc9bF07a54FECc416ef76327BbD2c3089";
const inscriptionSha256 =
  "1c4e8260508e6f74c2e8bbd237e1f3d41f49d4c4ed7c7a0ca0f0df9162a66f01";
const descriptionSha256 =
  "fba1afc49bac4db262c23c5565e299bca7c5e9eedbc602169aedca7adc7a7694";
const directorDeclarationSha256 =
  "ab8f2f3189528881f8c4f9a254bb93167fdf4027d44a345d2267e24fcfe4b416";
const includedArtworkIds = [
  "UNIT-A01",
  ...Array.from(
    { length: 36 },
    (_, offset) => `UNIT-A${String(offset + 3).padStart(2, "0")}`,
  ),
];

const intentText = readFileSync(
  join(dirname(batchDirectory), "ye-yongrun-unit-a01-a38.intent.json"),
  "utf8",
);
const intent = JSON.parse(intentText);
const indexText = readFileSync(
  join(batchDirectory, "package-index.json"),
  "utf8",
);
const index = JSON.parse(indexText);

assert(intent.status === "blocked-pre-mint", "intent must remain blocked");
assert(
  intent.network === "sepolia" && intent.chainId === 11_155_111,
  "intent must target Base Sepolia chain ID 84532",
);
assert(intent.mainnetAuthorized === false, "mainnet must remain unauthorized");
assert(intent.tokenStandard === "ERC-1155", "intent must use ERC-1155");
assert(intent.artworkSet.count === 37, "intent artwork count must be 37");
assert(
  intent.artworkSet.excludedArtworkIds.join(",") === "UNIT-A02",
  "UNIT-A02 must be excluded from the release set",
);
assert(intent.editionsPerArtwork === 100, "intent edition supply must be 100");
assert(intent.totalUnits === 3700, "intent total units must be 3700");
assert(
  intent.initialRecipient.address === artFi1,
  "intent recipient must be ArtFi1",
);
assert(
  intent.ico.unitPriceWei === "10000000000000000",
  "ICO price must be 0.01 ETH",
);
assert(
  intent.executionPolicy.sinOnly === true,
  "SIN-only execution must be required",
);
assert(
  intent.businessAuthorization.formalMintRequested === true &&
    intent.businessAuthorization.openseaPublishingIncluded === false &&
    intent.businessAuthorization.overridesTechnicalOrEvidenceGates === false &&
    intent.businessAuthorization
      .executionMayBeginOnlyAfterAllPreflightGatesPass === true,
  "formal mint authorization must be recorded without overriding preflight gates",
);
assert(
  intent.infrastructureAttestation.abcdyiSshRecovered === true &&
    intent.infrastructureAttestation.sinManagedTunnelActiveAndEnabled ===
      true &&
    intent.infrastructureAttestation
      .githubPrivateRepositoryReadThroughSinVerified === true &&
    intent.infrastructureAttestation.temporaryProbeCleaned === true,
  "restored infrastructure attestation is required",
);
assert(
  intent.infrastructureAttestation.sepoliaRpcVerifiedThroughSin === false &&
    intent.infrastructureAttestation.artFi1BalanceAndNonceVerified === false &&
    intent.infrastructureAttestation.signingAndBroadcastVerified === false,
  "unverified public-chain execution gates must remain false",
);
assert(
  [
    intent.executionPolicy.signingAuthorized,
    intent.executionPolicy.mintingAuthorized,
    intent.executionPolicy.broadcastAuthorized,
    intent.executionPolicy.openseaPublishingAuthorized,
  ].every((value) => value === false),
  "all execution actions must remain unauthorized",
);
assert(
  intent.artistUndertaking.reportedStatus === "signed",
  "signed status must be recorded",
);
assert(
  intent.artistUndertaking.artistSigner === "葉永潤",
  "Artist signer must be recorded",
);
assert(
  intent.artistUndertaking.witness.name === "Michael Yip",
  "witness must be recorded",
);
assert(
  intent.artistUndertaking.witness.capacity.startsWith("Director of CCHS"),
  "witness capacity must be recorded",
);
assert(
  intent.artistUndertaking.evidenceFile === null,
  "missing evidence must not be invented",
);
assert(
  intent.artistUndertaking.evidenceSha256 === null,
  "missing evidence hash must not be invented",
);
assert(
  [
    intent.artistUndertaking.signatureEvidenceVerified,
    intent.artistUndertaking.witnessCapacityVerified,
    intent.artistUndertaking.artworkCoverageVerified,
  ].every((value) => value === false),
  "undertaking evidence gates must remain false",
);
assert(
  intent.cchsDirectorDeclaration.declaredBy === "Michael YIP",
  "CCHS declarant must be recorded",
);
assert(
  intent.cchsDirectorDeclaration.declaredCapacity ===
    "Director of CCHS and authorized representative of CCHS",
  "declared CCHS capacity must be recorded",
);
assert(
  intent.artistUndertaking.reportedAgreementCounterpartyCapacity.includes(
    "authorized representative of CCHS",
  ) && intent.cchsDirectorDeclaration.authorityToActForCchsAsserted === true,
  "authority to act for CCHS must be recorded as asserted",
);
assert(
  intent.cchsDirectorDeclaration.legalEffectAssertedByDeclarant === true &&
    intent.cchsDirectorDeclaration.projectPolicyBinding === true,
  "CCHS declaration must bind project policy",
);
assert(
  intent.cchsDirectorDeclaration.cooperationSigned === true,
  "Artist cooperation must be recorded",
);
assert(
  intent.cchsDirectorDeclaration.physicalWorksReceivedIntoCustodyByCCHS ===
    true &&
    intent.cchsDirectorDeclaration.custodianBeforeSellout === "CCHS" &&
    intent.cchsDirectorDeclaration.ownerBeforeSellout === "Artist" &&
    intent.cchsDirectorDeclaration.custodyConveysTitle === false,
  "CCHS custody must preserve Artist ownership before sellout",
);
assert(
  intent.cchsDirectorDeclaration.nftConveysPhysicalRights === false,
  "NFTs must not convey physical rights",
);
assert(
  [
    intent.cchsDirectorDeclaration.identityAndCapacityDocumentVerified,
    intent.cchsDirectorDeclaration.corporateRegistryVerified,
    intent.cchsDirectorDeclaration.boardOrDelegatedAuthorityVerified,
    intent.cchsDirectorDeclaration.sourceInstrumentVerified,
    intent.cchsDirectorDeclaration.custodyIntakeVerified,
  ].every((value) => value === false),
  "CCHS declaration evidence gates must remain false",
);
assert(
  [
    intent.cchsDirectorDeclaration.sourceInstrumentFile,
    intent.cchsDirectorDeclaration.sourceInstrumentSha256,
    intent.cchsDirectorDeclaration.custodyIntakeFile,
    intent.cchsDirectorDeclaration.custodyIntakeSha256,
  ].every((value) => value === null),
  "missing CCHS evidence must not be invented",
);

assert(
  sha256(readFileSync(descriptionPath)) === descriptionSha256,
  "description hash mismatch",
);
const inscriptionBytes = readFileSync(inscriptionPath);
assert(inscriptionBytes.length === 15_254, "inscription byte length mismatch");
assert(
  !inscriptionBytes.subarray(0, 3).equals(Buffer.from("efbbbf", "hex")),
  "inscription must not have a BOM",
);
assert(
  !inscriptionBytes.includes(0x0d),
  "inscription must use LF-only line endings",
);
assert(
  sha256(inscriptionBytes) === inscriptionSha256,
  "inscription hash mismatch",
);

const assetFiles = readdirSync(assetDirectory)
  .filter((name) => /^UNIT-A\d{2}-000\.png$/.test(name))
  .sort();
assert(assetFiles.length === 38, "expected 38 artwork PNGs");
const assetLines = assetFiles.map(
  (name) => `${name}:${sha256(readFileSync(join(assetDirectory, name)))}`,
);
assert(
  sha256(Buffer.from(assetLines.join("\n"), "utf8")) ===
    intent.assets.pngCanonicalAggregateSha256,
  "artwork aggregate hash mismatch",
);

const packageFiles = readdirSync(packageDirectory)
  .filter((name) => /^UNIT-A\d{2}\.charity-edition\.json$/.test(name))
  .sort();
assert(packageFiles.length === 37, "expected 37 charity-edition packages");
assert(
  !packageFiles.includes("UNIT-A02.charity-edition.json"),
  "withdrawn UNIT-A02 package must be absent",
);
assert(
  index.status === "blocked-pre-mint",
  "package index must remain blocked",
);
assert(
  index.packageCount === 37 && index.totalUnits === 3700,
  "package totals are invalid",
);
assert(
  index.initialRecipient === artFi1,
  "package index recipient must be ArtFi1",
);

const seenMasterHashes = new Set();
const masterHashFiles = new Map();
for (let offset = 0; offset < includedArtworkIds.length; offset += 1) {
  const artworkId = includedArtworkIds[offset];
  const packageName = `${artworkId}.charity-edition.json`;
  assert(
    packageFiles[offset] === packageName,
    `missing package ${packageName}`,
  );
  const packageBytes = readFileSync(join(packageDirectory, packageName));
  const packageText = packageBytes.toString("utf8");
  const manifest = JSON.parse(packageText);
  const record = index.packages[offset];
  const masterName = `${artworkId}-000.png`;
  const masterBytes = readFileSync(join(assetDirectory, masterName));
  const masterSha256 = sha256(masterBytes);

  assert(record.artworkId === artworkId, `${artworkId} index order mismatch`);
  assert(
    record.packageFile === packageName,
    `${artworkId} index package mismatch`,
  );
  assert(
    record.packageSha256 === sha256(packageBytes),
    `${artworkId} package hash mismatch`,
  );
  assert(
    record.masterSha256 === masterSha256,
    `${artworkId} index master hash mismatch`,
  );
  assert(
    record.metadataURI ===
      `https://io.artcch.com/nft/metadata/sepolia/ye-yongrun/${artworkId}.json`,
    `${artworkId} index metadata URI mismatch`,
  );
  assert(
    record.editions === 100 && record.distributionWallet === artFi1,
    `${artworkId} index policy mismatch`,
  );
  assert(manifest.chainId === 84532, `${artworkId} must target Base Sepolia`);
  assert(manifest.standard === "ERC-1155", `${artworkId} must use ERC-1155`);
  assert(
    manifest.series.artworkId === artworkId,
    `${artworkId} manifest ID mismatch`,
  );
  assert(
    manifest.series.editions === 100,
    `${artworkId} edition supply mismatch`,
  );
  assert(
    manifest.series.unitPriceWei === "10000000000000000",
    `${artworkId} price mismatch`,
  );
  assert(
    manifest.series.immutableSupply === true,
    `${artworkId} supply must be immutable`,
  );
  assert(
    manifest.series.distributionWallet === artFi1,
    `${artworkId} recipient mismatch`,
  );
  assert(
    manifest.artwork.creator === "Ye Yong Run (葉永潤)",
    `${artworkId} Artist mismatch`,
  );
  assert(
    manifest.artwork.masterSha256 === masterSha256,
    `${artworkId} master hash mismatch`,
  );
  assert(
    manifest.artwork.publicArtworkPreview === false,
    `${artworkId} preview must be disabled`,
  );
  assert(
    manifest.artwork.publicArtworkUri === null,
    `${artworkId} public URI must be absent`,
  );
  assert(
    manifest.artwork.unwatermarkedWebDownload === false,
    `${artworkId} master download must be disabled`,
  );
  assert(
    manifest.holderAsset.preview === false &&
      manifest.holderAsset.generatedPerHolder === true &&
      manifest.holderAsset.publicUri === null &&
      manifest.holderAsset.unwatermarkedAvailable === false,
    `${artworkId} holder delivery policy mismatch`,
  );
  assert(
    manifest.metadata.publicURI === record.metadataURI,
    `${artworkId} manifest metadata URI mismatch`,
  );
  assert(
    manifest.inscription.termsSha256 === inscriptionSha256,
    `${artworkId} inscription mismatch`,
  );
  assert(
    manifest.inscription.termsBytes === 15_254,
    `${artworkId} inscription byte length mismatch`,
  );
  assert(
    manifest.inscription.lineEndings === "LF",
    `${artworkId} inscription line endings mismatch`,
  );
  assert(
    manifest.inscription.bom === false,
    `${artworkId} inscription BOM mismatch`,
  );
  assert(
    manifest.marketplaceMode === "external-mirror",
    `${artworkId} marketplace mode mismatch`,
  );
  assert(
    manifest.artfiExchangeEnabled === false,
    `${artworkId} exchange must remain disabled`,
  );
  assert(
    manifest.rights.nftMintAuthorized === true,
    `${artworkId} mint authorization missing`,
  );
  assert(
    manifest.rights.authorizationBasis ===
      "formal-mint-authorization-and-cchs-director-declaration" &&
      manifest.rights.sourceDocumentsConfidential === true &&
      manifest.rights.sourceDocumentsProcessedByAi === false,
    `${artworkId} confidential rights authorization policy mismatch`,
  );
  assert(
    manifest.rights.marketplaceListingEligible === false,
    `${artworkId} listing gate must remain false`,
  );
  assert(
    manifest.rights.listingActionConfirmed === false,
    `${artworkId} listing confirmation must remain false`,
  );
  assert(
    manifest.physicalArtwork.legalBasis === "cchs-director-declaration",
    `${artworkId} legal basis mismatch`,
  );
  assert(
    manifest.physicalArtwork.soleProjectLegalBasis === true,
    `${artworkId} legal basis must be exclusive`,
  );
  assert(
    manifest.physicalArtwork.directorDeclarationSha256 ===
      directorDeclarationSha256,
    `${artworkId} director declaration hash mismatch`,
  );
  assert(
    manifest.physicalArtwork.directorDeclarationAcceptedForRelease === true,
    `${artworkId} director declaration must be accepted for release`,
  );
  assert(
    manifest.physicalArtwork.confidentialUnderlyingDocumentsRequired ===
      false &&
      manifest.physicalArtwork.confidentialOriginalLocation === "CCHS office" &&
      manifest.physicalArtwork.confidentialReviewOnlyUponLawfulProcess ===
        true &&
      manifest.physicalArtwork
        .confidentialUnderlyingDocumentsMayBeUploadedToPublicNetworkOrAi ===
        false,
    `${artworkId} confidential evidence policy mismatch`,
  );
  assert(
    manifest.fundraising.charityStatusReportedByAuthorizedDirector === true &&
      manifest.fundraising.cchsPolicyAcceptedForRelease === true &&
      manifest.fundraising.confirmationBasis === "cchs-director-declaration" &&
      manifest.fundraising.publicRegistryVerified === false,
    `${artworkId} CCHS declaration policy mismatch`,
  );
  assert(
    !packageText.includes("ffe6d7ce") && !packageText.includes("3e0580de"),
    `${artworkId} contains a revoked inscription hash`,
  );
  seenMasterHashes.add(masterSha256);
  masterHashFiles.set(masterSha256, [
    ...(masterHashFiles.get(masterSha256) ?? []),
    masterName,
  ]);
}
const duplicateGroups = [...masterHashFiles.entries()].filter(
  ([, files]) => files.length > 1,
);
assert(
  seenMasterHashes.size === 37,
  "release set must contain 37 unique image contents",
);
assert(
  duplicateGroups.length === 0,
  "release set must not contain duplicate artwork content",
);
assert(
  intent.assetIntegrityFindings.status === "resolved-by-exclusion" &&
    intent.assetIntegrityFindings.filesExpected === 38 &&
    intent.assetIntegrityFindings.filesPresent === 38 &&
    intent.assetIntegrityFindings.uniqueContentSha256Count === 37 &&
    intent.assetIntegrityFindings.includedArtworkCount === 37 &&
    intent.assetIntegrityFindings.includedUniqueContentSha256Count === 37 &&
    intent.assetIntegrityFindings.duplicateContentDetectedInIncludedSet ===
      false &&
    intent.assetIntegrityFindings.resolutionRequiredBeforeMint === false &&
    intent.assetIntegrityFindings.excludedArtworkIds.join(",") === "UNIT-A02",
  "duplicate artwork finding must be resolved by excluding UNIT-A02",
);
assert(
  !intentText.includes("ffe6d7ce") && !intentText.includes("3e0580de"),
  "intent contains a revoked inscription hash",
);
assert(
  !indexText.includes("ffe6d7ce") && !indexText.includes("3e0580de"),
  "index contains a revoked inscription hash",
);

process.stdout.write(
  `${JSON.stringify({
    verified: true,
    status: "blocked-pre-mint",
    standard: "ERC-1155",
    artworkCount: 37,
    editionsPerArtwork: 100,
    totalUnits: 3700,
    recipient: artFi1,
    schemaPackages: 37,
    uniqueMasterContents: seenMasterHashes.size,
    excludedArtworkIds: ["UNIT-A02"],
    duplicateContentFilesInReleaseSet: [],
    undertakingReportedSigned: true,
    directorDeclarationSoleProjectLegalBasis: true,
    confidentialOriginalsProcessedByAi: false,
  })}\n`,
);

function assert(value, message) {
  if (!value) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
