import type { ClientSessionController } from "./user-session-client";

type DeadlineController = Pick<
  ClientSessionController,
  "getSnapshot" | "subscribe" | "checkSessionDeadline"
>;
type DeadlineClock = {
  now: () => number;
  setTimer: (callback: () => void, delay: number) => () => void;
};
const browserClock: DeadlineClock = {
  now: () => Date.now(),
  setTimer: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};
const retryDelay = 15_000;
const maximumDelay = 2_147_483_647;

/** One access deadline and a bounded retry; durable expiry stays active during I/O. */
export function watchUserSessionDeadlines(
  controller: DeadlineController,
  clock: DeadlineClock = browserClock,
) {
  let stopped = false;
  let checking = false;
  let retryAt = 0;
  let key = "";
  let cancelTimer = () => {};
  const schedule = () => {
    cancelTimer();
    cancelTimer = () => {};
    const session = controller.getSnapshot().session;
    if (stopped || !session) return;
    const currentKey = JSON.stringify([
      session.id,
      session.accessExpiresAt,
      session.expiresAt,
    ]);
    if (currentKey !== key) {
      key = currentKey;
      retryAt = 0;
    }
    const now = clock.now();
    const accessCheck =
      session.accessExpiresAt > now
        ? session.accessExpiresAt
        : Math.max(now, retryAt);
    const due = checking
      ? session.expiresAt
      : Math.min(session.expiresAt, accessCheck);
    cancelTimer = clock.setTimer(
      () => {
        if (stopped) return;
        const current = controller.getSnapshot().session;
        if (!current) return;
        if (checking) {
          if (clock.now() < current.expiresAt) {
            schedule();
            return;
          }
          // The first check publishes local expiry synchronously before any API wait.
          void controller
            .checkSessionDeadline(
              current.id,
              current.accessExpiresAt,
              current.expiresAt,
            )
            .catch(() => undefined);
          return;
        }
        if (
          clock.now() < Math.min(current.accessExpiresAt, current.expiresAt)
        ) {
          schedule();
          return;
        }
        checking = true;
        retryAt = clock.now() + retryDelay;
        void controller
          .checkSessionDeadline(
            current.id,
            current.accessExpiresAt,
            current.expiresAt,
          )
          .catch(() => undefined)
          .finally(() => {
            checking = false;
            if (!stopped) schedule();
          });
      },
      Math.max(0, Math.min(maximumDelay, due - now)),
    );
  };
  const unsubscribe = controller.subscribe(schedule);
  schedule();
  return () => {
    stopped = true;
    cancelTimer();
    unsubscribe();
  };
}
