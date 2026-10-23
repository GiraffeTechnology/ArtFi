import { describe, expect, it } from "vitest";
import type { BaseStreamMessage, Callback } from "@opensea/stream-js";

import { MarketplaceHealthTracker } from "./adapter.js";

import {
  eventFingerprint,
  normalizeOpenSeaEvent,
  OpenSeaAdapter,
} from "./opensea.js";

const listed = {
  event_type: "item_listed",
  sent_at: "2026-08-19T04:00:00Z",
  version: 7,
  payload: {
    event_timestamp: "2026-08-19T03:59:59Z",
    order_hash:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    item: {
      nft_id: "ethereum/0x2222222222222222222222222222222222222222/42",
      permalink:
        "https://opensea.io/assets/ethereum/0x2222222222222222222222222222222222222222/42",
    },
    collection: { slug: "artfi-test" },
    maker: { address: "0x3333333333333333333333333333333333333333" },
    base_price: "1000000000000000",
    payment_token: { symbol: "ETH" },
  },
};

describe("OpenSea normalization", () => {
  it("normalizes an order without adding execution capability", () => {
    const event = normalizeOpenSeaEvent(listed);
    expect(event).toMatchObject({
      schemaVersion: "1",
      source: "opensea",
      eventType: "item_listed",
      eventFamily: "order",
      version: 7,
      chain: "ethereum",
      tokenId: "42",
      contractAddress: "0x2222222222222222222222222222222222222222",
      collectionSlug: "artfi-test",
      price: "1000000000000000",
    });
  });

  it("produces a stable idempotency fingerprint", () => {
    const event = normalizeOpenSeaEvent(listed);
    expect(eventFingerprint(event)).toMatch(/^[0-9a-f]{64}$/);
    expect(eventFingerprint(event)).toBe(eventFingerprint(event));
  });

  it("fails closed when the source entity cannot be identified", () => {
    expect(() =>
      normalizeOpenSeaEvent({
        event_type: "item_sold",
        payload: { chain: "ethereum", event_timestamp: "2026-08-19T04:00:00Z" },
      }),
    ).toThrow(/entity key/);
  });

  it("exposes a read-only capability boundary for future adapters", () => {
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      backfillPages: 1,
    });
    expect(adapter.capabilities).toEqual({
      realtime: true,
      restBackfill: true,
      createsOrders: false,
      fulfillsOrders: false,
      custody: false,
    });
  });

  it("retries only bounded transient REST failures and records recovery", async () => {
    const responses = [429, 503, 200];
    const delays: number[] = [];
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      backfillPages: 1,
      retryAttempts: 3,
      retryBaseDelayMs: 10,
      sleep: async (delay) => {
        delays.push(delay);
      },
      fetchImpl: async () => {
        const status = responses.shift() ?? 500;
        return new Response(
          JSON.stringify({ asset_events: status === 200 ? [listed] : [] }),
          { status },
        );
      },
    });
    const events: unknown[] = [];
    await adapter.backfill(async (event) => {
      events.push(event);
    });
    expect(delays).toEqual([10, 20]);
    expect(events).toHaveLength(1);
    expect(adapter.health().consecutiveFailures).toBe(0);
    expect(adapter.health().state).toBe("healthy");
  });

  it("honors a bounded Retry-After delay for provider rate limits", async () => {
    const delays: number[] = [];
    let calls = 0;
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      backfillPages: 1,
      retryAttempts: 2,
      retryBaseDelayMs: 10,
      sleep: async (delay) => {
        delays.push(delay);
      },
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response("{}", {
              status: 429,
              headers: { "retry-after": "2" },
            })
          : new Response(JSON.stringify({ asset_events: [listed] }), {
              status: 200,
            });
      },
    });
    await adapter.backfill(async () => undefined);
    expect(delays).toEqual([2_000]);
    expect(adapter.health()).toMatchObject({
      state: "healthy",
      consecutiveFailures: 0,
    });
  });

  it("times out a stalled REST request and records provider degradation", async () => {
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      backfillPages: 1,
      retryAttempts: 1,
      requestTimeoutMs: 10,
      fetchImpl: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    });
    await expect(adapter.backfill(async () => undefined)).rejects.toThrow(
      "request timed out",
    );
    expect(adapter.health()).toMatchObject({
      state: "degraded",
      consecutiveFailures: 1,
    });
  });

  it("follows REST cursors until the complete collection history is exhausted", async () => {
    const requestedCursors: Array<string | null> = [];
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      backfillPages: 3,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        const cursor = url.searchParams.get("next");
        requestedCursors.push(cursor);
        return new Response(
          JSON.stringify({
            asset_events: [
              {
                ...listed,
                version: cursor === null ? 7 : 8,
                payload: {
                  ...listed.payload,
                  event_timestamp:
                    cursor === null
                      ? "2026-08-19T03:59:59Z"
                      : "2026-08-19T04:00:01Z",
                },
              },
            ],
            next: cursor === null ? "cursor-page-2" : null,
          }),
          { status: 200 },
        );
      },
    });
    const events: unknown[] = [];
    await adapter.backfill(async (event) => {
      events.push(event);
    });
    expect(requestedCursors).toEqual([null, "cursor-page-2"]);
    expect(events).toHaveLength(2);
    expect(adapter.health()).toMatchObject({
      state: "healthy",
      consecutiveFailures: 0,
    });
  });

  it("fails closed instead of reporting incomplete REST history as successful", async () => {
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      backfillPages: 1,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ asset_events: [listed], next: "more-history" }),
          { status: 200 },
        ),
    });
    await expect(adapter.backfill(async () => undefined)).rejects.toThrow(
      "incomplete at the configured page limit",
    );
    expect(adapter.health()).toMatchObject({
      state: "degraded",
      consecutiveFailures: 1,
      lastBackfillSuccessAt: undefined,
    });
  });

  it("rejects a repeated REST cursor without looping or claiming recovery", async () => {
    let calls = 0;
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      backfillPages: 3,
      fetchImpl: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ asset_events: [listed], next: "stuck-cursor" }),
          { status: 200 },
        );
      },
    });
    await expect(adapter.backfill(async () => undefined)).rejects.toThrow(
      "cursor did not advance",
    );
    expect(calls).toBe(2);
    expect(adapter.health()).toMatchObject({
      state: "degraded",
      consecutiveFailures: 1,
    });
  });

  it("does not retry permanent REST rejection", async () => {
    let calls = 0;
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      backfillPages: 1,
      retryAttempts: 3,
      retryBaseDelayMs: 10,
      sleep: async () => {
        throw new Error("sleep must not be called");
      },
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 401 });
      },
    });
    await expect(adapter.backfill(async () => undefined)).rejects.toThrow(
      "HTTP 401",
    );
    expect(calls).toBe(1);
    expect(adapter.health()).toMatchObject({
      state: "degraded",
      consecutiveFailures: 1,
    });
  });

  it("does not classify an operator abort as a provider failure", async () => {
    const controller = new AbortController();
    controller.abort(new Error("TEST_ONLY_ABORT"));
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      backfillPages: 1,
      fetchImpl: async (_input, init) => {
        if (init?.signal?.aborted) throw init.signal.reason;
        throw new Error("aborted signal was not propagated");
      },
    });
    await expect(
      adapter.backfill(async () => undefined, controller.signal),
    ).rejects.toThrow("TEST_ONLY_ABORT");
    expect(adapter.health()).toMatchObject({
      state: "stopped",
      consecutiveFailures: 0,
    });
  });
});

