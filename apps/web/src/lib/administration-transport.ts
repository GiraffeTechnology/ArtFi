/** Shared browser/server transfer bounds; no session or authorization logic. */
export const administrationRequestTimeoutMs = 8_000;
export const administrationResponseByteLimit = 2 * 1024 * 1024;
export const administrationRequestByteLimit = 16_384;
const messages: Record<number, string> = {
  400: "The moderation request contains unsupported fields or parameters.",
  401: "Sign in again with the current wallet.",
  403: "This wallet does not have the required permission.",
  404: "The record was not found or is not available to this wallet.",
  409: "The record changed or this action was already completed. Refresh before trying again.",
  413: "The request is too large.",
  422: "Check the required fields, explanation length and selected action.",
};
export function administrationErrorMessage(status: number) {
  return (
    messages[status] ||
    "Administration is unavailable. No change was confirmed; retry the same request when available."
  );
}
export function administrationErrorStatus(status: number) {
  return Object.hasOwn(messages, status) ? status : 503;
}
export function discardAdministrationBody(message: Request | Response) {
  try {
    void message.body?.cancel().catch(() => undefined);
  } catch {
    /* Already locked or cancelled. */
  }
}
/** Bound the whole operation, including headers and streams that ignore abort.
 * Cancellation retires this result, never proves that a mutation did not occur. */
export async function withAdministrationDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(administrationErrorMessage(503)));
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(abort, administrationRequestTimeoutMs);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
    // Retire any late continuation without awaiting a hostile cleanup hook.
    controller.abort();
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}
export async function administrationText(
  message: Request | Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > administrationResponseByteLimit
  )
    throw new RangeError("Invalid administration response bound.");
  signal.throwIfAborted();
  const reader = message.body?.getReader();
  if (!reader) throw new Error(administrationErrorMessage(503));
  let ended = false,
    size = 0;
  let onAbort: (() => void) | undefined;
  const parts: string[] = [];
  try {
    const declared = message.headers.get("content-length");
    if (
      declared !== null &&
      (!/^[0-9]+$/.test(declared) || BigInt(declared) > BigInt(limit))
    )
      throw new Error(administrationErrorMessage(503));
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(administrationErrorMessage(503)));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (;;) {
      const item = await Promise.race([reader.read(), interrupted]);
      signal.throwIfAborted();
      if (item.done) {
        ended = true;
        break;
      }
      size += item.value.byteLength;
      if (size > limit) throw new Error(administrationErrorMessage(503));
      parts.push(decoder.decode(item.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (!ended) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        /* Best effort. */
      }
    }
    reader.releaseLock();
  }
}
export async function administrationJSON(
  message: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    message.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    discardAdministrationBody(message);
    throw new Error(administrationErrorMessage(503));
  }
  return JSON.parse(
    await administrationText(message, administrationResponseByteLimit, signal),
  );
}
