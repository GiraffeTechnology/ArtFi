// TEST_ONLY public read data. No live asset, registry, holder, or warehouse claim.
export const oracleFixtureContract =
  "0x1000000000000000000000000000000000000002";
export function oracleReadFixtures() {
  const certificate = {
    assetId: "test_artwork_1",
    tokenId: "1",
    certificateVersion: 2,
    certificateHash: "a".repeat(64),
    previousCertificateHash: "b".repeat(64),
    wenbaoChangeRef: "TEST_ONLY-change-2",
    warehouseReceiptHash: "c".repeat(64),
    effectiveAt: "2026-10-01T10:00:00Z",
    supersededAt: null,
    status: "CURRENT" as const,
  };
  return {
    token: {
      binding: {
        chainId: "560048",
        contract: oracleFixtureContract,
        tokenId: "1",
        assetId: "test_artwork_1",
      },
      status: "VALID" as const,
      currentCertificate: { ...certificate },
    },
    asset: {
      asset: {
        assetId: "test_artwork_1",
        assetFingerprintHash: "d".repeat(64),
        wenbaoRegistryRef: "TEST_ONLY-registry-reference",
        transferEligibility: "VALID" as const,
        warehouseReceiptHash: "c".repeat(64),
        currentCertificateHash: "a".repeat(64),
        currentCertificateVersion: 2,
        encumbranceStatus: "NONE",
        oracleStatus: "VALID" as const,
        updatedAt: "2026-10-01T10:00:00Z",
      },
      status: "VALID" as const,
      currentCertificate: { ...certificate },
      warehouse: {
        assetId: "test_artwork_1",
        warehouseReceiptHash: "c".repeat(64),
        warehouseStatus: "IN_CUSTODY" as const,
        encumbranceStatus: "NONE",
        observedAt: "2026-10-01T09:30:00Z",
      },
    },
  };
}
