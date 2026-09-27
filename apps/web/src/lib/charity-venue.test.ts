import { describe, expect, it } from "vitest";

import {
  charityVenueState,
  selectCharityVenueRecord,
  type CharityVenueRecord,
} from "./charity-venue";

const charityContract = "0x00000000000000000000000000000000000000c1";
const otherContract = "0x00000000000000000000000000000000000000c2";

function record(
  overrides: Partial<CharityVenueRecord> = {},
): CharityVenueRecord {
  return {
    source: "opensea",
    chain: "ethereum",
    contractAddress: charityContract,
    tokenId: "1",
    latestEventType: "item_listed",
    latestEventTimestamp: "2026-09-27T10:00:00Z",
    marketplaceUrl: `https://opensea.io/assets/ethereum/${charityContract}/1`,
    ...overrides,
  };
}

describe("selectCharityVenueRecord", () => {
  it("matches on contract and token id together", () => {
    const records = [
      record({ contractAddress: otherContract, tokenId: "1" }),
      record({ tokenId: "2" }),
      record({ tokenId: "1" }),
    ];
    expect(
      selectCharityVenueRecord(records, charityContract, "1"),
    ).toMatchObject({ contractAddress: charityContract, tokenId: "1" });
  });

  // A token id alone is not an identity: every collection numbers from one, so a record from another
  // contract with the same id describes a different asset.
  it("never accepts another collection's record with the same id", () => {
    const records = [record({ contractAddress: otherContract, tokenId: "1" })];
    expect(
      selectCharityVenueRecord(records, charityContract, "1"),
    ).toBeUndefined();
  });

  it("compares the contract without regard to case", () => {
    const records = [
      record({ contractAddress: charityContract.toUpperCase() }),
    ];
    expect(
      selectCharityVenueRecord(records, charityContract, "1"),
    ).toBeDefined();
  });

  it("prefers the most recent observation", () => {
    const records = [
      record({ latestEventTimestamp: "2026-09-27T10:00:00Z" }),
      record({
        latestEventTimestamp: "2026-09-27T12:00:00Z",
        latestEventType: "item_sold",
      }),
    ];
    expect(
      selectCharityVenueRecord(records, charityContract, "1")?.latestEventType,
    ).toBe("item_sold");
  });

  it("reports nothing when the collection has no records", () => {
    expect(selectCharityVenueRecord([], charityContract, "1")).toBeUndefined();
  });
});

describe("charityVenueState", () => {
  it("shows the venue's own reported link", () => {
    expect(charityVenueState(record({ orderStatus: "active" }))).toEqual({
      kind: "attributed",
      url: `https://opensea.io/assets/ethereum/${charityContract}/1`,
      venue: "OpenSea",
      eventType: "item_listed",
      orderStatus: "active",
      observedAt: "2026-09-27T10:00:00Z",
    });
  });

  it("omits an order status the record does not carry", () => {
    const state = charityVenueState(record());
    expect(state.kind).toBe("attributed");
    expect(state).not.toHaveProperty("orderStatus");
  });

  /**
   * The refusals that matter. Each of these would be a link the page hopes is safe, and the mirror's
   * own ingest rule already rejects them — a page is the last place a bad `href` becomes clickable.
   */
  it("refuses a URL that is not an HTTPS opensea.io address", () => {
    const refused = [
      "http://opensea.io/assets/ethereum/1/1",
      "https://user:password@opensea.io/assets/ethereum/1/1",
      "https://opensea.io.example.com/assets/ethereum/1/1",
      "https://notopensea.io/assets/ethereum/1/1",
      "javascript:alert(1)",
      "not a url",
    ];
    for (const marketplaceUrl of refused) {
      expect(charityVenueState(record({ marketplaceUrl })).kind).toBe(
        "unattributed",
      );
    }
  });

  // Observed, but with nothing to link to. That is a different statement from "nothing observed" and
  // the page says so, rather than collapsing the two.
  it("separates an observed record with no link from no record at all", () => {
    expect(charityVenueState(record({ marketplaceUrl: undefined }))).toEqual({
      kind: "unattributed",
      venue: "OpenSea",
      eventType: "item_listed",
      observedAt: "2026-09-27T10:00:00Z",
    });
    expect(charityVenueState(undefined)).toEqual({ kind: "unobserved" });
  });
});
