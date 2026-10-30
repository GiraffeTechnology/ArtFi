import { validRuntimeMode } from "../../../scripts/agent/runtime-profile.mjs";
import { readFile } from "node:fs/promises";

export const MODE = "TEST_ONLY_NO_REAL_VALUE";
export const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);
export const fail = (code) => {
  throw Error(code);
};
export const stableCode = (error, fallback = "DEPENDENCY_UNAVAILABLE") =>
  /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message ?? "")
    ? error.message
    : fallback;
const plain = (x) => x && Object.getPrototypeOf(x) === Object.prototype;
const exact = (x, allowed) =>
  plain(x) && Object.keys(x).every((k) => allowed.includes(k));
const integer = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

export function serviceURL(value, code = "SERVICE_URL_INVALID") {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(code);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) ||
    /%2f|%5c|\\/i.test(url.pathname)
  )
    fail(code);
  return url.href.replace(/\/$/, "");
}

export function validateConfig(input) {
  const config = structuredClone(input);
  if (
    !exact(config, [
      "schemaVersion",
      "mode",
      "listen",
      "webOrigin",
      "authentication",
      "database",
      "adapter",
      "worker",
    ]) ||
    config.schemaVersion !== 1 ||
    !validRuntimeMode(config.mode) ||
    !exact(config.listen, ["host", "port"]) ||
    !["127.0.0.1", "::1"].includes(config.listen.host) ||
    !integer(config.listen.port, 1, 65535)
  )
    fail("AGENT_CONFIG_INVALID");
  const origin = new URL(
    serviceURL(config.webOrigin, "AGENT_WEB_ORIGIN_INVALID"),
  );
  if (origin.pathname !== "/") fail("AGENT_WEB_ORIGIN_INVALID");
  config.webOrigin = origin.origin;
  if (!exact(config.authentication, ["apiURL", "allowedChainIds"]))
    fail("AGENT_AUTH_CONFIG_INVALID");
  config.authentication.apiURL = serviceURL(
    config.authentication.apiURL,
    "AGENT_AUTH_CONFIG_INVALID",
  );
  config.authentication.allowedChainIds ??= [560048];
  if (
    !Array.isArray(config.authentication.allowedChainIds) ||
    !config.authentication.allowedChainIds.length ||
    config.authentication.allowedChainIds.some(
      (id) => ![560048, 1, 8453].includes(id),
    ) ||
    new Set(config.authentication.allowedChainIds).size !==
      config.authentication.allowedChainIds.length
  )
    fail("AGENT_AUTH_CONFIG_INVALID");
  if (config.database !== null) {
    const db = config.database;
    if (
      !exact(db, ["host", "port", "database", "user", "passwordFile", "tls"]) ||
      typeof db.host !== "string" ||
      !/^[a-zA-Z0-9.:-]{1,253}$/.test(db.host) ||
      !integer(db.port, 1, 65535) ||
      !/^[a-zA-Z0-9_]{1,64}$/.test(db.database ?? "") ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(db.user ?? "") ||
      db.user === "root" ||
      typeof db.passwordFile !== "string" ||
      db.passwordFile.length < 1 ||
      (db.tls !== null &&
        (!exact(db.tls, ["caFile"]) ||
          typeof db.tls.caFile !== "string" ||
          !db.tls.caFile))
    )
      fail("AGENT_DATABASE_CONFIG_INVALID");
    if (!LOOPBACK.has(db.host) && db.tls === null)
      fail("AGENT_DATABASE_TLS_REQUIRED");
  }
  if (
    !exact(config.adapter, ["kind", "baseURL", "tokenFile"]) ||
    !["unavailable", "artfi-isolated-test-v1"].includes(config.adapter.kind)
  )
    fail("AGENT_ADAPTER_CONFIG_INVALID");
  if (config.adapter.kind === "unavailable") {
    if (Object.keys(config.adapter).length !== 1)
      fail("AGENT_ADAPTER_CONFIG_INVALID");
  } else {
    if (config.mode !== MODE) fail("ISOLATED_ADAPTER_MODE_REFUSED");
    config.adapter.baseURL = serviceURL(
      config.adapter.baseURL,
      "AGENT_ADAPTER_CONFIG_INVALID",
    );
    if (
      !LOOPBACK.has(new URL(config.adapter.baseURL).hostname) ||
      typeof config.adapter.tokenFile !== "string" ||
      !config.adapter.tokenFile
    )
      fail("ISOLATED_TEST_ADAPTER_LOOPBACK_REQUIRED");
  }
  config.worker ??= { intervalMs: 1000 };
  if (
    !exact(config.worker, ["intervalMs"]) ||
    !integer(config.worker.intervalMs, 100, 60000)
  )
    fail("AGENT_WORKER_CONFIG_INVALID");
  return Object.freeze(config);
}

export async function readBoundedFile(path, limit = 65536) {
  const bytes = await readFile(path);
  if (bytes.byteLength > limit) fail("CONFIG_FILE_TOO_LARGE");
  return bytes.toString("utf8");
}
export async function loadConfig(path) {
  if (!path) fail("ARTFI_AGENT_CONFIG_FILE_REQUIRED");
  let input;
  try {
    input = JSON.parse(await readBoundedFile(path));
  } catch {
    fail("AGENT_CONFIG_FILE_UNAVAILABLE");
  }
  return validateConfig(input);
}
export async function readSecretFile(path) {
  let value;
  try {
    value = (await readBoundedFile(path, 8192)).trimEnd();
  } catch {
    fail("AGENT_SECRET_FILE_UNAVAILABLE");
  }
  if (value.length < 1 || /[\r\n\0]/.test(value))
    fail("AGENT_SECRET_FILE_INVALID");
  return value;
}
export function bridgeToken(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) < 32 ||
    Buffer.byteLength(value) > 4096 ||
    /[\r\n\0]/.test(value)
  )
    fail("AGENT_BRIDGE_TOKEN_REQUIRED");
  return value;
}
