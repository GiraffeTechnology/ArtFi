import { afterEach, describe, expect, it, vi } from "vitest";
import { eventFingerprint, normalizeOpenSeaEvent } from "./opensea.js";

const sourceTime = "2026-10-20T03:04:05.006Z";
const event = () => ({
  event_type: "item_listed",
  payload: {
    chain: "ethereum",
    order_hash: `0x${"1".repeat(64)}`,
    event_timestamp: sourceTime,
  },
});

afterEach(() => vi.restoreAllMocks());

describe("source event-time admission", () => {
  it.each([undefined, null, false, true, {}, [], "", " "])(
    "rejects absent or non-source timestamp %o",
    (value) => {
      const input = event();
      Object.assign(input.payload, { event_timestamp: value });
      expect(() => normalizeOpenSeaEvent(input)).toThrow(/timestamp/);
    },
  );

  it("does not replace missing source time with wall-clock freshness", () => {
    const input = event();
    Object.assign(input.payload, { event_timestamp: undefined });
    for (const now of [
      Date.parse(sourceTime),
      Date.parse(sourceTime) + 86400000,
    ]) {
      vi.spyOn(Date, "now").mockReturnValue(now);
      expect(() => normalizeOpenSeaEvent(input)).toThrow(/timestamp/);
      vi.restoreAllMocks();
    }
  });

  it.each([NaN, Infinity, -Infinity, "not-a-source-time"])(
    "rejects invalid source time %o",
    (value) => {
      const input = event();
      Object.assign(input.payload, { event_timestamp: value });
      expect(() => normalizeOpenSeaEvent(input)).toThrow(/timestamp/);
    },
  );

  it("uses the existing sent-at source fallback without inventing a clock", () => {
    const input = { ...event(), sent_at: sourceTime };
    Object.assign(input.payload, { event_timestamp: undefined });
    expect(normalizeOpenSeaEvent(input).eventTimestamp).toBe(sourceTime);
  });

  it("uses existing REST created-date source fallback", () => {
    const input = event();
    Object.assign(input.payload, {
      event_timestamp: undefined,
      created_date: sourceTime,
    });
    expect(normalizeOpenSeaEvent(input).eventTimestamp).toBe(sourceTime);
  });

  it("keeps source-time versions and fingerprints stable across wall clocks", () => {
    const first = normalizeOpenSeaEvent(event());
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(sourceTime) + 86400000);
    const second = normalizeOpenSeaEvent(event());
    expect(first.version).toBe(Date.parse(sourceTime));
    expect(second.eventTimestamp).toBe(sourceTime);
    expect(eventFingerprint(second)).toBe(eventFingerprint(first));
    expect(second.chain).toBe("ethereum");
  });

  it.each([
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    "7",
    false,
    {},
  ])("rejects supplied ambiguous version %o", (version) =>
    expect(() => normalizeOpenSeaEvent({ ...event(), version })).toThrow(
      /version/,
    ),
  );

  it.each([0, 7, Number.MAX_SAFE_INTEGER])(
    "retains explicit safe version %o",
    (version) => {
      expect(normalizeOpenSeaEvent({ ...event(), version }).version).toBe(
        version,
      );
    },
  );

  it("retains an explicit payload source version", () => {
    const input = event();
    Object.assign(input.payload, { version: 19 });
    expect(normalizeOpenSeaEvent(input).version).toBe(19);
  });
});
