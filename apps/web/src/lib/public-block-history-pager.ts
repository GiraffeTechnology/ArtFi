export type PublicHistoryFailure =
  | "INVALID_QUERY"
  | "INVALID_CURSOR"
  | "UNAVAILABLE"
  | "SOURCE_CHANGED"
  | "DENSE_RANGE"
  | "MALFORMED"
  | "CANCELLED";
export type PublicBlockHistoryPagerState<Page> = Readonly<{
  phase: "idle" | "loading" | "ready" | "unavailable" | "paused";
  page: Page | null;
  pending: boolean;
  observedAt: number | null;
  failure: PublicHistoryFailure | null;
}>;

/** One actual read at a time. Abort fences results; the supplied RPC transport
 * retains its own timeout/cancellation behavior. No read is automatically retried. */
export function createPublicBlockHistoryPager<
  Cursor,
  Page extends Readonly<{ older: Cursor | null; newer: Cursor | null }>,
>(
  read: (cursor: Cursor | null, signal: AbortSignal) => Promise<Page>,
  now: () => number = Date.now,
) {
  const initial: PublicBlockHistoryPagerState<Page> = Object.freeze({
    phase: "idle",
    page: null,
    pending: false,
    observedAt: null,
    failure: null,
  });
  let state = initial,
    generation = 0,
    visible = true,
    inFlight = false;
  let abort: AbortController | null = null;
  let lastCursor: Cursor | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: PublicBlockHistoryPagerState<Page>) => {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const load = async (cursor: Cursor | null) => {
    if (!visible || inFlight) return;
    inFlight = true;
    const captured = generation,
      controller = new AbortController();
    abort = controller;
    lastCursor = cursor;
    publish({
      phase: "loading",
      page: null,
      pending: true,
      observedAt: null,
      failure: null,
    });
    try {
      const page = await read(cursor, controller.signal);
      if (!visible || captured !== generation || controller.signal.aborted)
        return;
      const instant = now();
      if (!Number.isSafeInteger(instant) || instant < 0)
        throw new Error("invalid observation clock");
      publish({
        phase: "ready",
        page,
        pending: true,
        observedAt: instant,
        failure: null,
      });
    } catch (error) {
      if (!visible || captured !== generation || controller.signal.aborted)
        return;
      let code: unknown = null;
      try {
        const descriptor =
          error && typeof error === "object"
            ? Object.getOwnPropertyDescriptor(error, "code")
            : undefined;
        if (descriptor && Object.hasOwn(descriptor, "value"))
          code = descriptor.value;
      } catch {
        /* A hostile error object must not break the unavailable state. */
      }
      const failure: PublicHistoryFailure =
        typeof code === "string" &&
        [
          "INVALID_QUERY",
          "INVALID_CURSOR",
          "UNAVAILABLE",
          "SOURCE_CHANGED",
          "DENSE_RANGE",
          "MALFORMED",
          "CANCELLED",
        ].includes(code)
          ? (code as PublicHistoryFailure)
          : "UNAVAILABLE";
      publish({
        phase: "unavailable",
        page: null,
        pending: true,
        observedAt: null,
        failure,
      });
    } finally {
      inFlight = false;
      abort = null;
      // An obsolete response may release its actual in-flight slot, but cannot
      // restore any page after a hide/restart or source-context replacement.
      publish({ ...state, pending: false });
    }
  };
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    newest: () => load(null),
    older: () =>
      state.phase === "ready" && state.page?.older
        ? load(state.page.older)
        : Promise.resolve(),
    newer: () =>
      state.phase === "ready" && state.page?.newer
        ? load(state.page.newer)
        : Promise.resolve(),
    retry: () =>
      state.phase === "unavailable" ? load(lastCursor) : Promise.resolve(),
    setVisible: (enabled: boolean) => {
      if (enabled === visible) return;
      visible = enabled;
      generation++;
      abort?.abort();
      lastCursor = null;
      publish({
        phase: enabled ? "idle" : "paused",
        page: null,
        pending: inFlight,
        observedAt: null,
        failure: null,
      });
    },
  };
}
