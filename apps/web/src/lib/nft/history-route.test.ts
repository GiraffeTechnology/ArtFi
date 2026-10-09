import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/api/nft/[action]/route";
import { UserAuthError } from "../user-auth";
import type { NftOperationHistory } from "./model";

const state = vi.hoisted(() => ({ auth: vi.fn(), fetch: vi.fn() }));
vi.mock("../user-auth", async (original) => ({
  ...(await original<typeof import("../user-auth")>()),
  requireUserSession: state.auth,
}));

const account = "0x1111111111111111111111111111111111111111";
const accessToken = "TEST_ONLY-history-session";
function history(page = 1, chainId = 1): NftOperationHistory {
  return {
    wallet: account,
    chainId,
    page,
    pageSize: 25,
    hasMore: false,
    data: [
      {
        id: "TEST_ONLY-history-operation-1",
        chainId,
        status: "accepted",
        action: "list",
        collection: "test-only-digital",
        tokenId: "7",
        kind: "signature",
        walletStarted: true,
        orderHash: `0x${"7".repeat(64)}`,
        updatedAt: "2026-10-06T00:00:00Z",
      },
    ],
  };
}
async function get(values: Record<string, string> = {}) {
  const query = new URLSearchParams({ account, chainId: "1", ...values });
  return GET(new Request(`https://artfi.example/api/nft/history?${query}`), {
    params: Promise.resolve({ action: "history" }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ARTFI_API_URL", "http://127.0.0.1:8080");
  vi.stubEnv("ARTFI_USER_AUTH_BRIDGE_TOKEN", "TEST_ONLY-bridge-".repeat(3));
  vi.stubGlobal("fetch", state.fetch);
  state.auth.mockResolvedValue({
    session: { id: "TEST_ONLY-session", address: account, chainId: 1 },
    accessToken,
  });
  state.fetch.mockResolvedValue(Response.json(history()));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("authenticated NFT history HTTP route", () => {
  it("loads the first page for the authenticated wallet through the journal", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(history());
    expect(state.auth).toHaveBeenCalledWith(account, 1);
    expect(state.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = state.fetch.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:8080/v1/nft/operations/history");
    expect(options).toMatchObject({ method: "POST", cache: "no-store" });
    expect(JSON.parse(options.body)).toEqual({ accessToken, page: 1 });
  });

  it("preserves an explicit page and supported selected chain", async () => {
    state.auth.mockResolvedValue({
      session: {
        id: "TEST_ONLY-base-session",
        address: account,
        chainId: 8453,
      },
      accessToken,
    });
    state.fetch.mockResolvedValue(Response.json(history(2, 8453)));
    const response = await get({ chainId: "8453", page: "2" });
    expect(response.status).toBe(200);
    expect(state.auth).toHaveBeenCalledWith(account, 8453);
    expect(JSON.parse(state.fetch.mock.calls[0][1].body)).toEqual({
      accessToken,
      page: 2,
    });
    expect(await response.json()).toEqual(history(2, 8453));
  });

  it.each([
    "No wallet session is present.",
    "Your wallet session has expired.",
  ])("requires signing in again when %s", async (detail) => {
    state.auth.mockRejectedValue(new UserAuthError(401, detail));
    const response = await get();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ detail });
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5", "next", "1000000"])(
    "reports a normal invalid page value %s without querying history",
    async (page) => {
      const response = await get({ page });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        detail: "Invalid NFT history query.",
      });
      expect(state.auth).not.toHaveBeenCalled();
      expect(state.fetch).not.toHaveBeenCalled();
    },
  );

  it("returns an unavailable response when the history service fails", async () => {
    state.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    const response = await get();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      detail: "Private NFT operation history is unavailable.",
    });
  });

  it("returns an unavailable response when the history connection is interrupted", async () => {
    state.fetch.mockRejectedValue(
      new TypeError("TEST ONLY connection interrupted"),
    );
    const response = await get();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      detail: "The NFT service is unavailable. Try again later.",
    });
  });
});
