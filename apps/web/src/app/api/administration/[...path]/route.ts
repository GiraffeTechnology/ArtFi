import { administrationRoute } from "@/lib/administration";
import { nativeOrderAPIURL } from "@/lib/native-order-upstream";
import {
  administrationErrorMessage,
  administrationErrorStatus,
  administrationJSON,
  administrationText,
  administrationRequestByteLimit,
  discardAdministrationBody,
  withAdministrationDeadline,
} from "@/lib/administration-transport";
import {
  assertUserRequestOrigin,
  requireUserSession,
  UserAuthError,
} from "@/lib/user-auth";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };

async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    return await withAdministrationDeadline(async (signal) => {
      const { path } = await context.params;
      signal.throwIfAborted();
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
        signal.throwIfAborted();
        upstreamHeaders.set("authorization", `Bearer ${accessToken}`);
      }
      let body: string | undefined;
      if (request.method !== "GET") {
        try {
          body = await administrationText(
            request,
            administrationRequestByteLimit,
            signal,
          );
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
        signal,
      });
      if (signal.aborted) {
        discardAdministrationBody(response);
        signal.throwIfAborted();
      }
      if (!response.ok) {
        discardAdministrationBody(response);
        const status = administrationErrorStatus(response.status);
        return Response.json(
          { detail: administrationErrorMessage(status) },
          { status, headers },
        );
      }
      const result = await administrationJSON(response, signal);
      return Response.json(result, { status: response.status, headers });
    }, request.signal);
  } catch (error) {
    const status = error instanceof UserAuthError ? error.status : 503;
    return Response.json(
      {
        detail: administrationErrorMessage(status),
      },
      { status, headers },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
