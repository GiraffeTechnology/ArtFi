import { fail } from "./config.mjs";
export async function readResponseJSON(response, limit = 65536) {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    fail("UPSTREAM_RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) fail("UPSTREAM_RESPONSE_INVALID");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        fail("UPSTREAM_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error?.message === "UPSTREAM_RESPONSE_TOO_LARGE") throw error;
    fail("UPSTREAM_RESPONSE_INVALID");
  } finally {
    reader.releaseLock();
  }
}
export async function readRequestJSON(request, limit = 32768) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")
  )
    fail("JSON_CONTENT_TYPE_REQUIRED");
  const declared = request.headers["content-length"];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
    fail("REQUEST_TOO_LARGE");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) fail("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      fail("REQUEST_JSON_INVALID");
    return result;
  } catch {
    fail("REQUEST_JSON_INVALID");
  }
}
export function exactInput(input, keys) {
  return (
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).length === keys.length &&
    keys.every((key) => Object.hasOwn(input, key))
  );
}
