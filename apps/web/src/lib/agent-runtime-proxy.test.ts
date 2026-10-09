import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ session: vi.fn(), origin: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/user-auth", () => ({
  requireUserSession: auth.session,
  assertUserRequestOrigin: auth.origin,
  userAuthOrigin: () => "https://artfi.test",
  UserAuthError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
import { agentRuntimeProxy } from "./agent-runtime-proxy";
import { UserAuthError } from "./user-auth";
const wallet = "0x" + "a".repeat(40),
  bridge = "ISOLATED_TEST_AGENT_BRIDGE_CREDENTIAL";
async function request(
  path = "status",
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return agentRuntimeProxy(
    new Request(`https://artfi.test/api/agent/${path}`, {
      method,
      headers: {
        "x-artfi-wallet": wallet,
        "x-artfi-chain": "560048",
        "content-type": "application/json",
        origin: "https://artfi.test",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: path.split("?")[0].split("/") }) },
  );
}
describe("agent runtime private bridge", () => {
  const upstream = vi.fn();
  beforeEach(() => {
    vi.stubEnv("ARTFI_AGENT_API_URL", "https://runtime.test/approved-prefix");
    vi.stubEnv("ARTFI_AGENT_BRIDGE_TOKEN", bridge);
    vi.stubGlobal("fetch", upstream);
    auth.session
      .mockReset()
      .mockResolvedValue({ accessToken: "ISOLATED_TEST_ACCESS_TOKEN" });
    auth.origin.mockReset();
    upstream
      .mockReset()
      .mockResolvedValue(Response.json({ mode: "TEST_ONLY_NO_REAL_VALUE" }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("validates live wallet session and preserves configured bridge prefix", async () => {
    const result = await request();
    expect(result.status).toBe(200);
    expect(auth.session).toHaveBeenCalledExactlyOnceWith(wallet, 560048);
    const [url, options] = upstream.mock.calls[0];
    expect(url.toString()).toBe(
      "https://runtime.test/approved-prefix/v1/agent/status",
    );
    expect(options).toMatchObject({
      cache: "no-store",
      redirect: "error",
      headers: {
        authorization: `Bearer ${bridge}`,
        "x-artfi-user-access": "ISOLATED_TEST_ACCESS_TOKEN",
      },
    });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.text()).not.toContain(bridge);
  });
  it.each([401, 403, 503])(
    "denies session error %i before reading runtime",
    async (status) => {
      auth.session.mockRejectedValue(
        new UserAuthError(status, "private reason"),
      );
      expect((await request()).status).toBe(status);
      expect(upstream).not.toHaveBeenCalled();
    },
  );
  it("rejects cross-origin mutation, unapproved routes and wrong chain", async () => {
    auth.origin.mockImplementation(() => {
      throw new UserAuthError(403, "origin");
    });
    expect((await request("intents", "POST", {})).status).toBe(403);
    expect(auth.session).not.toHaveBeenCalled();
    expect((await request("sign", "POST", {})).status).toBe(404);
    expect(
      (await request("status", "GET", undefined, { "x-artfi-chain": "999999" }))
        .status,
    ).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("redacts upstream details and rejects unconfigured runtime", async () => {
    upstream.mockResolvedValue(
      new Response("secret upstream", { status: 500 }),
    );
    const result = await request();
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("secret");
    upstream.mockClear();
    vi.stubEnv("ARTFI_AGENT_API_URL", "");
    expect((await request()).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("never forwards arbitrary query parameters or oversized payloads", async () => {
    expect((await request("status?account=other")).status).toBe(400);
    expect((await request("intents/abc/history?limit=1&limit=2")).status).toBe(
      400,
    );
    expect(
      (await request("intents", "POST", { payload: "x".repeat(33000) })).status,
    ).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
});
