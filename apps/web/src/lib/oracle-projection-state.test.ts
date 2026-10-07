import {
  QueryClient,
  QueryObserver,
  onlineManager,
} from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { projectionFixture } from "../test/oracle-projection-fixtures";
import {
  projectionReadView,
  type ProjectionReadResponse,
} from "./oracle-projection-model";

const cleanups: (() => void)[] = [];
afterEach(() => {
  onlineManager.setOnline(true);
  cleanups.splice(0).forEach((fn) => fn());
});
function observe(queryFn: () => Promise<ProjectionReadResponse>) {
  const client = new QueryClient();
  client.mount();
  const observer = new QueryObserver(client, {
    queryKey: ["projection", "asset", "1500"],
    queryFn,
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  cleanups.push(() => {
    unsubscribe();
    client.unmount();
    client.clear();
  });
  return observer;
}
it("hides cached projection while offline and during the resumed read", async () => {
  let finish: ((value: ProjectionReadResponse) => void) | undefined;
  const read = vi
    .fn<() => Promise<ProjectionReadResponse>>()
    .mockResolvedValueOnce(projectionFixture())
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const observer = observe(read);
  await observer.refetch();
  expect(projectionReadView(observer.getCurrentResult()).result?.ok).toBe(true);
  onlineManager.setOnline(false);
  const pending = observer.refetch();
  expect(observer.getCurrentResult().data?.ok).toBe(true);
  expect(projectionReadView(observer.getCurrentResult())).toEqual({
    phase: "paused",
  });
  onlineManager.setOnline(true);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(projectionReadView(observer.getCurrentResult())).toEqual({
    phase: "loading",
  });
  finish!({ ok: false, code: "PROJECTION_SOURCE_UNAVAILABLE" });
  await pending;
  expect(projectionReadView(observer.getCurrentResult())).toEqual({
    phase: "settled",
    result: { ok: false, code: "PROJECTION_SOURCE_UNAVAILABLE" },
  });
});
it("a different instant starts empty instead of showing the previous instant's holder", async () => {
  const read = vi
    .fn<() => Promise<ProjectionReadResponse>>()
    .mockResolvedValueOnce(projectionFixture())
    .mockImplementationOnce(() => new Promise(() => {}));
  const observer = observe(read);
  await observer.refetch();
  observer.setOptions({
    queryKey: ["projection", "asset", "999"],
    queryFn: read,
    retry: false,
  });
  expect(projectionReadView(observer.getCurrentResult())).toEqual({
    phase: "loading",
  });
  expect(observer.getCurrentResult().data).toBeUndefined();
});
it("an initial offline read reports paused without inventing any empty/final result", () => {
  onlineManager.setOnline(false);
  const read = vi
    .fn<() => Promise<ProjectionReadResponse>>()
    .mockResolvedValue(projectionFixture());
  expect(projectionReadView(observe(read).getCurrentResult())).toEqual({
    phase: "paused",
  });
  expect(read).not.toHaveBeenCalled();
});
