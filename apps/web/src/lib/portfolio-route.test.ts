import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/portfolio/[address]/route";
import { UserAuthError } from "./user-auth";

const session = vi.hoisted(() => vi.fn());
vi.mock("@/lib/user-auth", () => ({
  requireUserSession: session,
  UserAuthError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
const address = "0x1000000000000000000000000000000000000001";
const records = { address, chainId: 560048, positions: [], transactions: [] };
const request = (owner = address, query = "") =>
  GET(new Request(`https://app.example/api/portfolio/${owner}${query}`), {
    params: Promise.resolve({ address: owner }),
  });

describe("authenticated portfolio route", () => {
  const upstream = vi.fn();
  beforeEach(() => {
    vi.stubEnv("ARTFI_API_URL", "https://api.example");
    vi.stubGlobal("fetch", upstream);
    session.mockReset().mockResolvedValue({
      session: { address },
      accessToken: "unused-test-token",
    });
    upstream.mockReset().mockResolvedValue(Response.json(records));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it.each([401, 403, 503])(
    "fails closed before reading data for session status %i",
    async (status) => {
      session.mockRejectedValue(new UserAuthError(status, "private detail"));
      const response = await request();
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(upstream).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain("private detail");
    },
  );
  it("verifies the exact wallet and fetches bounded uncached records", async () => {
    const response = await request();
    expect(session).toHaveBeenCalledExactlyOnceWith(address);
    expect(upstream.mock.calls[0][0].toString()).toBe(
      `https://api.example/v1/portfolio/${address}`,
    );
    expect(upstream.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: "Bearer unused-test-token" },
      cache: "no-store",
      redirect: "error",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(records);
  });
  it.each([
    { ...records, address: "0x2000000000000000000000000000000000000002" },
    { ...records, chainId: 1 },
    { ...records, positions: null },
  ])("rejects upstream records for an incorrect context", async (body) => {
    upstream.mockResolvedValue(Response.json(body));
    expect((await request()).status).toBe(503);
  });
  it("rejects malformed addresses and unexpected query parameters", async () => {
    expect((await request("invalid")).status).toBe(400);
    expect((await request(address, "?other=1")).status).toBe(400);
    expect(session).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
  it("does not echo upstream failures or authentication values", async () => {
    upstream.mockResolvedValue(
      new Response("private upstream content", { status: 500 }),
    );
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(
      /private upstream|unused-test-token/,
    );
  });
});
