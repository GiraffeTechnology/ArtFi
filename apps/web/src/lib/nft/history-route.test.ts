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

describe("server-side complete NFT history admission", () => {
  it.each(["foreign-row-chain", "private-root-field", "duplicate-operation"])(
    "history-server regression: rejects %s before returning history",
    async (field) => {
      const value = history();
      if (field === "foreign-row-chain") value.data[0]!.chainId = 8453;
      if (field === "private-root-field")
        Reflect.set(value, "accessToken", "TEST_ONLY-never-return");
      if (field === "duplicate-operation")
        value.data.push({ ...value.data[0]! });
      state.fetch.mockResolvedValue(Response.json(value));
      const response = await get();
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        detail: "The NFT service is unavailable. Try again later.",
      });
      expect(state.auth).toHaveBeenCalledTimes(1);
      expect(state.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "id",
    "status",
    "action",
    "collection",
    "token",
    "kind",
    "wallet-marker",
    "time",
    "calendar",
    "transaction-hash",
    "order-hash",
    "private-row",
  ])(
    "rejects a malformed %s without partial page publication",
    async (field) => {
      const value = history(),
        row = value.data[0]!;
      if (field === "id") row.id = "short";
      if (field === "status") row.status = "paid";
      if (field === "action") row.action = "execute";
      if (field === "collection") row.collection = "Other Collection";
      if (field === "token") row.tokenId = "01";
      if (field === "kind") row.kind = "signedRawTransaction";
      if (field === "wallet-marker") Reflect.set(row, "walletStarted", "true");
      if (field === "time") row.updatedAt = "not-a-time";
      if (field === "calendar") row.updatedAt = "2026-02-31T00:00:00Z";
      if (field === "transaction-hash") row.transactionHash = "0x1";
      if (field === "order-hash") row.orderHash = "0x1";
      if (field === "private-row")
        Reflect.set(row, "plan", { signature: "TEST_ONLY-never-return" });
      state.fetch.mockResolvedValue(Response.json(value));
      const response = await get();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        detail: "The NFT service is unavailable. Try again later.",
      });
      expect(state.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "wallet",
    "chain",
    "missing-row-field",
    "null-row",
    "reverse-source-time",
  ])(
    "rejects incompatible %s while retaining authenticated scope",
    async (field) => {
      const value = history();
      if (field === "wallet")
        value.wallet = "0x2222222222222222222222222222222222222222";
      if (field === "chain") value.chainId = 8453;
      if (field === "missing-row-field")
        Reflect.deleteProperty(value.data[0]!, "walletStarted");
      if (field === "null-row") Reflect.set(value.data, "0", null);
      if (field === "reverse-source-time")
        value.data.push({
          ...value.data[0]!,
          id: "TEST_ONLY-history-operation-2",
          updatedAt: "2026-10-06T00:00:00.000000001Z",
        });
      state.fetch.mockResolvedValue(Response.json(value));
      const response = await get();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        detail: "The NFT service is unavailable. Try again later.",
      });
      expect(state.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("retains large token identity, nanosecond times and distinct valid rows", async () => {
    const value = history();
    value.data[0]!.tokenId = ((1n << 256n) - 1n).toString();
    value.data[0]!.updatedAt = "2026-10-06T00:00:00.000000002Z";
    value.data.push({
      ...value.data[0]!,
      id: "TEST_ONLY-history-operation-2",
      updatedAt: "2026-10-06T00:00:00.000000001Z",
    });
    state.fetch.mockResolvedValue(Response.json(value));
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(value);
  });
  it("does not invent completion for an empty page with more native records", async () => {
    const value = { ...history(), data: [], hasMore: true };
    state.fetch.mockResolvedValue(Response.json(value));
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(value);
  });
  it("normalizes native hexadecimal references without changing the selected wallet or chain", async () => {
    const value = history();
    value.data[0]!.transactionHash = "0x" + "AB".repeat(32);
    state.fetch.mockResolvedValue(Response.json(value));
    const response = await get();
    expect(response.status).toBe(200);
    expect((await response.json()).data[0].transactionHash).toBe(
      "0x" + "ab".repeat(32),
    );
    expect(state.auth).toHaveBeenCalledWith(account, 1);
  });
});
