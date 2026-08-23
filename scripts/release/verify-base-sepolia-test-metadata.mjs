import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const webRequire = createRequire(join(repositoryRoot, "apps/web/package.json"));
const { keccak256, stringToHex } = webRequire("viem");

const metadataDirectory = join(
  repositoryRoot,
  "apps/web/public/nft/metadata/base-sepolia/ye-yongrun",
);
const manifest = JSON.parse(
  readFileSync(
    join(
      repositoryRoot,
      "release/testnet/base-sepolia/formal-37/manifest.json",
    ),
    "utf8",
  ),
);
const expectedIds = [
  "UNIT-A01",
  ...Array.from(
    { length: 36 },
    (_, offset) => `UNIT-A${String(offset + 3).padStart(2, "0")}`,
  ),
];
const files = readdirSync(metadataDirectory)
  .filter((name) => /^UNIT-A\d{2}\.json$/.test(name))
  .sort();

assert(manifest.chainId === 84_532, "manifest chain ID must be Base Sepolia");
assert(manifest.testnetOnly === true, "manifest must be testnet-only");
assert(
  manifest.mainnetAuthorized === false,
  "mainnet must remain unauthorized",
);
assert(manifest.contract === null, "predeployment contract must remain unset");
assert(manifest.artworkCount === 37, "artwork count must be 37");
assert(manifest.totalUnits === 3700, "unit count must be 3700");
assert(
  manifest.excludedArtworkIds.join(",") === "UNIT-A02",
  "UNIT-A02 must remain excluded",
);
assert(files.length === 37, "metadata document count must be 37");
assert(!files.includes("UNIT-A02.json"), "formal A02 metadata is forbidden");

const masterHashes = new Set();
const metadataHashes = new Set();
for (let index = 0; index < expectedIds.length; index += 1) {
  const artworkId = expectedIds[index];
  assert(files[index] === `${artworkId}.json`, `${artworkId} metadata missing`);
  const bytes = readFileSync(join(metadataDirectory, files[index]));
  const metadata = JSON.parse(bytes.toString("utf8"));
  const record = manifest.series[index];
  assert(record.artworkId === artworkId, `${artworkId} order mismatch`);
  assert(
    record.artworkIdBytes32 === keccak256(stringToHex(artworkId)),
    `${artworkId} ID hash mismatch`,
  );
  assert(
    record.metadataHash === `0x${sha256(bytes)}`,
    `${artworkId} metadata hash mismatch`,
  );
  assert(
    record.metadataURI === `${manifest.publicBaseURL}/${artworkId}.json`,
    `${artworkId} metadata URI mismatch`,
  );
  assert(metadata.artfi.chainId === 84_532, `${artworkId} chain mismatch`);
  assert(
    metadata.artfi.network === "Base Sepolia",
    `${artworkId} network mismatch`,
  );
  assert(
    metadata.artfi.testnetOnly === true,
    `${artworkId} test boundary missing`,
  );
  assert(
    metadata.artfi.mainnetAuthorized === false,
    `${artworkId} mainnet boundary missing`,
  );
  assert(!("image" in metadata), `${artworkId} image field forbidden`);
  assert(
    metadata.inscription.sha256 === manifest.inscriptionSha256,
    `${artworkId} inscription hash mismatch`,
  );
  masterHashes.add(record.masterArtworkHash);
  metadataHashes.add(record.metadataHash);
}
assert(masterHashes.size === 37, "master hashes must be unique");
assert(metadataHashes.size === 37, "metadata hashes must be unique");

const a02Manifest = JSON.parse(
  readFileSync(
    join(
      repositoryRoot,
      "release/testnet/base-sepolia/a02-rwa-dao/manifest.json",
    ),
    "utf8",
  ),
);
const a02PublicBytes = readFileSync(
  join(
    repositoryRoot,
    "apps/web/public/nft/metadata/base-sepolia/test-only/a02.json",
  ),
);
const a02Metadata = JSON.parse(a02PublicBytes.toString("utf8"));
assert(a02Manifest.chainId === 84_532, "A02 chain mismatch");
assert(a02Manifest.testnetOnly === true, "A02 must be testnet-only");
assert(a02Manifest.mainnetForbidden === true, "A02 mainnet gate missing");
assert(a02Manifest.formalReleaseMember === false, "A02 formal release leak");
assert(
  sha256(a02PublicBytes) === a02Manifest.metadata.sha256,
  "A02 public metadata hash mismatch",
);
assert(!("image" in a02Metadata), "A02 image field forbidden");

process.stdout.write(
  `${JSON.stringify({
    verified: true,
    chainId: 84_532,
    formalArtworkCount: 37,
    formalUnits: 3700,
    excludedArtworkIds: ["UNIT-A02"],
    isolatedA02TestUnits: 100,
    mainnetStateChanges: 0,
  })}\n`,
);

function assert(value, message) {
  if (!value) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
