import { publicSetting } from "@/lib/public-runtime-config";
import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import {
  createPublicClient,
  http,
  isAddress,
  recoverMessageAddress,
  type Address,
  type Hex,
} from "viem";
import { hoodi, mainnet, base } from "viem/chains";
import { enabledSessionChain } from "./auth-chains";

export const userAccessCookie = "artfi_user_access";
export const userRefreshCookie = "artfi_user_refresh";
export const userChallengeCookie = "artfi_user_challenge";
export const userAccessPath = "/api";
export const userAuthPath = "/api/user/auth";
export const maximumAuthBytes = 16_384;

export type UserSession = {
  id: string;
  address: Address;
  chainId: number;
  expiresAt: number;
  accessExpiresAt: number;
};
export type UserChallenge = {
  id: string;
  address: Address;
  chainId: number;
  origin: string;
  message: string;
  issuedAt: number;
  expiresAt: number;
};
export type UserTokens = {
  session: UserSession;
  accessToken: string;
  refreshToken: string;
};
export class UserAuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "UserAuthError";
  }
}

function bridgeSecret() {
  const value = process.env.ARTFI_USER_AUTH_BRIDGE_TOKEN?.trim() ?? "";
  if (Buffer.byteLength(value) < 32)
    throw new UserAuthError(503, "Wallet sign-in is unavailable.");
  return value;
}

export function userAuthOrigin(requestOrigin: string) {
  const parsed = new URL(process.env.ARTFI_WEB_URL?.trim() || requestOrigin);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "https:" &&
      !(
        parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      ))
  )
    throw new UserAuthError(503, "Wallet sign-in origin is unavailable.");
  return parsed.origin;
}

export function assertUserRequestOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = userAuthOrigin(new URL(request.url).origin);
  if (
    !origin ||
    origin !== expected ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new UserAuthError(403, "The request origin is not allowed.");
  return expected;
}

export async function readBoundedJSON(
  request: Request | Response,
): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/.test(declared) || Number(declared) > maximumAuthBytes)
  )
    throw new UserAuthError(413, "The sign-in request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new UserAuthError(400, "A JSON request is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumAuthBytes) {
        await reader.cancel();
        throw new UserAuthError(413, "The sign-in request is too large.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof UserAuthError) throw error;
    throw new UserAuthError(400, "A valid JSON request is required.");
  } finally {
    reader.releaseLock();
  }
}

export function userAuthUpstreamURL(action: string) {
  if (!["challenge", "verify", "session", "refresh", "logout"].includes(action))
    throw new UserAuthError(404, "Unknown sign-in action.");
  const base = new URL(
    process.env.ARTFI_USER_AUTH_API_URL?.trim() ||
      process.env.ARTFI_API_URL?.trim() ||
      "",
  );
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      ))
  )
    throw new UserAuthError(503, "Wallet sign-in API is unavailable.");
  base.pathname = `${base.pathname.replace(/\/$/, "")}/v1/user/auth/${action}`;
  return base;
}

export async function userAuthRequest<T>(
  action: string,
  payload: unknown,
): Promise<T> {
  const body = JSON.stringify(payload);
  const credential = bridgeSecret();
  let response: Response;
  try {
    response = await fetch(userAuthUpstreamURL(action), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new UserAuthError(503, "Wallet sign-in API is unavailable.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    const status = [400, 401, 403, 409, 429].includes(response.status)
      ? response.status
      : 503;
    throw new UserAuthError(
      status,
      status === 503
        ? "Wallet sign-in API is unavailable."
        : "The wallet session could not be verified. Sign in again.",
    );
  }
  if (response.status === 204) return undefined as T;
  try {
    return (await readBoundedJSON(response)) as T;
  } catch {
    throw new UserAuthError(
      503,
      "Wallet sign-in API returned an invalid response.",
    );
  }
}

export function validUserSession(value: unknown): value is UserSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as UserSession;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    candidate.id.length <= 128 &&
    typeof candidate.address === "string" &&
    isAddress(candidate.address) &&
    enabledSessionChain(candidate.chainId) &&
    Number.isSafeInteger(candidate.expiresAt) &&
    candidate.expiresAt > Date.now() &&
    Number.isSafeInteger(candidate.accessExpiresAt) &&
    candidate.accessExpiresAt > Date.now() &&
    candidate.accessExpiresAt <= candidate.expiresAt
  );
}

export function validateUserTokens(value: unknown): UserTokens {
  const candidate = value as UserTokens;
  if (
    !candidate ||
    !validUserSession(candidate.session) ||
    typeof candidate.accessToken !== "string" ||
    candidate.accessToken.length < 32 ||
    candidate.accessToken.length > 4096 ||
    typeof candidate.refreshToken !== "string" ||
    candidate.refreshToken.length < 32 ||
    candidate.refreshToken.length > 512
  )
    throw new UserAuthError(
      503,
      "Wallet sign-in API returned an invalid response.",
    );
  return candidate;
}

