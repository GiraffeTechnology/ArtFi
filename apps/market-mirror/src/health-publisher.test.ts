import { describe, expect, it, vi } from "vitest";

import { MarketplaceHealthTracker } from "./adapter.js";
import { publishMarketplaceHealth } from "./health-publisher.js";

describe("marketplace health publisher", () => {
  it("posts the exact provider snapshot through the indexer credential boundary", async () => {
    const tracker = new MarketplaceHealthTracker(
      "opensea",
      60_000,
      () => new Date("2026-09-14T00:00:10.000Z"),
    );
    tracker.start();
    tracker.markBackfillSuccess();
    const snapshot = tracker.snapshot();
    let capturedURL = "";
    let capturedInit: RequestInit | undefined;
    await publishMarketplaceHealth(
      "https://api.test/",
      "test-only-indexer-key",
      snapshot,
      async (input, init) => {
        capturedURL = String(input);
        capturedInit = init;
        return new Response("{}", { status: 201 });
      },
    );
    expect(capturedURL).toBe("https://api.test/v1/indexer/market-health");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Indexer-Key": "test-only-indexer-key",
    });
    expect(JSON.parse(String(capturedInit?.body))).toEqual(snapshot);
  });

  it("fails closed when durable health ingestion rejects the report", async () => {
    const tracker = new MarketplaceHealthTracker("opensea", 60_000);
    await expect(
      publishMarketplaceHealth(
        "https://api.test",
        "test-only-indexer-key",
        tracker.snapshot(new Date("2026-09-14T00:00:10.000Z")),
        async () => new Response("{}", { status: 503 }),
      ),
    ).rejects.toThrow("HTTP 503");
  });
  it("bounds a report even when the transport ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | null | undefined;
      const pending = publishMarketplaceHealth(
        "https://api.test",
        "test-only-indexer-key",
        new MarketplaceHealthTracker("opensea", 60_000).snapshot(),
        async (_, init) => {
          signal = init?.signal;
          return await new Promise<Response>(() => {});
        },
        50,
      );
      const rejection = expect(pending).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(51);
      await rejection;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
