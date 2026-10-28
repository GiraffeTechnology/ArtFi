import { consumeHolderChallenge } from "@/lib/charity-holder-challenge-store";
import { holderVerificationResponse } from "@/lib/charity-holder-request";
import { readUserJSON } from "@/lib/user-auth-json";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isAddress, isHex, type Address, type Hex } from "viem";

import {
  createHolderGrant,
  holderChallengeCookie,
  holderCookiePath,
  holderGrantCookie,
  readHolderChallenge,
  verifyHolderOwnership,
} from "@/lib/charity-holder-auth";
import { configuredOrigin } from "@/lib/operator-auth";

async function verify(request: Request, signal: AbortSignal) {
  const origin = configuredOrigin(new URL(request.url).origin);
  let owns: boolean;
  let address: Address;
  let tokenId: string;
  try {
    const body = (await readUserJSON(request, { signal, timeoutMs: 8000 })) as {
      address?: string;
      signature?: string;
    };
    signal.throwIfAborted();
    const cookieStore = await cookies();
    signal.throwIfAborted();
    const originalChallengeToken = cookieStore.get(
      holderChallengeCookie,
    )?.value;
    const challenge = readHolderChallenge(originalChallengeToken);
    if (
      !challenge ||
      !body.address ||
      !isAddress(body.address) ||
      body.address.toLowerCase() !== challenge.address ||
      !body.signature ||
      !isHex(body.signature)
    ) {
      return NextResponse.json(
        { detail: "The holder challenge is invalid or expired." },
        { status: 401 },
      );
    }
    address = body.address as Address;
    tokenId = challenge.tokenId;
    owns = await verifyHolderOwnership(
      address,
      tokenId,
      challenge.message,
      body.signature as Hex,
    );
    signal.throwIfAborted();
    // Preserve the original challenge lifetime through the asynchronous ownership read.
    const currentChallenge = readHolderChallenge(originalChallengeToken);
    if (!currentChallenge) {
      return NextResponse.json(
        { detail: "The holder challenge is invalid or expired." },
        { status: 401 },
      );
    }
    if (owns) {
      await consumeHolderChallenge(
        originalChallengeToken!,
        currentChallenge,
        origin,
      );
      signal.throwIfAborted();
      if (!readHolderChallenge(originalChallengeToken)) {
        return NextResponse.json(
          { detail: "The holder challenge is invalid or expired." },
          { status: 401 },
        );
      }
    }
  } catch {
    // An unreachable chain is reported as unavailable. It is never treated as ownership.
    return NextResponse.json(
      { detail: "Charity holder verification is unavailable." },
      { status: 503 },
    );
  }

  if (!owns) {
    return NextResponse.json(
      { detail: "This wallet does not hold the requested charity edition." },
      { status: 403 },
    );
  }

  const { grant, token } = createHolderGrant(address, tokenId);
  const response = NextResponse.json({
    verified: true,
    address: grant.address,
    tokenId: grant.tokenId,
    expiresAt: new Date(grant.expiresAt).toISOString(),
    holderBenefit: "watermarked-copy-after-ownership-verification",
  });
  response.cookies.set(holderGrantCookie, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: origin.startsWith("https:"),
    path: holderCookiePath,
    maxAge: 10 * 60,
  });
  response.cookies.set(holderChallengeCookie, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: origin.startsWith("https:"),
    path: holderCookiePath,
    maxAge: 0,
  });
  return response;
}

export async function POST(request: Request) {
  return holderVerificationResponse(request, (signal) =>
    verify(request, signal),
  );
}
