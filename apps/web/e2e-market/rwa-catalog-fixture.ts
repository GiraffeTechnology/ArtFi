import type { Page } from "@playwright/test";
import type { RwaAsset } from "../src/lib/rwa-catalog";
export function isolatedSourceAsset(
  section: "whole" | "fractional" = "whole",
): RwaAsset {
  return {
    slug: section === "whole" ? "test-whole-record" : "test-fraction-record",
    title:
      section === "whole"
        ? "TEST ONLY source-bound receipt"
        : "TEST ONLY source-bound fractions",
    artist: "Isolated artist",
    year: 2026,
    medium: "Isolated test metadata",
    location: "Isolated test environment",
    description:
      "Isolated synthetic source correspondence record, never a real-world claim.",
    section,
    rights:
      "TEST ONLY bounded receipt or participation rights. No real asset or financial value.",
    provenance: ["Isolated approved-source fixture"],
    binding: {
      chainId: 560048,
      collectionAddress:
        section === "whole"
          ? "0x1000000000000000000000000000000000000002"
          : "0x1000000000000000000000000000000000000007",
      tokenId: section === "whole" ? "1" : "2",
      underlyingAssetId: `TEST_ONLY-${section}-asset`,
      marketAddress:
        section === "whole"
          ? "0x1000000000000000000000000000000000000001"
          : "0x1000000000000000000000000000000000000003",
      ...(section === "fractional"
        ? {
            fractionTokenAddress: "0x1000000000000000000000000000000000000004",
            vaultAddress: "0x1000000000000000000000000000000000000008",
          }
        : {}),
    },
    grounding: {
      status: "verified",
      mode: "TEST_ONLY",
      sourceId: "isolated-source",
      sourceName: "Isolated correspondence fixture",
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
export async function isolatedSourceCatalog(
  page: Page,
  assets = [isolatedSourceAsset("whole"), isolatedSourceAsset("fractional")],
) {
  const state = { assets, status: 200, reads: 0 };
  await page.route("**/api/rwa/assets**", async (route) => {
    state.reads++;
    if (state.status !== 200) {
      await route.fulfill({
        status: state.status,
        json: { detail: "Isolated source is unavailable." },
      });
      return;
    }
    const url = new URL(route.request().url());
    const suffix = url.pathname.replace("/api/rwa/assets", "");
    if (suffix) {
      if (suffix.endsWith("/oracle") || suffix.endsWith("/projection")) {
        await route.fulfill({
          status: 503,
          json: {
            ok: false,
            code: suffix.endsWith("/oracle")
              ? "ORACLE_NOT_CONFIGURED"
              : "ORACLE_NOT_CONFIGURED",
          },
        });
        return;
      }
      const found = state.assets.find((asset) => `/${asset.slug}` === suffix);
      await route.fulfill({
        status: found ? 200 : 404,
        json: found ?? { detail: "Unknown isolated asset" },
      });
      return;
    }
    const q = url.searchParams;
    let matched = state.assets.filter(
      (asset) =>
        (!q.get("section") || asset.section === q.get("section")) &&
        (!q.get("fractionTokenAddress") ||
          asset.binding.fractionTokenAddress?.toLowerCase() ===
            q.get("fractionTokenAddress")?.toLowerCase()) &&
        (!q.get("collectionAddress") ||
          asset.binding.collectionAddress.toLowerCase() ===
            q.get("collectionAddress")?.toLowerCase()) &&
        (!q.get("tokenId") || asset.binding.tokenId === q.get("tokenId")) &&
        (!q.get("q") ||
          asset.title.toLowerCase().includes(q.get("q")!.toLowerCase())),
    );
    if (q.get("sort") === "title")
      matched = matched.toSorted((a, b) => a.title.localeCompare(b.title));
    const pageNumber = Number(q.get("page") || 1),
      pageSize = Number(q.get("pageSize") || 20);
    await route.fulfill({
      json: {
        data: matched.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
        total: matched.length,
        page: pageNumber,
        pageSize,
      },
    });
  });
  return state;
}
