import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  createPublicClient,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { hoodi } from "viem/chains";

import { charityEditionsAbi } from "@/lib/contracts";

/**
 * Charity-edition holder verification — #110 §2 CH.5.
 *
 * The only holder benefit is a high-resolution watermarked copy, released only after wallet
 * ownership is verified. Ownership means two independent facts, and both are checked here:
 *
 *   1. the caller controls the wallet — proven by a signature over a single-use challenge;
 *   2. the wallet actually holds the edition — proven by an ERC-1155 `balanceOf` read.
 *
 * Signature recovery runs in this Next.js server route rather than in the Go API, because the Go
 * module carries no secp256k1 or keccak dependency and adding one widens the API's supply chain for
 * a single call site. The grant this module issues is an HMAC the Go side can verify with stdlib
 * alone. `ACCEPTANCE.md` G2.8 requires that browser-supplied headers alone cannot grant access —
 * satisfied, because the browser never mints a grant: it is signed here with a server-held secret
 * after both facts above are established.
 *
 * Every failure path is closed. An unreachable RPC produces no grant, never an assumed holder.
 */

export const holderChallengeCookie = "artfi_charity_holder_challenge";
export const holderGrantCookie = "artfi_charity_holder_grant";
export const holderCookiePath = "/api/charity";

type HolderChallenge = {
  type: "holder-challenge";
  address: Address;
  tokenId: string;
  message: string;
  expiresAt: number;
};

export type HolderGrant = {
  type: "holder-grant";
  address: Address;
  tokenId: string;
  expiresAt: number;
};

function secret() {
  const value = process.env.ARTFI_CHARITY_HOLDER_SESSION_SECRET?.trim() ?? "";
  if (value.length < 32) {
    throw new Error("Charity holder session signing is unavailable.");
  }
  return value;
}

/** Token IDs are decimal uint256 strings. Anything else never reaches a contract read. */
export function canonicalTokenId(value: string | undefined) {
  if (typeof value !== "string" || !/^[0-9]{1,78}$/.test(value))
    return undefined;
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function encode(value: HolderChallenge | HolderGrant) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", secret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function decode<T extends HolderChallenge | HolderGrant>(
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
      canonicalTokenId(decoded.tokenId) !== decoded.tokenId ||
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

export function createHolderChallenge(
  address: string,
  tokenId: string,
  origin: string,
) {
  if (!isAddress(address))
    throw new Error("A valid wallet address is required.");
  const canonicalId = canonicalTokenId(tokenId);
  if (!canonicalId)
    throw new Error("A valid charity edition token ID is required.");
  const canonicalAddress = address.toLowerCase() as Address;
  const expiresAt = Date.now() + 5 * 60_000;
  const issuedAt = new Date().toISOString();
  const expirationTime = new Date(expiresAt).toISOString();
  const nonce = randomBytes(16).toString("hex");
  const authority = new URL(origin);
  // The token ID is inside the signed text, so a signature collected for one edition cannot be
  // replayed to unlock another.
  const message = `${authority.host} wants you to sign in with your Ethereum account:
${canonicalAddress}

Verify ownership of ArtCCH:ArtFi charity edition ${canonicalId} to receive the watermarked holder file. This signature creates no transaction, moves no asset, and grants no rights in the artwork.

URI: ${authority.origin}/charity/editions/${canonicalId}
Version: 1
Chain ID: ${hoodi.id}
Nonce: ${nonce}
Issued At: ${issuedAt}
Expiration Time: ${expirationTime}`;
  const challenge: HolderChallenge = {
    type: "holder-challenge",
    address: canonicalAddress,
    tokenId: canonicalId,
    message,
    expiresAt,
  };
  return { challenge, token: encode(challenge) };
}

export function readHolderChallenge(token: string | undefined) {
  return decode<HolderChallenge>(token, "holder-challenge");
}

export function createHolderGrant(address: Address, tokenId: string) {
  const canonicalId = canonicalTokenId(tokenId);
  if (!canonicalId)
    throw new Error("A valid charity edition token ID is required.");
  const grant: HolderGrant = {
    type: "holder-grant",
    address: address.toLowerCase() as Address,
    tokenId: canonicalId,
    expiresAt: Date.now() + 10 * 60_000,
  };
  return { grant, token: encode(grant) };
}

export function readHolderGrant(token: string | undefined) {
  return decode<HolderGrant>(token, "holder-grant");
}

/** A grant unlocks exactly the edition it names, and nothing else. */
export function grantCoversEdition(
  grant: HolderGrant | undefined,
  tokenId: string,
) {
  const canonicalId = canonicalTokenId(tokenId);
  return Boolean(grant && canonicalId && grant.tokenId === canonicalId);
}

function publicClient() {
  if (process.env.ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE?.trim() !== "sin") {
    throw new Error(
      "Charity holder chain verification is restricted to the SIN execution zone.",
    );
  }
  const rpcURL =
    process.env.ARTFI_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_HOODI_RPC_URL?.trim();
  if (!rpcURL)
    throw new Error("Charity holder chain verification is unavailable.");
  return createPublicClient({ chain: hoodi, transport: http(rpcURL) });
}

function charityEditionsAddress() {
  const value =
    process.env.ARTFI_CHARITY_EDITIONS_ADDRESS?.trim() ||
    process.env.NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS?.trim() ||
    "";
  if (!isAddress(value))
    throw new Error("The charity editions contract is unavailable.");
  return value;
}

export type OwnershipReader = {
  verifyMessage: (input: {
    address: Address;
    message: string;
    signature: Hex;
  }) => Promise<boolean>;
  balanceOf: (address: Address, tokenId: bigint) => Promise<bigint>;
};

function chainReader(): OwnershipReader {
  const client = publicClient();
  const address = charityEditionsAddress();
  return {
    verifyMessage: (input) => client.verifyMessage(input),
    balanceOf: (holder, tokenId) =>
      client.readContract({
        address,
        abi: charityEditionsAbi,
        functionName: "balanceOf",
        args: [holder, tokenId],
      }) as Promise<bigint>,
  };
}

/**
 * Both facts, in order. A valid signature over a wallet that holds nothing is not ownership, and a
 * held balance without a signature is not control of that wallet.
 *
 * The reader is injectable so the contract can be exercised deterministically in tests without a
 * chain. A test double is never a substitute for runtime evidence and is not recorded as one.
 */
export async function verifyHolderOwnership(
  address: Address,
  tokenId: string,
  message: string,
  signature: Hex,
  reader: OwnershipReader = chainReader(),
) {
  const canonicalId = canonicalTokenId(tokenId);
  if (!canonicalId) return false;
  const signed = await reader.verifyMessage({ address, message, signature });
  if (!signed) return false;
  const balance = await reader.balanceOf(address, BigInt(canonicalId));
  return balance > 0n;
}
