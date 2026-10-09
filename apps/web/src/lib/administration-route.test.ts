import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST, PUT } from "../app/api/administration/[...path]/route";
import { UserAuthError } from "./user-auth";
const auth = vi.hoisted(() => ({ session: vi.fn(), origin: vi.fn() }));
vi.mock("@/lib/user-auth", () => ({
  requireUserSession: auth.session,
  assertUserRequestOrigin: auth.origin,
  UserAuthError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
const wallet = "0x" + "1".repeat(40);
function request(
  path = "admin/moderation/cases",
  method = "GET",
  payload?: unknown,
  headerOverrides?: Record<string, string>,
) {
  const headers = {
    "x-artfi-wallet": wallet,
    "x-artfi-chain": "560048",
    "idempotency-key": "request-retry-key",
    ...headerOverrides,
  };
  const req = new Request(`https://web.test/api/administration/${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return ({ GET, POST, PUT } as Record<string, typeof GET>)[method](req, {
    params: Promise.resolve({ path: path.split("?")[0].split("/") }),
  });
}
describe("private administration web bridge", () => {
  const upstream = vi.fn();
  beforeEach(() => {
    vi.stubEnv("ARTFI_API_URL", "https://api.test/artfi");
    vi.stubGlobal("fetch", upstream);
    auth.session
      .mockReset()
      .mockResolvedValue({ accessToken: "TEST_ONLY-private-access" });
    auth.origin.mockReset();
    upstream.mockReset().mockResolvedValue(Response.json({ data: [] }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("authenticates the displayed wallet, keeps credentials server-side and disables caching", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(auth.session).toHaveBeenCalledExactlyOnceWith(wallet, 560048);
    const [url, options] = upstream.mock.calls[0];
    expect(url.toString()).toBe(
      "https://api.test/artfi/v1/admin/moderation/cases",
    );
    expect(options).toMatchObject({ cache: "no-store", redirect: "error" });
    expect(options.headers.get("authorization")).toBe(
      "Bearer TEST_ONLY-private-access",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("TEST_ONLY-private-access");
  });
  it.each([401, 403, 503])(
    "fails closed on session failure %i",
    async (status) => {
      auth.session.mockRejectedValue(
        new UserAuthError(status, "private internal failure"),
      );
      const response = await request();
      expect(response.status).toBe(status);
      expect(upstream).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain("private internal");
    },
  );
  it("rejects origin mismatch before reading a session or sending a mutation", async () => {
    auth.origin.mockImplementation(() => {
      throw new UserAuthError(403, "bad origin");
    });
    expect((await request("admin/config", "PUT", {})).status).toBe(403);
    expect(auth.session).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
  it("forwards the same revision and retry key, never an operator credential", async () => {
    const body = {
      revision: 3,
      noticeEnabled: false,
      noticeText: "",
      reason: "Documented update",
    };
    expect((await request("admin/config", "PUT", body)).status).toBe(200);
    const options = upstream.mock.calls[0][1];
    expect(options.body).toBe(JSON.stringify(body));
    expect(options.headers.get("idempotency-key")).toBe("request-retry-key");
    expect(auth.origin).toHaveBeenCalledOnce();
  });
  it("keeps public reads independent from login and rejects writes to them", async () => {
    expect((await request("platform/config")).status).toBe(200);
    expect(auth.session).not.toHaveBeenCalled();
    expect(upstream.mock.calls[0][1].headers.has("authorization")).toBe(false);
    upstream.mockClear();
    expect((await request("platform/config", "PUT", {})).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("does not expose upstream topology, credentials, or private failed responses", async () => {
    upstream.mockResolvedValue(
      new Response("database password and private report", { status: 500 }),
    );
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(
      /database|password|private report/,
    );
  });
  it("rejects missing context, oversized bodies and invalid retry keys", async () => {
    expect(
      (await request("admin/config", "PUT", {}, { "x-artfi-chain": "" }))
        .status,
    ).toBe(401);
    expect(
      (await request("admin/config", "PUT", {}, { "idempotency-key": "short" }))
        .status,
    ).toBe(400);
    expect(
      (await request("admin/config", "PUT", { text: "x".repeat(17000) }))
        .status,
    ).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
});
