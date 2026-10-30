import { parsePortfolioRecords } from "@/lib/portfolio-records-contract";
import { isAddress } from "viem";
import {
  boundedOrderText,
  nativeOrderAPIURL,
} from "@/lib/native-order-upstream";
import { requireUserSession, UserAuthError } from "@/lib/user-auth";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };

function discardPortfolioBody(response: Response) {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    /* Already locked or cancelled. */
  }
}

/** Bound the entire read, including a session or transport that ignores abort. */
async function portfolioRead<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Portfolio read interrupted."));
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(abort, 5000);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
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
    signal.removeEventListener("abort", abort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ address: string }> },
) {
  const { address } = await context.params;
  if (!isAddress(address) || new URL(request.url).search)
    return Response.json(
      { detail: "Invalid portfolio request." },
      { status: 400, headers },
    );
  try {
    return await portfolioRead(async (signal) => {
      const { accessToken } = await requireUserSession(address);
      signal.throwIfAborted();
      const response = await fetch(
        nativeOrderAPIURL(`/v1/portfolio/${address.toLowerCase()}`),
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          cache: "no-store",
          redirect: "error",
          signal,
        },
      );
      if (signal.aborted) {
        discardPortfolioBody(response);
        signal.throwIfAborted();
      }
      if (!response.ok) {
        discardPortfolioBody(response);
        throw new Error("Portfolio unavailable.");
      }
      const data: unknown = JSON.parse(
        await boundedOrderText(response.body, 2 * 1024 * 1024, {
          signal,
          timeoutMs: 5000,
        }),
      );
      signal.throwIfAborted();
      return Response.json(parsePortfolioRecords(data, address), { headers });
    }, request.signal);
  } catch (error) {
    const status = error instanceof UserAuthError ? error.status : 503;
    return Response.json(
      {
        detail:
          status === 401 || status === 403
            ? "Sign in with this wallet to view its holdings and history."
            : "Portfolio records are unavailable.",
      },
      { status, headers },
    );
  }
}
