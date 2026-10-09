import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/orders/fraction-book/route";
const address = "0x1000000000000000000000000000000000000001";
const query = `chainId=560048&marketAddress=${address}&assetAddress=${address}&paymentToken=${address}&at=1500`;
const fetcher = vi.fn();
beforeEach(() => {
  vi.stubEnv("ARTFI_API_URL", "https://api.example.invalid");
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
const request = (value = query) =>
  new Request(`https://io.artcch.com/api/orders/fraction-book?${value}`);
describe("fraction book HTTP boundary", () => {
  it("forwards only public explicit scope with no session, credential, cache or redirect", async () => {
    fetcher.mockResolvedValue(
      Response.json({
        data: [],
        at: 1500,
        logHash: `0x${"a".repeat(64)}`,
        priority: "price-time-hash",
      }),
    );
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(String(fetcher.mock.calls[0][0])).toBe(
      `https://api.example.invalid/v1/orders/fraction-book?${query}`,
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      cache: "no-store",
      redirect: "error",
    });
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("headers");
  });
  it.each([
    query + "&at=1501",
    query + "&sellerAddress=" + address,
    query.replace("560048", "1"),
    query.replace("at=1500", "at=-1"),
    query.replace("at=1500", "at=01500"),
    query.replace("at=1500", "at=281474976710656"),
    query.replace("paymentToken=" + address, "paymentToken=bad"),
  ])("rejects malformed scope before upstream: %s", async (value) => {
    expect((await GET(request(value))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("explains the fail-closed snapshot bound without returning partial candidates", async () => {
    fetcher.mockResolvedValue(
      Response.json({ detail: "private backend detail" }, { status: 422 }),
    );
    const response = await GET(request());
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain("No partial");
    expect(body).not.toContain("private backend");
  });
  it("redacts malformed upstream and transport failures", async () => {
    fetcher.mockRejectedValue(new Error("sensitive internal URL"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("sensitive");
  });
});
