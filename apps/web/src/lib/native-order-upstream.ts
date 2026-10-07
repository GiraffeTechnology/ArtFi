import "server-only";

export function nativeOrderAPIURL(path: string) {
  const configured = process.env.ARTFI_API_URL?.trim();
  if (!configured) throw new Error("The order service is unavailable.");
  const base = new URL(configured);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(base.hostname)
      ))
  ) {
    throw new Error("The order service is unavailable.");
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
  return new URL(path.replace(/^\//, ""), base);
}

export async function nativeOrderResponse(response: Response) {
  const text = await boundedOrderText(response.body, 2 * 1024 * 1024);
  if (text.length > 2 * 1024 * 1024)
    throw new Error("The order response is too large.");
  const data: unknown = JSON.parse(text);
  if (!response.ok)
    return Response.json(
      { detail: "The order service could not complete this request." },
      {
        status:
          response.status >= 400 && response.status < 600
            ? response.status
            : 502,
      },
    );
  return Response.json(data, {
    status: response.status,
    headers: { "cache-control": "no-store" },
  });
}

/** Never buffer an unbounded public request or upstream response. */
export async function boundedOrderText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
) {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new Error("The order payload is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
