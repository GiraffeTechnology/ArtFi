import { timingSafeEqual } from "node:crypto";
import { bridgeToken, fail, serviceURL } from "./config.mjs";
import { readResponseJSON } from "./http-json.mjs";

// Uses ArtFi's existing server-owned wallet session API. Connecting an address
// is never login; JSON supplied by a browser is never session authority.
export function createSessionAuthenticator({
  apiURL,
  userAuthBridgeToken,
  agentBridgeToken,
  webOrigin,
  allowedChainIds = [560048],
  fetchImpl = fetch,
  clock = Date.now,
}) {
  const base = serviceURL(apiURL, "AGENT_AUTH_CONFIG_INVALID");
  const upstreamToken = bridgeToken(userAuthBridgeToken);
  const transportToken = Buffer.from(bridgeToken(agentBridgeToken));
  return async function authenticate(request) {
    const raw = request.headers.authorization;
    const provided =
      typeof raw === "string" && raw.startsWith("Bearer ")
        ? Buffer.from(raw.slice(7))
        : Buffer.alloc(0);
    if (
      provided.length !== transportToken.length ||
      !timingSafeEqual(provided, transportToken)
    )
      fail("AGENT_TRANSPORT_UNAUTHORIZED");
    if (request.headers["x-artfi-web-origin"] !== webOrigin)
      fail("AGENT_ORIGIN_REFUSED");
    const accessToken = request.headers["x-artfi-user-access"];
    if (
      typeof accessToken !== "string" ||
      accessToken.length < 32 ||
      accessToken.length > 4096 ||
      /[\r\n\0]/.test(accessToken)
    )
      fail("AUTHENTICATED_SESSION_REQUIRED");
    let response;
    try {
      response = await fetchImpl(`${base}/v1/user/auth/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${upstreamToken}`,
        },
        body: JSON.stringify({ accessToken }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      fail("SESSION_DEPENDENCY_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel();
      fail(
        [400, 401, 403].includes(response.status)
          ? "AUTHENTICATED_SESSION_REQUIRED"
          : "SESSION_DEPENDENCY_UNAVAILABLE",
      );
    }
    const result = await readResponseJSON(response, 16384);
    const session = result?.session,
      now = clock();
    if (
      !session ||
      typeof session.id !== "string" ||
      session.id.length < 1 ||
      session.id.length > 128 ||
      !/^0x[0-9a-fA-F]{40}$/.test(session.address ?? "") ||
      !allowedChainIds.includes(session.chainId) ||
      !Number.isSafeInteger(session.expiresAt) ||
      !Number.isSafeInteger(session.accessExpiresAt) ||
      session.accessExpiresAt <= now ||
      session.accessExpiresAt > session.expiresAt ||
      session.expiresAt <= now
    )
      fail("AUTHENTICATED_SESSION_REQUIRED");
    return Object.freeze({
      authenticated: true,
      id: session.id,
      wallet: session.address,
      chainId: String(session.chainId),
      expiresAt: session.accessExpiresAt,
    });
  };
}
