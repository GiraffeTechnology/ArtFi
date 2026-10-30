import { NextResponse } from "next/server";

import {
  configuredOrigin,
  createOperatorChallenge,
  operatorChallengeCookie,
  operatorCookiePath,
} from "@/lib/operator-auth";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { address?: string };
    const origin = configuredOrigin(new URL(request.url).origin);
    const { challenge, token } = createOperatorChallenge(
      body.address ?? "",
      origin,
    );
    const response = NextResponse.json({
      address: challenge.address,
      chainId: challenge.chainId,
      registryAddress: challenge.registryAddress,
      safeAddress: challenge.safeAddress,
      message: challenge.message,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
    });
    response.cookies.set(operatorChallengeCookie, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: origin.startsWith("https:"),
      path: operatorCookiePath,
      maxAge: 5 * 60,
    });
    return response;
  } catch {
    return NextResponse.json(
      { detail: "Operator challenge is unavailable." },
      { status: 503 },
    );
  }
}
