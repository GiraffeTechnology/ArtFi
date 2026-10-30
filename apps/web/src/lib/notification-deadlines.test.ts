import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../app/api/notifications/[...path]/route";
import { createNotificationInbox } from "./notification-inbox-state";
import {
  browserNotificationTransport,
  maximumNotificationResponseBytes,
  notificationJSON,
} from "./notification-transport";

const auth = vi.hoisted(() => ({ require: vi.fn(), origin: vi.fn() }));
vi.mock("@/lib/user-auth", () => ({
  requireUserSession: auth.require,
  assertUserRequestOrigin: auth.origin,
  UserAuthError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
const identity = {
  address: `0x${"1".repeat(40)}`,
  chainId: 560048,
  sessionId: "a".repeat(32),
  expiresAt: 4000000000000,
};
const page = () => ({
  address: identity.address,
  chainId: identity.chainId,
  notifications: [],
  preferences: {
    revision: "0",
    transactionAlerts: true,
    systemMessageAlerts: true,
  },
  chainEventsAvailable: true,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function stalledBody() {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel,
  });
  return { response: new Response(stream), cancel };
}
function proxyRequest(method = "GET", signal?: AbortSignal) {
  const path = method === "GET" ? "inbox" : "read";
  return new Request(`https://artfi.example/api/notifications/${path}`, {
    method,
    signal,
    headers: {
      "x-artfi-wallet": identity.address,
      "x-artfi-chain": "560048",
      "x-artfi-session": identity.sessionId,
      "content-type": "application/json",
      "idempotency-key": "exact-notification-key-01",
    },
    ...(method === "POST"
      ? {
          body: JSON.stringify({
            id: "b".repeat(32),
            expectedSourceRevision: "1",
          }),
        }
      : {}),
  });
}
function configureProxy() {
  vi.stubEnv("ARTFI_API_URL", "https://api.example.test");
  auth.require.mockReset().mockResolvedValue({
    session: {
      id: identity.sessionId,
      address: identity.address,
      chainId: 560048,
      expiresAt: identity.expiresAt,
      accessExpiresAt: identity.expiresAt,
    },
    accessToken: "TEST_ONLY_COOKIE_TOKEN",
  });
  auth.origin.mockReset();
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("notification response settlement", () => {
  it("rejects excess bytes without waiting for a non-settling cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(maximumNotificationResponseBytes + 1));
      },
      cancel,
    });
    await expect(notificationJSON(new Response(body))).rejects.toThrow(
      "too large",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("settles a stalled read on abort despite a non-settling cancel hook", async () => {
    const { response, cancel } = stalledBody();
    const abort = new AbortController();
    const pending = expect(
      notificationJSON(response, abort.signal),
    ).rejects.toThrow();
    abort.abort();
    await pending;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
  });
  it("refuses an already aborted browser operation before calling fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const abort = new AbortController();
    abort.abort();
    await expect(
      browserNotificationTransport(fetch).list(identity, abort.signal),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["headers", "body"] as const)(
    "bounds a browser wait for %s when the transport ignores abort",
    async (stage) => {
      vi.useFakeTimers();
      const headers = deferred<Response>(),
        body = stalledBody();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockReturnValue(
          stage === "headers"
            ? headers.promise
            : Promise.resolve(body.response),
        );
      const pending = expect(
        browserNotificationTransport(fetch).list(
          identity,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(12001);
      await pending;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
      if (stage === "headers") headers.resolve(body.response);
      await vi.advanceTimersByTimeAsync(0);
      expect(body.cancel).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves a conflict without awaiting its unread body or replaying", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(new ReadableStream({ cancel }), { status: 409 }),
      );
    await expect(
      browserNotificationTransport(fetch).markRead(
        identity,
        { id: "b".repeat(32), expectedSourceRevision: "1" },
        "exact-notification-key-01",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("routes an unknown write through reconciliation and ignores its late acknowledgement", async () => {
    vi.useFakeTimers();
    const first = page(),
      changed = {
        ...page(),
        preferences: {
          revision: "1",
          transactionAlerts: false,
          systemMessageAlerts: true,
        },
      };
    const write = deferred<Response>(),
      lateCancel = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(first))
      .mockReturnValueOnce(write.promise)
      .mockResolvedValueOnce(Response.json(changed));
    const inbox = createNotificationInbox(browserNotificationTransport(fetch), {
      now: Date.now,
      requestKey: () => "exact-notification-key-01",
    });
    try {
      inbox.setIdentity(identity);
      await inbox.refresh();
      const pending = inbox.savePreferences({
        ...changed.preferences,
        revision: "0",
      });
      await vi.advanceTimersByTimeAsync(12001);
      await pending;
      expect(inbox.getSnapshot()).toMatchObject({
        status: "reconcile",
        pending: false,
        page: null,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      await inbox.savePreferences({ ...changed.preferences, revision: "0" });
      expect(fetch).toHaveBeenCalledTimes(2);
      write.resolve(new Response(new ReadableStream({ cancel: lateCancel })));
      await vi.advanceTimersByTimeAsync(0);
      expect(lateCancel).toHaveBeenCalledTimes(1);
      expect(inbox.getSnapshot().status).toBe("reconcile");
      await inbox.refresh();
      expect(inbox.getSnapshot()).toMatchObject({
        status: "ready",
        page: changed,
      });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls.map(([, options]) => options!.method)).toEqual([
        "GET",
        "PUT",
        "GET",
      ]);
      expect(fetch.mock.calls[1][1]!.headers).toMatchObject({
        "idempotency-key": "exact-notification-key-01",
      });
    } finally {
      inbox.dispose();
    }
  });
});

describe("notification proxy settlement", () => {
  it("cancels a stalled incoming write body at the same deadline without forwarding", async () => {
    vi.useFakeTimers();
    configureProxy();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const body = stalledBody();
    const request = new Request(proxyRequest("POST"), {
      body: body.response.body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = POST(request, {
      params: Promise.resolve({ path: ["read"] }),
    });
    await vi.advanceTimersByTimeAsync(8001);
    expect((await pending).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(request.body!.locked).toBe(false);
  });
  it("refuses an oversized incoming write even when its cancel hook never settles", async () => {
    configureProxy();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const request = new Request(proxyRequest("POST"), {
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(4097));
        },
        cancel,
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await POST(request, {
      params: Promise.resolve({ path: ["read"] }),
    });
    expect(response.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each(["headers", "body", "authentication"] as const)(
    "returns a redacted503 within8 seconds for stalled %s and never forwards a late write",
    async (stage) => {
      vi.useFakeTimers();
      configureProxy();
      const headers = deferred<Response>(),
        body = stalledBody(),
        authentication = deferred<unknown>();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockReturnValue(
          stage === "body" ? Promise.resolve(body.response) : headers.promise,
        );
      vi.stubGlobal("fetch", fetch);
      if (stage === "authentication")
        auth.require.mockReturnValue(authentication.promise);
      const pending = POST(proxyRequest("POST"), {
        params: Promise.resolve({ path: ["read"] }),
      });
      await vi.advanceTimersByTimeAsync(8001);
      const response = await pending;
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("TEST_ONLY_COOKIE_TOKEN");
      if (stage === "authentication") {
        authentication.resolve({
          session: {
            id: identity.sessionId,
            address: identity.address,
            chainId: 560048,
            expiresAt: identity.expiresAt,
            accessExpiresAt: identity.expiresAt,
          },
          accessToken: "TEST_ONLY_COOKIE_TOKEN",
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).not.toHaveBeenCalled();
      } else {
        expect(fetch).toHaveBeenCalledTimes(1);
        if (stage === "headers") headers.resolve(body.response);
        await vi.advanceTimersByTimeAsync(0);
        expect(body.cancel).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("preserves an upstream409 while its cancellation remains pending", async () => {
    configureProxy();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(new ReadableStream({ cancel }), { status: 409 }),
      );
    vi.stubGlobal("fetch", fetch);
    const response = await POST(proxyRequest("POST"), {
      params: Promise.resolve({ path: ["read"] }),
    });
    expect(response.status).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("does not authenticate an already cancelled incoming request", async () => {
    configureProxy();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const abort = new AbortController();
    abort.abort();
    const response = await GET(proxyRequest("GET", abort.signal), {
      params: Promise.resolve({ path: ["inbox"] }),
    });
    expect(response.status).toBe(503);
    expect(auth.require).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
