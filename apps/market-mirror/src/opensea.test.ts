import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  eventFingerprint,
  normalizeOpenSeaEvent,
  OpenSeaAdapter,
  OpenSeaJoinReadiness,
  startOpenSeaMirror,
  writeAll,
} from "./opensea.js";
import type {
  MarketEventSink,
  MarketSnapshotSink,
  MarketplaceAdapter,
  MarketplaceStreamLifecycle,
  NormalizedMarketEvent,
} from "./adapter.js";

function atomicSnapshotSink(sink: MarketEventSink): MarketSnapshotSink {
  return async (events, signal) => {
    const staged: NormalizedMarketEvent[] = [];
    for await (const event of events) {
      if (signal.aborted) throw signal.reason;
      staged.push(event);
    }
    if (signal.aborted) throw signal.reason;
    for (const event of staged) {
      await sink(event);
    }
  };
}

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

async function expectStableSnapshotDirectoryClean(
  spoolParentDirectory: string,
): Promise<void> {
  const entries = await readdir(spoolParentDirectory);
  expect(entries).toHaveLength(1);
  expect(await readdir(join(spoolParentDirectory, entries[0]!))).toEqual([]);
}

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

  it("completes short durable-log writes before returning", async () => {
    const chunks: Buffer[] = [];
    let calls = 0;
    const file = {
      async write(
        buffer: Uint8Array,
        offset: number,
        length: number,
      ): Promise<{ bytesWritten: number; buffer: Uint8Array }> {
        calls += 1;
        const bytesWritten = Math.min(2, length);
        chunks.push(
          Buffer.from(buffer.subarray(offset, offset + bytesWritten)),
        );
        return { bytesWritten, buffer };
      },
    } as unknown as Pick<FileHandle, "write">;

    await writeAll(file, "abcdef");

    expect(calls).toBe(3);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("abcdef");
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
      await expectStableSnapshotDirectoryClean(spoolParentDirectory);
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
          const event = {
            ...listed,
            version: cursor === null ? 9 : 8,
            payload: {
              ...listed.payload,
              event_timestamp:
                cursor === null
                  ? "2026-08-19T04:00:02Z"
                  : "2026-08-19T04:00:01Z",
            },
          };
          return new Response(
            JSON.stringify({
              asset_events: cursor === null ? [event, listed] : [event],
              next: cursor === null ? "overlap-unused" : null,
            }),
            { status: 200 },
          );
        },
      });
      await resumedAdapter.backfill(async (event) => {
        resumedPublished.push(event);
      });
      expect(requestedCursors).toEqual([null, "cursor-page-2"]);
      expect(resumedPublished.map((event) => event.version)).toEqual([7, 9, 8]);
      await expectStableSnapshotDirectoryClean(spoolParentDirectory);
    } finally {
      await rm(spoolParentDirectory, { force: true, recursive: true });
    }
  });

  it("traverses recovery overlap pages until the committed boundary", async () => {
    const spoolParentDirectory = await mkdtemp(
      join(tmpdir(), "artfi-opensea-overlap-test-"),
    );
    try {
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
        firstAdapter.backfill(async () => undefined),
      ).rejects.toThrow("provider interrupted");

      const requestedCursors: Array<string | null> = [];
      const published: NormalizedMarketEvent[] = [];
      const eventWithVersion = (version: number) => ({
        ...listed,
        version,
        payload: {
          ...listed.payload,
          event_timestamp: new Date(
            Date.parse("2026-08-19T04:00:00Z") + version * 1_000,
          ).toISOString(),
        },
      });
      const resumedAdapter = new OpenSeaAdapter({
        apiKey: "test-only",
        collectionSlugs: ["artfi-test"],
        retryAttempts: 1,
        spoolParentDirectory,
        fetchImpl: async (input) => {
          const cursor = new URL(String(input)).searchParams.get("next");
          requestedCursors.push(cursor);
          if (cursor === null) {
            return new Response(
              JSON.stringify({
                asset_events: [eventWithVersion(10), eventWithVersion(9)],
                next: "overlap-page-2",
              }),
              { status: 200 },
            );
          }
          if (cursor === "overlap-page-2") {
            return new Response(
              JSON.stringify({
                asset_events: [eventWithVersion(8), listed],
                next: "overlap-unused",
              }),
              { status: 200 },
            );
          }
          expect(cursor).toBe("cursor-page-2");
          return new Response(
            JSON.stringify({
              asset_events: [eventWithVersion(6)],
              next: null,
            }),
            { status: 200 },
          );
        },
      });
      await resumedAdapter.backfill(async (event) => {
        published.push(event);
      });

      expect(requestedCursors).toEqual([
        null,
        "overlap-page-2",
        "cursor-page-2",
      ]);
      expect(published.map((event) => event.version)).toEqual([7, 10, 9, 8, 6]);
      await expectStableSnapshotDirectoryClean(spoolParentDirectory);
    } finally {
      await rm(spoolParentDirectory, { force: true, recursive: true });
    }
  });

  it("recovers checkpoint and spool tails from the last complete record", async () => {
    const spoolParentDirectory = await mkdtemp(
      join(tmpdir(), "artfi-opensea-tail-recovery-test-"),
    );
    try {
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
        firstAdapter.backfill(async () => undefined),
      ).rejects.toThrow("provider interrupted");

      const [snapshotDirectory] = await readdir(spoolParentDirectory);
      const snapshotPath = join(spoolParentDirectory, snapshotDirectory!);
      await appendFile(join(snapshotPath, "events.ndjson"), '{"partial":');
      await appendFile(
        join(snapshotPath, "checkpoints.ndjson"),
        '{"schemaVersion":',
      );

      const requestedCursors: Array<string | null> = [];
      const published: NormalizedMarketEvent[] = [];
      const resumedAdapter = new OpenSeaAdapter({
        apiKey: "test-only",
        collectionSlugs: ["artfi-test"],
        spoolParentDirectory,
        fetchImpl: async (input) => {
          const cursor = new URL(String(input)).searchParams.get("next");
          requestedCursors.push(cursor);
          const event = {
            ...listed,
            version: cursor === null ? 9 : 8,
            payload: {
              ...listed.payload,
              event_timestamp:
                cursor === null
                  ? "2026-08-19T04:00:02Z"
                  : "2026-08-19T04:00:01Z",
            },
          };
          return new Response(
            JSON.stringify({
              asset_events: cursor === null ? [event, listed] : [event],
              next: cursor === null ? "overlap-unused" : null,
            }),
            { status: 200 },
          );
        },
      });
      await resumedAdapter.backfill(async (event) => {
        published.push(event);
      });

      expect(requestedCursors).toEqual([null, "cursor-page-2"]);
      expect(published.map((event) => event.version)).toEqual([7, 9, 8]);
      await expectStableSnapshotDirectoryClean(spoolParentDirectory);
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
      await expectStableSnapshotDirectoryClean(spoolParentDirectory);
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
      await expectStableSnapshotDirectoryClean(spoolParentDirectory);
    } finally {
      await rm(spoolParentDirectory, { force: true, recursive: true });
    }
  });

  it("recovers an abandoned stale-lock reclamation marker", async () => {
    const spoolParentDirectory = await mkdtemp(
      join(tmpdir(), "artfi-opensea-stale-reclaim-test-"),
    );
    try {
      const collectionsHash = createHash("sha256")
        .update(JSON.stringify(["artfi-test"]))
        .digest("hex");
      const spoolDirectory = join(
        spoolParentDirectory,
        `snapshot-${collectionsHash.slice(0, 24)}`,
      );
      const lockPath = join(spoolDirectory, "active.lock");
      await mkdir(spoolDirectory, { recursive: true });
      await writeFile(lockPath, "2147483647\n", { mode: 0o600 });
      await link(lockPath, `${lockPath}.reclaim`);

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
      await expectStableSnapshotDirectoryClean(spoolParentDirectory);
    } finally {
      await rm(spoolParentDirectory, { force: true, recursive: true });
    }
  });

  it("does not steal a stale lock while another live reclaimer owns the marker", async () => {
    const spoolParentDirectory = await mkdtemp(
      join(tmpdir(), "artfi-opensea-live-reclaim-test-"),
    );
    try {
      const collectionsHash = createHash("sha256")
        .update(JSON.stringify(["artfi-test"]))
        .digest("hex");
      const spoolDirectory = join(
        spoolParentDirectory,
        `snapshot-${collectionsHash.slice(0, 24)}`,
      );
      const lockPath = join(spoolDirectory, "active.lock");
      await mkdir(spoolDirectory, { recursive: true });
      await writeFile(lockPath, "2147483647\n", { mode: 0o600 });
      await writeFile(`${lockPath}.reclaim`, `${process.pid}\n`, {
        mode: 0o600,
      });

      const adapter = new OpenSeaAdapter({
        apiKey: "test-only",
        collectionSlugs: ["artfi-test"],
        spoolParentDirectory,
        fetchImpl: async () => {
          throw new Error("live reclaimer must retain exclusion");
        },
      });
      await expect(
        adapter.backfill(async () => undefined),
      ).rejects.toMatchObject({ code: "EEXIST" });
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
      await expectStableSnapshotDirectoryClean(spoolParentDirectory);
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
      await expectStableSnapshotDirectoryClean(spoolParentDirectory);
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

  it("buffers realtime delivery until the REST snapshot commits", async () => {
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
    const publish: MarketEventSink = async (event) => {
      published.push(event);
    };
    const stop = await startOpenSeaMirror(
      adapter,
      publish,
      atomicSnapshotSink(publish),
    );
    expect(observed).toEqual(["subscribe", "snapshot"]);
    expect(published).toEqual([historic, live]);
    stop();
    expect(observed).toEqual(["subscribe", "snapshot", "stop"]);
  });

  it("fails closed when the pre-snapshot realtime queue reaches capacity", async () => {
    const historic = normalizeOpenSeaEvent(listed);
    const queued: Promise<void>[] = [];
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
        for (let version = 1; version <= 257; version += 1) {
          queued.push(sink({ ...historic, version }).catch(() => undefined));
        }
        return () => undefined;
      },
      async backfill() {},
    };

    await expect(
      startOpenSeaMirror(
        adapter,
        async () => undefined,
        atomicSnapshotSink(async () => undefined),
      ),
    ).rejects.toThrow("realtime queue capacity exceeded");
    await Promise.all(queued);
  });

  it("fails closed before the retained realtime spool exceeds capacity", async () => {
    let liveSink: MarketEventSink | undefined;
    let releaseSnapshot!: () => void;
    let snapshotStarted!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const snapshotObserved = new Promise<void>((resolve) => {
      snapshotStarted = resolve;
    });
    const historic = normalizeOpenSeaEvent(listed);
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
        liveSink = sink;
        return () => undefined;
      },
      async backfill() {
        snapshotStarted();
        await snapshotGate;
      },
    };
    const starting = startOpenSeaMirror(
      adapter,
      async () => undefined,
      atomicSnapshotSink(async () => undefined),
    );
    await snapshotObserved;

    let overflow: unknown;
    for (let version = 1; version <= 10; version += 1) {
      try {
        await liveSink!({
          ...historic,
          version,
          payload: {
            ...historic.payload,
            padding: "x".repeat(600_000),
          },
        });
      } catch (error) {
        overflow = error;
        break;
      }
    }
    expect(overflow).toBeInstanceOf(Error);
    expect((overflow as Error).message).toContain(
      "realtime queue capacity exceeded",
    );
    releaseSnapshot();

    await expect(starting).rejects.toThrow("realtime queue capacity exceeded");
  });

  it("withholds the REST snapshot after realtime buffering fails", async () => {
    let liveSink: MarketEventSink | undefined;
    let releaseSnapshot!: () => void;
    let snapshotStarted!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const snapshotObserved = new Promise<void>((resolve) => {
      snapshotStarted = resolve;
    });
    const historic = normalizeOpenSeaEvent(listed);
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
        liveSink = sink;
        return () => undefined;
      },
      async backfill(sink) {
        snapshotStarted();
        await snapshotGate;
        await sink(historic);
      },
    };
    const published: NormalizedMarketEvent[] = [];
    const publish: MarketEventSink = async (event) => {
      published.push(event);
    };
    const starting = startOpenSeaMirror(
      adapter,
      publish,
      atomicSnapshotSink(publish),
    );
    await snapshotObserved;

    let overflow: unknown;
    for (let version = 1; version <= 10; version += 1) {
      try {
        await liveSink!({
          ...historic,
          version,
          payload: {
            ...historic.payload,
            padding: "x".repeat(600_000),
          },
        });
      } catch (error) {
        overflow = error;
        break;
      }
    }
    expect(overflow).toBeInstanceOf(Error);
    releaseSnapshot();

    await expect(starting).rejects.toThrow("realtime queue capacity exceeded");
    expect(published).toEqual([]);
  });

  it("keeps the atomic cutover committed when post-cutover buffering fails", async () => {
    let liveSink: MarketEventSink | undefined;
    const historic = normalizeOpenSeaEvent(listed);
    const secondHistoric = {
      ...historic,
      entityKey: `${historic.entityKey}:second`,
      version: historic.version + 1,
    };
    const queued: Promise<void>[] = [];
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
        liveSink = sink;
        return () => undefined;
      },
      async backfill(sink) {
        await sink(historic);
        await sink(secondHistoric);
      },
    };
    const published: NormalizedMarketEvent[] = [];
    const atomicSnapshot: MarketSnapshotSink = async (events, signal) => {
      const staged: NormalizedMarketEvent[] = [];
      for await (const event of events) {
        staged.push(event);
        if (staged.length === 1) {
          for (let version = 1; version <= 257; version += 1) {
            queued.push(
              liveSink!({ ...historic, version }).catch(() => undefined),
            );
          }
          await Promise.all(queued);
        }
      }
      if (signal.aborted) throw signal.reason;
      published.push(...staged);
    };

    await expect(
      startOpenSeaMirror(
        adapter,
        async (event) => {
          published.push(event);
        },
        atomicSnapshot,
      ),
    ).rejects.toThrow("realtime queue capacity exceeded");
    expect(published).toEqual([historic, secondHistoric]);
  });

  it("fails closed when the realtime queue overflows during snapshot commit", async () => {
    let liveSink: MarketEventSink | undefined;
    let releaseReplay!: () => void;
    let replayStarted!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const replayObserved = new Promise<void>((resolve) => {
      replayStarted = resolve;
    });
    const historic = normalizeOpenSeaEvent(listed);
    const queued: Promise<void>[] = [];
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
        liveSink = sink;
        await sink(historic);
        return () => undefined;
      },
      async backfill() {},
    };
    const publish: MarketEventSink = async () => {
      replayStarted();
      await replayGate;
    };
    const starting = startOpenSeaMirror(
      adapter,
      publish,
      atomicSnapshotSink(publish),
    );
    await replayObserved;
    for (let version = 1; version <= 257; version += 1) {
      queued.push(liveSink!({ ...historic, version }).catch(() => undefined));
    }
    releaseReplay();

    await expect(starting).rejects.toThrow("realtime queue capacity exceeded");
    await Promise.all(queued);
  });

  it("continues realtime delivery after an individual sink failure", async () => {
    let liveSink: MarketEventSink | undefined;
    const historic = normalizeOpenSeaEvent(listed);
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
        liveSink = sink;
        return () => undefined;
      },
      async backfill() {},
    };
    let attempts = 0;
    const published: NormalizedMarketEvent[] = [];
    const publish: MarketEventSink = async (event) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient sink failure");
      published.push(event);
    };
    const stop = await startOpenSeaMirror(
      adapter,
      publish,
      atomicSnapshotSink(publish),
    );

    await expect(liveSink?.(historic)).rejects.toThrow(
      "transient sink failure",
    );
    await liveSink?.({ ...historic, version: historic.version + 1 });
    expect(published.map((event) => event.version)).toEqual([
      historic.version + 1,
    ]);
    stop();
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

  it("runs recovery only after every collection rejoins a later connection", async () => {
    let reconnects = 0;
    let reconnectObserved!: () => void;
    const reconnected = new Promise<void>((resolve) => {
      reconnectObserved = resolve;
    });
    const readiness = new OpenSeaJoinReadiness(
      ["artfi-test", "artfi-second"],
      1_000,
      async () => {
        reconnects += 1;
        reconnectObserved();
      },
    );
    const acknowledge = (topic: string, generation: number) =>
      readiness.observe(
        Buffer.from(
          JSON.stringify([
            String(generation),
            String(generation),
            topic,
            "phx_reply",
            { status: "ok" },
          ]),
        ),
        generation,
      );

    const initialGeneration = readiness.beginConnection();
    acknowledge("collection:artfi-test", initialGeneration);
    acknowledge("collection:artfi-second", initialGeneration);
    await readiness.wait();
    expect(reconnects).toBe(0);

    const reconnectGeneration = readiness.beginConnection();
    acknowledge("collection:artfi-test", reconnectGeneration);
    await Promise.resolve();
    expect(reconnects).toBe(0);
    acknowledge("collection:artfi-second", reconnectGeneration);
    await reconnected;
    expect(reconnects).toBe(1);

    acknowledge("collection:artfi-second", initialGeneration);
    await Promise.resolve();
    expect(reconnects).toBe(1);
  });

  it("fails closed when reconnect recovery rejects", async () => {
    let fatalError: unknown;
    let fatalObserved!: () => void;
    const failed = new Promise<void>((resolve) => {
      fatalObserved = resolve;
    });
    const readiness = new OpenSeaJoinReadiness(
      ["artfi-test"],
      1_000,
      async () => {
        throw new Error("reconnect gap-fill failed");
      },
      (error) => {
        fatalError = error;
        fatalObserved();
      },
    );
    const acknowledge = (generation: number) =>
      readiness.observe(
        Buffer.from(
          JSON.stringify([
            String(generation),
            String(generation),
            "collection:artfi-test",
            "phx_reply",
            { status: "ok" },
          ]),
        ),
        generation,
      );

    const initialGeneration = readiness.beginConnection();
    acknowledge(initialGeneration);
    await readiness.wait();
    const reconnectGeneration = readiness.beginConnection();
    acknowledge(reconnectGeneration);
    await failed;
    expect(fatalError).toEqual(new Error("reconnect gap-fill failed"));
  });

  it("serializes a reconnect gap-fill through the mirror coordinator", async () => {
    let lifecycle: MarketplaceStreamLifecycle | undefined;
    let backfills = 0;
    let activeBackfills = 0;
    let maximumActiveBackfills = 0;
    let releaseFirstRecovery!: () => void;
    let releaseSecondRecovery!: () => void;
    let firstRecoveryStarted!: () => void;
    let secondRecoveryStarted!: () => void;
    const firstRecoveryGate = new Promise<void>((resolve) => {
      releaseFirstRecovery = resolve;
    });
    const secondRecoveryGate = new Promise<void>((resolve) => {
      releaseSecondRecovery = resolve;
    });
    const firstRecoveryObserved = new Promise<void>((resolve) => {
      firstRecoveryStarted = resolve;
    });
    const secondRecoveryObserved = new Promise<void>((resolve) => {
      secondRecoveryStarted = resolve;
    });
    const adapter: MarketplaceAdapter = {
      source: "opensea",
      capabilities: {
        realtime: true,
        restBackfill: true,
        createsOrders: false,
        fulfillsOrders: false,
        custody: false,
      },
      async start(_sink, streamLifecycle) {
        lifecycle = streamLifecycle;
        return () => undefined;
      },
      async backfill() {
        backfills += 1;
        activeBackfills += 1;
        maximumActiveBackfills = Math.max(
          maximumActiveBackfills,
          activeBackfills,
        );
        try {
          if (backfills === 2) {
            firstRecoveryStarted();
            await firstRecoveryGate;
          } else if (backfills === 3) {
            secondRecoveryStarted();
            await secondRecoveryGate;
          }
        } finally {
          activeBackfills -= 1;
        }
      },
    };

    const stop = await startOpenSeaMirror(
      adapter,
      async () => undefined,
      atomicSnapshotSink(async () => undefined),
    );
    expect(backfills).toBe(1);
    const firstRecovery = lifecycle!.onReconnectReady();
    const secondRecovery = lifecycle!.onReconnectReady();
    await firstRecoveryObserved;
    expect(backfills).toBe(2);
    expect(maximumActiveBackfills).toBe(1);
    releaseFirstRecovery();
    await secondRecoveryObserved;
    expect(backfills).toBe(3);
    expect(maximumActiveBackfills).toBe(1);
    releaseSecondRecovery();
    await Promise.all([firstRecovery, secondRecovery]);
    stop();
  });

  it("holds reconnect gap-fill until the initial atomic commit completes", async () => {
    let lifecycle: MarketplaceStreamLifecycle | undefined;
    let backfills = 0;
    let releaseCommit!: () => void;
    let commitStarted!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commitObserved = new Promise<void>((resolve) => {
      commitStarted = resolve;
    });
    const historic = normalizeOpenSeaEvent(listed);
    const adapter: MarketplaceAdapter = {
      source: "opensea",
      capabilities: {
        realtime: true,
        restBackfill: true,
        createsOrders: false,
        fulfillsOrders: false,
        custody: false,
      },
      async start(_sink, streamLifecycle) {
        lifecycle = streamLifecycle;
        return () => undefined;
      },
      async backfill(sink) {
        backfills += 1;
        await sink(historic);
      },
    };
    const published: NormalizedMarketEvent[] = [];
    const starting = startOpenSeaMirror(
      adapter,
      async (event) => {
        published.push(event);
      },
      async (events) => {
        const staged: NormalizedMarketEvent[] = [];
        for await (const event of events) staged.push(event);
        commitStarted();
        await commitGate;
        published.push(...staged);
      },
    );

    await commitObserved;
    const reconnect = lifecycle!.onReconnectReady();
    await Promise.resolve();
    expect(backfills).toBe(1);
    releaseCommit();
    const stop = await starting;
    await reconnect;
    expect(backfills).toBe(2);
    expect(published).toEqual([historic, historic]);
    stop();
  });

  it("streams the durable snapshot with a one-event backpressured handoff and no second snapshot file", async () => {
    const historic = normalizeOpenSeaEvent(listed);
    let releaseFirst!: () => void;
    let observeFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstObserved = new Promise<void>((resolve) => {
      observeFirst = resolve;
    });
    let produced = 0;
    let consumed = 0;
    let commits = 0;
    let aborts = 0;
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
        return () => undefined;
      },
      async backfill(sink, _signal, options) {
        expect(options?.deferFinalize).toBe(true);
        await options?.onSourceSealed?.();
        for (let version = 1; version <= 3; version += 1) {
          produced += 1;
          await sink({
            ...historic,
            entityKey: `${historic.entityKey}:${version}`,
            version,
          });
        }
        return {
          async commit() {
            commits += 1;
          },
          async abort() {
            aborts += 1;
          },
        };
      },
    };
    const starting = startOpenSeaMirror(
      adapter,
      async () => undefined,
      async (events) => {
        for await (const event of events) {
          consumed += 1;
          if (consumed === 1) {
            observeFirst();
            await firstGate;
          }
          expect(event.entityKey).toContain(historic.entityKey);
        }
      },
    );

    await firstObserved;
    expect(produced).toBe(1);
    const realtimeDirectories = (
      await readdir(tmpdir(), { withFileTypes: true })
    ).filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith("artfi-opensea-realtime-"),
    );
    expect(realtimeDirectories.length).toBeGreaterThan(0);
    for (const directory of realtimeDirectories) {
      expect(await readdir(join(tmpdir(), directory.name))).not.toContain(
        "snapshot.ndjson",
      );
    }
    releaseFirst();
    const stop = await starting;
    expect({ produced, consumed, commits, aborts }).toEqual({
      produced: 3,
      consumed: 3,
      commits: 1,
      aborts: 0,
    });
    stop();
  });

  it("preserves a durable source snapshot and releases its lock when snapshot commit fails", async () => {
    const spoolParentDirectory = await mkdtemp(
      join(tmpdir(), "artfi-opensea-lease-test-"),
    );
    let leaseAborts = 0;
    const createDurableAdapter = (): MarketplaceAdapter => {
      const durable = new OpenSeaAdapter({
        apiKey: "test-only",
        collectionSlugs: ["artfi-test"],
        spoolParentDirectory,
        fetchImpl: async () =>
          new Response(JSON.stringify({ asset_events: [listed] }), {
            status: 200,
          }),
      });
      return {
        source: durable.source,
        capabilities: durable.capabilities,
        backfill: (sink, signal, options) =>
          durable.backfill(
            sink,
            signal,
            options
              ? {
                  ...options,
                  onLeaseReady: (lease) => {
                    options.onLeaseReady?.({
                      ...lease,
                      async abort() {
                        leaseAborts += 1;
                        await lease.abort();
                      },
                    });
                  },
                }
              : undefined,
          ),
        async start() {
          return () => undefined;
        },
      };
    };
    try {
      await expect(
        startOpenSeaMirror(
          createDurableAdapter(),
          async () => undefined,
          async (events) => {
            for await (const _event of events) {
              // Consume the complete source stream, then fail the atomic upload.
            }
            throw new Error("snapshot upload failed");
          },
        ),
      ).rejects.toThrow("snapshot upload failed");
      expect(leaseAborts).toBe(1);

      const [snapshotDirectory] = await readdir(spoolParentDirectory);
      const retained = await readdir(
        join(spoolParentDirectory, snapshotDirectory!),
      );
      expect(retained).toEqual(
        expect.arrayContaining(["events.ndjson", "checkpoints.ndjson"]),
      );
      expect(retained).not.toContain("active.lock");

      const recovered: NormalizedMarketEvent[] = [];
      const stop = await startOpenSeaMirror(
        createDurableAdapter(),
        async () => undefined,
        async (events) => {
          for await (const event of events) recovered.push(event);
        },
      );
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.entityKey).toBe(
        normalizeOpenSeaEvent(listed).entityKey,
      );
      await expectStableSnapshotDirectoryClean(spoolParentDirectory);
      stop();
    } finally {
      await rm(spoolParentDirectory, { force: true, recursive: true });
    }
  });

  it("starts the snapshot sink for a precommit-only tail and an all-zero cutover", async () => {
    const live = normalizeOpenSeaEvent(listed);
    const observed: NormalizedMarketEvent[][] = [];
    let commits = 0;
    const precommitOnly: MarketplaceAdapter = {
      source: "opensea",
      capabilities: {
        realtime: true,
        restBackfill: true,
        createsOrders: false,
        fulfillsOrders: false,
        custody: false,
      },
      async start(sink) {
        await sink(live);
        return () => undefined;
      },
      async backfill(_sink, _signal, options) {
        await options?.onSourceSealed?.();
        return {
          async commit() {
            commits += 1;
          },
          async abort() {
            throw new Error("unexpected abort");
          },
        };
      },
    };
    const precommitStop = await startOpenSeaMirror(
      precommitOnly,
      async () => undefined,
      async (events) => {
        const snapshot: NormalizedMarketEvent[] = [];
        for await (const event of events) snapshot.push(event);
        observed.push(snapshot);
      },
    );
    precommitStop();

    const allZero: MarketplaceAdapter = {
      ...precommitOnly,
      async start() {
        return () => undefined;
      },
    };
    const zeroStop = await startOpenSeaMirror(
      allZero,
      async () => undefined,
      async (events) => {
        const snapshot: NormalizedMarketEvent[] = [];
        for await (const event of events) snapshot.push(event);
        observed.push(snapshot);
      },
    );
    zeroStop();

    expect(observed).toEqual([[live], []]);
    expect(commits).toBe(2);
  });

  it("stops the realtime subscription when the REST snapshot fails", async () => {
    let stopped = false;
    const live = normalizeOpenSeaEvent(listed);
    const published: NormalizedMarketEvent[] = [];
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
        await sink(live);
        return () => {
          stopped = true;
        };
      },
      async backfill() {
        throw new Error("snapshot failed");
      },
    };
    await expect(
      startOpenSeaMirror(
        adapter,
        async (event) => {
          published.push(event);
        },
        atomicSnapshotSink(async (event) => {
          published.push(event);
        }),
      ),
    ).rejects.toThrow("snapshot failed");
    expect(stopped).toBe(true);
    expect(published).toEqual([]);
  });
});
