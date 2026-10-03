import { describe, expect, it, vi } from "vitest";

import { ArtFiAPIError, createArtFiClient } from "./index";

describe("ArtFi API client", () => {
  it("reads the locked Sepolia configuration", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          api: "v1",
          chainId: 560048,
          mode: "preview",
          network: "sepolia",
          readOnly: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const config = await createArtFiClient(
      "http://localhost:8080",
      fetcher,
    ).config();
    expect(config).toMatchObject({ chainId: 560048, readOnly: true });
  });

  it("turns problem responses into a typed error", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: "about:blank",
          title: "Missing",
          status: 404,
          detail: "No record",
          requestId: "abc",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    );
    await expect(
      createArtFiClient("http://localhost:8080", fetcher).asset("missing"),
    ).rejects.toBeInstanceOf(ArtFiAPIError);
  });
});

describe("public native order reads", () => {
  it("preserves exact deployment, asset and page filters without credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: [], total: 0, page: 2, pageSize: 20 }),
      );
    await createArtFiClient("https://api.example.test", fetcher).nativeOrders({
      kind: "whole",
      chainId: 560048,
      marketAddress: "0x1111111111111111111111111111111111111111",
      assetAddress: "0x2222222222222222222222222222222222222222",
      tokenId: "1",
      page: 2,
      pageSize: 20,
    });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/v1/orders");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kind: "whole",
      chainId: "560048",
      marketAddress: "0x1111111111111111111111111111111111111111",
      assetAddress: "0x2222222222222222222222222222222222222222",
      tokenId: "1",
      page: "2",
      pageSize: "20",
    });
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({
      Accept: "application/json, application/problem+json",
    });
  });
  it("loads a public order by hash and exact deployment", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ intentHash: "0xabc" }));
    await createArtFiClient("https://api.example.test", fetcher).nativeOrder(
      "0xabc",
      560048,
      "0x1111111111111111111111111111111111111111",
    );
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/v1/orders/0xabc");
    expect(url.searchParams.get("chainId")).toBe("560048");
    expect(url.searchParams.get("marketAddress")).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });
  it("keeps service failure distinct from an empty order list", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          type: "about:blank",
          title: "Unavailable",
          status: 503,
          detail: "Order storage unavailable",
          requestId: "test",
        },
        { status: 503 },
      ),
    );
    await expect(
      createArtFiClient("https://api.example.test", fetcher).nativeOrders(),
    ).rejects.toBeInstanceOf(ArtFiAPIError);
  });
});
