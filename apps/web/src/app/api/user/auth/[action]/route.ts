import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isAddress, type Address, type Hex } from "viem";
import { hoodi } from "viem/chains";
import {
  assertUserRequestOrigin,
  readBoundedJSON,
  readUserChallenge,
  sealUserChallenge,
  userAccessCookie,
  userAccessPath,
  userAuthOrigin,
  userAuthPath,
  userAuthRequest,
  userChallengeCookie,
  userRefreshCookie,
  UserAuthError,
  validateUserTokens,
  validUserSession,
  verifyUserSignature,
  type UserChallenge,
  type UserSession,
  type UserTokens,
} from "@/lib/user-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ action: string }> };
const commonCookie = { httpOnly: true, sameSite: "strict" as const };

function output(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
function secure(request: Request) {
  return (
    new URL(userAuthOrigin(new URL(request.url).origin)).protocol === "https:"
  );
}
function clearCookie(
  response: NextResponse,
  name: string,
  path: string,
  request: Request,
) {
  response.cookies.set(name, "", {
    ...commonCookie,
    secure: secure(request),
    path,
    maxAge: 0,
  });
}
function clearAll(response: NextResponse, request: Request) {
  clearCookie(response, userAccessCookie, userAccessPath, request);
  clearCookie(response, userRefreshCookie, userAuthPath, request);
  clearCookie(response, userChallengeCookie, userAuthPath, request);
  return response;
}
function tokenResponse(tokens: UserTokens, request: Request) {
  const response = output({ session: tokens.session });
  response.cookies.set(userAccessCookie, tokens.accessToken, {
    ...commonCookie,
    secure: secure(request),
    path: userAccessPath,
    expires: new Date(tokens.session.accessExpiresAt),
  });
  response.cookies.set(userRefreshCookie, tokens.refreshToken, {
    ...commonCookie,
    secure: secure(request),
    path: userAuthPath,
    expires: new Date(tokens.session.expiresAt),
  });
  clearCookie(response, userChallengeCookie, userAuthPath, request);
  return response;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new UserAuthError(400, "A valid sign-in request is required.");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new UserAuthError(400, "Unknown sign-in request fields.");
}
function errorResponse(error: unknown) {
  return output(
    {
      detail:
        error instanceof UserAuthError
          ? error.message
          : "Wallet sign-in is unavailable.",
    },
    error instanceof UserAuthError ? error.status : 503,
  );
}

export async function GET(request: Request, context: Context) {
  try {
    if ((await context.params).action !== "session")
      return output({ detail: "Unknown sign-in action." }, 404);
    const accessToken = (await cookies()).get(userAccessCookie)?.value;
    if (!accessToken) return output({ session: null }, 401);
    const result = await userAuthRequest<{ session: UserSession }>("session", {
      accessToken,
    });
    if (!validUserSession(result.session))
      return output({ session: null }, 401);
    return output({ session: result.session });
  } catch (error) {
    if (error instanceof UserAuthError && error.status === 401)
      return output({ session: null }, 401);
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const origin = assertUserRequestOrigin(request);
    const { action } = await context.params;
    if (!["challenge", "verify", "refresh", "logout"].includes(action))
      return output({ detail: "Unknown sign-in action." }, 404);
    const body = object(await readBoundedJSON(request));
    const jar = await cookies();
    if (action === "challenge") {
      exactKeys(body, ["address", "chainId"]);
      if (
        typeof body.address !== "string" ||
        !isAddress(body.address) ||
        body.chainId !== hoodi.id
      )
        throw new UserAuthError(400, "Connect a valid wallet on Hoodi.");
      const challenge = await userAuthRequest<UserChallenge>("challenge", {
        address: body.address.toLowerCase(),
        chainId: hoodi.id,
        origin,
      });
      const token = sealUserChallenge(challenge);
      const checked = readUserChallenge(token, origin);
      if (
        !checked ||
        checked.address.toLowerCase() !== body.address.toLowerCase()
      )
        throw new UserAuthError(
          503,
          "Wallet sign-in API returned an invalid challenge.",
        );
      const response = output({
        address: challenge.address,
        chainId: challenge.chainId,
        message: challenge.message,
        expiresAt: challenge.expiresAt,
      });
      response.cookies.set(userChallengeCookie, token, {
        ...commonCookie,
        secure: secure(request),
        path: userAuthPath,
        expires: new Date(challenge.expiresAt),
      });
      return response;
    }
    if (action === "verify") {
      exactKeys(body, ["address", "chainId", "signature"]);
      const challenge = readUserChallenge(
        jar.get(userChallengeCookie)?.value,
        origin,
      );
      if (
        !challenge ||
        body.address !== challenge.address ||
        body.chainId !== challenge.chainId ||
        typeof body.signature !== "string"
      )
        throw new UserAuthError(
          401,
          "The sign-in challenge expired or changed. Start again.",
        );
      if (
        !(await verifyUserSignature(
          challenge.address as Address,
          challenge.message,
          body.signature as Hex,
        ))
      )
        throw new UserAuthError(
          401,
          "The wallet signature could not be verified.",
        );
      const tokens = validateUserTokens(
        await userAuthRequest("verify", {
          challengeId: challenge.id,
          address: challenge.address,
          chainId: challenge.chainId,
          origin,
          message: challenge.message,
        }),
      );
      if (
        tokens.session.address.toLowerCase() !== challenge.address.toLowerCase()
      )
        throw new UserAuthError(
          503,
          "Wallet sign-in API returned an invalid session.",
        );
      return tokenResponse(tokens, request);
    }
    exactKeys(body, []);
    const refreshToken = jar.get(userRefreshCookie)?.value;
    const accessToken = jar.get(userAccessCookie)?.value;
    if (action === "refresh") {
      if (!refreshToken)
        return clearAll(output({ session: null }, 401), request);
      try {
        return tokenResponse(
          validateUserTokens(
            await userAuthRequest("refresh", { refreshToken }),
          ),
          request,
        );
      } catch (error) {
        if (error instanceof UserAuthError && [401, 403].includes(error.status))
          return clearAll(output({ session: null }, 401), request);
        throw error;
      }
    }
    // Keep cookies on upstream failure so the user can retry actual durable revocation.
    if (refreshToken || accessToken)
      await userAuthRequest("logout", { refreshToken, accessToken });
    return clearAll(output({ session: null }), request);
  } catch (error) {
    return errorResponse(error);
  }
}
