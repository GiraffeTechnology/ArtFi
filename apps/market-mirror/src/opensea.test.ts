import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  eventFingerprint,
  normalizeOpenSeaEvent,
  OpenSeaAdapter,
  OpenSeaJoinReadiness,
  startOpenSeaMirror,
} from "./opensea.js";
import type {
  MarketEventSink,
  MarketplaceAdapter,
  NormalizedMarketEvent,
} from "./adapter.js";

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
    });
    expect(adapter.capabilities).toEqual({
      realtime: true,
      restBackfill: true,
      createsOrders: false,
      fulfillsOrders: false,
      custody: false,
    });
  });

  it("follows REST cursors until the collection history is exhausted", async () => {
    const requestedCursors: Array<string | null> = [];
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      fetchImpl: async (input) => {
        const cursor = new URL(String(input)).searchParams.get("next");
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
  });

  it("continues beyond the former deployment page cap until history is exhausted", async () => {
    const requestedCursors: Array<string | null> = [];
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      fetchImpl: async (input) => {
        const cursor = new URL(String(input)).searchParams.get("next");
        requestedCursors.push(cursor);
        const page = cursor === null ? 0 : Number(cursor.slice("page-".length));
        return new Response(
          JSON.stringify({
            asset_events: [{ ...listed, version: page + 1 }],
            next: page < 24 ? `page-${page + 1}` : null,
          }),
          { status: 200 },
        );
      },
    });
    const published: unknown[] = [];
    await adapter.backfill(async (event) => {
      published.push(event);
    });
    expect(requestedCursors).toHaveLength(25);
    expect(requestedCursors.at(-1)).toBe("page-24");
    expect(published).toHaveLength(25);
  });

  it("spools complete histories outside the process heap and removes the spool", async () => {
    const spoolParentDirectory = await mkdtemp(
      join(tmpdir(), "artfi-opensea-test-"),
    );
    try {
      const adapter = new OpenSeaAdapter({
        apiKey: "test-only",
        collectionSlugs: ["artfi-test"],
        spoolParentDirectory,
        fetchImpl: async () =>
          new Response(JSON.stringify({ asset_events: [listed] }), {
            status: 200,
          }),
      });
      await adapter.backfill(async () => undefined);
      expect(await readdir(spoolParentDirectory)).toEqual([]);
    } finally {
      await rm(spoolParentDirectory, { force: true, recursive: true });
    }
  });

  it("resumes a durable snapshot from its last fsynced cursor", async () => {
    const spoolParentDirectory = await mkdtemp(
      join(tmpdir(), "artfi-opensea-resume-test-"),
    );
    try {
      const firstPublished: unknown[] = [];
      const firstAdapter = new OpenSeaAdapter({
        apiKey: "test-only",
        collectionSlugs: ["artfi-test"],
        retryAttempts: 1,
        spoolParentDirectory,
        fetchImpl: async (input) => {
          const cursor = new URL(String(input)).searchParams.get("next");
          if (cursor === null) {
            return new Response(
              JSON.stringify({
                asset_events: [listed],
                next: "cursor-page-2",
              }),
              { status: 200 },
            );
          }
          throw new Error("provider interrupted after page one");
        },
      });
      await expect(
        firstAdapter.backfill(async (event) => {
          firstPublished.push(event);
        }),
      ).rejects.toThrow("provider interrupted");
      expect(firstPublished).toEqual([]);
      expect(await readdir(spoolParentDirectory)).toHaveLength(1);

      const requestedCursors: Array<string | null> = [];
      const resumedPublished: NormalizedMarketEvent[] = [];
      const resumedAdapter = new OpenSeaAdapter({
        apiKey: "test-only",
        collectionSlugs: ["artfi-test"],
        spoolParentDirectory,
        fetchImpl: async (input) => {
          const cursor = new URL(String(input)).searchParams.get("next");
          requestedCursors.push(cursor);
          return new Response(
            JSON.stringify({
              asset_events: [
                {
                  ...listed,
                  version: 8,
                  payload: {
                    ...listed.payload,
                    event_timestamp: "2026-08-19T04:00:01Z",
                  },
                },
              ],
              next: null,
            }),
            { status: 200 },
          );
        },
      });
      await resumedAdapter.backfill(async (event) => {
        resumedPublished.push(event);
      });
      expect(requestedCursors).toEqual(["cursor-page-2"]);
      expect(resumedPublished.map((event) => event.version)).toEqual([7, 8]);
      expect(await readdir(spoolParentDirectory)).toEqual([]);
    } finally {
      await rm(spoolParentDirectory, { force: true, recursive: true });
    }
  });

  it("keeps a durable snapshot single-writer", async () => {
    const spoolParentDirectory = await mkdtemp(
      join(tmpdir(), "artfi-opensea-lock-test-"),
    );
    let markEntered!: () => void;
    let releaseFetch!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    try {
      const firstAdapter = new OpenSeaAdapter({
        apiKey: "test-only",
        collectionSlugs: ["artfi-test"],
        spoolParentDirectory,
        fetchImpl: async () => {
          markEntered();
          await release;
          return new Response(JSON.stringify({ asset_events: [listed] }), {
            status: 200,
          });
        },
      });
      const running = firstAdapter.backfill(async () => undefined);
      await entered;

      const competingAdapter = new OpenSeaAdapter({
        apiKey: "test-only",
        collectionSlugs: ["artfi-test"],
        spoolParentDirectory,
        fetchImpl: async () => {
          throw new Error("competing process must not fetch");
        },
      });
      await expect(
        competingAdapter.backfill(async () => undefined),
      ).rejects.toMatchObject({ code: "EEXIST" });
      releaseFetch();
      await running;
      expect(await readdir(spoolParentDirectory)).toEqual([]);
    } finally {
      releaseFetch();
      await rm(spoolParentDirectory, { force: true, recursive: true });
    }
  });

  it("recovers a durable snapshot after its lock owner exits", async () => {
    const spoolParentDirectory = await mkdtemp(
      join(tmpdir(), "artfi-opensea-stale-lock-test-"),
    );
    try {
      const collectionsHash = createHash("sha256")
        .update(JSON.stringify(["artfi-test"]))
        .digest("hex");
      const spoolDirectory = join(
        spoolParentDirectory,
        `snapshot-${collectionsHash.slice(0, 24)}`,
      );
      await mkdir(spoolDirectory, { recursive: true });
      await writeFile(join(spoolDirectory, "active.lock"), "2147483647\n", {
        mode: 0o600,
      });

      const published: NormalizedMarketEvent[] = [];
      const adapter = new OpenSeaAdapter({
        apiKey: "test-only",
        collectionSlugs: ["artfi-test"],
        spoolParentDirectory,
        fetchImpl: async () =>
          new Response(JSON.stringify({ asset_events: [listed] }), {
            status: 200,
          }),
      });
      await adapter.backfill(async (event) => {
        published.push(event);
      });

      expect(published).toHaveLength(1);
      expect(await readdir(spoolParentDirectory)).toEqual([]);
    } finally {
      await rm(spoolParentDirectory, { force: true, recursive: true });
    }
  });

  it("recovers when a live PID belongs to a different process instance", async () => {
    const spoolParentDirectory = await mkdtemp(
      join(tmpdir(), "artfi-opensea-reused-pid-lock-test-"),
    );
    try {
      const collectionsHash = createHash("sha256")
        .update(JSON.stringify(["artfi-test"]))
        .digest("hex");
      const spoolDirectory = join(
        spoolParentDirectory,
        `snapshot-${collectionsHash.slice(0, 24)}`,
      );
      await mkdir(spoolDirectory, { recursive: true });
      await writeFile(
        join(spoolDirectory, "active.lock"),
        `${JSON.stringify({
          schemaVersion: "1",
          pid: process.pid,
          processInstance: "different-process-instance",
          token: "stale-owner",
        })}\n`,
        { mode: 0o600 },
      );

      const published: NormalizedMarketEvent[] = [];
      const adapter = new OpenSeaAdapter({
        apiKey: "test-only",
        collectionSlugs: ["artfi-test"],
        spoolParentDirectory,
        fetchImpl: async () =>
          new Response(JSON.stringify({ asset_events: [listed] }), {
            status: 200,
          }),
      });
      await adapter.backfill(async (event) => {
        published.push(event);
      });

      expect(published).toHaveLength(1);
      expect(await readdir(spoolParentDirectory)).toEqual([]);
    } finally {
      await rm(spoolParentDirectory, { force: true, recursive: true });
    }
  });

  it("keeps simultaneous stale-lock recovery single-writer", async () => {
    const spoolParentDirectory = await mkdtemp(
      join(tmpdir(), "artfi-opensea-stale-lock-race-test-"),
    );
    let markEntered!: () => void;
    let releaseFetch!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    try {
      const collectionsHash = createHash("sha256")
        .update(JSON.stringify(["artfi-test"]))
        .digest("hex");
      const spoolDirectory = join(
        spoolParentDirectory,
        `snapshot-${collectionsHash.slice(0, 24)}`,
      );
      await mkdir(spoolDirectory, { recursive: true });
      await writeFile(
        join(spoolDirectory, "active.lock"),
        `${JSON.stringify({
          schemaVersion: "1",
          pid: process.pid,
          processInstance: "different-process-instance",
          token: "stale-owner",
        })}\n`,
        { mode: 0o600 },
      );

      let fetchCalls = 0;
      const createAdapter = () =>
        new OpenSeaAdapter({
          apiKey: "test-only",
          collectionSlugs: ["artfi-test"],
          spoolParentDirectory,
          fetchImpl: async () => {
            fetchCalls += 1;
            markEntered();
            await release;
            return new Response(JSON.stringify({ asset_events: [listed] }), {
              status: 200,
            });
          },
        });
      const attempts = [
        createAdapter().backfill(async () => undefined),
        createAdapter().backfill(async () => undefined),
      ].map((attempt) =>
        attempt.then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        ),
      );
      await entered;
      const firstOutcome = await Promise.race(attempts);
      expect(firstOutcome).toMatchObject({
        status: "rejected",
        reason: { code: "EEXIST" },
      });
      expect(fetchCalls).toBe(1);
      releaseFetch();
      const outcomes = await Promise.all(attempts);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect(await readdir(spoolParentDirectory)).toEqual([]);
    } finally {
      releaseFetch();
      await rm(spoolParentDirectory, { force: true, recursive: true });
    }
  });

  it("rejects a repeated REST cursor without looping", async () => {
    let calls = 0;
    const published: unknown[] = [];
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      fetchImpl: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ asset_events: [listed], next: "stuck-cursor" }),
          { status: 200 },
        );
      },
    });
    await expect(
      adapter.backfill(async (event) => {
        published.push(event);
      }),
    ).rejects.toThrow("cursor did not advance");
    expect(calls).toBe(2);
    expect(published).toEqual([]);
  });

  it("honors a bounded Retry-After delay for provider rate limits", async () => {
    const delays: number[] = [];
    let calls = 0;
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
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
    expect(calls).toBe(2);
  });

  it("times out a stalled REST request", async () => {
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
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
  });

  it("keeps the timeout active while reading a stalled response body", async () => {
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      retryAttempts: 1,
      requestTimeoutMs: 10,
      fetchImpl: async (_input, init) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(init.signal?.reason),
              { once: true },
            );
          },
        });
        return new Response(body, { status: 200 });
      },
    });
    await expect(adapter.backfill(async () => undefined)).rejects.toThrow(
      "request timed out",
    );
  });

  it("does not retry a permanent provider rejection", async () => {
    let calls = 0;
    const adapter = new OpenSeaAdapter({
      apiKey: "test-only",
      collectionSlugs: ["artfi-test"],
      retryAttempts: 3,
      sleep: async () => {
        throw new Error("permanent rejection must not sleep");
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
  });

  it("subscribes to realtime delivery before taking the REST snapshot", async () => {
    const observed: string[] = [];
    let liveSink: MarketEventSink | undefined;
    const historic = normalizeOpenSeaEvent(listed);
    const live = {
      ...historic,
      version: historic.version + 1,
      eventTimestamp: "2026-08-19T04:00:01.000Z",
    };
    const adapter: MarketplaceAdapter = {
      source: "opensea",
      capabilities: {
        realtime: true,
        restBackfill: true,
        createsOrders: false,
        fulfillsOrders: false,
        custody: false,
      },
      async start(sink) {
        observed.push("subscribe");
        liveSink = sink;
        return () => observed.push("stop");
      },
      async backfill(sink) {
        observed.push("snapshot");
        await liveSink?.(live);
        await sink(historic);
      },
    };
    const published: NormalizedMarketEvent[] = [];
    const stop = await startOpenSeaMirror(adapter, async (event) => {
      published.push(event);
    });
    expect(observed).toEqual(["subscribe", "snapshot"]);
    expect(published).toEqual([live, historic]);
    stop();
    expect(observed).toEqual(["subscribe", "snapshot", "stop"]);
  });

  it("waits for every remote collection join acknowledgement", async () => {
    const readiness = new OpenSeaJoinReadiness(
      ["artfi-test", "artfi-second"],
      1_000,
    );
    let resolved = false;
    const waiting = readiness.wait().then(() => {
      resolved = true;
    });
    readiness.observe(
      Buffer.from(
        JSON.stringify([
          "1",
          "1",
          "collection:artfi-test",
          "phx_reply",
          { status: "ok" },
        ]),
      ),
    );
    await Promise.resolve();
    expect(resolved).toBe(false);
    readiness.observe(
      Buffer.from(
        JSON.stringify([
          "2",
          "2",
          "collection:artfi-second",
          "phx_reply",
          { status: "ok" },
        ]),
      ),
    );
    await waiting;
    expect(resolved).toBe(true);
  });

  it("stops the realtime subscription when the REST snapshot fails", async () => {
    let stopped = false;
    const adapter: MarketplaceAdapter = {
      source: "opensea",
      capabilities: {
        realtime: true,
        restBackfill: true,
        createsOrders: false,
        fulfillsOrders: false,
        custody: false,
      },
      async start() {
        return () => {
          stopped = true;
        };
      },
      async backfill() {
        throw new Error("snapshot failed");
      },
    };
    await expect(
      startOpenSeaMirror(adapter, async () => undefined),
    ).rejects.toThrow("snapshot failed");
    expect(stopped).toBe(true);
  });
});
