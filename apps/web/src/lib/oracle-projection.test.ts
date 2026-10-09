import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/assets/[slug]/projection/route";
import {
  projectionFixture,
  projectionSourceFixture,
} from "../test/oracle-projection-fixtures";
import { readWholeArtworkProjection } from "./oracle-projection";
import {
  projectionReadResponseSchema,
  projectionUint64,
  projectionUint256,
} from "./oracle-projection-model";

const slug = "blue-hour-archive";
const fetchMock = vi.fn<typeof fetch>();
const fixture = projectionFixture();
const entry = fixture.entry.ok ? fixture.entry.value : null;
function response(
  url: string,
  mutate?: (body: Record<string, unknown>, url: string) => void,
) {
  const suffix = new URL(url).pathname.split("/projection/")[1];
  const [tokenId, ...rest] = suffix.split("/");
  const tail = rest.join("/");
  const body: Record<string, unknown> = {
    tokenId,
    source: { ...projectionSourceFixture },
  };
  if (!tail)
    Object.assign(body, {
      registerId: projectionSourceFixture.registerId,
      entryCount: "2",
    });
  else if (tail === "position")
    Object.assign(body, {
      tradeablePosition: `0x${"2".repeat(40)}`,
      positionSource: "erc-721",
    });
  else {
    body.instant = rest.at(-1);
    if (tail.startsWith("entry/"))
      body.entry = {
        ...entry,
        ...(BigInt(String(body.instant)) >= 2000n ? { supersededAt: "0" } : {}),
      };
    if (tail.startsWith("holder/")) body.holder = `0x${"1".repeat(40)}`;
    if (tail.startsWith("finality/")) body.final = true;
  }
  mutate?.(body, url);
  return Response.json(body);
}
function serve(mutate?: (body: Record<string, unknown>, url: string) => void) {
  fetchMock.mockImplementation(async (url) => response(String(url), mutate));
}
beforeEach(() => {
  vi.stubEnv(
    "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS",
    projectionSourceFixture.contract,
  );
  vi.stubEnv("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID", "1");
  vi.stubEnv("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG", slug);
  vi.stubEnv(
    "ARTFI_ORACLE_READ_API_URL",
    "https://oracle.example.test/existing-bridge/",
  );
  vi.stubGlobal("fetch", fetchMock);
  serve();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fetchMock.mockReset();
});

