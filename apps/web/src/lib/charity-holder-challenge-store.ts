import "server-only";
import { createHash } from "node:crypto";
import { hoodi } from "viem/chains";
import { userAuthRequest } from "./user-auth";
import type { readHolderChallenge } from "./charity-holder-auth";

type Challenge = NonNullable<ReturnType<typeof readHolderChallenge>>;

/** Identity of the existing signed cookie, not a receipt or transaction digest. */
function binding(token: string, challenge: Challenge, origin: string) {
  return {
    challengeHash: createHash("sha256").update(token).digest("hex"),
    address: challenge.address,
    chainId: hoodi.id,
    tokenId: challenge.tokenId,
    origin,
    issuedAt: challenge.expiresAt - 5 * 60_000,
    expiresAt: challenge.expiresAt,
  };
}

export async function registerHolderChallenge(
  token: string,
  challenge: Challenge,
  origin: string,
) {
  const result = await userAuthRequest<unknown>(
    "holder-challenge",
    binding(token, challenge, origin),
  );
  if (result !== undefined)
    throw new Error("Holder challenge registration was not confirmed.");
}

export async function consumeHolderChallenge(
  token: string,
  challenge: Challenge,
  origin: string,
) {
  // No retry: an unconfirmed response can mean the single-use update committed.
  const result = await userAuthRequest<unknown>(
    "holder-consume",
    binding(token, challenge, origin),
  );
  if (result !== undefined)
    throw new Error("Holder challenge consumption was not confirmed.");
}
