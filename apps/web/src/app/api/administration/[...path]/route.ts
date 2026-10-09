import { administrationRoute } from "@/lib/administration";
import {
  boundedOrderText,
  nativeOrderAPIURL,
} from "@/lib/native-order-upstream";
import {
  assertUserRequestOrigin,
  requireUserSession,
  UserAuthError,
} from "@/lib/user-auth";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const messages: Record<number, string> = {
  400: "The moderation request contains unsupported fields or parameters.",
  401: "Sign in again with the current wallet.",
  403: "This wallet does not have the required permission.",
  404: "The record was not found or is not available to this wallet.",
  409: "The record changed or this action was already completed. Refresh before trying again.",
  413: "The request is too large.",
  422: "Check the required fields, explanation length and selected action.",
};

async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await context.params;
    const route = administrationRoute(path, request.method);
    if (!route)
      return Response.json(
        { detail: "Unknown administration route." },
        { status: 404, headers },
      );
    if (request.method !== "GET") assertUserRequestOrigin(request);
    const upstreamHeaders = new Headers();
    if (route.private) {
      const wallet = request.headers.get("x-artfi-wallet") || "";
      const chain = Number(request.headers.get("x-artfi-chain"));
      if (!Number.isSafeInteger(chain) || chain <= 0)
        throw new UserAuthError(401, "A current wallet session is required.");
      const { accessToken } = await requireUserSession(wallet, chain);
      upstreamHeaders.set("authorization", `Bearer ${accessToken}`);
    }
    let body: string | undefined;
    if (request.method !== "GET") {
      try {
        body = await boundedOrderText(request.body, 16_384);
      } catch {
        throw new UserAuthError(413, "The request is too large or invalid.");
      }
      upstreamHeaders.set("content-type", "application/json");
      const key = request.headers.get("idempotency-key") || "";
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(key))
        return Response.json(
          { detail: "A valid request key is required." },
          { status: 400, headers },
        );
      upstreamHeaders.set("idempotency-key", key);
    }
    const url = nativeOrderAPIURL(route.upstream);
    url.search = new URL(request.url).search;
    const response = await fetch(url, {
      method: request.method,
      headers: upstreamHeaders,
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const status = messages[response.status] ? response.status : 503;
      return Response.json(
        {
          detail:
            messages[status] ||
            "Durable administration records are unavailable. No change was confirmed.",
        },
        { status, headers },
      );
    }
    return Response.json(
      JSON.parse(await boundedOrderText(response.body, 2 * 1024 * 1024)),
      { status: response.status, headers },
    );
  } catch (error) {
    const status = error instanceof UserAuthError ? error.status : 503;
    return Response.json(
      {
        detail:
          messages[status] ||
          "Administration is unavailable. No change was confirmed; retry the same request when available.",
      },
      { status, headers },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
