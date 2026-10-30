import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { GET } from "../app/api/rwa/assets/[slug]/analytics/route";
import { readNativeAnalyticsJSON } from "./native-market-analytics-read";
import {
  analyticsAssetFixture,
  analyticsPaymentToken,
  nativeAnalyticsFixture,
} from "../test/native-market-analytics-fixture";
import { rwaAssetIdentity } from "./rwa-catalog";
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv("ARTFI_API_URL", "https://api.invalid/existing-prefix/");
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const context = () => ({
  params: Promise.resolve({ slug: analyticsAssetFixture().slug }),
});
const request = (query = `paymentToken=${analyticsPaymentToken}`) =>
  new Request(
    `https://artfi.invalid/api/rwa/assets/isolated-real-record/analytics?${query}`,
    {
      headers: {
        cookie: "TEST_ONLY_PRIVATE_COOKIE",
        authorization: "Bearer TEST_ONLY_PRIVATE_TOKEN",
      },
    },
  );
describe("native analytics approved-source relay and transfer bounds", () => {
  it("derives market and token from the server record, preserves the deployment prefix and forwards no browser credentials", async () => {
    const asset = analyticsAssetFixture();
    fetcher
      .mockResolvedValueOnce(Response.json(asset))
      .mockResolvedValueOnce(Response.json(nativeAnalyticsFixture()));
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      catalogIdentity: rwaAssetIdentity(asset),
      catalogRevision: asset.revision,
      analytics: nativeAnalyticsFixture(),
    });
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      `https://api.invalid/existing-prefix/v1/rwa/assets/${asset.slug}`,
    );
    const actual = new URL(String(fetcher.mock.calls[1]![0]));
    expect(actual.pathname).toBe("/existing-prefix/v1/market/native-analytics");
    expect(Object.fromEntries(actual.searchParams)).toEqual({
      chainId: "560048",
      marketAddress: asset.binding.marketAddress,
      assetToken: asset.binding.fractionTokenAddress,
      paymentToken: analyticsPaymentToken,
    });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("PRIVATE");
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
  });
  it.each([
    "paymentToken=bad",
    `paymentToken=${analyticsPaymentToken}&paymentToken=${analyticsPaymentToken}`,
    `paymentToken=${analyticsPaymentToken}&assetToken=other`,
    "paymentToken=0x0000000000000000000000000000000000000000",
  ])("rejects unsupported query %s before backend access", async (query) => {
    expect((await GET(request(query), context())).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["whole", "network", "missing-token"])(
    "keeps %s unsupported without remapping its meaning",
    async (kind) => {
      const asset = analyticsAssetFixture();
      if (kind === "whole") asset.section = "whole";
      if (kind === "network") asset.binding.chainId = 1;
      if (kind === "missing-token")
        asset.binding.fractionTokenAddress = undefined;
      fetcher.mockResolvedValueOnce(Response.json(asset));
      expect((await GET(request(), context())).status).toBe(422);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("does not treat revoked grounding as a prohibition on reading historical indexed trades", async () => {
    const asset = analyticsAssetFixture();
    asset.grounding.status = "revoked";
    fetcher
      .mockResolvedValueOnce(Response.json(asset))
      .mockResolvedValueOnce(Response.json(nativeAnalyticsFixture()));
    expect((await GET(request(), context())).status).toBe(200);
  });
  it("refuses a foreign analytics response and never returns its values", async () => {
    fetcher
      .mockResolvedValueOnce(Response.json(analyticsAssetFixture()))
      .mockResolvedValueOnce(
        Response.json({
          ...nativeAnalyticsFixture(),
          assetToken: "0x" + "a".repeat(40),
        }),
      );
    const response = await GET(request(), context());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("27021597764222979");
  });
  it("sanitizes unavailable upstream responses without forwarding their body", async () => {
    fetcher
      .mockResolvedValueOnce(Response.json(analyticsAssetFixture()))
      .mockResolvedValueOnce(
        new Response("TEST_ONLY_INTERNAL_ERROR", { status: 503 }),
      );
    const response = await GET(request(), context());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("INTERNAL_ERROR");
  });
  it("rejects an oversized declared body even when its small JSON body is valid", async () => {
    const response = new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": "196609",
      },
    });
    fetcher.mockResolvedValue(response);
    await expect(
      readNativeAnalyticsJSON("https://api.invalid/"),
    ).rejects.toThrow();
  });
  it("discards an unacceptable content type without consuming its body", async () => {
    const response = new Response("not-json", {
      headers: { "content-type": "text/html" },
    });
    const reader = vi.spyOn(response.body!, "getReader"),
      cancel = vi.spyOn(response.body!, "cancel");
    fetcher.mockResolvedValue(response);
    await expect(
      readNativeAnalyticsJSON("https://api.invalid/"),
    ).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("bounds ignored header cancellation and discards a late response without reading it", async () => {
    vi.useFakeTimers();
    let deliver!: (value: Response) => void;
    fetcher.mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const result = readNativeAnalyticsJSON("https://api.invalid/");
    const rejection = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(8001);
    await rejection;
    const response = Response.json({});
    const reader = vi.spyOn(response.body!, "getReader"),
      cancel = vi.spyOn(response.body!, "cancel");
    deliver(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(reader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not begin a request whose caller already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readNativeAnalyticsJSON("https://api.invalid/", controller.signal),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
