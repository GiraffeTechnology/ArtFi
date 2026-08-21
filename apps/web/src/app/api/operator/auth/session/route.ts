import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  operatorSessionCookie,
  readOperatorSession,
  sessionStillAuthorized,
} from "@/lib/operator-auth";

export async function GET() {
  try {
    const cookieStore = await cookies();
    const session = readOperatorSession(
      cookieStore.get(operatorSessionCookie)?.value,
    );
    if (!session || !(await sessionStillAuthorized(session))) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }
    return NextResponse.json({
      authenticated: true,
      address: session.address,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  } catch {
    return NextResponse.json({ authenticated: false }, { status: 503 });
  }
}
