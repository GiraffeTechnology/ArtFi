import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isAddress, isHex, type Address, type Hex } from "viem";

import {
  configuredOrigin,
  createOperatorSession,
  operatorChallengeCookie,
  operatorCookiePath,
  operatorSessionCookie,
  readOperatorChallenge,
  verifyOperatorWallet,
} from "@/lib/operator-auth";

export async function POST(request: Request) {
  try {
    const origin = configuredOrigin(new URL(request.url).origin);
    const body = (await request.json()) as {
      address?: string;
      signature?: string;
    };
    const cookieStore = await cookies();
    const challenge = readOperatorChallenge(
      cookieStore.get(operatorChallengeCookie)?.value,
    );
    if (
      !challenge ||
      !body.address ||
      !isAddress(body.address) ||
      body.address.toLowerCase() !== challenge.address ||
      !body.signature ||
      !isHex(body.signature)
    ) {
      return NextResponse.json(
        { detail: "Operator challenge is invalid or expired." },
        { status: 401 },
      );
    }
    const authorized = await verifyOperatorWallet(
      body.address as Address,
      challenge.message,
      body.signature as Hex,
    );
    if (!authorized) {
      return NextResponse.json(
        { detail: "The wallet does not hold the reviewed registrar role." },
        { status: 403 },
      );
    }
    const { session, token } = createOperatorSession(body.address as Address);
    const response = NextResponse.json({
      authenticated: true,
      address: session.address,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
    response.cookies.set(operatorSessionCookie, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: origin.startsWith("https:"),
      path: operatorCookiePath,
      maxAge: 10 * 60,
    });
    response.cookies.set(operatorChallengeCookie, "", {
      httpOnly: true,
      sameSite: "strict",
      secure: origin.startsWith("https:"),
      path: operatorCookiePath,
      maxAge: 0,
    });
    return response;
  } catch {
    return NextResponse.json(
      { detail: "Operator wallet verification is unavailable." },
      { status: 503 },
    );
  }
}