export function sealUserChallenge(challenge: UserChallenge) {
  const payload = Buffer.from(JSON.stringify(challenge)).toString("base64url");
  const signature = createHmac("sha256", bridgeSecret())
    .update(`user-challenge:${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function readUserChallenge(token: string | undefined, origin: string) {
  if (!token || token.length > 8_192) return undefined;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return undefined;
  const expected = createHmac("sha256", bridgeSecret())
    .update(`user-challenge:${payload}`)
    .digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return undefined;
  try {
    const challenge = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as UserChallenge;
    if (
      typeof challenge.id !== "string" ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(challenge.id) ||
      !isAddress(challenge.address) ||
      !enabledSessionChain(challenge.chainId) ||
      challenge.origin !== origin ||
      typeof challenge.message !== "string" ||
      challenge.message.length > 4_096 ||
      !Number.isSafeInteger(challenge.issuedAt) ||
      challenge.issuedAt > Date.now() + 5_000 ||
      !Number.isSafeInteger(challenge.expiresAt) ||
      challenge.expiresAt <= Date.now() ||
      challenge.expiresAt - challenge.issuedAt > 5 * 60_000
    )
      return undefined;
    return challenge;
  } catch {
    return undefined;
  }
}

export type UserSignatureVerifier = (input: {
  address: Address;
  message: string;
  signature: Hex;
  chainId?: number;
}) => Promise<boolean>;

async function verifyContractSignature(
  input: Parameters<UserSignatureVerifier>[0],
) {
  if (process.env.ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE?.trim() !== "sin")
    throw new UserAuthError(
      503,
      "Contract-wallet verification is unavailable.",
    );
  const chain = [hoodi, mainnet, base].find(
    (candidate) => candidate.id === (input.chainId ?? hoodi.id),
  );
  if (!chain || !enabledSessionChain(chain.id))
    throw new UserAuthError(403, "Unsupported wallet chain.");
  const url =
    chain.id === hoodi.id
      ? process.env.ARTFI_RPC_URL?.trim() ||
        publicSetting("NEXT_PUBLIC_HOODI_RPC_URL")?.trim()
      : process.env[`ARTFI_NFT_RPC_${chain.id}`]?.trim();
  if (!url)
    throw new UserAuthError(
      503,
      "Contract-wallet verification is unavailable.",
    );
  const client = createPublicClient({
    chain,
    transport: http(url, { timeout: 8_000, retryCount: 0 }),
  });
  if ((await client.getChainId()) !== chain.id)
    throw new UserAuthError(
      503,
      "Contract-wallet verification is on the wrong network.",
    );
  const code = await client.getCode({ address: input.address });
  if (!code || code === "0x") return false;
  return client.verifyMessage({
    address: input.address,
    message: input.message,
    signature: input.signature,
  });
}

export async function verifyUserSignature(
  address: Address,
  message: string,
  signature: Hex,
  contractVerifier: UserSignatureVerifier = verifyContractSignature,
  chainId: number = hoodi.id,
) {
  if (
    !isAddress(address) ||
    typeof message !== "string" ||
    message.length > 4_096 ||
    typeof signature !== "string" ||
    !/^0x(?:[a-fA-F0-9]{2}){1,8192}$/.test(signature)
  )
    return false;
  try {
    if (
      (await recoverMessageAddress({ message, signature })).toLowerCase() ===
      address.toLowerCase()
    )
      return true;
  } catch {
    /* Contract wallets may use a non-ECDSA signature format. */
  }
  // An EOA success never calls RPC. A contract-wallet fallback must validate against Hoodi.
  return contractVerifier({ address, message, signature, chainId });
}

export async function requireUserSession(
  seller: string,
  chainId: number = hoodi.id,
) {
  if (!isAddress(seller))
    throw new UserAuthError(400, "A valid seller wallet is required.");
  const accessToken = (await cookies()).get(userAccessCookie)?.value;
  if (!accessToken)
    throw new UserAuthError(401, "Sign in with the seller wallet.");
  const response = await userAuthRequest<{ session: UserSession }>("session", {
    accessToken,
  });
  if (!validUserSession(response.session))
    throw new UserAuthError(401, "Sign in with the seller wallet.");
  if (
    response.session.address.toLowerCase() !== seller.toLowerCase() ||
    response.session.chainId !== chainId
  )
    throw new UserAuthError(403, "Sign in with the seller wallet.");
  return { session: response.session, accessToken };
}
