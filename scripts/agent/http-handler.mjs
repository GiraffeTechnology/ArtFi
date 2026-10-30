const plain = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const fail = (code) => {
  throw Error(code);
};
const headers = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});
const stableCode = (error) =>
  /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message ?? "")
    ? error.message
    : "DEPENDENCY_UNAVAILABLE";
const statusFor = (code) => {
  if (code === "AUTHENTICATED_SESSION_REQUIRED") return 401;
  if (code === "OPERATION_NOT_FOUND" || code === "ROUTE_NOT_FOUND") return 404;
  if (code === "IMMUTABLE_REQUEST_CONFLICT") return 409;
  if (code === "REQUEST_TOO_LARGE") return 413;
  if (code === "HANDLER_RESPONSE_INVALID") return 502;
  if (
    code === "DEPENDENCY_UNAVAILABLE" ||
    /^(SOURCE|STORE|DATABASE|RPC)_/.test(code)
  )
    return 503;
  if (
    /(_INVALID|_REQUIRED)$/.test(code) ||
    /^(CREATE_SCHEMA|DRAFT_INPUT|OPERATION_ID)_/.test(code)
  )
    return 400;
  return 403;
};

function response(status, value) {
  if (!plain(value)) fail("HANDLER_RESPONSE_INVALID");
  return Object.freeze({
    status,
    headers,
    body: JSON.stringify(value),
  });
}

function exactKeys(value, keys) {
  return (
    plain(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseBody(request, maxRequestBytes) {
  if (
    typeof request.contentType !== "string" ||
    !/^application\/json(?:;|$)/i.test(request.contentType) ||
    typeof request.bodyText !== "string"
  )
    fail("REQUEST_SCHEMA_INVALID");
  if (new TextEncoder().encode(request.bodyText).byteLength > maxRequestBytes)
    fail("REQUEST_TOO_LARGE");
  let value;
  try {
    value = JSON.parse(request.bodyText);
  } catch {
    fail("REQUEST_SCHEMA_INVALID");
  }
  if (!plain(value)) fail("REQUEST_SCHEMA_INVALID");
  return value;
}

export function createAgentHttpHandler({
  service,
  maxRequestBytes = 64 * 1024,
}) {
  if (
    !service ||
    ["prepareIntent", "createIntent", "getIntent", "recordRevocation"].some(
      (name) => typeof service[name] !== "function",
    ) ||
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes < 1024 ||
    maxRequestBytes > 1024 * 1024
  )
    fail("HTTP_HANDLER_CONFIGURATION_INVALID");
  const prepare = service.prepareIntent.bind(service);
  const create = service.createIntent.bind(service);
  const get = service.getIntent.bind(service);
  const record = service.recordRevocation.bind(service);

  return async function handle(request, session) {
    try {
      if (
        !plain(request) ||
        !["GET", "POST"].includes(request.method) ||
        typeof request.path !== "string" ||
        request.path.includes("?") ||
        request.path.includes("#")
      )
        fail("REQUEST_SCHEMA_INVALID");
      if (request.method === "POST" && request.path === "/intents/prepare") {
        const input = parseBody(request, maxRequestBytes);
        if (
          !exactKeys(input, [
            "contract",
            "tokenId",
            "maxUnitPrice",
            "validUntil",
          ]) ||
          Object.values(input).some((value) => typeof value !== "string")
        )
          fail("REQUEST_SCHEMA_INVALID");
        return response(200, await prepare(session, structuredClone(input)));
      }
      if (request.method === "POST" && request.path === "/intents") {
        const input = parseBody(request, maxRequestBytes);
        return response(200, await create(session, structuredClone(input)));
      }
      const read = request.path.match(/^\/intents\/([A-Za-z0-9_-]{1,128})$/);
      if (request.method === "GET" && read) {
        if (request.bodyText !== undefined && request.bodyText !== "")
          fail("REQUEST_SCHEMA_INVALID");
        return response(200, await get(session, read[1]));
      }
      const revocation = request.path.match(
        /^\/intents\/([A-Za-z0-9_-]{1,128})\/revocation$/,
      );
      if (request.method === "POST" && revocation) {
        const input = parseBody(request, maxRequestBytes);
        if (
          !exactKeys(input, ["transactionHash"]) ||
          typeof input.transactionHash !== "string"
        )
          fail("REQUEST_SCHEMA_INVALID");
        return response(
          200,
          await record(session, revocation[1], input.transactionHash),
        );
      }
      fail("ROUTE_NOT_FOUND");
    } catch (error) {
      const code = stableCode(error);
      return response(statusFor(code), { error: code });
    }
  };
}
