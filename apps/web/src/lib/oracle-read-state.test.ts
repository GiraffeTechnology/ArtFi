import {
  QueryClient,
  QueryObserver,
  onlineManager,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { oracleReadFixtures } from "../test/oracle-fixtures";
import type { OracleReadResponse } from "./oracle-read-model";
import { oracleReadView } from "./oracle-read-state";

const cleanups: (() => void)[] = [];
afterEach(() => {
  onlineManager.setOnline(true);
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

function observe(queryFn: () => Promise<OracleReadResponse>) {
  const client = new QueryClient();
  client.mount();
  const observer = new QueryObserver(client, {
    queryKey: ["whole-artwork-oracle", "blue-hour-archive"],
    queryFn,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  cleanups.push(() => {
    unsubscribe();
    client.unmount();
    client.clear();
  });
  return observer;
}
function projection(): OracleReadResponse {
  return { ok: true, ...oracleReadFixtures(), readAt: "2026-10-02T10:00:00Z" };
}

describe("Oracle current-read presentation during interrupted connectivity", () => {
  it("hides successful cache during an offline refresh and until the resumed read finishes", async () => {
    let finish: ((value: OracleReadResponse) => void) | undefined;
    const fetch = vi
      .fn<() => Promise<OracleReadResponse>>()
      .mockResolvedValueOnce(projection())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const observer = observe(fetch);
    await observer.refetch();
    expect(oracleReadView(observer.getCurrentResult()).result?.ok).toBe(true);

    onlineManager.setOnline(false);
    const refresh = observer.refetch();
    const paused = observer.getCurrentResult();
    // This exact library behavior caused the regression: cached success plus
    // paused is neither pending nor fetching. A loading-only guard is insufficient.
    expect(paused).toMatchObject({
      isPaused: true,
      isPending: false,
      isFetching: false,
      data: { ok: true },
    });
    expect(oracleReadView(paused)).toEqual({ phase: "paused" });
    expect(fetch).toHaveBeenCalledTimes(1);

    onlineManager.setOnline(true);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(oracleReadView(observer.getCurrentResult())).toEqual({
      phase: "loading",
    });
    finish!({ ok: false, code: "ORACLE_RECORD_GONE" });
    await refresh;
    expect(oracleReadView(observer.getCurrentResult())).toEqual({
      phase: "settled",
      result: { ok: false, code: "ORACLE_RECORD_GONE" },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shows offline on the first paused read instead of an endless loading message", async () => {
    onlineManager.setOnline(false);
    const fetch = vi
      .fn<() => Promise<OracleReadResponse>>()
      .mockResolvedValue(projection());
    const observer = observe(fetch);
    expect(observer.getCurrentResult()).toMatchObject({
      isPaused: true,
      isPending: true,
    });
    expect(oracleReadView(observer.getCurrentResult())).toEqual({
      phase: "paused",
    });
    expect(fetch).not.toHaveBeenCalled();
    onlineManager.setOnline(true);
    await vi.waitFor(() =>
      expect(oracleReadView(observer.getCurrentResult()).result?.ok).toBe(true),
    );
  });

  it("allows an explicit retry while paused without showing the old facts", async () => {
    const fetch = vi
      .fn<() => Promise<OracleReadResponse>>()
      .mockResolvedValue(projection());
    const observer = observe(fetch);
    await observer.refetch();
    onlineManager.setOnline(false);
    const first = observer.refetch();
    const retry = observer.refetch();
    expect(oracleReadView(observer.getCurrentResult())).toEqual({
      phase: "paused",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    onlineManager.setOnline(true);
    await Promise.all([first, retry]);
    expect(oracleReadView(observer.getCurrentResult()).result?.ok).toBe(true);
  });
});
