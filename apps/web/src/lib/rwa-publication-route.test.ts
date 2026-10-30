import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST, PUT } from "../app/api/rwa/publication/[...path]/route";
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
const wallet = "0x1000000000000000000000000000000000000010";
const asset = {
  slug: "example-receipt",
  title: "Example artwork",
  artist: "Example artist",
  year: 2026,
  medium: "Example pigment",
  location: "Example custody",
  description: "Public descriptive record for an example artwork.",
  section: "whole",
  rights: "Example delivery receipt rights under the approved source record.",
  provenance: ["Approved source reference"],
  binding: {
    chainId: 560048,
    collectionAddress: "0x1000000000000000000000000000000000000002",
    tokenId: "1",
    underlyingAssetId: "urn:example:underlying",
  },
};
function request(
  body: unknown = asset,
  path = "drafts",
  method = "POST",
  extra: Record<string, string> = {},
) {
  return (method === "PUT" ? PUT : POST)(
    new Request(`https://web.test/api/rwa/publication/${path}`, {
      method,
      headers: {
        "x-artfi-wallet": wallet,
        "x-artfi-chain": "560048",
        "idempotency-key": "retry-publication-key",
        ...extra,
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: path.split("/") }) },
  );
}
describe("ordinary-session source publication bridge", () => {
  const upstream = vi.fn();
  beforeEach(() => {
    vi.stubEnv("ARTFI_API_URL", "https://api.test/artfi");
    vi.stubGlobal("fetch", upstream);
    auth.session
      .mockReset()
      .mockResolvedValue({ accessToken: "TEST_ONLY-private-session" });
    auth.origin.mockReset();
    upstream.mockReset().mockResolvedValue(
      Response.json({
        asset: { ...asset, imageUrl: "" },
        contextHash: `0x${"11".repeat(32)}`,
        executable: false,
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("uses the ordinary matching wallet session, no operator secret or admin admission", async () => {
    const result = await request();
    expect(result.status).toBe(200);
    expect(auth.session).toHaveBeenCalledExactlyOnceWith(wallet, 560048);
    expect(auth.origin).toHaveBeenCalledOnce();
    const [url, options] = upstream.mock.calls[0];
    expect(url.toString()).toBe(
      "https://api.test/artfi/v1/user/rwa/catalog-drafts",
    );
    expect(options).toMatchObject({ cache: "no-store", redirect: "error" });
    expect(options.headers.authorization).toBe(
      "Bearer TEST_ONLY-private-session",
    );
    expect(await result.text()).not.toContain("TEST_ONLY-private-session");
  });
  it("rejects accidental signing secrets before forwarding any source or draft", async () => {
    expect(
      (await request({ ...asset, privateKey: "do-not-transmit" })).status,
    ).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    expect(
      (
        await request({
          ...asset,
          binding: { ...asset.binding, seed: "do-not-transmit" },
        })
      ).status,
    ).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([401, 403, 503])(
    "fails closed on authentication failure %i",
    async (status) => {
      auth.session.mockRejectedValue(
        new UserAuthError(status, "private failure"),
      );
      const result = await request();
      expect(result.status).toBe(status);
      expect(upstream).not.toHaveBeenCalled();
      expect(await result.text()).not.toContain("private failure");
    },
  );
  it("blocks cross-origin, unsupported chain, route traversal and oversized envelope", async () => {
    auth.origin.mockImplementation(() => {
      throw new UserAuthError(403, "cross-origin");
    });
    expect((await request()).status).toBe(403);
    expect(auth.session).not.toHaveBeenCalled();
    auth.origin.mockReset();
    expect(
      (await request(asset, "drafts", "POST", { "x-artfi-chain": "1" })).status,
    ).toBe(401);
    expect((await request(asset, "../admin")).status).toBe(404);
    expect((await request({ payload: "x".repeat(65000) })).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("does not expose upstream errors or invent publication after failed source verification", async () => {
    upstream.mockResolvedValue(
      new Response("private upstream details", { status: 422 }),
    );
    const result = await request();
    expect(result.status).toBe(422);
    expect(await result.text()).not.toContain("private upstream");
  });
});
