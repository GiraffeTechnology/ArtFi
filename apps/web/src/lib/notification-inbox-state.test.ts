import { describe, expect, it, vi } from "vitest";
import {
  createNotificationInbox,
  notificationIdentity,
  NotificationRequestError,
  parseNotificationPage,
  parseNotificationPreferences,
  type NotificationIdentity,
  type NotificationTransport,
} from "./notification-inbox-state";

const owner = "0x" + "1".repeat(40);
const other = "0x" + "2".repeat(40);
const hash = "0x" + "a".repeat(64);
const identity: NotificationIdentity = {
  address: owner,
  chainId: 560048,
  sessionId: "b".repeat(32),
  expiresAt: 10000,
};

function eventNotice() {
  return {
    id: "c".repeat(32),
    sourceKey: `560048:${hash}:4294967295`,
    sourceKind: "chain_event",
    sourceRevision: "18446744073709551615",
    state: "removed",
    read: false,
    readAt: null as string | null,
    messageCode: "event_removed",
    event: {
      transactionHash: hash,
      logIndex: 4294967295,
      contractAddress: other,
      eventName: "Transfer",
      blockNumber: "9007199254740993",
    },
    text: null,
  };
}

function response() {
  return {
    address: owner,
    chainId: 560048,
    notifications: [eventNotice()],
    preferences: {
      revision: "0",
      transactionAlerts: true,
      systemMessageAlerts: true,
    },
    chainEventsAvailable: true,
  };
}

function readResponse() {
  const page = response();
  page.notifications[0].read = true;
  page.notifications[0].readAt = "2026-10-15T12:00:00.000Z";
  return page;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  let now = 1;
  let key = 0;
  const transport: NotificationTransport = {
    list: vi.fn(async () => response()),
    markRead: vi.fn(async () => readResponse()),
    savePreferences: vi.fn(async () => ({
      ...response(),
      preferences: {
        revision: "1",
        transactionAlerts: false,
        systemMessageAlerts: true,
      },
    })),
  };
  const requestKey = vi.fn(() => `notification-key-${++key}`);
  const inbox = createNotificationInbox(transport, {
    now: () => now,
    requestKey,
  });
  inbox.setIdentity(identity);
  return {
    inbox,
    transport,
    requestKey,
    time: (value: number) => (now = value),
  };
}

describe("notification response boundaries", () => {
  it("retains full event identities and integer strings without granting finality", () => {
    const value = response();
    const page = parseNotificationPage(value, identity);
    expect(page.notifications[0].sourceKey).toBe(
      value.notifications[0].sourceKey,
    );
    expect(page.notifications[0].event?.blockNumber).toBe("9007199254740993");
    expect(page.notifications[0].state).toBe("removed");
    expect(page.notifications[0].messageCode).toBe("event_removed");
    expect(page.notifications[0].sourceRevision).toBe("18446744073709551615");
    expect(Object.isFrozen(page.notifications[0].event)).toBe(true);
    value.notifications[0].state = "confirmed";
    expect(page.notifications[0].state).toBe("removed");
  });

  it.each([
    ["wallet", { address: other }],
    ["chain", { chainId: 1 }],
    ["unknown envelope field", { accessToken: "must-not-enter-state" }],
    ["unbounded page", { notifications: Array(101).fill(eventNotice()) }],
    ["unavailable chain events", { chainEventsAvailable: false }],
  ] as const)("rejects %s responses", (_, patch) => {
    expect(() =>
      parseNotificationPage({ ...response(), ...patch }, identity),
    ).toThrow();
  });

  it.each([
    ["truncated source key", { sourceKey: "a".repeat(32) }],
    ["wrong chain source", { sourceKey: `1:${hash}:4294967295` }],
    ["wrong status code", { messageCode: "event_confirmed" }],
    ["unsupported status", { state: "failed" }],
    ["invented source", { sourceKind: "oracle" }],
    ["numeric revision", { sourceRevision: 2 }],
    ["noncanonical revision", { sourceRevision: "01" }],
    ["overflow", { sourceRevision: "18446744073709551616" }],
    ["unknown fields", { authorization: "not a notification field" }],
    ["inconsistent read", { read: true, readAt: null }],
    ["bad read time", { read: true, readAt: "yesterday" }],
  ] as const)("rejects %s notice data", (_, patch) => {
    expect(() =>
      parseNotificationPage(
        { ...response(), notifications: [{ ...eventNotice(), ...patch }] },
        identity,
      ),
    ).toThrow();
  });

  it("rejects duplicate storage or source identities", () => {
    for (const duplicate of [
      eventNotice(),
      { ...eventNotice(), id: "d".repeat(32) },
      {
        ...eventNotice(),
        sourceKey: `560048:${hash}:1`,
        event: { ...eventNotice().event, logIndex: 1 },
      },
    ])
      expect(() =>
        parseNotificationPage(
          { ...response(), notifications: [eventNotice(), duplicate] },
          identity,
        ),
      ).toThrow();
  });

  it("accepts only public notice text and clears withdrawn text", () => {
    const notice = {
      ...eventNotice(),
      sourceKey: "platform:service_notice",
      sourceKind: "system_notice",
      sourceRevision: "17",
      state: "published",
      messageCode: "service_notice",
      event: null,
      text: "Service maintenance notice.",
    };
    const input = { ...response(), notifications: [notice] };
    expect(parseNotificationPage(input, identity).notifications[0].text).toBe(
      notice.text,
    );
    expect(() =>
      parseNotificationPage(
        { ...input, notifications: [{ ...notice, state: "withdrawn" }] },
        identity,
      ),
    ).toThrow();
    const withdrawn = { ...notice, state: "withdrawn", text: null };
    expect(
      parseNotificationPage({ ...input, notifications: [withdrawn] }, identity)
        .notifications[0].text,
    ).toBeNull();
  });

  it("rejects unsafe event, preference and principal representations", () => {
    for (const patch of [
      { logIndex: -1 },
      { logIndex: 4294967296 },
      { blockNumber: 9007199254740992 },
      { blockNumber: (1n << 256n).toString() },
      { transactionHash: "0x123" },
    ])
      expect(() =>
        parseNotificationPage(
          {
            ...response(),
            notifications: [
              { ...eventNotice(), event: { ...eventNotice().event, ...patch } },
            ],
          },
          identity,
        ),
      ).toThrow();
    for (const patch of [
      { transactionAlerts: "false" },
      { revision: "-1" },
      { revision: "01" },
      { owner },
    ])
      expect(() =>
        parseNotificationPreferences({ ...response().preferences, ...patch }),
      ).toThrow();
    for (const patch of [
      { expiresAt: 1 },
      { chainId: 0 },
      { chainId: 1.1 },
      { sessionId: "" },
      { address: "not-a-wallet" },
    ])
      expect(() =>
        notificationIdentity({ ...identity, ...patch }, 1),
      ).toThrow();
    expect(() => notificationIdentity(identity, NaN)).toThrow();
  });
});

