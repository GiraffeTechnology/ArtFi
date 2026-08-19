import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "artfi-mint-package-"));
try {
  const artwork = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const evidence = Buffer.from("authorized test rights fixture");
  const artworkHash = sha256(artwork);
  const evidenceHash = sha256(evidence);
  writeFileSync(join(directory, "artwork.png"), artwork);
  writeFileSync(join(directory, "rights.txt"), evidence);
  const manifest = {
    schemaVersion: 1,
    chainId: 11155111,
    recipient: "0x2222222222222222222222222222222222222222",
    marketplaceMode: "external-mirror",
    artfiExchangeEnabled: false,
    artwork: {
      title: "Authorized test fixture",
      creator: "Fixture creator",
      file: "artwork.png",
      mimeType: "image/png",
      sha256: artworkHash,
      uri: `https://assets.artfi.test/rwa/images/${artworkHash}/artwork.png`,
    },
    rights: {
      rightsHolder: "Fixture rights holder",
      basis: "creator",
      evidenceFile: "rights.txt",
      evidenceSha256: evidenceHash,
      attribution: "Fixture creator",
      nftMintAuthorized: true,
      marketplaceListingEligible: true,
      listingActionConfirmed: false,
      expiresAt: null,
    },
    metadata: { description: "Deterministic test metadata", attributes: [] },
  };
  const manifestPath = join(directory, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const output = execFileSync(
    process.execPath,
    ["scripts/release/verify-mint-package.mjs", manifestPath],
    { encoding: "utf8" },
  );
  const result = JSON.parse(output);
  if (
    result.artworkSha256 !== artworkHash ||
    !/^[0-9a-f]{64}$/.test(result.metadataSha256)
  ) {
    throw new Error("mint verifier did not reproduce immutable hashes");
  }
  manifest.artwork.sha256 = "0".repeat(64);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  let rejected = false;
  try {
    execFileSync(
      process.execPath,
      ["scripts/release/verify-mint-package.mjs", manifestPath],
      { stdio: "pipe" },
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("tampered artwork hash was accepted");
  process.stdout.write("Mint package verifier tests passed.\n");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
