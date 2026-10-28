import { afterEach, describe, expect, it, vi } from "vitest";
import { administrationRequestTimeoutMs } from "./administration-transport";
import {
  createIndexedHistoryController,
  indexedHistoryByteLimit,
  initialIndexedHistoryFilter as initial,
  readIndexedHistoryFilter,
  readIndexedHistoryPage,
  requestIndexedHistory,
  type IndexedHistoryPage,
} from "./portfolio-indexed-history";

const owner = "0x1000000000000000000000000000000000000001";
const contract = "0x1000000000000000000000000000000000000002";
const hash = (index: number) => `0x${index.toString(16).padStart(64, "0")}`;
function entry(index: number) {
  return {
    id: `560048:${hash(index)}:0`,
    transactionHash: hash(index),
    logIndex: 0,
    blockNumber: index,
    contractAddress: contract,
    eventName: "TEST_ONLY_Event",
    status: "confirmed",
    observedAt: "2026-10-28T00:00:00Z",
  };
}
function page() {
  return {
    address: owner,
    chainId: 560048,
    scope: "indexed_chain_events",
    filters: { ...initial },
    pageSize: 10,
    total: 1,
    data: [entry(1)],
  };
}
const admit = () => readIndexedHistoryPage(page(), owner, initial);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("server-paged indexed history contract", () => {
  it("admits events beyond the old one-hundred-record response without changing identities", () => {
    const filter = { ...initial, order: "oldest" as const, page: 11 };
    const input = {
      ...page(),
      filters: filter,
      total: 115,
      data: Array.from({ length: 10 }, (_, i) => entry(i + 101)),
    };
    const result = readIndexedHistoryPage(input, owner, filter);
    expect(result.data[0].id).toBe(entry(101).id);
    expect(result.total).toBe(115);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.data[0])).toBe(true);
  });
  it.each([
    "chainId=1",
    "address=other",
    "pageSize=100",
    "provider=foreign",
    "page=0",
    "page=01",
    "page=1000001",
    "page=",
    "status=live",
    "status=all&status=removed",
    "eventName=x",
    "eventName=Transfer%27",
    "contractAddress=bad",
    "order=random",
  ])("rejects unsupported or ambiguous filters: %s", (query) => {
    expect(() =>
      readIndexedHistoryFilter(new URLSearchParams(query)),
    ).toThrow();
  });
  it.each([
    { ...page(), address: contract },
    { ...page(), chainId: 1 },
    { ...page(), scope: "live_chain" },
    { ...page(), filters: { ...initial, page: 2 } },
    { ...page(), total: 2 },
    { ...page(), total: Number.MAX_SAFE_INTEGER + 1 },
    { ...page(), data: [{ ...entry(1), id: "foreign" }] },
    { ...page(), data: [{ ...entry(1), observedAt: "2026-02-30T00:00:00Z" }] },
    {
      ...page(),
      data: [{ ...entry(1), blockNumber: Number.MAX_SAFE_INTEGER + 1 }],
    },
    { ...page(), privatePayload: "TEST_ONLY_PRIVATE" },
  ])("refuses a foreign, incomplete or malformed snapshot", (value) => {
    expect(() => readIndexedHistoryPage(value, owner, initial)).toThrow();
  });
  it("refuses unsorted, duplicate and out-of-filter events rather than dropping them", () => {
    for (const data of [
      [entry(1), entry(2)],
      [entry(1), entry(1)],
    ])
      expect(() =>
        readIndexedHistoryPage({ ...page(), total: 2, data }, owner, initial),
      ).toThrow();
    const filter = { ...initial, status: "removed" as const };
    expect(() =>
      readIndexedHistoryPage({ ...page(), filters: filter }, owner, filter),
    ).toThrow();
    const named = { ...initial, eventName: "DifferentEvent" };
    expect(() =>
      readIndexedHistoryPage({ ...page(), filters: named }, owner, named),
    ).toThrow();
    const asset = { ...initial, contractAddress: owner };
    expect(() =>
      readIndexedHistoryPage({ ...page(), filters: asset }, owner, asset),
    ).toThrow();
  });
  it("admits an empty later page only as that snapshot's current result", () => {
    const filter = { ...initial, page: 12 };
    expect(
      readIndexedHistoryPage(
        { ...page(), total: 0, data: [], filters: filter },
        owner,
        filter,
      ).total,
    ).toBe(0);
  });
});

