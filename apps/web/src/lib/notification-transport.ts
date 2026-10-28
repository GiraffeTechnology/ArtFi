import {
  NotificationRequestError,
  type NotificationIdentity,
  type NotificationTransport,
} from "./notification-inbox-state";

export const maximumNotificationResponseBytes = 196_608;

/** Bound settlement even when a transport or stream ignores cancellation.
 * A timed-out mutation has an unknown result and must never be retried here. */
export async function withNotificationDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 12_000,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12_000)
    throw new RangeError("Invalid notification deadline.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  let interrupted: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    interrupted = () => reject(new Error("Notification request interrupted."));
    controller.signal.addEventListener("abort", interrupted, { once: true });
  });
  const timer = setTimeout(abort, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      stopped,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (interrupted)
      controller.signal.removeEventListener("abort", interrupted);
  }
}

/** Cleanup cannot hold the caller's result or expose an upstream error. */
export function discardNotificationBody(response: Response) {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // The body may already be locked or cancelled.
  }
}

/** Bound bytes before parsing. No response, wallet identity or token is persisted. */
export async function notificationText(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > maximumNotificationResponseBytes
  )
    throw new RangeError("Invalid notification body limit.");
  signal.throwIfAborted();
  const reader = body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  let ended = false;
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Notification read interrupted."));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      signal.throwIfAborted();
      if (done) {
        ended = true;
        break;
      }
      size += value.byteLength;
      if (size > maximumBytes) {
        throw new Error("The notification response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (!ended) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function notificationJSON(
  response: Response,
  signal: AbortSignal = AbortSignal.timeout(12_000),
): Promise<unknown> {
  if (!response.body) throw new Error("Notifications are unavailable.");
  return JSON.parse(
    await notificationText(
      response.body,
      maximumNotificationResponseBytes,
      signal,
    ),
  );
}

export function notificationRoute(path: string[], method: string) {
  const joined = path.join("/");
  if (joined === "inbox" && method === "GET") return "/v1/user/notifications";
  if (joined === "read" && method === "POST")
    return "/v1/user/notifications/read";
  if (joined === "preferences" && ["GET", "PUT"].includes(method))
    return "/v1/user/notification-preferences";
  return undefined;
}

export function notificationSessionMatches(
  expected: Pick<NotificationIdentity, "address" | "chainId" | "sessionId">,
  actual: { address: string; chainId: number; id: string },
) {
  return (
    expected.address === actual.address.toLowerCase() &&
    expected.chainId === actual.chainId &&
    expected.sessionId === actual.id
  );
}

export function browserNotificationTransport(
  request: typeof fetch = fetch,
): NotificationTransport {
  const call = (
    route: string,
    identity: NotificationIdentity,
    signal: AbortSignal,
    method = "GET",
    body?: unknown,
    key?: string,
  ) =>
    withNotificationDeadline(async (requestSignal) => {
      const headers: Record<string, string> = {
        "x-artfi-wallet": identity.address,
        "x-artfi-chain": String(identity.chainId),
        "x-artfi-session": identity.sessionId,
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (key) headers["idempotency-key"] = key;
      const response = await request(`/api/notifications/${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: requestSignal,
      });
      if (requestSignal.aborted) {
        discardNotificationBody(response);
        requestSignal.throwIfAborted();
      }
      if (!response.ok) {
        discardNotificationBody(response);
        throw new NotificationRequestError(response.status);
      }
      return notificationJSON(response, requestSignal);
    }, signal);
  return {
    list: (identity, signal) => call("inbox", identity, signal),
    markRead: (identity, input, key, signal) =>
      call("read", identity, signal, "POST", input, key),
    savePreferences: (identity, input, key, signal) =>
      call("preferences", identity, signal, "PUT", input, key),
  };
}
