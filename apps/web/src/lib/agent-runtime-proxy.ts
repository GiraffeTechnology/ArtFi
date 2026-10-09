import { isSessionChain } from "@/lib/auth-chains";
import "server-only";
import { boundedOrderText } from "@/lib/native-order-upstream";
import {
  assertUserRequestOrigin,
  requireUserSession,
  userAuthOrigin,
  UserAuthError,
} from "@/lib/user-auth";

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const mode = "TEST_ONLY_NO_REAL_VALUE";
export function agentRoute(path: string[], method: string) {
  if (path.some((segment) => !/^[A-Za-z0-9_-]{1,128}$/.test(segment)))
    return undefined;
  const route = path.join("/");
  if (
    (method === "GET" && route === "status") ||
    (method === "POST" &&
      ["intents", "intents/prepare", "actions", "actions/prepare"].includes(
        route,
      )) ||
    (["intents", "actions"].includes(path[0]) &&
      path.length === 2 &&
      method === "GET") ||
    (["intents", "actions"].includes(path[0]) &&
      path.length === 3 &&
      ((path[2] === "history" && method === "GET") ||
        (path[0] === "intents" &&
          path[2] === "revocations" &&
          method === "POST")))
  )
    return route;
  return undefined;
}
export function agentRuntimeURL(route: string) {
  const url = new URL(process.env.ARTFI_AGENT_API_URL?.trim() || "");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("AGENT_RUNTIME_UNCONFIGURED");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/agent/${route}`;
  return url;
}
export async function agentRuntimeProxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await context.params;
    const route = agentRoute(path, request.method);
    if (!route)
      return Response.json(
        { code: "AGENT_ROUTE_NOT_FOUND", mode },
        { status: 404, headers: responseHeaders },
      );
    if (request.method !== "GET") assertUserRequestOrigin(request);
    if (request.headers.get("sec-fetch-site") === "cross-site")
      throw new UserAuthError(403, "Origin refused.");
    const wallet = request.headers.get("x-artfi-wallet") || "";
    const chainId = Number(request.headers.get("x-artfi-chain"));
    if (!isSessionChain(chainId))
      throw new UserAuthError(401, "A supported wallet session is required.");
    const { accessToken } = await requireUserSession(wallet, chainId);
    const bridge = process.env.ARTFI_AGENT_BRIDGE_TOKEN?.trim() || "";
    if (
      Buffer.byteLength(bridge) < 32 ||
      Buffer.byteLength(bridge) > 4096 ||
      /[\r\n\0]/.test(bridge)
    )
      throw new Error("AGENT_RUNTIME_UNCONFIGURED");
    const url = agentRuntimeURL(route);
    const params = new URL(request.url).searchParams;
    if (params.size && !route.endsWith("/history"))
      return Response.json(
        { code: "AGENT_QUERY_INVALID", mode },
        { status: 400, headers: responseHeaders },
      );
    for (const key of params.keys())
      if (!["after", "limit"].includes(key) || params.getAll(key).length !== 1)
        return Response.json(
          { code: "AGENT_QUERY_INVALID", mode },
          { status: 400, headers: responseHeaders },
        );
    url.search = params.toString();
    let body: string | undefined;
    if (request.method === "POST") {
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          request.headers.get("content-type") || "",
        )
      )
        throw new UserAuthError(400, "JSON required.");
      try {
        body = await boundedOrderText(request.body, 32_768);
        JSON.parse(body);
      } catch {
        throw new UserAuthError(413, "Invalid or oversized request.");
      }
    }
    const upstream = await fetch(url, {
      method: request.method,
      body,
      headers: {
        authorization: `Bearer ${bridge}`,
        "x-artfi-user-access": accessToken,
        "x-artfi-web-origin": userAuthOrigin(new URL(request.url).origin),
        "content-type": "application/json",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      const status = [400, 401, 403, 404, 409, 413, 429].includes(
        upstream.status,
      )
        ? upstream.status
        : 503;
      return Response.json(
        {
          code:
            status === 401
              ? "AUTHENTICATED_SESSION_REQUIRED"
              : status === 404
                ? "OPERATION_NOT_FOUND"
                : status === 409
                  ? "IMMUTABLE_REQUEST_CONFLICT"
                  : "AGENT_RUNTIME_UNAVAILABLE",
          mode,
        },
        { status, headers: responseHeaders },
      );
    }
    const result = JSON.parse(await boundedOrderText(upstream.body, 131_072));
    return Response.json(result, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const status = error instanceof UserAuthError ? error.status : 503;
    return Response.json(
      {
        code:
          status === 401 || status === 403
            ? "AUTHENTICATED_SESSION_REQUIRED"
            : "AGENT_RUNTIME_UNAVAILABLE",
        mode,
      },
      { status, headers: responseHeaders },
    );
  }
}
