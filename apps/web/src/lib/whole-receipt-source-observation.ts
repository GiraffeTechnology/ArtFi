import "server-only";
import {
  observeWholeReceiptSource,
  snapshotWholeReceiptExpectation,
  refuseReceipt,
  WholeReceiptSourceError,
  type WholeReceiptSourceCode,
  type WholeReceiptSourceObservation,
} from "./whole-receipt-source-observation-model";

const MAX_BYTES = 65536;
function oracleBase() {
  const value = process.env.ARTFI_ORACLE_READ_API_URL?.trim();
  if (!value) return refuseReceipt("RECEIPT_ORACLE_NOT_CONFIGURED");
  try {
    const url = new URL(value);
    const local =
      process.env.NODE_ENV !== "production" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error("invalid base");
    url.pathname = url.pathname.replace(/\/$/, "") + "/";
    return url;
  } catch {
    return refuseReceipt("RECEIPT_ORACLE_CONFIG_INVALID");
  }
}
export type WholeReceiptSourceRead =
  | { ok: true; observation: WholeReceiptSourceObservation }
  | { ok: false; code: WholeReceiptSourceCode };

async function boundedJson(url: URL, signal?: AbortSignal) {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new WholeReceiptSourceError("RECEIPT_TIMEOUT"));
      controller.abort();
    }, 4000);
    cancel = () => {
      reject(new WholeReceiptSourceError("RECEIPT_CANCELLED"));
      controller.abort();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        if (signal?.aborted) return refuseReceipt("RECEIPT_CANCELLED");
        const response = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        });
        if (signal?.aborted) return refuseReceipt("RECEIPT_CANCELLED");
        if (response.redirected)
          return refuseReceipt("RECEIPT_SOURCE_MALFORMED");
        if (!response.ok)
          return refuseReceipt(
            response.status === 404
              ? "RECEIPT_NOT_AVAILABLE"
              : "RECEIPT_SOURCE_UNAVAILABLE",
          );
        const length = response.headers.get("content-length");
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          ) ||
          (length !== null &&
            (!/^[0-9]+$/.test(length) || Number(length) > MAX_BYTES)) ||
          !response.body
        )
          return refuseReceipt("RECEIPT_SOURCE_MALFORMED");
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > MAX_BYTES)
            return refuseReceipt("RECEIPT_SOURCE_MALFORMED");
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          ) as unknown;
        } catch {
          return refuseReceipt("RECEIPT_SOURCE_MALFORMED");
        }
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}

/** Existing deployment-owned URL only. Exact historical version, never legacy/current fallback.
 * The complete expectation must come from the authenticated immutable application plan and
 * approved deployment/policy binding, never from the Oracle response or browser JSON.
 */
export async function readWholeReceiptSourceVersion(
  expectedInput: unknown,
  signal?: AbortSignal,
): Promise<WholeReceiptSourceRead> {
  try {
    const expected = snapshotWholeReceiptExpectation(expectedInput);
    if (signal?.aborted) return refuseReceipt("RECEIPT_CANCELLED");
    const url = new URL(
      "v1/oracle/projection/" +
        expected.tokenId +
        "/receipt/version/" +
        expected.entry.version,
      oracleBase(),
    );
    const raw = await boundedJson(url, signal);
    if (signal?.aborted) return refuseReceipt("RECEIPT_CANCELLED");
    return { ok: true, observation: observeWholeReceiptSource(expected, raw) };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof WholeReceiptSourceError
          ? error.code
          : signal?.aborted
            ? "RECEIPT_CANCELLED"
            : "RECEIPT_SOURCE_UNAVAILABLE",
    };
  }
}
