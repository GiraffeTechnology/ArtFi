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

/**
 * The formal set — `PRD.md` §8.4: `UNIT-A01` and `UNIT-A03`–`UNIT-A38`, 37 works.
 *
 * `UNIT-A02` is withdrawn. It is a test-chain-only fixture in its own namespace, and §8.4 requires
 * the formal batch to hard-reject it; `ACCEPTANCE.md` §7.9 fails the audit if it reaches the formal
 * set or any mainnet manifest. The previous `^UNIT-A\\d{2}$` pattern admitted it, along with
 * `UNIT-A00`, `UNIT-A39` and every other two-digit id that names no work.
 *
 * `PRD.md` §4.7 CH.1's narrower 13-work first supply is deliberately **not** enforced here: it
 * conflicts with the 37 already minted, that conflict is open item 6 and a client decision, and a
 * verifier that picked a side would decide it.
 */
const formalSetArtworkIds = new Set(
  Array.from({ length: 38 }, (_, index) => index + 1)
    .filter((unit) => unit !== 2)
    .map((unit) => `UNIT-A${String(unit).padStart(2, "0")}`),
);

/**
 * Two payloads, two chains — `PRD.md` §7.0.
 *
 * The real batch lives on Sepolia and is frozen. The test payload lives on Hoodi, carries no
 * real-world value and no legal effect, and must never borrow the real batch's namespace. This
 * verifier accepted only the first, so a Hoodi package was rejected on its chain id and again on
 * its artwork id — step I of the Hoodi plan could not pass at all. Both are chain-dependent, so
 * they branch here rather than being loosened for everyone.
 */
const realBatchChainId = 11_155_111;
const testPayloadChainId = 560_048;
const isTestPayload = manifest.chainId === testPayloadChainId;

if (
  manifest.schemaVersion !== 1 ||
  (manifest.chainId !== realBatchChainId && !isTestPayload) ||
  manifest.standard !== "ERC-1155" ||
  manifest.marketplaceMode !== "external-mirror" ||
  manifest.artfiExchangeEnabled !== false
) {
  throw new Error(
    "charity editions must target the Sepolia real batch or the Hoodi test payload, ERC-1155 in external-mirror mode",
  );
}
if (manifest.series?.artworkId === "UNIT-A02") {
  throw new Error(
    "UNIT-A02 is withdrawn from the formal set and must never enter a release manifest",
  );
}

/**
 * §7.0's fourth place for the test-asset markers: a top-level field in the batch manifest.
 *
 * Required on the test payload and **forbidden on the real batch** — a frozen record of real
 * assets that declared itself of no real-world value would be false, and the 37 existing packages
 * carry no such field. §5 rule 1 of the Hoodi plan is enforced here too: the test payload gets its
 * own namespace and may not reuse the real batch's `UNIT-` ids.
 */
const testAssetMarkers = ["TESTNET", "NO REAL-WORLD VALUE", "NO LEGAL EFFECT"];
if (isTestPayload) {
  const declared = manifest.testAssetMarkers;
  if (
    !Array.isArray(declared) ||
    testAssetMarkers.some((marker) => !declared.includes(marker))
  ) {
    throw new Error(
      `a test payload must declare testAssetMarkers containing ${testAssetMarkers.join(", ")} (PRD.md §7.0)`,
    );
  }
  if (String(manifest.series?.artworkId ?? "").startsWith("UNIT-")) {
    throw new Error(
      "a test payload must not reuse the real batch's UNIT- artwork namespace (PRD.md §7.0)",
    );
  }
} else if (manifest.testAssetMarkers !== undefined) {
  throw new Error(
    "the real batch must not declare test-asset markers; it records real assets (PRD.md §7.0)",
  );
}

if (
  (!isTestPayload &&
    !formalSetArtworkIds.has(manifest.series?.artworkId ?? "")) ||
  !manifest.series?.artworkId ||
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
  manifest.holderAsset?.preview !== false ||
  // The holder-file binding is optional — the 37 frozen packages predate it and stay valid
  // (`AGENTS.md` §6: historical mint evidence is immutable) — but half of it never is.
  (manifest.holderAsset?.file === undefined) !==
    (manifest.holderAsset?.sha256 === undefined) ||
  (manifest.holderAsset?.file !== undefined &&
    typeof manifest.holderAsset.file !== "string") ||
  (manifest.holderAsset?.sha256 !== undefined &&
    !hashPattern.test(manifest.holderAsset.sha256))
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
// The directory is the real batch's, whatever the filename under it. Matching on the longer
// `…/UNIT-A` prefix would let a test payload sit in the frozen record's own folder just by being
// named differently.
const realBatchMetadataDirectory =
  "https://io.artcch.com/nft/metadata/sepolia/ye-yongrun/";
const realBatchMetadataPrefix = `${realBatchMetadataDirectory}UNIT-A`;
const publicURI = manifest.metadata?.publicURI;
if (
  typeof publicURI !== "string" ||
  // The real batch publishes under its own fixed path. The test payload must not: reusing it
  // would put a test asset where the frozen record lives (`PRD.md` §7.0). It still has to be
  // HTTPS and still has to name its own work.
  (isTestPayload
    ? publicURI.startsWith(realBatchMetadataDirectory) ||
      !publicURI.startsWith("https://")
    : !publicURI.startsWith(realBatchMetadataPrefix)) ||
  // Bound to this manifest's own artwork: the prefix and a bare `.json` suffix let a package
  // declare one work and publish another work's metadata.
  !publicURI.endsWith(`/${manifest.series.artworkId}.json`) ||
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

/**
 * CH.11 at packaging time: the watermarked holder file and the master must differ by hash.
 *
 * `charity-assets.ts` and `charity-object-store.ts` already enforce this at delivery time. This is
 * the packaging half, and it is checked here — before `--schema-only` exits — because a declared
 * digest that equals the master's is a fault in the manifest itself, not in the files beside it.
 */
if (
  manifest.holderAsset?.sha256 !== undefined &&
  manifest.holderAsset.sha256.toLowerCase() ===
    (manifest.artwork?.masterSha256 ?? "").toLowerCase()
) {
  throw new Error(
    "the watermarked holder file must not hash to the master: a package declaring both as one object is declaring the master as the holder benefit",
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
  if (manifest.holderAsset.file !== undefined) {
    const holderFile = verifyFile(
      manifestDirectory,
      manifest.holderAsset.file,
      manifest.holderAsset.sha256,
      10 << 20,
      "watermarked holder file",
    );
    // Proven against the bytes, not only against the two declared digests.
    if (holderFile.sha256 === master.sha256) {
      throw new Error(
        "the watermarked holder file is byte-identical to the master",
      );
    }
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
    // `null` means the package carries no holder-file binding, so CH.11's packaging half could not
    // be proven for it. A reviewer sees the absence rather than an unexplained pass.
    holderAssetSha256: manifest.holderAsset.sha256 ?? null,
    holderAssetDistinctFromMaster:
      manifest.holderAsset.sha256 === undefined
        ? null
        : manifest.holderAsset.sha256.toLowerCase() !==
          manifest.artwork.masterSha256.toLowerCase(),
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