describe("Oracle-owned temporal projection consumption", () => {
  it("reads only the Oracle GET API, keeps holder/owner/finality separate, and strips private fields", async () => {
    serve((body) => {
      body.internal = "private";
      Object.assign(body.source as object, { secret: "private" });
      if (body.entry)
        Object.assign(body.entry as object, { rawRecord: "private" });
    });
    const result = await readWholeArtworkProjection(slug, "1500");
    expect(result).toMatchObject({ ...fixture, readAt: expect.any(String) });
    expect(projectionReadResponseSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(
        /^https:\/\/oracle.example.test\/existing-bridge\/v1\/oracle\/projection\/1(?:\/|$)/,
      );
      expect(options).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      });
      expect(options).not.toHaveProperty("body");
    }
  });
  it("keeps uncovered entry/holder separate from false finality and never substitutes the owner", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (/\/(entry|holder)\/as-of\//.test(String(url)))
        return Response.json(
          { ok: false, errorCode: "INSTANT_NOT_COVERED" },
          { status: 404 },
        );
      return response(String(url), (body) => {
        if ("final" in body) body.final = false;
      });
    });
    const result = await readWholeArtworkProjection(slug, "999");
    expect(result).toMatchObject({
      ok: true,
      entry: { ok: false, code: "INSTANT_NOT_COVERED" },
      holder: { ok: false, code: "INSTANT_NOT_COVERED" },
      finality: { ok: true, value: false },
      position: { ok: true, value: `0x${"2".repeat(40)}` },
    });
  });
  it("does not infer false finality or a holder when an independent source read fails", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/holder/"))
        throw new Error("private source endpoint");
      if (String(url).includes("/finality/"))
        return Response.json(
          { ok: false, errorCode: "PROJECTION_SOURCE_UNAVAILABLE" },
          { status: 503 },
        );
      return response(String(url));
    });
    expect(await readWholeArtworkProjection(slug, "1500")).toMatchObject({
      ok: true,
      holder: { ok: false, code: "PROJECTION_READ_UNAVAILABLE" },
      finality: { ok: false, code: "PROJECTION_SOURCE_UNAVAILABLE" },
    });
  });
  it("reports an absent position as not read rather than copying the holder", async () => {
    serve((body) => {
      if ("tradeablePosition" in body) body.tradeablePosition = null;
    });
    expect(await readWholeArtworkProjection(slug, "1500")).toMatchObject({
      ok: true,
      position: { ok: true, value: null },
    });
  });
  it("preserves the exact Oracle EMPTY_PROJECTION error", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { ok: false, errorCode: "EMPTY_PROJECTION" },
        { status: 404 },
      ),
    );
    expect(await readWholeArtworkProjection(slug, "1500")).toEqual({
      ok: false,
      code: "EMPTY_PROJECTION",
    });
  });
  it.each([
    { effectiveAt: "1501" },
    { supersededAt: "1500" },
    { supersededAt: "999" },
    { version: "0" },
  ])(
    "rejects an entry that does not cover the exact queried instant: %j",
    async (changes) => {
      serve((body) => {
        if (body.entry) Object.assign(body.entry as object, changes);
      });
      expect(await readWholeArtworkProjection(slug, "1500")).toEqual({
        ok: false,
        code: "PROJECTION_SOURCE_MALFORMED",
      });
    },
  );
  it.each(["chainId", "contract", "registerId", "tokenId", "instant"])(
    "refuses mismatched %s on any observation",
    async (key) => {
      serve((body, url) => {
        if (!url.includes("/holder/")) return;
        if (key === "tokenId" || key === "instant") body[key] = "7";
        else
          (body.source as Record<string, unknown>)[key] =
            key === "chainId"
              ? "1"
              : `0x${"9".repeat(key === "contract" ? 40 : 64)}`;
      });
      expect(await readWholeArtworkProjection(slug, "1500")).toEqual({
        ok: false,
        code: "PROJECTION_BINDING_MISMATCH",
      });
    },
  );
  it("refuses source changes during the read and disagreed identity fields", async () => {
    let identities = 0;
    serve((body, url) => {
      if (url.endsWith("/1") && ++identities === 2)
        (body.source as Record<string, unknown>).registerId =
          `0x${"9".repeat(64)}`;
    });
    expect(await readWholeArtworkProjection(slug, "1500")).toEqual({
      ok: false,
      code: "PROJECTION_BINDING_MISMATCH",
    });
    serve((body) => {
      if ("registerId" in body) body.registerId = `0x${"9".repeat(64)}`;
    });
    expect(await readWholeArtworkProjection(slug, "1500")).toEqual({
      ok: false,
      code: "PROJECTION_BINDING_MISMATCH",
    });
  });
  it.each(["false", 0, null, {}, []])(
    "does not coerce finality from %j",
    async (value) => {
      serve((body) => {
        if ("final" in body) body.final = value;
      });
      expect(await readWholeArtworkProjection(slug, "1500")).toMatchObject({
        ok: true,
        finality: { ok: false, code: "PROJECTION_SOURCE_MALFORMED" },
      });
    },
  );
  it("keeps uint256 tokens and uint64 instants lossless", async () => {
    const token = (2n ** 256n - 1n).toString(),
      instant = (2n ** 64n - 1n).toString();
    vi.stubEnv("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID", token);
    expect(await readWholeArtworkProjection(slug, instant)).toMatchObject({
      ok: true,
      tokenId: token,
      instant,
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(`/projection/${token}/holder/as-of/${instant}`),
      ),
    ).toBe(true);
    for (const value of ["-1", "01", "1e3", "1.5", (2n ** 64n).toString()])
      expect(projectionUint64.safeParse(value).success).toBe(false);
    expect(projectionUint256.safeParse((2n ** 256n).toString()).success).toBe(
      false,
    );
  });
  it.each([
    ["../../admin", "UNKNOWN_ASSET"],
    ["weather-system-i", "BINDING_ELSEWHERE"],
  ])("refuses wrong asset %s without upstream reads", async (value, code) => {
    expect(await readWholeArtworkProjection(value, "1500")).toEqual({
      ok: false,
      code,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    ["ARTFI_ORACLE_READ_API_URL", "", "ORACLE_NOT_CONFIGURED"],
    [
      "ARTFI_ORACLE_READ_API_URL",
      "https://user:password@example.test",
      "ORACLE_CONFIG_INVALID",
    ],
    [
      "ARTFI_ORACLE_READ_API_URL",
      "https://example.test/?url=x",
      "ORACLE_CONFIG_INVALID",
    ],
    [
      "ARTFI_ORACLE_READ_API_URL",
      "https://example.test/#x",
      "ORACLE_CONFIG_INVALID",
    ],
    [
      "ARTFI_ORACLE_READ_API_URL",
      "http://remote.test",
      "ORACLE_CONFIG_INVALID",
    ],
    ["NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID", "01", "BINDING_INVALID"],
    [
      "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS",
      `0x${"0".repeat(40)}`,
      "BINDING_INVALID",
    ],
  ])("rejects invalid config %s", async (key, value, code) => {
    vi.stubEnv(key, value);
    expect(await readWholeArtworkProjection(slug, "1500")).toEqual({
      ok: false,
      code,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    () =>
      new Response("<html>private</html>", {
        headers: { "content-type": "text/html" },
      }),
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "65537",
        },
      }),
    () =>
      new Response("x".repeat(65537), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response("{broken", {
        headers: { "content-type": "application/json" },
      }),
    () =>
      Response.json({
        tokenId: "1",
        source: { ...projectionSourceFixture },
        entryCount: 2,
        registerId: projectionSourceFixture.registerId,
      }),
  ])("rejects malformed/big source data without echoing it", async (make) => {
    fetchMock.mockResolvedValue(make());
    expect(await readWholeArtworkProjection(slug, "1500")).toEqual({
      ok: false,
      code: "PROJECTION_SOURCE_MALFORMED",
    });
  });
  it("bounds the full stream lifetime even when the body never finishes", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(
      new Response(new ReadableStream(), {
        headers: { "content-type": "application/json" },
      }),
    );
    const result = readWholeArtworkProjection(slug, "1500");
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toEqual({ ok: false, code: "PROJECTION_TIMEOUT" });
  });
  it.each([
    "",
    "?instant=1500&instant=2000",
    "?instant=1500&url=https://elsewhere.test",
    "?instant=-1",
  ])("the same-origin route rejects query %s", async (query) => {
    const result = await GET(
      new Request(
        `https://io.artcch.com/api/assets/${slug}/projection${query}`,
      ),
      { params: Promise.resolve({ slug }) },
    );
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ ok: false, code: "INSTANT_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("the route returns non-cacheable valid data", async () => {
    const result = await GET(
      new Request(
        `https://io.artcch.com/api/assets/${slug}/projection?instant=1500`,
      ),
      { params: Promise.resolve({ slug }) },
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect((await result.json()).ok).toBe(true);
  });
});

it("uses a signed catalog token binding independently of sample-page configuration", async () => {
  vi.stubEnv("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS", "");
  const result = await readWholeArtworkProjection("new-source-record", "1500", {
    chainId: 560048,
    collectionAddress: projectionSourceFixture.contract,
    tokenId: "2",
  });
  expect(result.ok).toBe(true);
  expect(
    fetchMock.mock.calls.every(([url]) =>
      String(url).includes("/projection/2"),
    ),
  ).toBe(true);
});
