import { describe, expect, it } from "vitest";
import {
  MarketplaceHealthTracker,
  type MarketplaceBackfillLease,
} from "./adapter.js";
import { OpenSeaAdapter } from "./opensea.js";

describe("provider-neutral source health", () => {
  it("retains millisecond staleness while reporting whole-second lag", () => {
    let now = new Date("2026-10-30T00:00:00.000Z");
    const health = new MarketplaceHealthTracker("opensea", 60_000, () => now);
    const epoch = health.beginWork();
    expect(health.snapshot()).toMatchObject({ state: "starting", stale: true });
    health.markBackfillSuccess(epoch);
    expect(health.snapshot()).toMatchObject({
      state: "healthy",
      stale: false,
      realtimeConnected: false,
    });
    now = new Date("2026-10-30T00:01:00.500Z");
    expect(health.snapshot()).toMatchObject({
      state: "stale",
      stale: true,
      freshnessLagSeconds: 60,
    });
    health.stop();
    expect(health.snapshot().state).toBe("stopped");
  });
  it("never lets an older event acknowledgement undo a disconnect", () => {
    const health = new MarketplaceHealthTracker("opensea", 60_000);
    const epoch = health.beginWork();
    const first = health.beginConnection();
    health.markRealtimeReady(first);
    health.markEvent(first);
    health.markRealtimeFailure(first);
    health.markEvent(first);
    health.markBackfillSuccess(epoch);
    expect(health.snapshot()).toMatchObject({
      state: "degraded",
      realtimeConnected: false,
      consecutiveFailures: 1,
    });
    const next = health.beginConnection();
    health.markRealtimeReady(first);
    expect(health.snapshot().realtimeConnected).toBe(false);
    health.markRealtimeReady(next);
    health.markEventFailure(first);
    health.markEvent(next);
    expect(health.snapshot()).toMatchObject({
      state: "healthy",
      realtimeConnected: true,
      consecutiveFailures: 0,
    });
  });
  it("does not revive a stopped tracker or overwrite a restarted generation", () => {
    const health = new MarketplaceHealthTracker("opensea", 60_000);
    const old = health.beginWork();
    const connection = health.beginConnection();
    health.markRealtimeReady(connection);
    health.stop();
    health.markEvent(connection);
    health.markEventFailure(connection);
    health.markBackfillSuccess(old);
    health.markFailure(old);
    expect(health.snapshot()).toMatchObject({
      state: "stopped",
      realtimeConnected: false,
    });
    const next = health.beginWork();
    health.markBackfillSuccess(next);
    health.markFailure(old);
    health.markRealtimeReady(connection);
    expect(health.snapshot()).toMatchObject({
      state: "healthy",
      realtimeConnected: false,
      consecutiveFailures: 0,
    });
  });
});
describe("OpenSea committed source health", () => {
  it("records REST recovery only after the complete deferred snapshot commits", async () => {
    let now = new Date("2026-10-30T00:00:00Z");
    const adapter = new OpenSeaAdapter({
      apiKey: "TEST_ONLY",
      collectionSlugs: ["test-only"],
      now: () => now,
      fetchImpl: async () => new Response(JSON.stringify({ asset_events: [] })),
    });
    const lease = await adapter.backfill(async () => {}, undefined, {
      deferFinalize: true,
    });
    expect(lease).toBeDefined();
    expect(adapter.health()).toMatchObject({ state: "starting", stale: true });
    await (lease as MarketplaceBackfillLease).commit();
    expect(adapter.health()).toMatchObject({
      state: "healthy",
      stale: false,
      realtimeConnected: false,
    });
    now = new Date("2026-10-30T00:01:01Z");
    await (lease as MarketplaceBackfillLease).commit();
    expect(adapter.health()).toMatchObject({
      state: "stale",
      stale: true,
      freshnessLagSeconds: 61,
    });
  });
  it("retains bounded transient retries and reports successful recovery", async () => {
    const statuses = [429, 503, 200],
      delays: number[] = [];
    const adapter = new OpenSeaAdapter({
      apiKey: "TEST_ONLY",
      collectionSlugs: ["test-only"],
      retryAttempts: 3,
      retryBaseDelayMs: 10,
      sleep: async (delay) => {
        delays.push(delay);
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ asset_events: [] }), {
          status: statuses.shift() ?? 500,
        }),
    });
    await adapter.backfill(async () => {});
    expect(delays).toEqual([10, 20]);
    expect(adapter.health()).toMatchObject({
      state: "healthy",
      consecutiveFailures: 0,
    });
  });
  it("does not retry permanent rejection or invent healthy source evidence", async () => {
    let calls = 0;
    const adapter = new OpenSeaAdapter({
      apiKey: "TEST_ONLY",
      collectionSlugs: ["test-only"],
      fetchImpl: async () => {
        calls++;
        return new Response("{}", { status: 401 });
      },
      sleep: async () => {
        throw Error("MUST_NOT_RETRY");
      },
    });
    await expect(adapter.backfill(async () => {})).rejects.toThrow("HTTP 401");
    expect(calls).toBe(1);
    expect(adapter.health()).toMatchObject({
      state: "degraded",
      stale: true,
      consecutiveFailures: 1,
    });
  });
  it("a pre-cancelled operator request is not recorded as a provider failure", async () => {
    let calls = 0;
    const adapter = new OpenSeaAdapter({
      apiKey: "TEST_ONLY",
      collectionSlugs: ["test-only"],
      fetchImpl: async () => {
        calls++;
        throw Error("MUST_NOT_FETCH");
      },
    });
    const controller = new AbortController();
    controller.abort(Error("TEST_ONLY_CANCELLED"));
    await expect(
      adapter.backfill(async () => {}, controller.signal),
    ).rejects.toThrow("TEST_ONLY_CANCELLED");
    expect(calls).toBe(0);
    expect(adapter.health()).toMatchObject({
      state: "stopped",
      consecutiveFailures: 0,
    });
  });
});
