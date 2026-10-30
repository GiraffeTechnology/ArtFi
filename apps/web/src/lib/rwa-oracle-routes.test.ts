import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GET as catalog } from "../app/api/rwa/assets/route";
import { GET as oracle } from "../app/api/rwa/assets/[slug]/oracle/route";
import { GET as projection } from "../app/api/rwa/assets/[slug]/projection/route";
import { oracleReadResponseSchema } from "./oracle-read-model";
import { projectionReadResponseSchema } from "./oracle-projection-model";
import {
  sourceOracleAsset,
  sourceOracleReads,
  startSourceOracleFixture,
} from "../test/rwa-oracle-source-fixture";

let fixture: Awaited<ReturnType<typeof startSourceOracleFixture>>;
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const request = (path: string) =>
  new Request(`https://artfi.example/api/rwa/assets${path}`, {
    headers: {
      cookie: "TEST_ONLY-browser-session",
      authorization: "Bearer TEST_ONLY-browser-identity",
    },
  });
beforeAll(async () => {
  fixture = await startSourceOracleFixture();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(() => {
  fixture.reads.length = 0;
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("ARTFI_API_URL", `${fixture.origin}/catalog/`);
  vi.stubEnv("ARTFI_ORACLE_READ_API_URL", `${fixture.origin}/oracle/`);
  // A catalog record must work independently of the legacy sample binding.
  vi.stubEnv("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG", "blue-hour-archive");
  vi.stubEnv("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID", "1");
  vi.stubEnv(
    "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS",
    "0x1000000000000000000000000000000000000002",
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("published source-catalog Oracle wrappers over isolated HTTP upstreams", () => {
  it.each(["whole", "fractional"] as const)(
    "uses the published %s record for both real wrappers",
    async (section) => {
      const record = sourceOracleAsset(section);
      const catalogResponse = await catalog(
        request(`?section=${section}&pageSize=12`),
      );
      expect(catalogResponse.status).toBe(200);
      const published = await catalogResponse.json();
      expect(published.data).toEqual([record]);
      const slug = published.data[0].slug;

      const oracleResponse = await oracle(
        request(`/${slug}/oracle`),
        params(slug),
      );
      expect(oracleResponse.status).toBe(200);
      expect(oracleResponse.headers.get("cache-control")).toBe("no-store");
      const oracleBody = await oracleResponse.json();
      expect(oracleReadResponseSchema.parse(oracleBody)).toEqual({
        ok: true,
        ...sourceOracleReads(record),
        readAt: expect.any(String),
      });

      const projectionResponse = await projection(
        request(`/${slug}/projection?instant=1500`),
        params(slug),
      );
      expect(projectionResponse.status).toBe(200);
      expect(projectionResponse.headers.get("cache-control")).toBe("no-store");
      expect(
        projectionReadResponseSchema.parse(await projectionResponse.json()),
      ).toMatchObject({
        ok: true,
        tokenId: record.binding.tokenId,
        instant: "1500",
        source: {
          chainId: "560048",
          contract: record.binding.collectionAddress,
        },
        entry: {
          ok: true,
          value: { version: "2", effectiveAt: "0", supersededAt: "0" },
        },
        holder: { ok: true, value: `0x${"1".repeat(40)}` },
        position: { ok: true, value: `0x${"2".repeat(40)}` },
        finality: { ok: true, value: true },
      });
      const { tokenId, collectionAddress, chainId, assetId } = record.binding;
      const paths = fixture.reads.map((read) => read.path);
      expect(paths).toHaveLength(11);
      expect(paths.slice(0, 6)).toEqual([
        `/catalog/v1/rwa/assets?section=${section}&pageSize=12`,
        `/catalog/v1/rwa/assets/${slug}`,
        `/oracle/v1/rwa/tokens/${chainId}/${collectionAddress}/${tokenId}`,
        `/oracle/v1/rwa/assets/${assetId}`,
        `/catalog/v1/rwa/assets/${slug}`,
        `/oracle/v1/oracle/projection/${tokenId}`,
      ]);
      // The four independent observations may arrive in any network order.
      expect(paths.slice(6, 10).sort()).toEqual(
        [
          `/oracle/v1/oracle/projection/${tokenId}/entry/as-of/1500`,
          `/oracle/v1/oracle/projection/${tokenId}/holder/as-of/1500`,
          `/oracle/v1/oracle/projection/${tokenId}/finality/as-of/1500`,
          `/oracle/v1/oracle/projection/${tokenId}/position`,
        ].sort(),
      );
      expect(paths[10]).toBe(`/oracle/v1/oracle/projection/${tokenId}`);
      expect(
        fixture.reads.every(
          (read) => read.method === "GET" && !read.hasIdentity,
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["oracle", oracle, ""],
    ["projection", projection, "?instant=1500"],
  ] as const)(
    "does not replace a missing catalog record in %s with a sample",
    async (kind, route, query) => {
      const result = await route(
        request(`/unknown-record/${kind}${query}`),
        params("unknown-record"),
      );
      expect(result.status).toBe(404);
      expect(await result.json()).toEqual({ ok: false, code: "UNKNOWN_ASSET" });
      expect(fixture.reads.map((read) => read.path)).toEqual([
        "/catalog/v1/rwa/assets/unknown-record",
      ]);
    },
  );

  it.each([
    ["oracle", oracle, "?tokenId=1", "UNKNOWN_ASSET"],
    ["projection", projection, "?instant=1500&instant=1600", "INSTANT_INVALID"],
  ] as const)(
    "retains the %s wrapper query contract before any upstream read",
    async (kind, route, query, code) => {
      const slug = sourceOracleAsset().slug;
      const result = await route(
        request(`/${slug}/${kind}${query}`),
        params(slug),
      );
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ ok: false, code });
      expect(fixture.reads).toEqual([]);
    },
  );
});
