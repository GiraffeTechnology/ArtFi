import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ require: vi.fn(), origin: vi.fn() }));
vi.mock("@/lib/user-auth", () => ({
  requireUserSession: mocks.require,
  assertUserRequestOrigin: mocks.origin,
  UserAuthError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
import { GET, POST } from "./route";

const address = "0x" + "1".repeat(40),
  sessionId = "a".repeat(32);
const session = {
  id: sessionId,
  address,
  chainId: 560048,
  expiresAt: 4000000000000,
  accessExpiresAt: 4000000000000,
};
const page = {
  address,
  chainId: 560048,
  notifications: [],
  preferences: {
    revision: "0",
    transactionAlerts: true,
    systemMessageAlerts: true,
  },
  chainEventsAvailable: true,
};
const context = (path: string) => ({
  params: Promise.resolve({ path: [path] }),
});
const request = (
  path = "inbox",
  headers: Record<string, string> = {},
  method = "GET",
) =>
  new Request("https://artfi.example/api/notifications/" + path, {
    method,
    headers: {
      "x-artfi-wallet": address,
      "x-artfi-chain": "560048",
      "x-artfi-session": sessionId,
      ...headers,
    },
    ...(method === "POST"
      ? { body: '{"id":"' + "b".repeat(32) + '","expectedSourceRevision":"1"}' }
      : {}),
  });
describe("notification cookie proxy", () => {
  beforeEach(() => {
    vi.stubEnv("ARTFI_API_URL", "https://api.example.test");
    mocks.require
      .mockReset()
      .mockResolvedValue({ session, accessToken: "server-cookie-only" });
    mocks.origin.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("refuses a replaced cookie session before contacting the data API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    mocks.require.mockResolvedValue({
      session: { ...session, id: "b".repeat(32) },
      accessToken: "server-cookie-only",
    });
    const response = await GET(request(), context("inbox"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns only typed current data and never passes the cookie token to the browser", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(page));
    vi.stubGlobal("fetch", fetch);
    const response = await GET(request(), context("inbox"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.example.test/v1/user/notifications");
    expect(options.headers.get("authorization")).toBe(
      "Bearer server-cookie-only",
    );
    expect(options.cache).toBe("no-store");
    expect(mocks.require).toHaveBeenCalledTimes(2);
    expect(response.headers.get("authorization")).toBeNull();
  });
  it("discards data if the durable session changes while the source is awaited", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(page)));
    mocks.require
      .mockResolvedValueOnce({ session, accessToken: "server-cookie-only" })
      .mockResolvedValueOnce({
        session: { ...session, id: "b".repeat(32) },
        accessToken: "new-cookie-only",
      });
    const response = await GET(request(), context("inbox"));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("transactionAlerts");
  });
  it("refuses an upstream page with a different wallet or unsupported fields", async () => {
    for (const bad of [
      { ...page, address: "0x" + "2".repeat(40) },
      { ...page, privateExtra: "must-not-leak" },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(bad)));
      const response = await GET(request(), context("inbox"));
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("must-not-leak");
    }
  });
  it("sanitizes upstream conflicts and does not replay the mutation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("private-upstream-topology", { status: 409 }),
      );
    vi.stubGlobal("fetch", fetch);
    const response = await POST(
      request(
        "read",
        {
          "content-type": "application/json",
          "idempotency-key": "exact-read-key-01",
        },
        "POST",
      ),
      context("read"),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("private-upstream-topology");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.origin).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported routes and query selectors without forwarding", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await GET(request(), context("admin"))).status).toBe(404);
    expect(
      (await GET(request("inbox?wallet=other"), context("inbox"))).status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
