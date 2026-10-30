import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rwaCatalogFixture } from "../test/rwa-catalog-fixture";
import { readRwaAsset, readRwaCatalog } from "./rwa-catalog-server";
import { GET as list } from "../app/api/rwa/assets/route";
import { GET as detail } from "../app/api/rwa/assets/[slug]/route";
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv("ARTFI_API_URL", "https://api.example.test/existing-bridge/");
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("public RWA catalog relay", () => {
  it("preserves the deployment prefix and forwards no browser identity or cookies", async () => {
    fetcher.mockResolvedValue(
      Response.json({
        data: [rwaCatalogFixture()],
        total: 1,
        page: 1,
        pageSize: 12,
      }),
    );
    const response = await list(
      new Request(
        "https://artfi.example/api/rwa/assets?section=whole&pageSize=12",
        {
          headers: {
            cookie: "private-session",
            authorization: "Bearer private-token",
          },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://api.example.test/existing-bridge/v1/rwa/assets?section=whole&pageSize=12",
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: "omit",
      headers: { accept: "application/json" },
      redirect: "error",
    });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("private-");
  });
  it("rejects unsupported or repeated queries before reading the backend", async () => {
    expect(
      (
        await list(
          new Request(
            "https://artfi.example/api/rwa/assets?target=https://other.example",
          ),
        )
      ).status,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps absent source configuration distinct from empty live inventory", async () => {
    vi.stubEnv("ARTFI_API_URL", "");
    await expect(readRwaCatalog(new URLSearchParams())).rejects.toMatchObject({
      status: 503,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects another product section rather than remapping its meaning", async () => {
    fetcher.mockResolvedValue(
      Response.json({
        data: [rwaCatalogFixture()],
        total: 1,
        page: 1,
        pageSize: 12,
      }),
    );
    await expect(
      readRwaCatalog(new URLSearchParams({ section: "fractional" })),
    ).rejects.toThrow("another product");
  });
  it("binds detail to the exact slug and strips nonpublic extras", async () => {
    const record = rwaCatalogFixture();
    fetcher.mockResolvedValue(
      Response.json({ ...record, operatorSecret: "do-not-echo" }),
    );
    const result = await readRwaAsset(record.slug);
    expect(result).toEqual(record);
    fetcher.mockResolvedValue(
      Response.json({ ...record, slug: "another-record" }),
    );
    await expect(readRwaAsset(record.slug)).rejects.toThrow("different");
  });
  it.each(["../admin", "https://other.example", "invalid/slug"])(
    "rejects ambiguous detail path %s",
    async (slug) => {
      await expect(readRwaAsset(slug)).rejects.toMatchObject({ status: 404 });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("does not forward detail query parameters", async () => {
    const result = await detail(
      new Request("https://artfi.example/api/rwa/assets/isolated?tokenId=2"),
      { params: Promise.resolve({ slug: "isolated" }) },
    );
    expect(result.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds errors and missing records without echoing backend data", async () => {
    fetcher.mockResolvedValue(
      new Response("private topology", { status: 404 }),
    );
    await expect(readRwaAsset("isolated")).rejects.toMatchObject({
      status: 404,
    });
    fetcher.mockResolvedValue(
      new Response("private topology", { status: 500 }),
    );
    await expect(readRwaAsset("isolated")).rejects.toMatchObject({
      status: 503,
    });
  });
  it("rejects malformed and oversized backend data", async () => {
    fetcher.mockResolvedValue(Response.json({ incomplete: true }));
    await expect(readRwaAsset("isolated")).rejects.toMatchObject({
      status: 503,
    });
    fetcher.mockResolvedValue(
      new Response("a".repeat(1024 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(readRwaAsset("isolated")).rejects.toMatchObject({
      status: 503,
    });
  });
});
