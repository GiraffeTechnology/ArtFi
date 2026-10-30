import "server-only";

import { createHash, createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { CharityHolderAsset } from "./charity-assets";

/**
 * Private object read for the charity holder benefit — #110 §2 CH.5, CH.6 and CH.11.
 *
 * `charity-assets.ts` decides *whether* a descriptor may be served. This module is the other half
 * of CH.5: it turns an approved descriptor into the bytes the holder actually receives. Until it
 * existed the holder route returned a descriptor and no file, which `ACCEPTANCE.md` §7.17 counts as
 * presenting the benefit without the runtime behind it.
 *
 * Three properties matter more than throughput here:
 *
 *   - **The browser never learns where the object lives.** The signed request is made server-side
 *     and the bytes are relayed. No object key, bucket, endpoint or redirect reaches the client, so
 *     there is no URL a holder could share and no path a non-holder could guess.
 *   - **The bytes are proven before any of them are emitted.** The whole object is read, its digest
 *     compared against the descriptor, and only then returned. A swapped object — most importantly
 *     a master swapped in for the watermarked file — yields nothing at all rather than a partial
 *     stream that has already left the server.
 *   - **It is a separate store from the public one.** `R2_*` backs objects published with a public
 *     base URL. Charity holder files must never sit in public storage (CH.6), so this reads its own
 *     configuration and shares no bucket with the public path.
 *
 * Unconfigured is a refusal, not a fallback: with no store the holder route reports that delivery
 * is unavailable. It never invents a file and never degrades to the descriptor alone.
 */

/** A hard ceiling independent of the descriptor, so a bad `byteLength` cannot exhaust memory. */
export const maxHolderObjectBytes = 64 * 1024 * 1024;
/** Total time for the existing private GET, including headers and body. */
export const maxHolderReadDurationMs = 30_000;

export type HolderObjectConfig = {
  endpoint: URL;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type ObjectRefusal =
  | "not-configured"
  | "unreachable"
  | "size-mismatch"
  | "digest-mismatch"
  | "master-digest-collision"
  | "too-large";

export type ObjectDelivery =
  { ok: true; bytes: Uint8Array } | { ok: false; refusal: ObjectRefusal };

function loopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * Read the store configuration, or report that there is none.
 *
 * A partially configured store is treated as no store. Half a credential set is a deployment
 * mistake, and guessing the rest of it is how a read ends up pointed somewhere unreviewed.
 */
export function holderObjectConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): HolderObjectConfig | undefined {
  const endpoint = env.ARTFI_CHARITY_HOLDER_OBJECT_ENDPOINT?.trim();
  const bucket = env.ARTFI_CHARITY_HOLDER_OBJECT_BUCKET?.trim();
  const accessKeyId = env.ARTFI_CHARITY_HOLDER_OBJECT_ACCESS_KEY_ID?.trim();
  const secretAccessKey =
    env.ARTFI_CHARITY_HOLDER_OBJECT_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
    return undefined;

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return undefined;
  }
  // Credentials travel on this request. Plain HTTP is allowed only against loopback, for local runs.
  if (
    parsed.protocol !== "https:" &&
    !loopbackHost(parsed.host.split(":")[0])
  ) {
    return undefined;
  }

  return {
    endpoint: parsed,
    region: env.ARTFI_CHARITY_HOLDER_OBJECT_REGION?.trim() || "auto",
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "utf8") : data)
    .digest("hex");
}

