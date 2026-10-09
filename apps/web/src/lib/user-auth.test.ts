import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import {
  assertUserRequestOrigin,
  readBoundedJSON,
  readUserChallenge,
  requireUserSession,
  sealUserChallenge,
  userAccessCookie,
  userAuthRequest,
  userChallengeCookie,
  userRefreshCookie,
  verifyUserSignature,
  type UserChallenge,
} from "./user-auth";
import { GET, POST } from "../app/api/user/auth/[action]/route";

const jar = vi.hoisted(() => new Map<string, string>());
const rpc = vi.hoisted(() => ({
  getChainId: vi.fn(),
  getCode: vi.fn(),
  verifyMessage: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (jar.has(key) ? { value: jar.get(key)! } : undefined),
  }),
}));
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => rpc,
}));
const address = "0xaC0a88ae421B2D81d79b5dDdED5D7f252b62BF94" as Address;
const contract = "0x1111111111111111111111111111111111111111" as Address;
const origin = "https://io.artcch.com";
// Public ECDSA recovery vector; no signing key is stored or needed by this test.
const signature =
  "0x000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000021b" as Hex;
const message = "ArtFi EOA signature fixture";
const fetcher = vi.fn();
function challenge(): UserChallenge {
  const now = Date.now();
  return {
    id: "challenge_public_test_id",
    address: address.toLowerCase() as Address,
    chainId: 560048,
    origin,
    message,
    issuedAt: now,
    expiresAt: now + 300_000,
  };
}
function tokens() {
  return {
    session: {
      id: "session-one",
      address,
      chainId: 560048,
      expiresAt: Date.now() + 86400_000,
      accessExpiresAt: Date.now() + 600_000,
    },
    accessToken: "public-test-access-".repeat(4),
    refreshToken: "public-test-refresh-".repeat(4),
  };
}
const context = (action: string) => ({ params: Promise.resolve({ action }) });
function request(action: string, body: unknown = {}, requestOrigin = origin) {
  return new Request(`${origin}/api/user/auth/${action}`, {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jar.clear();
  vi.clearAllMocks();
  vi.stubEnv(
    "ARTFI_USER_AUTH_BRIDGE_TOKEN",
    "public-test-bridge-token-".repeat(3),
  );
  vi.stubEnv("ARTFI_WEB_URL", origin);
  vi.stubEnv(
    "ARTFI_API_URL",
    "https://api.example.invalid/existing-bridge/artfi/",
  );
  vi.stubEnv("ARTFI_OPERATOR_BEARER_TOKEN", "");
  vi.stubEnv("ARTFI_USER_AUTH_API_URL", "");
  vi.stubEnv("ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE", "sin");
  vi.stubEnv("ARTFI_RPC_URL", "https://rpc.example.invalid");
  vi.stubGlobal("fetch", fetcher);
  rpc.getChainId.mockResolvedValue(560048);
  rpc.getCode.mockResolvedValue("0x6000");
  rpc.verifyMessage.mockResolvedValue(true);
  fetcher.mockImplementation(async () => Response.json(tokens()));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ordinary wallet signature verification", () => {
  it("recovers an EOA locally without an RPC, operator credential, or contract reader", async () => {
    vi.stubEnv("ARTFI_RPC_URL", "");
    vi.stubEnv("ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE", "");
    expect(await verifyUserSignature(address, message, signature)).toBe(true);
    expect(rpc.getChainId).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks contract signatures against the configured Hoodi chain and contract code", async () => {
    expect(await verifyUserSignature(contract, message, "0xab")).toBe(true);
    expect(rpc.getChainId).toHaveBeenCalledOnce();
    expect(rpc.getCode).toHaveBeenCalledWith({ address: contract });
    expect(rpc.verifyMessage).toHaveBeenCalledWith({
      address: contract,
      message,
      signature: "0xab",
    });
  });
  it("fails closed for a wrong-chain RPC, absent contract code, rejected signature, or outage", async () => {
    rpc.getChainId.mockResolvedValueOnce(1);
    await expect(
      verifyUserSignature(contract, message, "0xab"),
    ).rejects.toThrow("wrong network");
    expect(rpc.verifyMessage).not.toHaveBeenCalled();
    rpc.getCode.mockResolvedValueOnce("0x");
    expect(await verifyUserSignature(contract, message, "0xab")).toBe(false);
    rpc.verifyMessage.mockResolvedValueOnce(false);
    expect(await verifyUserSignature(contract, message, "0xab")).toBe(false);
    rpc.getChainId.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(
      verifyUserSignature(contract, message, "0xab"),
    ).rejects.toThrow("RPC unavailable");
  });
  it("rejects altered EOA messages and malformed signatures", async () => {
    const fallback = vi.fn(async () => false);
    expect(
      await verifyUserSignature(address, `${message}!`, signature, fallback),
    ).toBe(false);
    expect(
      await verifyUserSignature(address, message, "invalid" as Hex, fallback),
    ).toBe(false);
    expect(fallback).toHaveBeenCalledOnce();
  });
});

describe("challenge and internal bridge boundary", () => {
  it("keeps the maximum challenge lifetime valid when the clock advances between reads", () => {
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now++);
    try {
      const value = challenge();
      expect(value.expiresAt - value.issuedAt).toBe(300_000);
      expect(readUserChallenge(sealUserChallenge(value), origin)).toEqual(
        value,
      );
    } finally {
      clock.mockRestore();
    }
  });
  it("binds the challenge cookie to its exact content, origin, lifetime, wallet, and chain", () => {
    const value = challenge();
    const sealed = sealUserChallenge(value);
    expect(readUserChallenge(sealed, origin)).toEqual(value);
    expect(readUserChallenge(`${sealed}x`, origin)).toBeUndefined();
    expect(readUserChallenge(sealed, "https://other.example")).toBeUndefined();
    expect(
      readUserChallenge(
        sealUserChallenge({ ...value, expiresAt: Date.now() - 1 }),
        origin,
      ),
    ).toBeUndefined();
    expect(
      readUserChallenge(sealUserChallenge({ ...value, chainId: 1 }), origin),
    ).toBeUndefined();
    expect(
      readUserChallenge(
        sealUserChallenge({ ...value, address: "invalid" as Address }),
        origin,
      ),
    ).toBeUndefined();
  });
  it("preserves the API path prefix and uses only the independent server bridge credential", async () => {
    await userAuthRequest("session", { accessToken: "public-token" });
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.example.invalid/existing-bridge/artfi/v1/user/auth/session",
    );
    expect(options.headers.authorization).toBe(
      `Bearer ${"public-test-bridge-token-".repeat(3)}`,
    );
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeDefined();
  });
  it("prefers the ordinary-auth API URL without inheriting operator routing", async () => {
    vi.stubEnv(
      "ARTFI_USER_AUTH_API_URL",
      "https://bridge.example.invalid/auth-prefix",
    );
    vi.stubEnv(
      "ARTFI_OPERATOR_API_URL",
      "https://registrar.example.invalid/private",
    );
    await userAuthRequest("session", { accessToken: "public-token" });
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://bridge.example.invalid/auth-prefix/v1/user/auth/session",
    );
  });
  it("rejects foreign/missing origins and bounds chunked input without trusting Content-Length", async () => {
    expect(() =>
      assertUserRequestOrigin(request("logout", {}, "https://evil.example")),
    ).toThrow();
    expect(() =>
      assertUserRequestOrigin(
        new Request(`${origin}/api/user/auth/logout`, { method: "POST" }),
      ),
    ).toThrow();
    await expect(
      readBoundedJSON(request("verify", { padding: "x".repeat(17_000) })),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("fails closed on upstream redirects, oversized responses and server detail leakage", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({ private: "x".repeat(17_000) }),
    );
    await expect(userAuthRequest("session", {})).rejects.toMatchObject({
      status: 503,
    });
    fetcher.mockResolvedValueOnce(
      Response.json({ detail: "internal-database-topology" }, { status: 500 }),
    );
    await expect(userAuthRequest("session", {})).rejects.toThrow(
      "API is unavailable",
    );
  });
});

