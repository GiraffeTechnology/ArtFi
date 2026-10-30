import { readUserJSON } from "./user-auth-json";

export type HolderStep =
  | "idle"
  | "requesting-challenge"
  | "awaiting-signature"
  | "verifying"
  | "verified"
  | "error";

export type HolderDescriptor = {
  contentType: string;
  byteLength: number;
  sha256: string;
};

export type HolderState = {
  step: HolderStep;
  message?: string;
  descriptor?: HolderDescriptor;
  expiresAt?: string;
};

export const holderRequestTimeoutMs = 8_000;
const unavailable = "Charity holder verification is unavailable.";
const fields = (value: unknown, keys: string[]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    throw new Error("The holder response was invalid. Verify again.");
  return value as Record<string, unknown>;
};
const future = (value: unknown, now: () => number): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  Date.parse(value) > now();
const rights =
  "This edition conveys no copyright, physical title, possession, redemption, commercial-use or reproduction right.";

/** Bounded requests never retry a possibly cookie-mutating verification POST. */
async function holderJSON(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  fallback: string,
  parent?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let response: Response | undefined;
  let responseFailure: Error | undefined;
  try {
    if (parent?.aborted) throw new Error("Holder verification was cancelled.");
    const interrupted = new Promise<never>((_, reject) => {
      const stop = (message: string) => {
        controller.abort();
        reject(new Error(message));
      };
      timer = setTimeout(
        () => stop("Holder verification timed out. Try again."),
        holderRequestTimeoutMs,
      );
      if (parent) {
        onAbort = () => stop("Holder verification was cancelled.");
        parent.addEventListener("abort", onAbort, { once: true });
        if (parent.aborted) onAbort();
      }
    });
    const pending = request(url, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    void pending.then(
      (late) => {
        if (controller.signal.aborted)
          void late.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    response = await Promise.race([pending, interrupted]);
    const body = await Promise.race([
      readUserJSON(response, {
        signal: controller.signal,
        timeoutMs: holderRequestTimeoutMs,
      }),
      interrupted,
    ]);
    if (!response.ok) {
      const detail =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as { detail?: unknown }).detail
          : undefined;
      responseFailure = new Error(
        typeof detail === "string" && detail.length > 0 && detail.length <= 1024
          ? detail
          : fallback,
      );
      throw responseFailure;
    }
    return body;
  } catch (error) {
    // No fetch/decoder diagnostic or unbounded upstream body is exposed to the UI.
    if (
      error instanceof Error &&
      (error.message === "Holder verification timed out. Try again." ||
        error.message === "Holder verification was cancelled." ||
        error === responseFailure)
    )
      throw error;
    throw new Error(unavailable);
  } finally {
    clearTimeout(timer);
    if (parent && onAbort) parent.removeEventListener("abort", onAbort);
  }
}

/** Only the still-mounted wallet/edition context may continue or display a proof. */
export async function verifyHolderAccess({
  address,
  tokenId,
  signMessage,
  isCurrent,
  update,
  request = fetch,
  now = Date.now,
  signal,
}: {
  address: string;
  tokenId: string;
  signMessage: (message: string) => Promise<string>;
  isCurrent: () => boolean;
  update: (state: HolderState) => void;
  request?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}) {
  const current = () => isCurrent() && !signal?.aborted;
  const publish = (state: HolderState) => {
    if (current()) update(state);
  };
  if (!current()) return;
  publish({ step: "requesting-challenge" });
  try {
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(address) ||
      !/^[0-9]{1,78}$/.test(tokenId) ||
      BigInt(tokenId) <= 0n ||
      BigInt(tokenId) >= 1n << 256n
    )
      throw new Error("A valid wallet and charity edition are required.");
    const edition = BigInt(tokenId).toString();
    const challenge = fields(
      await holderJSON(
        request,
        "/api/charity/holder/challenge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, tokenId }),
        },
        "The ownership challenge could not be created.",
        signal,
      ),
      ["address", "tokenId", "message", "expiresAt"],
    );
    if (!current()) return;
    if (
      typeof challenge.address !== "string" ||
      challenge.address.toLowerCase() !== address.toLowerCase() ||
      challenge.tokenId !== edition ||
      !future(challenge.expiresAt, now) ||
      typeof challenge.message !== "string" ||
      challenge.message.length === 0 ||
      new TextEncoder().encode(challenge.message).byteLength > 4096
    )
      throw new Error(
        "The ownership challenge did not match this wallet and edition or has expired.",
      );
    publish({ step: "awaiting-signature" });
    let signature: string;
    try {
      signature = await signMessage(challenge.message);
    } catch {
      throw new Error("The signature request was declined in the wallet.");
    }
    if (!current()) return;
    if (!future(challenge.expiresAt, now))
      throw new Error(
        "The ownership challenge expired. Verify ownership again.",
      );
    publish({ step: "verifying" });
    const verified = fields(
      await holderJSON(
        request,
        "/api/charity/holder/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, signature }),
        },
        "Ownership of this edition could not be verified.",
        signal,
      ),
      ["verified", "address", "tokenId", "expiresAt", "holderBenefit"],
    );
    if (!current()) return;
    if (
      verified.verified !== true ||
      verified.holderBenefit !==
        "watermarked-copy-after-ownership-verification" ||
      typeof verified.address !== "string" ||
      verified.address.toLowerCase() !== address.toLowerCase() ||
      verified.tokenId !== edition ||
      !future(verified.expiresAt, now)
    )
      throw new Error(
        "The ownership response is for a different wallet, edition, or expired session. Verify again.",
      );
    const descriptor = fields(
      await holderJSON(
        request,
        `/api/charity/editions/${tokenId}/holder-asset`,
        {},
        "The watermarked file is not available for this edition.",
        signal,
      ),
      [
        "tokenId",
        "class",
        "contentType",
        "byteLength",
        "sha256",
        "objectKey",
        "artworkPreview",
        "rights",
      ],
    );
    if (!current()) return;
    if (
      descriptor.tokenId !== edition ||
      descriptor.class !== "watermarked-holder" ||
      descriptor.artworkPreview !== "not-provided" ||
      descriptor.rights !== rights ||
      typeof descriptor.contentType !== "string" ||
      !["image/jpeg", "image/png", "image/tiff", "image/webp"].includes(
        descriptor.contentType,
      ) ||
      typeof descriptor.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(descriptor.sha256) ||
      !Number.isSafeInteger(descriptor.byteLength) ||
      (descriptor.byteLength as number) <= 0 ||
      typeof descriptor.objectKey !== "string" ||
      descriptor.objectKey.length === 0
    )
      throw new Error(
        "The watermarked file description was invalid and no access is shown.",
      );
    if (!future(verified.expiresAt, now))
      throw new Error("Holder access expired. Verify ownership again.");
    publish({
      step: "verified",
      descriptor: {
        contentType: descriptor.contentType,
        byteLength: descriptor.byteLength as number,
        sha256: descriptor.sha256,
      },
      expiresAt: verified.expiresAt,
    });
  } catch (error) {
    publish({
      step: "error",
      message: error instanceof Error ? error.message : unavailable,
    });
  }
}
