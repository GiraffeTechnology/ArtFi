import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
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
const metadataDirectory = join(
  repositoryRoot,
  "apps/web/public/nft/metadata/sepolia/ye-yongrun",
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
const policy = JSON.parse(
  readFileSync(join(batchDirectory, "mint-policy-series.json"), "utf8"),
);
const packageFiles = readdirSync(packageDirectory)
  .filter((name) => /^UNIT-A\d{2}\.charity-edition\.json$/.test(name))
  .sort();
const metadataFiles = readdirSync(metadataDirectory)
  .filter((name) => /^UNIT-A\d{2}\.json$/.test(name))
  .sort();

assert(policy.chainId === 11_155_111, "policy must target Base Sepolia");
assert(policy.standard === "ERC-1155", "policy must use ERC-1155");
assert(policy.packageCount === 37, "policy package count must be 37");
assert(policy.totalUnits === 3700, "policy unit count must be 3700");
assert(
  policy.excludedArtworkIds.join(",") === "UNIT-A02",
  "policy must exclude UNIT-A02",
);
assert(packageFiles.length === 37, "release package count must be 37");
assert(metadataFiles.length === 37, "public metadata count must be 37");
assert(
  !packageFiles.includes("UNIT-A02.charity-edition.json") &&
    !metadataFiles.includes("UNIT-A02.json"),
  "UNIT-A02 must not have release metadata",
);

const masterHashes = new Set();
const metadataHashes = new Set();
for (let index = 0; index < expectedIds.length; index += 1) {
  const artworkId = expectedIds[index];
  assert(
    packageFiles[index] === `${artworkId}.charity-edition.json`,
    `${artworkId} release package is missing`,
  );
  assert(
    metadataFiles[index] === `${artworkId}.json`,
    `${artworkId} metadata document is missing`,
  );
  const packagePath = join(packageDirectory, packageFiles[index]);
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  const verified = JSON.parse(
    execFileSync(process.execPath, [verifierPath, packagePath], {
      encoding: "utf8",
    }),
  );
  const metadataBytes = readFileSync(
    join(metadataDirectory, metadataFiles[index]),
  );
  const record = policy.series[index];
  assert(record.artworkId === artworkId, `${artworkId} policy order mismatch`);
  assert(
    record.artworkIdBytes32 === keccak256(stringToHex(artworkId)),
    `${artworkId} artwork ID hash mismatch`,
  );
  assert(
    record.masterArtworkHash === `0x${verified.masterArtworkSha256}`,
    `${artworkId} master hash mismatch`,
  );
  assert(
    record.metadataHash === `0x${verified.metadataSha256}`,
    `${artworkId} metadata hash mismatch`,
  );
  assert(
    record.metadataURI === manifest.metadata.publicURI,
    `${artworkId} metadata URI mismatch`,
  );
  assert(
    record.distributionWallet === manifest.series.distributionWallet,
    `${artworkId} recipient mismatch`,
  );
  assert(
    metadataBytes.toString("utf8") === verified.canonicalMetadata &&
      sha256(metadataBytes) === verified.metadataSha256,
    `${artworkId} public metadata bytes changed`,
  );
  assert(
    !verified.canonicalMetadata.includes('"image"') &&
      verified.canonicalMetadata.includes('"publicArtworkPreview":false') &&
      verified.canonicalMetadata.includes(
        `"sha256":"${policy.inscriptionSha256}"`,
      ),
    `${artworkId} no-preview inscription policy mismatch`,
  );
  masterHashes.add(record.masterArtworkHash);
  metadataHashes.add(record.metadataHash);
}
assert(masterHashes.size === 37, "master artwork hashes must be unique");
assert(metadataHashes.size === 37, "metadata hashes must be unique");

process.stdout.write(
  `${JSON.stringify({
    verified: true,
    chainId: 84532,
    standard: "ERC-1155",
    artworkCount: 37,
    totalUnits: 3700,
    excludedArtworkIds: ["UNIT-A02"],
    metadataDocuments: 37,
    publicArtworkPreviews: 0,
  })}\n`,
);

function assert(value, message) {
  if (!value) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
