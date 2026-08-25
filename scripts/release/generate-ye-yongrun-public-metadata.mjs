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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const webRequire = createRequire(join(repositoryRoot, "apps/web/package.json"));
const { keccak256, stringToHex } = webRequire("viem");

const batchDirectory = join(
  repositoryRoot,
  "release/mint-batches/ye-yongrun-unit-a01-a38",
);
const packageDirectory = join(batchDirectory, "packages");
const outputDirectory = join(
  repositoryRoot,
  "apps/web/public/nft/metadata/hoodi/ye-yongrun",
);
const verifierPath = join(
  repositoryRoot,
  "scripts/release/verify-charity-edition-package.mjs",
);
const expectedIds = [
  "UNIT-A01",
  ...Array.from(
    { length: 36 },
    (_, offset) => `UNIT-A${String(offset + 3).padStart(2, "0")}`,
  ),
];

mkdirSync(outputDirectory, { recursive: true });
for (const name of readdirSync(outputDirectory)) {
  if (/^UNIT-A\d{2}\.json$/.test(name)) {
    unlinkSync(join(outputDirectory, name));
  }
}

const packageFiles = readdirSync(packageDirectory)
  .filter((name) => /^UNIT-A\d{2}\.charity-edition\.json$/.test(name))
  .sort();
if (packageFiles.length !== 37) {
  throw new Error(`expected 37 release packages, found ${packageFiles.length}`);
}

const records = [];
for (let index = 0; index < packageFiles.length; index += 1) {
  const packageFile = packageFiles[index];
  const artworkId = packageFile.replace(".charity-edition.json", "");
  if (artworkId !== expectedIds[index] || artworkId === "UNIT-A02") {
    throw new Error(`unexpected release package ${packageFile}`);
  }
  const packagePath = join(packageDirectory, packageFile);
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  const verified = JSON.parse(
    execFileSync(process.execPath, [verifierPath, packagePath], {
      encoding: "utf8",
    }),
  );
  const expectedURI = `https://io.artcch.com/nft/metadata/hoodi/ye-yongrun/${artworkId}.json`;
  if (
    verified.artworkId !== artworkId ||
    manifest.metadata.publicURI !== expectedURI ||
    verified.canonicalMetadata.includes('"image"')
  ) {
    throw new Error(`${artworkId} public metadata policy mismatch`);
  }
  const outputPath = join(outputDirectory, `${artworkId}.json`);
  writeFileSync(outputPath, verified.canonicalMetadata, "utf8");
  const written = readFileSync(outputPath);
  const writtenSha256 = sha256(written);
  if (writtenSha256 !== verified.metadataSha256) {
    throw new Error(`${artworkId} metadata write changed canonical bytes`);
  }
  records.push({
    artworkId,
    artworkIdBytes32: keccak256(stringToHex(artworkId)),
    masterArtworkHash: `0x${verified.masterArtworkSha256}`,
    metadataHash: `0x${verified.metadataSha256}`,
    metadataURI: expectedURI,
    distributionWallet: manifest.series.distributionWallet,
    editions: 100,
  });
}

const index = {
  schemaVersion: 1,
  batchId: "ye-yongrun-unit-a01-a38",
  status: "blocked-pre-mint",
  chainId: 560048,
  standard: "ERC-1155",
  packageCount: 37,
  totalUnits: 3700,
  excludedArtworkIds: ["UNIT-A02"],
  inscriptionSha256:
    "1c4e8260508e6f74c2e8bbd237e1f3d41f49d4c4ed7c7a0ca0f0df9162a66f01",
  publicBaseURL: "https://io.artcch.com/nft/metadata/hoodi/ye-yongrun",
  series: records,
};
writeFileSync(
  join(batchDirectory, "mint-policy-series.json"),
  `${JSON.stringify(index, null, 2)}\n`,
  "utf8",
);

process.stdout.write(
  `Generated ${records.length} no-preview metadata documents for ${index.totalUnits} ERC-1155 units.\n`,
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