describe("browser auth BFF", () => {
  it("returns public session fields while storing tokens only in HttpOnly Strict scoped cookies", async () => {
    const value = challenge();
    jar.set(userChallengeCookie, sealUserChallenge(value));
    const response = await POST(
      request("verify", { address: value.address, chainId: 560048, signature }),
      context("verify"),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("session-one");
    expect(body).not.toContain("public-test-access");
    expect(body).not.toContain("public-test-refresh");
    expect(response.cookies.get(userAccessCookie)).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/api",
    });
    expect(response.cookies.get(userRefreshCookie)).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/api/user/auth",
    });
    const payload = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload).toEqual({
      challengeId: value.id,
      address: value.address,
      chainId: 560048,
      origin,
      message,
    });
    expect(payload.signature).toBeUndefined();
  });
  it("rejects browser verified flags and wallet mismatch before forwarding", async () => {
    jar.set(userChallengeCookie, sealUserChallenge(challenge()));
    expect(
      (
        await POST(
          request("verify", {
            address,
            chainId: 560048,
            signature,
            verified: true,
          }),
          context("verify"),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request("verify", { address: contract, chainId: 560048, signature }),
          context("verify"),
        )
      ).status,
    ).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps logout cookies on a revocation outage so sign-out can be retried", async () => {
    jar.set(userRefreshCookie, tokens().refreshToken);
    fetcher.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    const response = await POST(request("logout"), context("logout"));
    expect(response.status).toBe(503);
    expect(response.cookies.getAll()).toHaveLength(0);
  });
  it("clears every scoped cookie only after durable logout and clears a rejected refresh", async () => {
    jar.set(userRefreshCookie, tokens().refreshToken);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const response = await POST(request("logout"), context("logout"));
    expect(response.status).toBe(200);
    expect(response.cookies.getAll()).toHaveLength(3);
    expect(response.cookies.get(userAccessCookie)).toMatchObject({
      path: "/api",
      maxAge: 0,
    });
    fetcher.mockResolvedValueOnce(Response.json({}, { status: 401 }));
    expect(
      (await POST(request("refresh"), context("refresh"))).cookies.getAll(),
    ).toHaveLength(3);
  });
  it("revalidates the cookie against durable state and refuses mismatched sellers", async () => {
    jar.set(userAccessCookie, tokens().accessToken);
    fetcher.mockImplementation(async () =>
      Response.json({ session: tokens().session }),
    );
    await expect(requireUserSession(address)).resolves.toHaveProperty(
      "accessToken",
      tokens().accessToken,
    );
    await expect(requireUserSession(contract)).rejects.toMatchObject({
      status: 403,
    });
    fetcher.mockResolvedValueOnce(Response.json({}, { status: 401 }));
    await expect(requireUserSession(address)).rejects.toMatchObject({
      status: 401,
    });
    const response = await GET(
      new Request(`${origin}/api/user/auth/session`),
      context("session"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(tokens().accessToken);
  });
});
