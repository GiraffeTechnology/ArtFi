import { isAddress } from "viem";
import {
  administrationText,
  discardAdministrationBody,
  withAdministrationDeadline,
} from "@/lib/administration-transport";
import { nativeOrderAPIURL } from "@/lib/native-order-upstream";
import {
  portfolioPublicationByteLimit,
  portfolioPublicationQuery,
  readPortfolioPublicationFilter,
  readPortfolioPublicationPage,
  type PortfolioPublicationFilter,
} from "@/lib/portfolio-publications";
import { requireUserSession, UserAuthError } from "@/lib/user-auth";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };

/** Authenticated personal-center view of the existing public native index.
 * The seller and chain are fixed by the original session/path, never a filter. */
export async function GET(
  request: Request,
  context: { params: Promise<{ address: string }> },
) {
  const { address } = await context.params;
  let filter: PortfolioPublicationFilter;
  try {
    if (!isAddress(address)) throw new Error("Invalid address");
    filter = readPortfolioPublicationFilter(new URL(request.url).searchParams);
  } catch {
    return Response.json(
      { detail: "Invalid publication history filters." },
      { status: 400, headers },
    );
  }
  try {
    return await withAdministrationDeadline(async (signal) => {
      await requireUserSession(address);
      signal.throwIfAborted();
      const query = portfolioPublicationQuery(address, filter);
      const response = await fetch(nativeOrderAPIURL(`/v1/orders?${query}`), {
        headers: { accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal,
      });
      if (signal.aborted) {
        discardAdministrationBody(response);
        signal.throwIfAborted();
      }
      try {
        if (
          !response.ok ||
          response.redirected ||
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          )
        )
          throw new Error("Publication index unavailable");
        const value: unknown = JSON.parse(
          await administrationText(
            response,
            portfolioPublicationByteLimit,
            signal,
          ),
        );
        return Response.json(
          readPortfolioPublicationPage(value, address, filter),
          { headers },
        );
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
            ? "Sign in with this wallet to view its published sale records."
            : "Published sale records are unavailable.",
      },
      { status, headers },
    );
  }
}