describe("provider-neutral marketplace health", () => {
  it("distinguishes healthy, degraded, stale, and stopped states", () => {
    let now = new Date("2026-09-13T10:00:00.000Z");
    const health = new MarketplaceHealthTracker("opensea", 60_000, () => now);
    health.start();
    expect(health.snapshot()).toMatchObject({ state: "starting", stale: true });
    health.markBackfillSuccess();
    expect(health.snapshot()).toMatchObject({
      state: "healthy",
      stale: false,
      consecutiveFailures: 0,
    });
    health.markFailure();
    expect(health.snapshot()).toMatchObject({
      state: "degraded",
      consecutiveFailures: 1,
    });
    health.markEvent();
    expect(health.snapshot()).toMatchObject({
      state: "healthy",
      realtimeConnected: true,
      consecutiveFailures: 0,
    });
    now = new Date("2026-09-13T10:01:01.000Z");
    expect(health.snapshot()).toMatchObject({
      state: "stale",
      stale: true,
      freshnessLagSeconds: 61,
    });
    health.stop();
    expect(health.snapshot()).toMatchObject({
      state: "stopped",
      realtimeConnected: false,
    });
  });

  it("records stream transport errors without claiming a connection", async () => {
    let onError: ((error: unknown) => void) | undefined;
    let onEvent: Callback<BaseStreamMessage<unknown>> | undefined;
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      backfillPages: 1,
      streamClientFactory: (options) => {
        onError = options.onError;
        return {
          onEvents: (_slug, _eventTypes, callback) => {
            onEvent = callback;
            return () => undefined;
          },
          connect: () => undefined,
          disconnect: () => undefined,
        };
      },
    });
    const stop = await adapter.start(async () => undefined);
    expect(adapter.health()).toMatchObject({
      state: "starting",
      realtimeConnected: false,
    });
    onEvent?.(listed);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.health()).toMatchObject({
      state: "healthy",
      realtimeConnected: true,
    });
    onError?.(new Error("TEST_ONLY_STREAM_FAILURE"));
    expect(adapter.health()).toMatchObject({
      state: "degraded",
      realtimeConnected: false,
      consecutiveFailures: 1,
    });
    stop();
  });
});