describe("notification session and mutation lifecycle", () => {
  it.each([
    ["wallet", { address: other }],
    ["chain", { chainId: 1 }],
    ["session", { sessionId: "d".repeat(32) }],
  ] as const)(
    "ignores late reads after a %s change even when abort is ignored",
    async (_, patch) => {
      const f = fixture();
      const pending = deferred<unknown>();
      vi.mocked(f.transport.list).mockReturnValueOnce(pending.promise);
      const reading = f.inbox.refresh();
      const signal = vi.mocked(f.transport.list).mock.calls[0][1];
      f.inbox.setIdentity({ ...identity, ...patch });
      expect(signal.aborted).toBe(true);
      expect(f.inbox.getSnapshot().page).toBeNull();
      pending.resolve(response());
      await reading;
      expect(f.inbox.getSnapshot().page).toBeNull();
      expect(f.inbox.getSnapshot().identity).toEqual({ ...identity, ...patch });
    },
  );

  it("only accepts the latest read and never marks notices read on listing", async () => {
    const f = fixture();
    const first = deferred<unknown>();
    vi.mocked(f.transport.list).mockReturnValueOnce(first.promise);
    const old = f.inbox.refresh();
    const newest = { ...response(), notifications: [] };
    vi.mocked(f.transport.list).mockResolvedValueOnce(newest);
    await f.inbox.refresh();
    first.resolve(response());
    await old;
    expect(f.inbox.getSnapshot().page?.notifications).toEqual([]);
    expect(f.transport.markRead).not.toHaveBeenCalled();
  });

  it("clears private state at expiry, logout and disposal", async () => {
    const f = fixture();
    await f.inbox.refresh();
    f.time(identity.expiresAt);
    await f.inbox.markRead(eventNotice().id, eventNotice().sourceRevision);
    expect(f.inbox.getSnapshot()).toMatchObject({
      status: "expired",
      page: null,
      identity: null,
    });
    expect(f.transport.markRead).not.toHaveBeenCalled();
    f.time(1);
    f.inbox.setIdentity(identity);
    await f.inbox.refresh();
    f.inbox.setIdentity(null);
    expect(f.inbox.getSnapshot().page).toBeNull();
    f.inbox.setIdentity(identity);
    await f.inbox.refresh();
    f.inbox.dispose();
    expect(f.inbox.getSnapshot().identity).toBeNull();
    expect(f.inbox.getSnapshot().page).toBeNull();
  });

  it("does not accept a response that crosses expiry while in flight", async () => {
    const f = fixture();
    const pending = deferred<unknown>();
    vi.mocked(f.transport.list).mockReturnValueOnce(pending.promise);
    const reading = f.inbox.refresh();
    f.time(identity.expiresAt);
    pending.resolve(response());
    await reading;
    expect(f.inbox.getSnapshot().status).toBe("expired");
    expect(f.inbox.getSnapshot().page).toBeNull();
  });

  it("holds one mutation, retains its exact revision and awaits acknowledgement", async () => {
    const f = fixture();
    await f.inbox.refresh();
    const pending = deferred<unknown>();
    vi.mocked(f.transport.markRead).mockReturnValueOnce(pending.promise);
    const writing = f.inbox.markRead(
      eventNotice().id,
      eventNotice().sourceRevision,
    );
    await f.inbox.markRead(eventNotice().id, eventNotice().sourceRevision);
    await f.inbox.savePreferences({
      ...response().preferences,
      transactionAlerts: false,
    });
    await f.inbox.refresh();
    expect(f.transport.markRead).toHaveBeenCalledTimes(1);
    expect(f.transport.savePreferences).not.toHaveBeenCalled();
    expect(f.requestKey).toHaveBeenCalledTimes(1);
    expect(f.inbox.getSnapshot().page?.notifications[0].read).toBe(false);
    expect(vi.mocked(f.transport.markRead).mock.calls[0][1]).toEqual({
      id: eventNotice().id,
      expectedSourceRevision: eventNotice().sourceRevision,
    });
    pending.resolve(readResponse());
    await writing;
    expect(f.inbox.getSnapshot().page?.notifications[0].read).toBe(true);
    expect(f.inbox.getSnapshot().pending).toBe(false);
  });

  it.each([
    new Error("network result unknown"),
    new NotificationRequestError(409),
  ])(
    "requires reconciliation after a write failure without a blind retry",
    async (failure) => {
      const f = fixture();
      await f.inbox.refresh();
      vi.mocked(f.transport.markRead).mockRejectedValueOnce(failure);
      await f.inbox.markRead(eventNotice().id, eventNotice().sourceRevision);
      expect(f.inbox.getSnapshot()).toMatchObject({
        status: "reconcile",
        page: null,
        pending: false,
      });
      await f.inbox.markRead(eventNotice().id, eventNotice().sourceRevision);
      expect(f.transport.markRead).toHaveBeenCalledTimes(1);
      vi.mocked(f.transport.list).mockResolvedValueOnce(readResponse());
      await f.inbox.refresh();
      expect(f.inbox.getSnapshot().page?.notifications[0].read).toBe(true);
      expect(f.transport.markRead).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects stale and invented mark-read requests before transport", async () => {
    const f = fixture();
    await f.inbox.refresh();
    await f.inbox.markRead(eventNotice().id, "1");
    await f.inbox.markRead("f".repeat(32), eventNotice().sourceRevision);
    expect(f.transport.markRead).not.toHaveBeenCalled();
    expect(f.requestKey).not.toHaveBeenCalled();
  });

  it("does not apply an acknowledgement for an earlier source revision", async () => {
    const f = fixture();
    await f.inbox.refresh();
    const wrong = readResponse();
    wrong.notifications[0].sourceRevision = "1";
    vi.mocked(f.transport.markRead).mockResolvedValueOnce(wrong);
    await f.inbox.markRead(eventNotice().id, eventNotice().sourceRevision);
    expect(f.inbox.getSnapshot().status).toBe("reconcile");
    expect(f.inbox.getSnapshot().page).toBeNull();
  });

  it("clears private data on 401 and ignores late writes after logout", async () => {
    const f = fixture();
    await f.inbox.refresh();
    const pending = deferred<unknown>();
    vi.mocked(f.transport.markRead).mockReturnValueOnce(pending.promise);
    const writing = f.inbox.markRead(
      eventNotice().id,
      eventNotice().sourceRevision,
    );
    f.inbox.setIdentity(null);
    pending.resolve(readResponse());
    await writing;
    expect(f.inbox.getSnapshot().page).toBeNull();
    f.inbox.setIdentity(identity);
    vi.mocked(f.transport.list).mockRejectedValueOnce(
      new NotificationRequestError(401),
    );
    await f.inbox.refresh();
    expect(f.inbox.getSnapshot().identity).toBeNull();
    expect(f.inbox.getSnapshot().page).toBeNull();
  });

  it("persists preferences only after an exact revision acknowledgement", async () => {
    const f = fixture();
    await f.inbox.refresh();
    const input = { ...response().preferences, transactionAlerts: false };
    await f.inbox.savePreferences(input);
    expect(f.inbox.getSnapshot().page?.preferences).toEqual({
      ...input,
      revision: "1",
    });
    await f.inbox.savePreferences(input);
    expect(f.transport.savePreferences).toHaveBeenCalledTimes(1);
    const wrong = {
      ...response(),
      preferences: { ...input, revision: "3" },
    };
    vi.mocked(f.transport.savePreferences).mockResolvedValueOnce(wrong);
    await f.inbox.savePreferences({ ...input, revision: "1" });
    expect(f.inbox.getSnapshot().status).toBe("reconcile");
  });

  it("does not dispatch a mutation when secure request-key creation fails", async () => {
    const f = fixture();
    await f.inbox.refresh();
    f.requestKey.mockReturnValueOnce("short");
    await f.inbox.markRead(eventNotice().id, eventNotice().sourceRevision);
    expect(f.transport.markRead).not.toHaveBeenCalled();
    expect(f.inbox.getSnapshot().page).toBeNull();
  });
});
