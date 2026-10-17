import {
  boundedOrderText,
  nativeOrderAPIURL,
} from "@/lib/native-order-upstream";
import {
  notificationJSON,
  notificationRoute,
  notificationSessionMatches,
} from "@/lib/notification-transport";
import {
  parseNotificationPage,
  parseNotificationPreferences,
} from "@/lib/notification-inbox-state";
import {
  assertUserRequestOrigin,
  requireUserSession,
  UserAuthError,
} from "@/lib/user-auth";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const messages: Record<number, string> = {
  400: "The notification request contains unsupported fields or parameters.",
  401: "Sign in again with the current wallet.",
  403: "The request origin or wallet session does not match.",
  404: "The notification is not available to this wallet.",
  409: "The source or preferences changed. Refresh to reconcile current state.",
  413: "The notification request is too large.",
  422: "The current revision and explicit preferences are required.",
};

async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await context.params;
    const upstream = notificationRoute(path, request.method);
    if (!upstream)
      return Response.json(
        { detail: "Unknown notification route." },
        { status: 404, headers },
      );
    if (new URL(request.url).search)
      throw new UserAuthError(400, messages[400]);
    if (request.method !== "GET") assertUserRequestOrigin(request);
    const address = request.headers.get("x-artfi-wallet") || "";
    const rawChain = request.headers.get("x-artfi-chain") || "";
    const sessionId = request.headers.get("x-artfi-session") || "";
    const chainId = Number(rawChain);
    if (
      !/^0x[0-9a-f]{40}$/.test(address) ||
      !/^[1-9][0-9]{0,15}$/.test(rawChain) ||
      !Number.isSafeInteger(chainId) ||
      !/^[0-9a-f]{32}$/.test(sessionId)
    )
      throw new UserAuthError(401, messages[401]);
    const expected = { address, chainId, sessionId };
    // Browser binding headers select the displayed principal; they never
    // authenticate it. Only the existing HTTP-only cookie/session bridge does.
    const bound = await requireUserSession(address, chainId);
    if (!notificationSessionMatches(expected, bound.session))
      throw new UserAuthError(401, messages[401]);
    const identity = {
      ...expected,
      expiresAt: Math.min(
        bound.session.expiresAt,
        bound.session.accessExpiresAt,
      ),
    };
    let body: string | undefined;
    const upstreamHeaders = new Headers({
      authorization: `Bearer ${bound.accessToken}`,
    });
    if (request.method !== "GET") {
      if (
        request.headers.get("content-type")?.split(";")[0].trim() !==
        "application/json"
      )
        throw new UserAuthError(400, messages[400]);
      body = await boundedOrderText(request.body, 4096).catch(() => {
        throw new UserAuthError(413, messages[413]);
      });
      const key = request.headers.get("idempotency-key") || "";
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(key))
        throw new UserAuthError(400, messages[400]);
      upstreamHeaders.set("content-type", "application/json");
      upstreamHeaders.set("idempotency-key", key);
    }
    const response = await fetch(nativeOrderAPIURL(upstream), {
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
            "Notification state is unavailable. Refresh before acting.",
        },
        { status, headers },
      );
    }
    const data = await notificationJSON(response);
    const result =
      request.method === "GET" && path.join("/") === "preferences"
        ? parseNotificationPreferences(data)
        : parseNotificationPage(data, identity);
    const current = await requireUserSession(address, chainId);
    if (
      !notificationSessionMatches(expected, current.session) ||
      Date.now() >= identity.expiresAt
    )
      throw new UserAuthError(401, messages[401]);
    return Response.json(result, { status: 200, headers });
  } catch (error) {
    const status = error instanceof UserAuthError ? error.status : 503;
    return Response.json(
      {
        detail:
          messages[status] ||
          "Notifications are unavailable. No change was confirmed; refresh to reconcile.",
      },
      { status, headers },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