/** SigV4 path-style GET. Kept pure and exported so the signature is tested without a network. */
export function signedGetRequest(
  config: HolderObjectConfig,
  objectKey: string,
  now: Date,
): { url: string; headers: Record<string, string> } {
  const requestURL = new URL(config.endpoint.toString());
  const basePath = requestURL.pathname.replace(/\/$/, "");
  const key = objectKey.replace(/^\//, "");
  requestURL.pathname = `${basePath}/${config.bucket}/${key}`;

  const amzDate = `${now.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
  const date = amzDate.slice(0, 8);
  // A GET carries no payload, so the empty-string digest is the canonical payload hash.
  const payloadHash = sha256Hex("");

  const canonicalHeaders =
    `host:${requestURL.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "GET",
    requestURL.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${config.secretAccessKey}`, date), config.region),
      "s3",
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    url: requestURL.toString(),
    headers: {
      host: requestURL.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/**
 * The last gate before bytes leave the server.
 *
 * `decideHolderAsset` already proved the *descriptor* is a watermarked holder file whose digest
 * differs from the master's. This proves the *object* is the file that descriptor describes — the
 * two are different claims, and only this one is about what the holder actually receives.
 */
export function verifyHolderBytes(
  asset: CharityHolderAsset,
  bytes: Uint8Array,
): ObjectDelivery {
  if (bytes.byteLength > maxHolderObjectBytes) {
    return { ok: false, refusal: "too-large" };
  }
  if (bytes.byteLength !== asset.byteLength) {
    return { ok: false, refusal: "size-mismatch" };
  }
  const digest = sha256Hex(bytes);
  // Checked before the descriptor digest: a master served under a holder descriptor is the one
  // failure this module exists to make impossible, and it deserves its own refusal in the log.
  if (digest === asset.masterSha256.toLowerCase()) {
    return { ok: false, refusal: "master-digest-collision" };
  }
  if (digest !== asset.sha256.toLowerCase()) {
    return { ok: false, refusal: "digest-mismatch" };
  }
  return { ok: true, bytes };
}

/**
 * Fetch and verify. The fetch is injectable so the refusal paths are tested without a live store.
 */
export async function fetchHolderObject(
  asset: CharityHolderAsset,
  config: HolderObjectConfig | undefined = holderObjectConfigFromEnv(),
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<ObjectDelivery> {
  if (!config) return { ok: false, refusal: "not-configured" };
  // Freeze the descriptor values used by this read before the first asynchronous step.
  const selected = { ...asset };
  if (!Number.isSafeInteger(selected.byteLength) || selected.byteLength <= 0) {
    return { ok: false, refusal: "size-mismatch" };
  }
  if (selected.byteLength > maxHolderObjectBytes) {
    return { ok: false, refusal: "too-large" };
  }

  const controller = new AbortController();
  const expiresAt = performance.now() + maxHolderReadDurationMs;
  let timedOut = false;
  let bodyComplete = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const unavailable = (): ObjectDelivery => ({
    ok: false,
    refusal: "unreachable",
  });
  const expired = () => timedOut || performance.now() >= expiresAt;
  const releaseReader = (cancel: boolean) => {
    const active = reader;
    reader = undefined;
    if (!active) return;
    // Cleanup cannot extend the public deadline if an upstream cancellation never settles.
    if (cancel) {
      try {
        void active.cancel().catch(() => undefined);
      } catch {
        /* Best effort. */
      }
    }
    try {
      active.releaseLock();
    } catch {
      /* Already released. */
    }
  };
  const discard = (response: Response) => {
    try {
      void response.body?.cancel().catch(() => undefined);
    } catch {
      /* Best effort. */
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ObjectDelivery>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      releaseReader(true);
      resolve(unavailable());
    }, maxHolderReadDurationMs);
  });

  const readVerified = async (): Promise<ObjectDelivery> => {
    try {
      const signed = signedGetRequest(config, selected.objectKey, now);
      const response = await fetchImpl(signed.url, {
        method: "GET",
        headers: signed.headers,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (expired() || !response.ok) {
        discard(response);
        return unavailable();
      }
      const declared = response.headers.get("content-length");
      if (declared !== null) {
        if (!/^[0-9]+$/.test(declared)) {
          discard(response);
          return { ok: false, refusal: "size-mismatch" };
        }
        const length = Number(declared);
        if (length > maxHolderObjectBytes) {
          discard(response);
          return { ok: false, refusal: "too-large" };
        }
        if (!Number.isSafeInteger(length) || length !== selected.byteLength) {
          discard(response);
          return { ok: false, refusal: "size-mismatch" };
        }
      }
      if (expired()) {
        discard(response);
        return unavailable();
      }
      if (!response.body) {
        bodyComplete = true;
        return { ok: false, refusal: "size-mismatch" };
      }
      const active = response.body.getReader();
      reader = active;
      // At most the approved descriptor size is retained. Incoming chunks are checked
      // before copying, including when Content-Length is absent or misleading.
      let bytes = new Uint8Array(Math.min(selected.byteLength, 64 * 1024));
      let size = 0;
      while (true) {
        if (expired()) return unavailable();
        const part = await active.read();
        if (expired()) return unavailable();
        if (part.done) {
          bodyComplete = true;
          break;
        }
        if (!(part.value instanceof Uint8Array)) return unavailable();
        const end = size + part.value.byteLength;
        if (end > maxHolderObjectBytes)
          return { ok: false, refusal: "too-large" };
        if (end > selected.byteLength)
          return { ok: false, refusal: "size-mismatch" };
        if (end > bytes.byteLength) {
          const expanded = new Uint8Array(
            Math.min(selected.byteLength, Math.max(end, bytes.byteLength * 2)),
          );
          expanded.set(bytes.subarray(0, size));
          bytes = expanded;
        }
        bytes.set(part.value, size);
        size = end;
      }
      if (size !== selected.byteLength)
        return { ok: false, refusal: "size-mismatch" };
      if (expired()) return unavailable();
      return verifyHolderBytes(selected, bytes);
    } catch {
      return unavailable();
    }
  };

  try {
    // One outer race covers headers and the entire body. Per-chunk deadline
    // checks also bound an upstream producing only immediately resolved reads.
    return await Promise.race([readVerified(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!bodyComplete) controller.abort();
    releaseReader(!bodyComplete);
  }
}
