import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../app/api/assets/[slug]/oracle/route";
import {
  oracleFixtureContract,
  oracleReadFixtures,
} from "../test/oracle-fixtures";
import { readWholeArtworkOracle } from "./oracle-read";

const slug = "blue-hour-archive";
const fetchMock = vi.fn<typeof fetch>();
function configure() {
  vi.stubEnv(
    "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS",
    oracleFixtureContract,
  );
  vi.stubEnv("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID", "1");
  vi.stubEnv("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG", slug);
  vi.stubEnv(
    "ARTFI_ORACLE_READ_API_URL",
    "https://oracle.example.test/existing-bridge/",
  );
}
function respond(token: unknown, asset: unknown) {
  fetchMock
    .mockResolvedValueOnce(Response.json(token))
    .mockResolvedValueOnce(Response.json(asset));
}
beforeEach(() => {
  configure();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fetchMock.mockReset();
});

describe("existing whole-artwork Oracle read adapter", () => {
  it("uses the exact existing binding and strips nonpublic fields at every level", async () => {
    const { token, asset } = oracleReadFixtures();
    respond(
      {
        ...token,
        owner: "do-not-expose",
        currentCertificate: {
          ...token.currentCertificate,
          settlementBuyerCommitment: "secret",
        },
      },
      {
        ...asset,
        internal: "do-not-expose",
        asset: {
          ...asset.asset,
          currentOwnerCommitment: "secret",
          warehouseId: "secret",
        },
        warehouse: {
          ...asset.warehouse,
          holderCommitment: "secret",
          warehouseId: "secret",
        },
      },
    );
    const result = await readWholeArtworkOracle(slug);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /secret|do-not-expose|holderCommitment|warehouseId|currentOwnerCommitment/,
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://oracle.example.test/existing-bridge/v1/rwa/tokens/560048/${oracleFixtureContract}/1`,
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://oracle.example.test/existing-bridge/v1/rwa/assets/test_artwork_1",
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
    });
  });

  it("keeps the source's case-sensitive contract key", async () => {
    const address = "0x52908400098527886E0F7030069857D2E4169EE7";
    vi.stubEnv("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS", address);
    const { token, asset } = oracleReadFixtures();
    token.binding.contract = address;
    respond(token, asset);
    expect((await readWholeArtworkOracle(slug)).ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain(address);
  });

  it.each([
    ["../../admin", "UNKNOWN_ASSET"],
    ["weather-system-i", "BINDING_ELSEWHERE"],
    ["https://attacker.test", "UNKNOWN_ASSET"],
  ])("does not read another token for %s", async (page, code) => {
    expect(await readWholeArtworkOracle(page)).toEqual({ ok: false, code });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG", "", "BINDING_NOT_CONFIGURED"],
    [
      "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS",
      "",
      "BINDING_NOT_CONFIGURED",
    ],
    [
      "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS",
      "0x0000000000000000000000000000000000000000",
      "BINDING_INVALID",
    ],
    [
      "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS",
      "../../admin",
      "BINDING_INVALID",
    ],
    ["NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID", "01", "BINDING_INVALID"],
    ["NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID", "../admin", "BINDING_INVALID"],
    [
      "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID",
      String(2n ** 256n),
      "BINDING_INVALID",
    ],
    ["ARTFI_ORACLE_READ_API_URL", "", "ORACLE_NOT_CONFIGURED"],
    [
      "ARTFI_ORACLE_READ_API_URL",
      "https://user:password@oracle.example.test",
      "ORACLE_CONFIG_INVALID",
    ],
    [
      "ARTFI_ORACLE_READ_API_URL",
      "https://oracle.example.test?url=evil",
      "ORACLE_CONFIG_INVALID",
    ],
    [
      "ARTFI_ORACLE_READ_API_URL",
      "http://oracle.example.test",
      "ORACLE_CONFIG_INVALID",
    ],
    [
      "ARTFI_ORACLE_READ_API_URL",
      "file:///etc/passwd",
      "ORACLE_CONFIG_INVALID",
    ],
  ])(
    "rejects invalid or missing %s %s before network",
    async (name, value, code) => {
      vi.stubEnv(name, value);
      expect(await readWholeArtworkOracle(slug)).toEqual({ ok: false, code });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["chainId", "contract", "tokenId"] as const)(
    "rejects mismatched token %s before asset lookup",
    async (field) => {
      const { token } = oracleReadFixtures();
      token.binding[field] =
        field === "contract" ? oracleFixtureContract.replace(/2$/, "3") : "2";
      fetchMock.mockResolvedValueOnce(Response.json(token));
      expect(await readWholeArtworkOracle(slug)).toEqual({
        ok: false,
        code: "BINDING_MISMATCH",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["asset", "currentCertificate", "warehouse"] as const)(
    "rejects mismatched asset in %s",
    async (field) => {
      const { token, asset } = oracleReadFixtures();
      asset[field].assetId = "other_asset";
      respond(token, asset);
      expect(await readWholeArtworkOracle(slug)).toEqual({
        ok: false,
        code: "BINDING_MISMATCH",
      });
    },
  );

  it("rejects a certificate for another token", async () => {
    const { token } = oracleReadFixtures();
    token.currentCertificate.tokenId = "2";
    fetchMock.mockResolvedValueOnce(Response.json(token));
    expect(await readWholeArtworkOracle(slug)).toEqual({
      ok: false,
      code: "BINDING_MISMATCH",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves distinct statuses rather than declaring a transfer authorized", async () => {
    const { token, asset } = oracleReadFixtures();
    respond(token, { ...asset, status: "FROZEN" });
    const result = await readWholeArtworkOracle(slug);
    expect(result).toMatchObject({
      ok: true,
      token: { status: "VALID" },
      asset: { status: "FROZEN" },
    });
    expect(result).not.toHaveProperty("transferable");
  });

  it("preserves missing certificate and warehouse as null", async () => {
    const { token, asset } = oracleReadFixtures();
    respond(
      { ...token, currentCertificate: null },
      { ...asset, currentCertificate: null, warehouse: null },
    );
    expect(await readWholeArtworkOracle(slug)).toMatchObject({
      ok: true,
      asset: { currentCertificate: null, warehouse: null },
    });
  });

  it.each([
    [404, "TOKEN_NOT_FOUND"],
    [410, "ORACLE_RECORD_GONE"],
    [302, "ORACLE_UNAVAILABLE"],
    [500, "ORACLE_UNAVAILABLE"],
  ])("reports token HTTP %s accurately", async (status, code) => {
    fetchMock.mockResolvedValueOnce(
      new Response("internal-error", {
        status: Number(status),
        headers: { location: "https://untrusted.test" },
      }),
    );
    expect(await readWholeArtworkOracle(slug)).toEqual({ ok: false, code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("identifies missing asset independently of missing token", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(oracleReadFixtures().token))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await readWholeArtworkOracle(slug)).toEqual({
      ok: false,
      code: "ASSET_NOT_FOUND",
    });
  });
  it("does not leak upstream exception details", async () => {
    fetchMock.mockRejectedValueOnce(new Error("secret internal host"));
    expect(await readWholeArtworkOracle(slug)).toEqual({
      ok: false,
      code: "ORACLE_UNAVAILABLE",
    });
  });
  it.each([
    new Response("not-json", {
      headers: { "content-type": "application/json" },
    }),
    new Response("<html>error</html>", {
      headers: { "content-type": "text/html" },
    }),
    Response.json({ binding: {} }),
    Response.json({ ...oracleReadFixtures().token, status: "MADE_UP" }),
    new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": "65537",
      },
    }),
    new Response("x".repeat(65537), {
      headers: { "content-type": "application/json" },
    }),
  ])(
    "rejects malformed/oversized responses without exposing body",
    async (response) => {
      fetchMock.mockResolvedValueOnce(response);
      expect(await readWholeArtworkOracle(slug)).toEqual({
        ok: false,
        code: "ORACLE_INVALID_RESPONSE",
      });
    },
  );
  it("bounds a stalled fetch", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(() => new Promise(() => undefined));
    const result = readWholeArtworkOracle(slug);
    await vi.advanceTimersByTimeAsync(4001);
    expect(await result).toEqual({ ok: false, code: "ORACLE_TIMEOUT" });
  });
  it("bounds a stalled response body", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(
      new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const result = readWholeArtworkOracle(slug);
    await vi.advanceTimersByTimeAsync(4001);
    expect(await result).toEqual({ ok: false, code: "ORACLE_TIMEOUT" });
  });
  it("uses a fresh read on retry after an unavailable response", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect((await readWholeArtworkOracle(slug)).ok).toBe(false);
    const { token, asset } = oracleReadFixtures();
    respond(token, asset);
    expect((await readWholeArtworkOracle(slug)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("same-origin Oracle route", () => {
  it("rejects query overrides without issuing an upstream request", async () => {
    const response = await GET(
      new Request(
        `https://artfi.example.test/api/assets/${slug}/oracle?url=https://untrusted.test`,
      ),
      { params: Promise.resolve({ slug }) },
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("returns only sanitized facts with no-store headers", async () => {
    const { token, asset } = oracleReadFixtures();
    respond(token, asset);
    const response = await GET(
      new Request(`https://artfi.example.test/api/assets/${slug}/oracle`, {
        headers: {
          authorization: "Bearer browser-secret",
          cookie: "session=browser-secret",
        },
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: true });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
      "browser-secret",
    );
  });
});
