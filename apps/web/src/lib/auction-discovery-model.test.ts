import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import {
  planDiscoveryPage,
  snapshotDiscoveryCursor,
  type AuctionCreation,
  type DiscoveryWindow,
} from "./auction-discovery-model";

// Synthetic event identities only; these arithmetic cases create no authority.
const market = ("0x" + "1".repeat(40)) as Address,
  seller = ("0x" + "2".repeat(40)) as Address;
const hash = (n: number) =>
  ("0x" + (n + 1).toString(16).padStart(64, "0")) as Hex;
const window: DiscoveryWindow = {
  market,
  seller: null,
  anchorBlock: 25005n,
  anchorHash: hash(25005),
  windowTo: 25005n,
  blockSpan: 10000,
  pageSize: 10,
};
const creations = (count = 27): AuctionCreation[] =>
  Array.from({ length: count }, (_, i) => ({
    listingId: String(i + 1),
    seller,
    requestId: hash(i + 200),
    blockNumber: 25000n - BigInt(i),
    blockHash: hash(25000 - i),
    transactionHash: hash(i + 1000),
    logIndex: i,
  }));
describe("discovery cursor and candidate pagination", () => {
  it("walks within one block window without skipping IDs and reverses to the same earlier slice", () => {
    const events = creations(),
      a = planDiscoveryPage(events, null, window);
    const b = planDiscoveryPage(
      events,
      snapshotDiscoveryCursor(a.older),
      window,
    );
    const c = planDiscoveryPage(
      events,
      snapshotDiscoveryCursor(b.older),
      window,
    );
    expect([
      a.candidates.length,
      b.candidates.length,
      c.candidates.length,
    ]).toEqual([10, 10, 7]);
    expect(
      new Set(
        [...a.candidates, ...b.candidates, ...c.candidates].map(
          (x) => x.listingId,
        ),
      ).size,
    ).toBe(27);
    const back = planDiscoveryPage(
      events,
      snapshotDiscoveryCursor(c.newer),
      window,
    );
    expect(back.candidates).toEqual(b.candidates);
    expect(c.older?.windowTo).toBe("15005");
    expect(c.older?.boundary).toBeNull();
    expect(Object.isFrozen(a.candidates[0])).toBe(true);
    expect(Object.isFrozen(a.older?.boundary)).toBe(true);
  });
  it("crosses older empty windows to genesis and navigates newer windows from their oldest slice", () => {
    const a = planDiscoveryPage([], null, window);
    const bWindow = { ...window, windowTo: 15005n };
    const b = planDiscoveryPage([], snapshotDiscoveryCursor(a.older), bWindow);
    const cWindow = { ...window, windowTo: 5005n };
    const c = planDiscoveryPage([], snapshotDiscoveryCursor(b.older), cWindow);
    expect(c.fromBlock).toBe(0n);
    expect(c.older).toBeNull();
    expect(c.newer?.windowTo).toBe("15005");
    expect(c.newer?.direction).toBe("newer");
    const data = creations().map((x) => ({
      ...x,
      blockNumber: x.blockNumber - 10000n,
      blockHash: hash(Number(x.blockNumber - 10000n)),
    }));
    const back = planDiscoveryPage(
      data,
      snapshotDiscoveryCursor(c.newer),
      bWindow,
    );
    expect(back.candidates.map((x) => x.listingId)).toEqual(
      data.slice(-10).map((x) => x.listingId),
    );
  });
  it("rejects foreign filters, cursor aliases, nested getters, overflows and source-window drift", () => {
    const good = planDiscoveryPage(creations(), null, window).older!;
    const getter = vi.fn(() => good.boundary!.requestId);
    const nested = { ...good.boundary! };
    Object.defineProperty(nested, "requestId", {
      enumerable: true,
      get: getter,
    });
    for (const cursor of [
      { ...good, version: "future" },
      { ...good, extra: true },
      { ...good, chainId: 1 },
      { ...good, pageSize: 51 },
      { ...good, pageSize: "10" },
      { ...good, windowTo: "01" },
      { ...good, windowTo: "1" },
      { ...good, anchorBlock: "9".repeat(78) },
      { ...good, boundary: nested },
      { ...good, boundary: { ...good.boundary!, logIndex: 2 ** 32 } },
      { ...good, boundary: { ...good.boundary!, blockNumber: "0" } },
    ])
      expect(() => snapshotDiscoveryCursor(cursor)).toThrow("INVALID_CURSOR");
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      planDiscoveryPage(creations(), good, { ...window, seller }),
    ).toThrow("INVALID_CURSOR");
    expect(() =>
      planDiscoveryPage(creations(), good, { ...window, anchorHash: hash(9) }),
    ).toThrow("INVALID_CURSOR");
  });
  it("copies cursor fields and refuses missing or altered continuation identities", () => {
    const events = creations(),
      good = planDiscoveryPage(events, null, window).older!;
    const mutable = { ...good, boundary: { ...good.boundary! } };
    const copied = snapshotDiscoveryCursor(mutable);
    mutable.boundary.listingId = "99";
    expect(copied.boundary?.listingId).toBe(good.boundary?.listingId);
    expect(() =>
      planDiscoveryPage(
        events.filter((x) => x.listingId !== good.boundary!.listingId),
        copied,
        window,
      ),
    ).toThrow("SOURCE_CHANGED");
    expect(() =>
      planDiscoveryPage(
        events.map((x) =>
          x.listingId === good.boundary!.listingId
            ? { ...x, requestId: hash(999) }
            : x,
        ),
        copied,
        window,
      ),
    ).toThrow("SOURCE_CHANGED");
  });
  it("deduplicates only identical source events and rejects reused IDs or block positions", () => {
    const e = creations(1)[0];
    expect(planDiscoveryPage([e, e], null, window).duplicateCount).toBe(1);
    for (const bad of [
      { ...e, seller: market },
      { ...e, listingId: "99", transactionHash: hash(999) },
      { ...e, logIndex: e.logIndex + 1, transactionHash: hash(999) },
    ])
      expect(() => planDiscoveryPage([e, bad], null, window)).toThrow(
        "MALFORMED",
      );
    expect(() => planDiscoveryPage(Array(1000).fill(e), null, window)).toThrow(
      "DENSE_RANGE",
    );
  });
  it("keeps a seller-filtered window bound and rejects forged seller results", () => {
    const w = { ...window, seller };
    const a = planDiscoveryPage(creations(), null, w);
    expect(a.older?.seller).toBe(seller);
    expect(() =>
      planDiscoveryPage([{ ...creations(1)[0], seller: market }], null, w),
    ).toThrow("MALFORMED");
  });
});
