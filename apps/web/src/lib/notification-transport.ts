import {
  NotificationRequestError,
  type NotificationIdentity,
  type NotificationTransport,
} from "./notification-inbox-state";

export const maximumNotificationResponseBytes = 196_608;

/** Bound bytes before parsing. No response, wallet identity or token is persisted. */
export async function notificationJSON(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Notifications are unavailable.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumNotificationResponseBytes) {
        await reader.cancel();
        throw new Error("The notification response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
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
  const call = async (
    route: string,
    identity: NotificationIdentity,
    signal: AbortSignal,
    method = "GET",
    body?: unknown,
    key?: string,
  ) => {
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
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new NotificationRequestError(response.status);
    }
    return notificationJSON(response);
  };
  return {
    list: (identity, signal) => call("inbox", identity, signal),
    markRead: (identity, input, key, signal) =>
      call("read", identity, signal, "POST", input, key),
    savePreferences: (identity, input, key, signal) =>
      call("preferences", identity, signal, "PUT", input, key),
  };
}
