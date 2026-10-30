import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/v1/[...path]/route";
afterEach(() => vi.unstubAllGlobals());
describe("standalone public read proxy", () => {
  it("rejects private, portfolio, indexer and encoded traversal paths", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const path of [
      ["user", "auth", "session"],
      ["portfolio", "0x1"],
      ["indexer", "events"],
      ["..", "config"],
      ["%2e%2e", "config"],
    ])
      expect(
        (
          await GET(new Request("https://web.example.test/v1/config"), {
            params: Promise.resolve({ path }),
          })
        ).status,
      ).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves bridge prefixes and queries without forwarding browser credentials", async () => {
    const old = process.env.ARTFI_API_URL;
    process.env.ARTFI_API_URL = "https://bridge.example.test/artfi";
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetch);
    try {
      const response = await GET(
        new Request("https://web.example.test/v1/nfts?page=2", {
          headers: { authorization: "do-not-forward", cookie: "private=1" },
        }),
        { params: Promise.resolve({ path: ["nfts"] }) },
      );
      expect(response.status).toBe(200);
      expect(String(fetch.mock.calls[0][0])).toBe(
        "https://bridge.example.test/artfi/v1/nfts?page=2",
      );
      expect(fetch.mock.calls[0][1].headers).toEqual({
        accept: "application/json",
      });
      expect(fetch.mock.calls[0][1].redirect).toBe("error");
    } finally {
      if (old === undefined) delete process.env.ARTFI_API_URL;
      else process.env.ARTFI_API_URL = old;
    }
  });
  it("reports upstream failure without revealing configuration", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret")));
    const response = await GET(
      new Request("https://web.example.test/v1/config"),
      { params: Promise.resolve({ path: ["config"] }) },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
  });
});
