import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClientSessionController,
  ClientSessionError,
  type SessionAPI,
} from "./user-session-client";
import {
  authenticatedSession,
  type UserSession,
} from "./user-session-client-state";
import { watchUserSessionDeadlines } from "./user-session-deadlines";

const address = "0x1234567890123456789012345678901234567890";
const wallet = { address, chainId: 560048, status: "connected" as const };
const start = 1_800_000_000_000;
function session(): UserSession {
  return {
    id: "session-one",
    address,
    chainId: 560048,
    expiresAt: start + 60_000,
    accessExpiresAt: start + 1_000,
  };
}
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  let current = session();
  let unavailable = false;
  const calls: string[] = [];
  const api: SessionAPI = vi.fn(async (action) => {
    calls.push(action);
    if (unavailable)
      throw new ClientSessionError(503, "Temporarily unavailable");
    if (action === "session" && Date.now() >= current.accessExpiresAt)
      throw new ClientSessionError(401, "Expired access");
    if (action === "refresh")
      current = { ...current, accessExpiresAt: Date.now() + 30_000 };
    return action === "logout" ? {} : { session: current };
  });
  const controller = new ClientSessionController(
    api,
    (run) => run(),
    () => {},
  );
  controller.setWallet(wallet);
  return {
    controller,
    calls,
    api,
    unavailable: (value: boolean) => {
      unavailable = value;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("access and durable session deadlines", () => {
  it("does not treat expired access as authenticated while retaining refresh eligibility", () => {
    const s = setup();
    expect(authenticatedSession(session(), wallet)).toBe(true);
    vi.setSystemTime(start + 1_000);
    expect(authenticatedSession(session(), wallet)).toBe(false);
    expect(s.calls).toEqual([]);
  });
  it("refreshes an open page at access expiry without a signature or revision change", async () => {
    const { controller, calls } = setup();
    await controller.restore();
    const revision = controller.getSnapshot().revision;
    const states: boolean[] = [];
    const unsub = controller.subscribe(() =>
      states.push(controller.getSnapshot().authenticated),
    );
    const stop = watchUserSessionDeadlines(controller);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(["session", "session", "refresh"]);
    expect(states).toContain(false);
    expect(controller.getSnapshot()).toMatchObject({
      authenticated: true,
      revision,
    });
    stop();
    unsub();
  });
  it("keeps failure unauthenticated and retries at a bounded interval", async () => {
    const s = setup();
    await s.controller.restore();
    s.unavailable(true);
    const stop = watchUserSessionDeadlines(s.controller);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.controller.getSnapshot().authenticated).toBe(false);
    expect(s.controller.getSnapshot().session?.id).toBe("session-one");
    const count = s.calls.length;
    await vi.advanceTimersByTimeAsync(14_999);
    expect(s.calls).toHaveLength(count);
    s.unavailable(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls.slice(-2)).toEqual(["session", "refresh"]);
    expect(s.controller.getSnapshot().authenticated).toBe(true);
    stop();
  });
  it("ignores an old access timer after refresh and never logs out current cookies", async () => {
    const { controller, calls } = setup();
    await controller.restore();
    const old = controller.getSnapshot().session!;
    vi.setSystemTime(start + 1_000);
    await controller.checkSessionDeadline(
      old.id,
      old.accessExpiresAt,
      old.expiresAt,
    );
    const current = controller.getSnapshot().session;
    const before = calls.length;
    await controller.checkSessionDeadline(
      old.id,
      old.accessExpiresAt,
      old.expiresAt,
    );
    expect(calls).toHaveLength(before);
    expect(controller.getSnapshot().session).toBe(current);
    expect(calls).not.toContain("logout");
  });
  it("does not restore after provider cleanup or local sign-out", async () => {
    const { controller, calls } = setup();
    await controller.restore();
    const stop = watchUserSessionDeadlines(controller);
    stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual(["session"]);
    const stopAgain = watchUserSessionDeadlines(controller);
    await controller.signOut();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(["session", "logout"]);
    stopAgain();
  });
  it("absolute expiry wins over a delayed access check and late response cannot restore", async () => {
    const { controller, api, calls } = setup();
    await controller.restore();
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    vi.mocked(api).mockImplementationOnce(() => pending);
    const stop = watchUserSessionDeadlines(controller);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getSnapshot().authenticated).toBe(false);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(controller.getSnapshot().session).toBeNull();
    finish({
      session: {
        ...session(),
        accessExpiresAt: start + 90_000,
        expiresAt: start + 120_000,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().session).toBeNull();
    expect(calls).not.toContain("logout");
    stop();
  });
  it.each(["", "x".repeat(129), "valid-id"])(
    "rejects impossible public session deadlines or ID %s",
    async (id) => {
      setup();
      const bad = { ...session(), id, accessExpiresAt: start + 120_000 };
      const api: SessionAPI = async () => ({ session: bad });
      const controller = new ClientSessionController(
        api,
        (run) => run(),
        () => {},
      );
      controller.setWallet(wallet);
      await controller.restore();
      expect(controller.getSnapshot().session).toBeNull();
    },
  );
});
