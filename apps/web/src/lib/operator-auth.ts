import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  createPublicClient,
  http,
  isAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { hoodi } from "viem/chains";

export const operatorChallengeCookie = "artfi_operator_challenge";
export const operatorSessionCookie = "artfi_operator_session";
export const operatorCookiePath = "/api/operator";

type Challenge = {
  type: "challenge";
  address: Address;
  message: string;
  expiresAt: number;
};

export type OperatorSession = {
  type: "session";
  address: Address;
  expiresAt: number;
};

const hasRoleAbi = [
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const registrarRole = keccak256(toBytes("REGISTRAR_ROLE"));

function secret() {
  const value = process.env.ARTFI_OPERATOR_SESSION_SECRET?.trim() ?? "";
  if (value.length < 32) {
    throw new Error("Operator session signing is unavailable.");
  }
  return value;
}

function encode(value: Challenge | OperatorSession) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", secret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function decode<T extends Challenge | OperatorSession>(
  token: string | undefined,
  type: T["type"],
) {
  if (!token) return undefined;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return undefined;
  const expected = createHmac("sha256", secret()).update(payload).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return undefined;
  }
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as T;
    if (
      decoded.type !== type ||
      !isAddress(decoded.address) ||
      !Number.isSafeInteger(decoded.expiresAt) ||
      decoded.expiresAt <= Date.now()
    ) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

export function createOperatorChallenge(address: string, origin: string) {
  if (!isAddress(address))
    throw new Error("A valid wallet address is required.");
  const canonicalAddress = address.toLowerCase() as Address;
  const expiresAt = Date.now() + 5 * 60_000;
  const issuedAt = new Date().toISOString();
  const expirationTime = new Date(expiresAt).toISOString();
  const nonce = randomBytes(16).toString("hex");
  const authority = new URL(origin);
  const message = `${authority.host} wants you to sign in with your Ethereum account:
${canonicalAddress}

Verify an ArtCCH:ArtFi administrator wallet. This signature creates no transaction and grants no rights.

URI: ${authority.origin}/create/rwa
Version: 1
Chain ID: ${hoodi.id}
Nonce: ${nonce}
Issued At: ${issuedAt}
Expiration Time: ${expirationTime}`;
  const challenge: Challenge = {
    type: "challenge",
    address: canonicalAddress,
    message,
    expiresAt,
  };
  return { challenge, token: encode(challenge) };
}

export function readOperatorChallenge(token: string | undefined) {
  return decode<Challenge>(token, "challenge");
}

export function createOperatorSession(address: Address) {
  const session: OperatorSession = {
    type: "session",
    address: address.toLowerCase() as Address,
    expiresAt: Date.now() + 10 * 60_000,
  };
  return { session, token: encode(session) };
}

export function readOperatorSession(token: string | undefined) {
  return decode<OperatorSession>(token, "session");
}

function publicClient() {
  if (process.env.ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE?.trim() !== "sin") {
    throw new Error(
      "Operator chain verification is restricted to the SIN execution zone.",
    );
  }
  const rpcURL =
    process.env.ARTFI_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_HOODI_RPC_URL?.trim();
  if (!rpcURL) throw new Error("Operator chain verification is unavailable.");
  return createPublicClient({ chain: hoodi, transport: http(rpcURL) });
}

function registryAddress() {
  const value = process.env.ARTFI_RWA_REGISTRY_ADDRESS?.trim() ?? "";
  if (!isAddress(value))
    throw new Error("The reviewed RWA registry is unavailable.");
  return value;
}

export async function verifyOperatorWallet(
  address: Address,
  message: string,
  signature: Hex,
) {
  const client = publicClient();
  const valid = await client.verifyMessage({ address, message, signature });
  if (!valid) return false;
  return client.readContract({
    address: registryAddress(),
    abi: hasRoleAbi,
    functionName: "hasRole",
    args: [registrarRole, address],
  });
}

export async function sessionStillAuthorized(session: OperatorSession) {
  const client = publicClient();
  return client.readContract({
    address: registryAddress(),
    abi: hasRoleAbi,
    functionName: "hasRole",
    args: [registrarRole, session.address],
  });
}

export function configuredOrigin(requestOrigin: string) {
  const configured = process.env.ARTFI_WEB_URL?.trim();
  const value = configured || requestOrigin;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error("Operator origin is unavailable.");
  }
  return parsed.origin;
}
