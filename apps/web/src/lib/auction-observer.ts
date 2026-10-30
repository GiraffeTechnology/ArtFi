export type AuctionObserverState<T> = Readonly<{
  phase: "idle" | "loading" | "ready" | "unavailable" | "paused";
  value: T | null;
  observedAt: number | null;
}>;

/** One in-flight read per observer. Timers run after completion, and late reads
 * cannot restore a hidden, disposed or superseded view. No write is dispatched. */
export function createAuctionObserver<T>(
  read: () => Promise<T>,
  options: { now?: () => number; interval?: number } = {},
) {
  const now = options.now ?? Date.now;
  const interval = options.interval ?? 12000;
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 30000)
    throw new Error("The auction observation interval is outside its bounds.");
  const initial: AuctionObserverState<T> = Object.freeze({
    phase: "idle",
    value: null,
    observedAt: null,
  });
  let state = initial,
    active = false,
    disposed = false,
    generation = 0,
    inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const publish = (update: AuctionObserverState<T>) => {
    state = Object.freeze(update);
    for (const listener of listeners) listener();
  };
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const refresh = async () => {
    clearTimer();
    if (!active || disposed || inFlight) return;
    const captured = generation;
    inFlight = true;
    publish({ phase: "loading", value: null, observedAt: null });
    try {
      const value = await read();
      const observedAt = now();
      if (!Number.isSafeInteger(observedAt) || observedAt < 0)
        throw new Error("The observation time is unavailable.");
      if (active && !disposed && captured === generation)
        publish({ phase: "ready", value, observedAt });
    } catch {
      if (active && !disposed && captured === generation)
        publish({ phase: "unavailable", value: null, observedAt: null });
    } finally {
      inFlight = false;
      if (active && !disposed)
        timer = setTimeout(
          () => void refresh(),
          captured === generation ? interval : 0,
        );
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
    refresh,
    setActive: (enabled: boolean) => {
      if (disposed || enabled === active) return;
      active = enabled;
      generation++;
      clearTimer();
      if (enabled) {
        publish({ phase: "loading", value: null, observedAt: null });
        void refresh();
      } else publish({ phase: "paused", value: null, observedAt: null });
    },
    dispose: () => {
      if (disposed) return;
      active = false;
      disposed = true;
      generation++;
      clearTimer();
      publish({ phase: "paused", value: null, observedAt: null });
      listeners.clear();
    },
  };
}
