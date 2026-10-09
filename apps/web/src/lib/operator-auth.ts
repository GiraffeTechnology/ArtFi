import { publicSetting } from "@/lib/public-runtime-config";
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
import { artFiAdminSafeAbi } from "./contracts";

export const operatorChallengeCookie = "artfi_operator_challenge";
export const operatorSessionCookie = "artfi_operator_session";
export const operatorCookiePath = "/api/operator";

type OperatorBinding = {
  chainId: number;
  registryAddress: Address;
  safeAddress?: Address;
};

type Challenge = OperatorBinding & {
  type: "challenge";
  address: Address;
  message: string;
  expiresAt: number;
};

export type OperatorSession = OperatorBinding & {
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
      decoded.expiresAt <= Date.now() ||
      !bindingMatches(decoded)
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
  const binding = deploymentBinding();
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
Chain ID: ${binding.chainId}
Registry: ${binding.registryAddress}
Administration Safe: ${binding.safeAddress ?? "not configured (direct role)"}
Nonce: ${nonce}
Issued At: ${issuedAt}
Expiration Time: ${expirationTime}`;
  const challenge: Challenge = {
    type: "challenge",
    ...binding,
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
    ...deploymentBinding(),
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
    publicSetting("NEXT_PUBLIC_HOODI_RPC_URL")?.trim();
  if (!rpcURL) throw new Error("Operator chain verification is unavailable.");
  return createPublicClient({ chain: hoodi, transport: http(rpcURL) });
}

function registryAddress() {
  const value = process.env.ARTFI_RWA_REGISTRY_ADDRESS?.trim() ?? "";
  if (!isAddress(value))
    throw new Error("The reviewed RWA registry is unavailable.");
  return value;
}

function deploymentBinding(): OperatorBinding {
  const registry = registryAddress().toLowerCase() as Address;
  const rawSafe = process.env.ARTFI_ADMIN_SAFE_ADDRESS?.trim();
  const publicSafe = publicSetting(
    "NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS",
  )?.trim();
  if (
    (rawSafe || publicSafe) &&
    rawSafe?.toLowerCase() !== publicSafe?.toLowerCase()
  )
    throw new Error(
      "Server and public administration safe configuration must match.",
    );
  if (rawSafe && (!isAddress(rawSafe) || /^0x0{40}$/i.test(rawSafe)))
    throw new Error("The reviewed administration safe is unavailable.");
  return {
    chainId: hoodi.id,
    registryAddress: registry,
    ...(rawSafe ? { safeAddress: rawSafe.toLowerCase() as Address } : {}),
  };
}

function bindingMatches(value: OperatorBinding) {
  const current = deploymentBinding();
  return (
    value.chainId === current.chainId &&
    value.registryAddress === current.registryAddress &&
    value.safeAddress === current.safeAddress
  );
}

async function hasRegistrarAuthority(
  address: Address,
  binding: OperatorBinding,
) {
  const client = publicClient();
  if ((await client.getChainId()) !== binding.chainId)
    throw new Error(
      "Operator RPC chain does not match the reviewed deployment.",
    );
  if (binding.safeAddress) {
    const safeHoldsRole = await client.readContract({
      address: binding.registryAddress,
      abi: hasRoleAbi,
      functionName: "hasRole",
      args: [registrarRole, binding.safeAddress],
    });
    if (safeHoldsRole)
      return client.readContract({
        address: binding.safeAddress,
        abi: artFiAdminSafeAbi,
        functionName: "isOwner",
        args: [address],
      });
  }
  return client.readContract({
    address: binding.registryAddress,
    abi: hasRoleAbi,
    functionName: "hasRole",
    args: [registrarRole, address],
  });
}

export async function verifyOperatorWallet(
  address: Address,
  message: string,
  signature: Hex,
) {
  const client = publicClient();
  if (!(await client.verifyMessage({ address, message, signature })))
    return false;
  return hasRegistrarAuthority(address, deploymentBinding());
}

export async function sessionStillAuthorized(session: OperatorSession) {
  if (!bindingMatches(session)) return false;
  return hasRegistrarAuthority(session.address, session);
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
