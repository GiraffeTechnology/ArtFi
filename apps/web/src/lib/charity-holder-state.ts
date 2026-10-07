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

async function readDetail(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { detail?: string };
    return typeof body.detail === "string" ? body.detail : fallback;
  } catch {
    return fallback;
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
}: {
  address: string;
  tokenId: string;
  signMessage: (message: string) => Promise<string>;
  isCurrent: () => boolean;
  update: (state: HolderState) => void;
  request?: typeof fetch;
  now?: () => number;
}) {
  const publish = (state: HolderState) => {
    if (isCurrent()) update(state);
  };
  if (!isCurrent()) return;
  publish({ step: "requesting-challenge" });
  try {
    const challengeResponse = await request("/api/charity/holder/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, tokenId }),
    });
    if (!challengeResponse.ok)
      throw new Error(
        await readDetail(
          challengeResponse,
          "The ownership challenge could not be created.",
        ),
      );
    const challenge = (await challengeResponse.json()) as { message: string };
    if (!isCurrent()) return;
    publish({ step: "awaiting-signature" });
    let signature: string;
    try {
      signature = await signMessage(challenge.message);
    } catch {
      throw new Error("The signature request was declined in the wallet.");
    }
    if (!isCurrent()) return;
    publish({ step: "verifying" });
    const verifyResponse = await request("/api/charity/holder/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, signature }),
    });
    if (!verifyResponse.ok)
      throw new Error(
        await readDetail(
          verifyResponse,
          "Ownership of this edition could not be verified.",
        ),
      );
    const verified = (await verifyResponse.json()) as {
      address: string;
      tokenId: string;
      expiresAt: string;
    };
    if (!isCurrent()) return;
    if (
      verified.address?.toLowerCase() !== address.toLowerCase() ||
      verified.tokenId !== BigInt(tokenId).toString() ||
      !Number.isFinite(Date.parse(verified.expiresAt)) ||
      Date.parse(verified.expiresAt) <= now()
    )
      throw new Error(
        "The ownership response is for a different wallet, edition, or expired session. Verify again.",
      );

    const descriptorResponse = await request(
      `/api/charity/editions/${tokenId}/holder-asset`,
      { cache: "no-store" },
    );
    if (!descriptorResponse.ok)
      throw new Error(
        await readDetail(
          descriptorResponse,
          "The watermarked file is not available for this edition.",
        ),
      );
    const descriptor = (await descriptorResponse.json()) as HolderDescriptor;
    if (Date.parse(verified.expiresAt) <= now())
      throw new Error("Holder access expired. Verify ownership again.");
    publish({ step: "verified", descriptor, expiresAt: verified.expiresAt });
  } catch (error) {
    publish({
      step: "error",
      message:
        error instanceof Error
          ? error.message
          : "Charity holder verification is unavailable.",
    });
  }
}
