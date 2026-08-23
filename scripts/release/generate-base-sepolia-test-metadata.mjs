import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const webRequire = createRequire(join(repositoryRoot, "apps/web/package.json"));
const { keccak256, stringToHex } = webRequire("viem");

const outputDirectory = join(
  repositoryRoot,
  "apps/web/public/nft/metadata/base-sepolia/ye-yongrun",
);
const sourcePolicyPath = join(
  repositoryRoot,
  "release/mint-batches/ye-yongrun-unit-a01-a38/mint-policy-series.json",
);
const packageDirectory = join(
  repositoryRoot,
  "release/mint-batches/ye-yongrun-unit-a01-a38/packages",
);
const packageVerifierPath = join(
  repositoryRoot,
  "scripts/release/verify-charity-edition-package.mjs",
);
const outputManifestPath = join(
  repositoryRoot,
  "release/testnet/base-sepolia/formal-37/manifest.json",
);
const a02Directory = join(
  repositoryRoot,
  "release/testnet/base-sepolia/a02-rwa-dao",
);
const a02PublicPath = join(
  repositoryRoot,
  "apps/web/public/nft/metadata/base-sepolia/test-only/a02.json",
);
const expectedIds = [
  "UNIT-A01",
  ...Array.from(
    { length: 36 },
    (_, offset) => `UNIT-A${String(offset + 3).padStart(2, "0")}`,
  ),
];
const inscriptionSha256 =
  "1c4e8260508e6f74c2e8bbd237e1f3d41f49d4c4ed7c7a0ca0f0df9162a66f01";
const publicBaseURL =
  "https://io.artcch.com/nft/metadata/base-sepolia/ye-yongrun";

const sourcePolicyBytes = readFileSync(sourcePolicyPath);
const sourcePolicy = JSON.parse(sourcePolicyBytes.toString("utf8"));
if (
  sourcePolicy.chainId !== 11_155_111 ||
  sourcePolicy.series.length !== 37 ||
  sourcePolicy.excludedArtworkIds.join(",") !== "UNIT-A02"
) {
  throw new Error("source Sepolia policy boundary mismatch");
}

mkdirSync(outputDirectory, { recursive: true });
for (const name of readdirSync(outputDirectory)) {
  if (/^UNIT-A\d{2}\.json$/.test(name)) unlinkSync(join(outputDirectory, name));
}

const records = [];
for (let index = 0; index < expectedIds.length; index += 1) {
  const artworkId = expectedIds[index];
  const sourceRecord = sourcePolicy.series[index];
  if (sourceRecord.artworkId !== artworkId || artworkId === "UNIT-A02") {
    throw new Error(
      `unexpected source policy record ${sourceRecord.artworkId}`,
    );
  }

  const verified = JSON.parse(
    execFileSync(
      process.execPath,
      [
        packageVerifierPath,
        join(packageDirectory, `${artworkId}.charity-edition.json`),
      ],
      { encoding: "utf8" },
    ),
  );
  if (
    sourceRecord.masterArtworkHash !== `0x${verified.masterArtworkSha256}` ||
    sourceRecord.metadataHash !== `0x${verified.metadataSha256}`
  ) {
    throw new Error(`${artworkId} source package/policy commitment mismatch`);
  }
  const metadata = JSON.parse(verified.canonicalMetadata);
  metadata.artfi.chainId = 84_532;
  metadata.artfi.network = "Base Sepolia";
  metadata.artfi.testnetOnly = true;
  metadata.artfi.mainnetAuthorized = false;
  if ("image" in metadata || metadata.artfi.publicArtworkPreview !== false) {
    throw new Error(`${artworkId} preview policy mismatch`);
  }

  const serialized = JSON.stringify(metadata);
  const metadataSha256 = sha256(Buffer.from(serialized));
  const metadataURI = `${publicBaseURL}/${artworkId}.json`;
  writeFileSync(join(outputDirectory, `${artworkId}.json`), serialized, "utf8");
  records.push({
    artworkId,
    artworkIdBytes32: keccak256(stringToHex(artworkId)),
    masterArtworkHash: sourceRecord.masterArtworkHash,
    metadataHash: `0x${metadataSha256}`,
    metadataURI,
    distributionWallet: sourceRecord.distributionWallet,
    editions: 100,
  });
}

const manifest = {
  schemaVersion: 1,
  namespace: "ARTFI/BASE-SEPOLIA/FORMAL-37/PREMAINNET/V1",
  status: "predeployment",
  network: "Base Sepolia",
  chainId: 84_532,
  testnetOnly: true,
  mainnetAuthorized: false,
  standard: "ERC-1155",
  contract: null,
  artworkCount: 37,
  editionsPerArtwork: 100,
  totalUnits: 3700,
  excludedArtworkIds: ["UNIT-A02"],
  initialRecipient: "0x75F6e1BAc9bF07a54FECc416ef76327BbD2c3089",
  inscriptionSha256,
  sourceSepoliaPolicySha256: sha256(sourcePolicyBytes),
  publicBaseURL,
  series: records,
  execution: {
    uniqueNonceCoordinator: "ArtFi task",
    signing: "local-offline-only",
    rpcAndBroadcast: "ArtFiChainBridge/sin/v1 only",
    publicNetworkFromSandboxForbidden: true,
    unsignedPayloadPolicy: null,
    deploymentEvidence: null,
  },
};
mkdirSync(dirname(outputManifestPath), { recursive: true });
writeFileSync(
  outputManifestPath,
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

const a02Manifest = JSON.parse(
  readFileSync(join(a02Directory, "manifest.json"), "utf8"),
);
const a02MetadataBytes = readFileSync(join(a02Directory, "metadata.json"));
if (sha256(a02MetadataBytes) !== a02Manifest.metadata.sha256) {
  throw new Error("A02 isolated metadata hash mismatch");
}
mkdirSync(dirname(a02PublicPath), { recursive: true });
writeFileSync(a02PublicPath, a02MetadataBytes);

process.stdout.write(
  `Generated ${records.length} Base Sepolia formal-test metadata documents and one isolated A02 test document.\n`,
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
