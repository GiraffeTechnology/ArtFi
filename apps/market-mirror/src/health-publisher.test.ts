import { describe, expect, it } from "vitest";

import { MarketplaceHealthTracker } from "./adapter.js";
import { publishMarketplaceHealth } from "./health-publisher.js";

describe("marketplace health publisher", () => {
  it("posts the exact provider snapshot through the indexer credential boundary", async () => {
    const tracker = new MarketplaceHealthTracker(
      "opensea",
      60_000,
      () => new Date("2026-09-14T00:00:10.000Z"),
    );
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
});
