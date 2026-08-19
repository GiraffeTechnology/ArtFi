import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [path, mode] = process.argv.slice(2);
if (!path)
  throw new Error("usage: verify-release.mjs <manifest.json> [--schema-only]");
const manifest = JSON.parse(readFileSync(path, "utf8"));
const address = /^0x[0-9a-fA-F]{40}$/;
const hash = /^[0-9a-f]{64}$/;

if (manifest.chainId !== 11_155_111 || manifest.mainnetApproved !== false) {
  throw new Error(
    "release candidates must remain Sepolia-only and mainnet-disabled",
  );
}
if (
  manifest.marketplaceMode !== "external-mirror" ||
  manifest.artfiExchangeEnabled !== false ||
  !Array.isArray(manifest.approvedMarketplaceSources) ||
  manifest.approvedMarketplaceSources.length === 0
) {
  throw new Error(
    "this release must remain an approved-source external mirror with the ArtFi exchange disabled",
  );
}
if (!manifest.pilot?.enabled || !Array.isArray(manifest.deployments)) {
  throw new Error("a capped pilot and deployment array are required");
}
for (const deployment of manifest.deployments) {
  if (
    !address.test(deployment.address) ||
    !hash.test(deployment.bytecodeSha256)
  ) {
    throw new Error("deployment address/bytecode evidence is invalid");
  }
}
if (mode !== "--schema-only") {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (manifest.releaseCommit !== head)
    throw new Error("manifest does not match the release commit");
  for (const value of Object.values(manifest.artifacts ?? {})) {
    if (!hash.test(value))
      throw new Error("release artifact hashes are incomplete");
  }
  if (
    manifest.independentAudit?.status !== "approved" ||
    !hash.test(manifest.independentAudit.reportSha256)
  ) {
    throw new Error("independent audit approval is missing");
  }
  if (
    manifest.legalApproval?.status !== "approved" ||
    !hash.test(manifest.legalApproval.referenceHash)
  ) {
    throw new Error("legal approval is missing");
  }
  if (
    manifest.goNoGo?.status !== "approved" ||
    manifest.goNoGo.approvedBy.length < 2
  ) {
    throw new Error("separated go/no-go approval is missing");
  }
}
process.stdout.write(
  `Release manifest validation passed (${mode === "--schema-only" ? "schema" : "full gate"}).\n`,
);
