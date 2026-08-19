import { describe, expect, it } from "vitest";

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
});