describe("history transport", () => {
  it("captures the query before awaiting and uses only the original same-origin private route", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(page()));
    vi.stubGlobal("fetch", fetcher);
    const filter = { ...initial };
    const pending = requestIndexedHistory(
      owner,
      filter,
      new AbortController().signal,
    );
    filter.page = 2;
    await expect(pending).resolves.toMatchObject({ filters: initial });
    expect(fetcher.mock.calls[0][0]).toBe(
      `/api/portfolio/${owner}/history?status=all&order=newest&page=1`,
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  });
  it.each([401, 403, 429, 503])(
    "keeps HTTP%s distinct from empty history",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            Response.json({ detail: "TEST_ONLY_PRIVATE" }, { status }),
          ),
      );
      await expect(
        requestIndexedHistory(owner, initial, new AbortController().signal),
      ).rejects.toThrow("Indexed transaction history is unavailable");
    },
  );
  it("bounds actual response bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(" ".repeat(indexedHistoryByteLimit + 1), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(
      requestIndexedHistory(owner, initial, new AbortController().signal),
    ).rejects.toThrow();
  });
  it("bounds ignored-abort headers and discards the late body", async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = requestIndexedHistory(
      owner,
      initial,
      new AbortController().signal,
    );
    const assertion = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(administrationRequestTimeoutMs + 1);
    await assertion;
    const late = Response.json(page());
    const cancel = vi.spyOn(late.body!, "cancel");
    finish(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("wallet-owned history request lifecycle", () => {
  it("clears the old page synchronously and ignores an older response after a new filter", async () => {
    let release!: (value: IndexedHistoryPage) => void;
    let firstSignal!: AbortSignal;
    const request = vi
      .fn<typeof requestIndexedHistory>()
      .mockImplementationOnce((_address, _filter, signal) => {
        firstSignal = signal;
        return new Promise<IndexedHistoryPage>((resolve) => {
          release = resolve;
        });
      })
      .mockResolvedValueOnce(
        readIndexedHistoryPage(
          { ...page(), filters: { ...initial, order: "oldest" } },
          owner,
          { ...initial, order: "oldest" },
        ),
      );
    const controller = createIndexedHistoryController(owner, request);
    const old = controller.refresh();
    const current = controller.change({ ...initial, order: "oldest" });
    expect(firstSignal.aborted).toBe(true);
    expect(controller.getSnapshot().page).toBeUndefined();
    await current;
    release(admit());
    await old;
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      filter: { order: "oldest" },
    });
    expect(controller.getSnapshot().page?.filters.order).toBe("oldest");
    controller.dispose();
  });
  it("retains no account data after disposal and a late response", async () => {
    let release!: (value: IndexedHistoryPage) => void;
    const controller = createIndexedHistoryController(
      owner,
      () =>
        new Promise<IndexedHistoryPage>((resolve) => {
          release = resolve;
        }),
    );
    const pending = controller.refresh();
    controller.dispose();
    release(admit());
    await pending;
    expect(controller.getSnapshot()).toMatchObject({ status: "disposed" });
    expect(controller.getSnapshot().page).toBeUndefined();
  });
  it("supports the original React effect setup/cleanup/setup without reviving a retired request", async () => {
    let release!: (value: IndexedHistoryPage) => void;
    const request = vi
      .fn<typeof requestIndexedHistory>()
      .mockImplementationOnce(
        () =>
          new Promise<IndexedHistoryPage>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(admit());
    const controller = createIndexedHistoryController(owner, request);
    const old = controller.refresh();
    controller.dispose();
    controller.activate();
    await controller.refresh();
    release(admit());
    await old;
    expect(controller.getSnapshot().status).toBe("ready");
    expect(request).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
  it("does not turn a failed refresh into an empty successful page or keep old records", async () => {
    const request = vi
      .fn<typeof requestIndexedHistory>()
      .mockResolvedValueOnce(admit())
      .mockRejectedValueOnce(new Error("TEST_ONLY_INTERNAL"));
    const controller = createIndexedHistoryController(owner, request);
    await controller.refresh();
    const pending = controller.refresh();
    expect(controller.getSnapshot().page).toBeUndefined();
    await pending;
    expect(controller.getSnapshot()).toMatchObject({ status: "error" });
    expect(controller.getSnapshot().page).toBeUndefined();
    controller.dispose();
  });
});
