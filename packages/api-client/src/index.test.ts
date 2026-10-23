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

  it("reads durable external market provider health", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: "1",
          source: "opensea",
          state: "healthy",
          stale: false,
          realtimeConnected: true,
          consecutiveFailures: 0,
          observedAt: "2026-09-14T00:00:30Z",
          lastEventAt: "2026-09-14T00:00:20Z",
          freshnessLagSeconds: 10,
          staleAfterSeconds: 60,
          receivedAt: "2026-09-14T00:00:31Z",
          reportLagSeconds: 1,
          reportingStale: false,
          available: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const health = await createArtFiClient(
      "http://localhost:8080",
      fetcher,
    ).marketProviderHealth();

    expect(health).toMatchObject({
      source: "opensea",
      available: true,
      reportingStale: false,
    });
    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://localhost:8080/v1/market/health?source=opensea"),
      expect.any(Object),
    );
  });
});
