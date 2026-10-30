import { describe, expect, it, vi } from "vitest";
import {
  browserNotificationTransport,
  maximumNotificationResponseBytes,
  notificationJSON,
  notificationText,
  notificationRoute,
  notificationSessionMatches,
} from "./notification-transport";
import { NotificationRequestError } from "./notification-inbox-state";

const identity = {
  address: "0x" + "1".repeat(40),
  chainId: 560048,
  sessionId: "a".repeat(32),
  expiresAt: 4000000000000,
};
describe("notification transport boundaries", () => {
  it("never treats a matching wallet alone as the same session", () => {
    const current = {
      address: identity.address,
      chainId: identity.chainId,
      id: identity.sessionId,
    };
    expect(notificationSessionMatches(identity, current)).toBe(true);
    for (const changed of [
      { ...current, address: "0x" + "2".repeat(40) },
      { ...current, chainId: 1 },
      { ...current, id: "b".repeat(32) },
    ])
      expect(notificationSessionMatches(identity, changed)).toBe(false);
  });
  it.each([
    [["inbox"], "POST"],
    [["read"], "GET"],
    [["preferences"], "POST"],
    [["inbox", "read"], "POST"],
    [["..", "inbox"], "GET"],
  ])("rejects unsupported route/method combinations %j %s", (path, method) => {
    expect(
      notificationRoute(path as string[], method as string),
    ).toBeUndefined();
  });
  it("cancels oversized streamed responses before parsing", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(maximumNotificationResponseBytes + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(notificationJSON(new Response(stream))).rejects.toThrow(
      "too large",
    );
    expect(cancelled).toBe(true);
  });
  it("rejects malformed UTF8 and malformed JSON", async () => {
    await expect(
      notificationJSON(new Response(new Uint8Array([0xff]))),
    ).rejects.toThrow();
    await expect(notificationJSON(new Response("{"))).rejects.toThrow();
  });
  it("sends the captured full principal and exact request key without exposing a bearer", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }));
    const transport = browserNotificationTransport(request);
    const input = {
      id: "b".repeat(32),
      expectedSourceRevision: "18446744073709551615",
    };
    await transport.markRead(
      identity,
      input,
      "exact-request-key-01",
      new AbortController().signal,
    );
    const [url, options] = request.mock.calls[0];
    expect(url).toBe("/api/notifications/read");
    expect(options).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify(input),
    });
    const headers = new Headers(options?.headers);
    expect(headers.get("x-artfi-session")).toBe(identity.sessionId);
    expect(headers.get("x-artfi-wallet")).toBe(identity.address);
    expect(headers.get("x-artfi-chain")).toBe("560048");
    expect(headers.get("idempotency-key")).toBe("exact-request-key-01");
    expect(headers.has("authorization")).toBe(false);
  });
  it("preserves conflict classification and never retries an ambiguous write", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private error", { status: 409 }));
    const transport = browserNotificationTransport(request);
    await expect(
      transport.markRead(
        identity,
        { id: "b".repeat(32), expectedSourceRevision: "1" },
        "exact-request-key-02",
        new AbortController().signal,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<NotificationRequestError>>({
        status: 409,
      }),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function notificationChunks(
  chunks: Uint8Array[],
  cancel: () => void | Promise<void> = () => undefined,
) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel,
  });
}

describe("notification stream progress", () => {
  const bytes = (value: string) => new TextEncoder().encode(value);
  const empty = () => new Uint8Array();
  const afterEmptyBudget = () => [
    ...Array.from({ length: 65 }, empty),
    ...Array.from({ length: 8 }, () => bytes(" ")),
    bytes("{}"),
  ];

  it("preserves split UTF8 after the allowed empty-read budget", async () => {
    const value = { label: "Café 🧭" };
    const stream = notificationChunks([
      ...Array.from({ length: 64 }, empty),
      ...Array.from(bytes(JSON.stringify(value)), (byte) =>
        Uint8Array.of(byte),
      ),
    ]);
    await expect(notificationJSON(new Response(stream))).resolves.toEqual(
      value,
    );
    expect(stream.locked).toBe(false);
  });

  it("rejects excessive empty reads without waiting for cancellation", async () => {
    const cancelled = vi.fn(() => new Promise<void>(() => undefined));
    const stream = notificationChunks(afterEmptyBudget(), cancelled);
    await expect(notificationJSON(new Response(stream))).rejects.toThrow(
      "made no progress",
    );
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it("cannot reset the empty-read budget with intermittent bytes", async () => {
    const stream = notificationChunks([
      ...Array.from({ length: 65 }, () => [empty(), bytes(" ")]).flat(),
      ...Array.from({ length: 8 }, () => bytes(" ")),
      bytes("{}"),
    ]);
    await expect(notificationJSON(new Response(stream))).rejects.toThrow(
      "made no progress",
    );
    expect(stream.locked).toBe(false);
  });

  it("applies the progress budget to bounded request bodies too", async () => {
    const stream = notificationChunks(afterEmptyBudget());
    await expect(
      notificationText(stream, 4_096, new AbortController().signal),
    ).rejects.toThrow("made no progress");
    expect(stream.locked).toBe(false);
  });

  it("retains the exact positive-byte response limit", async () => {
    const stream = notificationChunks([
      bytes(" ".repeat(maximumNotificationResponseBytes - 2)),
      bytes("{}"),
    ]);
    await expect(notificationJSON(new Response(stream))).resolves.toEqual({});
  });

  it.each(["markRead", "savePreferences"] as const)(
    "does not replay %s when its acknowledgement stream has no progress",
    async (method) => {
      const stream = notificationChunks(afterEmptyBudget());
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(stream));
      const transport = browserNotificationTransport(request);
      const key = "unchanged-request-key-03";
      const signal = new AbortController().signal;
      const operation =
        method === "markRead"
          ? transport.markRead(
              identity,
              { id: "b".repeat(32), expectedSourceRevision: "1" },
              key,
              signal,
            )
          : transport.savePreferences(
              identity,
              {
                revision: "0",
                transactionAlerts: true,
                systemMessageAlerts: false,
              },
              key,
              signal,
            );
      await expect(operation).rejects.toThrow("made no progress");
      expect(request).toHaveBeenCalledTimes(1);
      expect(
        new Headers(request.mock.calls[0][1]?.headers).get("idempotency-key"),
      ).toBe(key);
      expect(stream.locked).toBe(false);
    },
  );
});
