import { registerHolderChallenge } from "@/lib/charity-holder-challenge-store";
import { holderVerificationResponse } from "@/lib/charity-holder-request";
import { readUserJSON } from "@/lib/user-auth-json";
import { NextResponse } from "next/server";

import {
  createHolderChallenge,
  holderChallengeCookie,
  holderCookiePath,
} from "@/lib/charity-holder-auth";
import { configuredOrigin } from "@/lib/operator-auth";

async function challenge(request: Request, signal: AbortSignal) {
  try {
    const body = (await readUserJSON(request, { signal, timeoutMs: 8000 })) as {
      address?: string;
      tokenId?: string;
    };
    signal.throwIfAborted();
    const origin = configuredOrigin(new URL(request.url).origin);
    const { challenge, token } = createHolderChallenge(
      body.address ?? "",
      body.tokenId ?? "",
      origin,
    );
    await registerHolderChallenge(token, challenge, origin);
    signal.throwIfAborted();
    const response = NextResponse.json({
      address: challenge.address,
      tokenId: challenge.tokenId,
      message: challenge.message,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
    });
    response.cookies.set(holderChallengeCookie, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: origin.startsWith("https:"),
      path: holderCookiePath,
      maxAge: 5 * 60,
    });
    return response;
  } catch {
    return NextResponse.json(
      { detail: "Charity holder verification is unavailable." },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  return holderVerificationResponse(request, (signal) =>
    challenge(request, signal),
  );
}
