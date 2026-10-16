import { describe, expect, it, vi } from "vitest";
import { rwaCatalogFixture } from "../test/rwa-catalog-fixture";
import {
  assertRwaAssetBinding,
  assertLegacyWholeSettlement,
  assertRwaTradingEvidence,
  rwaAssetIdentity,
  rwaAssetSchema,
  rwaCatalogQuery,
  type RwaTradeBinding,
} from "./rwa-catalog";
const record = rwaCatalogFixture();
const binding: RwaTradeBinding = {
  section: "whole",
  chainId: 560048,
  marketAddress: record.binding.marketAddress!,
  collectionAddress: record.binding.collectionAddress,
  tokenId: record.binding.tokenId,
};
describe("source-bound RWA catalog contract", () => {
  it("preserves valid signed mixed-case address text without imposing checksum casing", () => {
    const mixed = "0x12345678901234567890123456789012aAbB0011";
    const result = rwaAssetSchema.parse({
      ...record,
      binding: { ...record.binding, collectionAddress: mixed },
    });
    expect(result.binding.collectionAddress).toBe(mixed);
  });

  it("strips nonpublic fields at every boundary", () => {
    const value = rwaAssetSchema.parse({
      ...record,
      operatorSecret: "not-public",
      binding: { ...record.binding, internalURL: "not-public" },
      grounding: { ...record.grounding, sourcePrivateKey: "not-public" },
    });
    expect(JSON.stringify(value)).not.toContain("not-public");
  });
  it.each([
    "revoked",
    "expired",
    "source-unavailable",
    "not-yet-valid",
  ] as const)(
    "does not grant new trading authority from %s evidence",
    (status) =>
      expect(() =>
        assertRwaAssetBinding(
          { ...record, grounding: { ...record.grounding, status } },
          binding,
        ),
      ).toThrow("inactive"),
  );
  it.each([
    "marketAddress",
    "collectionAddress",
    "tokenId",
    "chainId",
  ] as const)("rejects changed token binding %s", (field) => {
    const changed = {
      ...record,
      binding: {
        ...record.binding,
        [field]:
          field === "chainId"
            ? 1
            : field === "tokenId"
              ? "2"
              : "0x1000000000000000000000000000000000000009",
      },
    };
    expect(() => assertRwaAssetBinding(changed, binding)).toThrow(
      "does not match",
    );
  });
  it("requires the same source identity and reviewed rights", () => {
    const expected = { ...binding, identity: rwaAssetIdentity(record) };
    assertRwaAssetBinding(record, expected);
    expect(() =>
      assertRwaAssetBinding(
        { ...record, rights: "Changed source rights" },
        expected,
      ),
    ).toThrow("rights changed");
    expect(() =>
      assertRwaAssetBinding(
        {
          ...record,
          grounding: { ...record.grounding, sourceId: "different-source" },
        },
        expected,
      ),
    ).toThrow("identity");
  });
  it("does not substitute whole receipt evidence for a fraction binding", () =>
    expect(() =>
      assertRwaAssetBinding(record, {
        ...binding,
        section: "fractional",
        fractionTokenAddress: record.binding.collectionAddress,
      }),
    ).toThrow());
  it.each([
    "unknown=value",
    "section=nft",
    "page=0",
    "pageSize=51",
    "page=1&page=2",
    "sort=private",
    "collectionAddress=invalid",
    "tokenId=-1",
    "q=%00",
  ])("rejects unsupported query %s", (query) =>
    expect(() => rwaCatalogQuery(new URLSearchParams(query))).toThrow(),
  );
  it("preserves only supported bounded queries", () =>
    expect(
      String(
        rwaCatalogQuery(
          new URLSearchParams({
            section: "whole",
            q: "studio",
            sort: "title",
            page: "2",
            pageSize: "12",
          }),
        ),
      ),
    ).toBe("section=whole&q=studio&sort=title&page=2&pageSize=12"));
  it("rechecks the exact approved source record without credentials or cached results", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(record));
    expect(
      await assertRwaTradingEvidence(
        { ...binding, slug: record.slug },
        fetcher,
      ),
    ).toEqual(record);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/rwa/assets/${record.slug}`,
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      }),
    );
  });
  it("requires unique source correspondence when resolving a configured token", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [record], total: 1, page: 1, pageSize: 2 }),
    );
    await assertRwaTradingEvidence(binding, fetcher);
    expect(fetcher.mock.calls[0][0]).toContain("collectionAddress=");
    for (const total of [0, 2]) {
      fetcher.mockResolvedValueOnce(
        Response.json({
          data: total ? [record, record] : [],
          total,
          page: 1,
          pageSize: 2,
        }),
      );
      await expect(assertRwaTradingEvidence(binding, fetcher)).rejects.toThrow(
        "unique",
      );
    }
  });
  it("never grants new authority when the source read fails", async () => {
    await expect(
      assertRwaTradingEvidence(binding, async () =>
        Response.json(
          { detail: "private upstream explanation" },
          { status: 503 },
        ),
      ),
    ).rejects.toThrow("No new wallet action");
  });
});

describe("registry receipt versus legacy direct settlement", () => {
  it("preserves non-registry whole assets and registry-backed fractions", () => {
    expect(() => assertLegacyWholeSettlement(record)).not.toThrow();
    expect(() =>
      assertLegacyWholeSettlement({
        ...record,
        section: "fractional",
        grounding: { ...record.grounding, registryBacked: true },
      }),
    ).not.toThrow();
  });
  it("refuses a registry receipt without consulting owner/holder equality or a second receipt", () => {
    expect(() =>
      assertLegacyWholeSettlement({
        ...record,
        grounding: { ...record.grounding, registryBacked: true },
      }),
    ).toThrow("already-frozen funds");
  });
  it("does not allow a contradictory false flag to hide the source registry record", () => {
    expect(() =>
      assertLegacyWholeSettlement({
        ...record,
        grounding: {
          ...record.grounding,
          registryRecord: {
            reference: "registered",
            version: "2",
            observedAt: 1,
          },
        },
      }),
    ).toThrow("registry-backed receipt");
  });
  it("invalidates reviewed identity when the registration classification or reference changes", () => {
    const registry = {
      ...record,
      grounding: {
        ...record.grounding,
        registryBacked: true,
        registryRecord: {
          reference: "registered",
          version: "2",
          observedAt: 1,
        },
      },
    };
    const expected = { ...binding, identity: rwaAssetIdentity(record) };
    expect(() => assertRwaAssetBinding(registry, expected)).toThrow("identity");
    const selected = { ...binding, identity: rwaAssetIdentity(registry) };
    for (const field of ["reference", "version"] as const) {
      const changed = structuredClone(registry);
      changed.grounding.registryRecord[field] = "changed";
      expect(() => assertRwaAssetBinding(changed, selected)).toThrow(
        "identity",
      );
    }
  });
  it("rechecks current source state before any fresh-payment callback", async () => {
    const action = vi.fn();
    const current = {
      ...record,
      grounding: { ...record.grounding, registryBacked: true },
    };
    const run = async () => {
      const fresh = await assertRwaTradingEvidence(
        { ...binding, slug: record.slug },
        async () => Response.json(current),
      );
      assertLegacyWholeSettlement(fresh);
      action();
    };
    await expect(run()).rejects.toThrow("already-frozen funds");
    expect(action).not.toHaveBeenCalled();
  });
});
