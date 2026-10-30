import { NextResponse } from "next/server";

/** Bound this read-only proof; late or cancelled reads never issue a new grant. */
export async function holderVerificationResponse(
  request: Request,
  operation: (signal: AbortSignal) => Promise<Response>,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Holder verification interrupted."));
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(abort, 8000);
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      stopped,
    ]);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json(
      { detail: "Charity holder verification is unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}
