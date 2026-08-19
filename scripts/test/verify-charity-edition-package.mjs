import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "artfi-charity-edition-"));
const master = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("master"),
]);
const watermarked = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("watermarked-holder-copy"),
]);
const rights = Buffer.from("rights evidence");
const cchs = Buffer.from(
  "CCHS registration, wallet, and receipting policy evidence",
);
writeFileSync(join(directory, "master.png"), master);
writeFileSync(join(directory, "watermarked.png"), watermarked);
writeFileSync(join(directory, "rights.pdf"), rights);
writeFileSync(join(directory, "cchs.pdf"), cchs);

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
    watermarkedFile: "watermarked.png",
    watermarkedMimeType: "image/png",
    watermarkedSha256: sha256(watermarked),
    highResolution: true,
    watermarked: true,
    delivery: "token-gated-download",
    preview: false,
  },
  rights: {
    basis: "assignment",
    evidenceFile: "rights.pdf",
    evidenceSha256: sha256(rights),
    attribution: "Copyright ArtCCH. Created by Michael Yip's team.",
    nftMintAuthorized: true,
    marketplaceListingEligible: true,
    listingActionConfirmed: false,
    expiresAt: null,
  },
  physicalArtwork: {
    mapped: true,
    conveysPhysicalTitle: false,
    redeemable: false,
    donationTrigger: "primary-sellout-100",
    donationRecipient: "CCHS",
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
    receiptValuationPolicy: "cchs-issue-date-eth-cad-public-market-rate",
    receiptRateTimestampBasis: "cchs-receipt-issued-at",
    receiptRatePair: "ETH/CAD",
    receiptRateSourceSelection: "CCHS-approved-public-market-source",
    receiptRateSnapshotSha256Required: true,
    officialReceiptAmountDeterminedBy: "CCHS",
    ethCadPriceEvidenceRequired: true,
    charityStatusConfirmed: true,
    cchsPolicyConfirmed: true,
    cchsEvidenceFile: "cchs.pdf",
    cchsEvidenceSha256: sha256(cchs),
  },
  metadata: {
    description: "No preview; holder access is watermarked only.",
    attributes: [],
  },
};

const manifestPath = join(directory, "package.json");
writeFileSync(manifestPath, JSON.stringify(packageBase));
const output = execFileSync(
  process.execPath,
  ["scripts/release/verify-charity-edition-package.mjs", manifestPath],
  { encoding: "utf8" },
);
const result = JSON.parse(output);
if (
  result.masterArtworkSha256 !== sha256(master) ||
  result.watermarkedArtworkSha256 !== sha256(watermarked) ||
  !/^[0-9a-f]{64}$/.test(result.metadataSha256) ||
  result.canonicalMetadata.includes('"image"')
) {
  throw new Error(
    "charity edition verifier did not reproduce private, no-preview metadata",
  );
}

for (const mutate of [
  (value) => (value.series.editions = 101),
  (value) => (value.artwork.publicArtworkPreview = true),
  (value) => (value.artwork.unwatermarkedWebDownload = true),
  (value) => (value.holderAsset.watermarkedSha256 = value.artwork.masterSha256),
  (value) => (value.fundraising.proceedsPercent = 99),
  (value) => (value.fundraising.receiptValuationPolicy = "eth-transfer-date"),
  (value) =>
    (value.fundraising.receiptRateTimestampBasis = "eth-transferred-at"),
  (value) => (value.fundraising.receiptRatePair = "ETH/USD"),
  (value) => (value.fundraising.receiptRateSnapshotSha256Required = false),
  (value) => (value.fundraising.officialReceiptAmountDeterminedBy = "ArtFi"),
  (value) => (value.physicalArtwork.conveysPhysicalTitle = true),
  (value) => (value.rights.listingActionConfirmed = true),
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
