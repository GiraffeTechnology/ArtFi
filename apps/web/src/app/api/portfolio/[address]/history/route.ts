import { isAddress } from "viem";
import {
  administrationText,
  discardAdministrationBody,
  withAdministrationDeadline,
} from "@/lib/administration-transport";
import { nativeOrderAPIURL } from "@/lib/native-order-upstream";
import {
  indexedHistoryByteLimit,
  indexedHistoryQuery,
  readIndexedHistoryFilter,
  readIndexedHistoryPage,
  type IndexedHistoryFilter,
} from "@/lib/portfolio-indexed-history";
import { requireUserSession, UserAuthError } from "@/lib/user-auth";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
export async function GET(
  request: Request,
  context: { params: Promise<{ address: string }> },
) {
  const { address } = await context.params;
  let filter: IndexedHistoryFilter;
  try {
    if (!isAddress(address)) throw new Error("Invalid address");
    filter = readIndexedHistoryFilter(new URL(request.url).searchParams);
  } catch {
    return Response.json(
      { detail: "Invalid indexed history filters." },
      { status: 400, headers },
    );
  }
  try {
    return await withAdministrationDeadline(async (signal) => {
      const { accessToken } = await requireUserSession(address);
      signal.throwIfAborted();
      const upstream = nativeOrderAPIURL(
        `/v1/portfolio/${address.toLowerCase()}/history?${indexedHistoryQuery(filter)}`,
      );
      const response = await fetch(upstream, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        cache: "no-store",
        redirect: "error",
        signal,
      });
      if (signal.aborted) {
        discardAdministrationBody(response);
        signal.throwIfAborted();
      }
      try {
        if (response.status === 401 || response.status === 403)
          return Response.json(
            { detail: "Sign in with this wallet to read its indexed history." },
            { status: response.status, headers },
          );
        if (
          !response.ok ||
          response.redirected ||
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          )
        )
          throw new Error("History read unavailable");
        const value: unknown = JSON.parse(
          await administrationText(response, indexedHistoryByteLimit, signal),
        );
        return Response.json(readIndexedHistoryPage(value, address, filter), {
          headers,
        });
      } finally {
        if (!response.bodyUsed) discardAdministrationBody(response);
      }
    }, request.signal);
  } catch (error) {
    const status = error instanceof UserAuthError ? error.status : 503;
    return Response.json(
      {
        detail:
          status === 401 || status === 403
            ? "Sign in with this wallet to read its indexed history."
            : "Indexed transaction history is unavailable.",
      },
      { status, headers },
    );
  }
}
