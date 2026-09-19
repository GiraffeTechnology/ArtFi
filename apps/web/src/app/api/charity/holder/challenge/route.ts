import { NextResponse } from "next/server";

import {
  createHolderChallenge,
  holderChallengeCookie,
  holderCookiePath,
} from "@/lib/charity-holder-auth";
import { configuredOrigin } from "@/lib/operator-auth";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      address?: string;
      tokenId?: string;
    };
    const origin = configuredOrigin(new URL(request.url).origin);
    const { challenge, token } = createHolderChallenge(
      body.address ?? "",
      body.tokenId ?? "",
      origin,
    );
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
