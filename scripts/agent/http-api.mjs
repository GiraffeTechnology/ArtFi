const operationId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const transactionHash = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code) => {
  throw Error(code);
};
const states = new Set([
  "PREPARED",
  "STARTED",
  "SUBMITTED",
  "CONFIRMED",
  "UNKNOWN",
  "RECONCILING",
  "SAFE_DEGRADED",
  "SETTLED",
  "TERMINAL_REJECTED",
]);

function responseFailure(status) {
  if (status === 401) return "AUTHENTICATED_SESSION_REQUIRED";
  if (status === 403) return "AUTHORIZATION_REFUSED";
  if (status === 409) return "REQUEST_CONFLICT";
  if (status === 429) return "DEPENDENCY_RATE_LIMITED";
  if (status >= 500) return "DEPENDENCY_UNAVAILABLE";
  return "HTTP_REQUEST_REFUSED";
}

function sameOriginPath(path) {
  if (
    typeof path !== "string" ||
    !/^\/[A-Za-z0-9/_-]+$/.test(path) ||
    path.includes("//") ||
    path.endsWith("/") ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    fail("HTTP_API_CONFIGURATION_INVALID");
  return path;
}

export function createAgentHttpApi({
  fetchImpl,
  basePath,
  requestTimeoutMs = 5000,
  maxResponseBytes = 1024 * 1024,
}) {
  if (
    typeof fetchImpl !== "function" ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 10 ||
    requestTimeoutMs > 30000 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1024 ||
    maxResponseBytes > 4 * 1024 * 1024
  )
    fail("HTTP_API_CONFIGURATION_INVALID");
  const base = sameOriginPath(basePath);

  async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (
      payload !== undefined &&
      new TextEncoder().encode(payload).byteLength > 64 * 1024
    )
      fail("HTTP_REQUEST_TOO_LARGE");
    let response;
    let text;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          accept: "application/json",
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: payload }),
        signal: controller.signal,
      });
      if (
        !response ||
        !Number.isInteger(response.status) ||
        typeof response.headers?.get !== "function" ||
        typeof response.text !== "function"
      )
        fail("HTTP_RESPONSE_INVALID");
      if (!response.ok) fail(responseFailure(response.status));
      const contentType = response.headers.get("content-type") ?? "";
      if (!/^application\/json(?:;|$)/i.test(contentType))
        fail("HTTP_RESPONSE_INVALID");
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^(0|[1-9][0-9]*)$/.test(length) ||
          Number(length) > maxResponseBytes)
      )
        fail("HTTP_RESPONSE_TOO_LARGE");
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) fail("DEPENDENCY_TIMEOUT");
      if (/^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message ?? "")) throw error;
      fail("DEPENDENCY_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
    if (new TextEncoder().encode(text).byteLength > maxResponseBytes)
      fail("HTTP_RESPONSE_TOO_LARGE");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      fail("HTTP_RESPONSE_INVALID");
    }
    if (!plain(value)) fail("HTTP_RESPONSE_INVALID");
    return value;
  }

  return Object.freeze({
    async prepareIntent(input) {
      if (!plain(input)) fail("HTTP_REQUEST_SCHEMA_INVALID");
      const value = await request("POST", "/intents/prepare", structuredClone(input));
      if (
        value.mode !== "TEST_ONLY_NO_REAL_VALUE" ||
        !operationId(value.operationId)
      )
        fail("HTTP_RESPONSE_INVALID");
      return value;
    },
    async createIntent(input) {
      if (!plain(input)) fail("HTTP_REQUEST_SCHEMA_INVALID");
      const value = await request("POST", "/intents", structuredClone(input));
      if (
        !operationId(value.id) ||
        !states.has(value.state) ||
        typeof value.existing !== "boolean"
      )
        fail("HTTP_RESPONSE_INVALID");
      return value;
    },
    async getIntent(id) {
      if (!operationId(id)) fail("INTENT_ID_INVALID");
      const value = await request("GET", `/intents/${encodeURIComponent(id)}`);
      if (value.id !== id || value.mode !== "TEST_ONLY_NO_REAL_VALUE")
        fail("HTTP_RESPONSE_INVALID");
      return value;
    },
    async recordRevocation(id, hash) {
      if (!operationId(id)) fail("INTENT_ID_INVALID");
      if (!transactionHash(hash)) fail("REVOCATION_HASH_INVALID");
      const value = await request(
        "POST",
        `/intents/${encodeURIComponent(id)}/revocation`,
        { transactionHash: hash.toLowerCase() },
      );
      if (
        value.id !== id ||
        !["PENDING", "CONFIRMED"].includes(value.state)
      )
        fail("HTTP_RESPONSE_INVALID");
      return value;
    },
  });
}
