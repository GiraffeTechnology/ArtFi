import "server-only";

import { createHash, createHmac } from "node:crypto";

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
  if (asset.byteLength > maxHolderObjectBytes) {
    return { ok: false, refusal: "too-large" };
  }

  const signed = signedGetRequest(config, asset.objectKey, now);
  let response: Response;
  try {
    response = await fetchImpl(signed.url, {
      method: "GET",
      headers: signed.headers,
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    return { ok: false, refusal: "unreachable" };
  }
  if (!response.ok) return { ok: false, refusal: "unreachable" };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { ok: false, refusal: "unreachable" };
  }

  return verifyHolderBytes(asset, bytes);
}
