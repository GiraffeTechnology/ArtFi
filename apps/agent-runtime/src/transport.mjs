import { createServer } from "node:http";
import { readRequestJSON, exactInput } from "./http-json.mjs";
import { MODE, stableCode, fail } from "./config.mjs";
const id = (x) => /^[A-Za-z0-9_-]{1,128}$/.test(x);
const noStore = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
function send(response, status, body) {
  response.writeHead(status, noStore);
  response.end(JSON.stringify(body));
}
function statusFor(code) {
  if (
    ["AUTHENTICATED_SESSION_REQUIRED", "AGENT_TRANSPORT_UNAUTHORIZED"].includes(
      code,
    )
  )
    return 401;
  if (code === "AGENT_ORIGIN_REFUSED") return 403;
  if (code === "OPERATION_NOT_FOUND" || code === "AGENT_ROUTE_NOT_FOUND")
    return 404;
  if (code === "REQUEST_TOO_LARGE") return 413;
  if (code === "AGENT_RATE_LIMITED") return 429;
  if (code === "AGENT_METHOD_NOT_ALLOWED") return 405;
  if (
    /UNAVAILABLE|UNCONFIGURED|REQUIRED|TIMEOUT|DEGRADED/.test(code) &&
    code !== "JSON_CONTENT_TYPE_REQUIRED"
  )
    return 503;
  if (/CONFLICT|RESERVED|CONSUMED/.test(code)) return 409;
  return 400;
}
export function createAgentHTTPServer({
  authenticate,
  getRuntimeStatus,
  getService,
  clock = Date.now,
}) {
  if (
    [authenticate, getRuntimeStatus, getService, clock].some(
      (x) => typeof x !== "function",
    )
  )
    fail("AGENT_TRANSPORT_CONFIG_INVALID");
  const rate = new Map();
  let inFlight = 0;
  const server = createServer(async (request, response) => {
    try {
      if (
        request.headers["transfer-encoding"] &&
        request.headers["content-length"]
      )
        fail("REQUEST_JSON_INVALID");
      const parsed = new URL(request.url, "http://127.0.0.1");
      if (
        parsed.pathname === "/healthz" &&
        request.method === "GET" &&
        !parsed.search
      ) {
        const status = getRuntimeStatus();
        send(response, 200, {
          mode: status.mode,
          state: status.state,
          productionReady: false,
        });
        return;
      }
      if (inFlight >= 32) fail("AGENT_RATE_LIMITED");
      inFlight++;
      try {
        const session = await authenticate(request);
        const now = clock();
        const previous = rate.get(session.id);
        const window =
          previous && previous.until > now
            ? previous
            : { until: now + 60000, count: 0 };
        window.count++;
        rate.set(session.id, window);
        for (const [key, value] of rate)
          if (value.until <= now) rate.delete(key);
        if (rate.size > 10000 || window.count > 120) fail("AGENT_RATE_LIMITED");
        if (
          parsed.pathname === "/v1/agent/status" &&
          request.method === "GET" &&
          !parsed.search
        ) {
          send(response, 200, getRuntimeStatus());
          return;
        }
        const service = getService();
        if (!service) fail("EXECUTION_DEPENDENCY_UNAVAILABLE");
        if (
          parsed.pathname === "/v1/agent/intents/prepare" &&
          request.method === "POST" &&
          !parsed.search
        ) {
          const input = await readRequestJSON(request);
          if (
            !exactInput(input, [
              "contract",
              "tokenId",
              "maxUnitPrice",
              "validUntil",
            ])
          )
            fail("DRAFT_INPUT_INVALID");
          send(response, 200, await service.prepareIntent(session, input));
          return;
        }
        if (
          parsed.pathname === "/v1/agent/intents" &&
          request.method === "POST" &&
          !parsed.search
        ) {
          send(
            response,
            201,
            await service.createIntent(session, await readRequestJSON(request)),
          );
          return;
        }
        if (
          parsed.pathname === "/v1/agent/actions/prepare" &&
          request.method === "POST" &&
          !parsed.search
        ) {
          if (typeof service.prepareAction !== "function")
            fail("ACTION_DEPENDENCY_UNAVAILABLE");
          send(
            response,
            200,
            await service.prepareAction(
              session,
              await readRequestJSON(request),
            ),
          );
          return;
        }
        if (
          parsed.pathname === "/v1/agent/actions" &&
          request.method === "POST" &&
          !parsed.search
        ) {
          if (typeof service.createAction !== "function")
            fail("ACTION_DEPENDENCY_UNAVAILABLE");
          send(
            response,
            201,
            await service.createAction(session, await readRequestJSON(request)),
          );
          return;
        }
        const actionMatch =
          /^\/v1\/agent\/actions\/([^/]+)(?:\/(history))?$/.exec(
            parsed.pathname,
          );
        if (
          actionMatch &&
          id(actionMatch[1]) &&
          request.method === "GET" &&
          !parsed.search
        ) {
          if (typeof service.getAction !== "function")
            fail("ACTION_DEPENDENCY_UNAVAILABLE");
          send(
            response,
            200,
            actionMatch[2]
              ? await service.actionHistory(session, actionMatch[1])
              : await service.getAction(session, actionMatch[1]),
          );
          return;
        }
        const match =
          /^\/v1\/agent\/intents\/([^/]+)(?:\/(history|revocations))?$/.exec(
            parsed.pathname,
          );
        if (!match || !id(match[1])) fail("AGENT_ROUTE_NOT_FOUND");
        if (request.method === "GET" && !match[2] && !parsed.search) {
          send(response, 200, await service.getIntent(session, match[1]));
          return;
        }
        if (request.method === "GET" && match[2] === "history") {
          if (
            [...parsed.searchParams.keys()].some(
              (k) => !["after", "limit"].includes(k),
            ) ||
            [...parsed.searchParams.keys()].some(
              (k) => parsed.searchParams.getAll(k).length !== 1,
            )
          )
            fail("AUDIT_PAGE_INVALID");
          const after = parsed.searchParams.get("after") ?? "0",
            limit = parsed.searchParams.get("limit") ?? "50";
          if (
            !/^(0|[1-9][0-9]{0,19})$/.test(after) ||
            !/^[1-9][0-9]{0,2}$/.test(limit) ||
            Number(limit) > 100
          )
            fail("AUDIT_PAGE_INVALID");
          send(
            response,
            200,
            await service.getHistory(session, match[1], {
              after,
              limit: Number(limit),
            }),
          );
          return;
        }
        if (
          request.method === "POST" &&
          match[2] === "revocations" &&
          !parsed.search
        ) {
          const input = await readRequestJSON(request);
          if (!exactInput(input, ["transactionHash"]))
            fail("REVOCATION_HASH_INVALID");
          send(
            response,
            200,
            await service.recordRevocation(
              session,
              match[1],
              input.transactionHash,
            ),
          );
          return;
        }
        fail("AGENT_METHOD_NOT_ALLOWED");
      } finally {
        inFlight--;
      }
    } catch (error) {
      if (!response.headersSent)
        send(response, statusFor(stableCode(error)), {
          code: stableCode(error),
          mode: getRuntimeStatus().mode,
        });
      else response.destroy();
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 32;
  return server;
}
