import type { RwaAsset } from "../lib/rwa-catalog";
export function rwaCatalogFixture(): RwaAsset {
  return {
    slug: "isolated-real-record",
    title: "TEST ONLY source record",
    artist: "Isolated artist",
    year: 2026,
    medium: "Synthetic metadata",
    location: "Isolated environment",
    description:
      "An isolated correspondence record with no real asset or financial meaning.",
    section: "whole",
    rights:
      "TEST ONLY receipt rights with no actual claim or real financial value.",
    provenance: ["Isolated approved source evidence"],
    binding: {
      chainId: 560048,
      collectionAddress: "0x1000000000000000000000000000000000000002",
      tokenId: "1",
      assetId: "test_artwork_1",
      underlyingAssetId: "TEST_ONLY-underlying-asset",
      marketAddress: "0x1000000000000000000000000000000000000001",
    },
    grounding: {
      status: "verified",
      mode: "TEST_ONLY",
      sourceId: "isolated-source",
      sourceName: "Isolated source",
      sourceKind: "custody",
      sourceReference: "https://evidence.invalid/TEST_ONLY",
      evidenceSha256: "1".repeat(64),
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2027-01-01T00:00:00Z",
      verifiedAt: "2026-10-05T00:00:00Z",
      registryBacked: false,
    },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
    revision: 1,
  };
}
