import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { POST } from "../app/api/user/auth/[action]/route";
import {
  sealUserChallenge,
  userAccessCookie,
  userRefreshCookie,
  userChallengeCookie,
  type UserChallenge,
} from "./user-auth";

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
const origin = "https://app.example.invalid";
const address = "0x1111111111111111111111111111111111111111" as Address;
const fetcher = vi.fn();
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function challenge(lifetime = 300_000): UserChallenge {
  return {
    id: "public_signin_challenge_01",
    address,
    chainId: 560048,
    origin,
    message: "Public contract-wallet challenge fixture",
    issuedAt: Date.now(),
    expiresAt: Date.now() + lifetime,
  };
}
function tokens() {
  return {
    session: {
      id: "public-session-01",
      address,
      chainId: 560048,
      expiresAt: Date.now() + 86400_000,
      accessExpiresAt: Date.now() + 600_000,
    },
    accessToken: "public-access-token-".repeat(3),
    refreshToken: "public-refresh-token-".repeat(3),
  };
}
function request(signal?: AbortSignal) {
  return new Request(`${origin}/api/user/auth/verify`, {
    method: "POST",
    signal,
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ address, chainId: 560048, signature: "0xab" }),
  });
}
const context = { params: Promise.resolve({ action: "verify" }) };
function begin(lifetime = 300_000, signal?: AbortSignal) {
  const value = challenge(lifetime);
  jar.set(userChallengeCookie, sealUserChallenge(value));
  return POST(request(signal), context);
}
function noCookies(response: Awaited<ReturnType<typeof POST>>) {
  expect(response.cookies.getAll()).toHaveLength(0);
  expect(response.headers.get("cache-control")).toBe("no-store");
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  vi.resetAllMocks();
  jar.clear();
  vi.stubEnv(
    "ARTFI_USER_AUTH_BRIDGE_TOKEN",
    "public-bridge-fixture-".repeat(3),
  );
  vi.stubEnv("ARTFI_WEB_URL", origin);
  vi.stubEnv("ARTFI_API_URL", "https://bridge.example.invalid/artfi");
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("sign-in proof completion", () => {
  it("signin-completion regression expired proof never reaches durable verification", async () => {
    rpc.verifyMessage.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 1000);
      return true;
    });
    const response = await begin(1000);
    expect(response.status).toBe(401);
    noCookies(response);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("signin-completion regression expired upstream return issues no login cookies", async () => {
    fetcher.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 1000);
      return Response.json(tokens());
    });
    const response = await begin(1000);
    expect(response.status).toBe(401);
    noCookies(response);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("signin-completion regression cancelled proof never reaches durable verification", async () => {
    const controller = new AbortController();
    rpc.verifyMessage.mockImplementation(async () => {
      controller.abort();
      return true;
    });
    const response = await begin(300_000, controller.signal);
    expect(response.status).toBe(503);
    noCookies(response);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("signin-completion regression cancelled upstream return issues no login cookies", async () => {
    const controller = new AbortController();
    fetcher.mockImplementation(async () => {
      controller.abort();
      return Response.json(tokens());
    });
    const response = await begin(300_000, controller.signal);
    expect(response.status).toBe(503);
    noCookies(response);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("completes valid original proof once with existing scoped HttpOnly cookies", async () => {
    const response = await begin();
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
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
    const text = await response.text();
    expect(text).toContain("public-session-01");
    expect(text).not.toContain("public-access-token");
    expect(text).not.toContain("public-refresh-token");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("never starts proof or bridge for an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await begin(300_000, controller.signal);
    expect(response.status).toBe(503);
    noCookies(response);
    expect(rpc.getChainId).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a stalled signature proof and ignores its late success", async () => {
    const pending = deferred<boolean>();
    rpc.verifyMessage.mockReturnValue(pending.promise);
    const run = begin();
    await vi.advanceTimersByTimeAsync(7999);
    expect(fetcher).not.toHaveBeenCalled();
    let done = false;
    void run.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await run;
    expect(response.status).toBe(503);
    noCookies(response);
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses one deadline across proof and bridge without replaying a late result", async () => {
    rpc.verifyMessage.mockImplementation(
      () =>
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(true), 6000),
        ),
    );
    const pending = deferred<Response>();
    fetcher.mockReturnValue(pending.promise);
    const run = begin();
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1999);
    let done = false;
    void run.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await run;
    expect(response.status).toBe(503);
    noCookies(response);
    pending.resolve(Response.json(tokens()));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("returns promptly on cancellation even if the contract reader ignores it", async () => {
    const pending = deferred<boolean>();
    rpc.verifyMessage.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const run = begin(300_000, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.verifyMessage).toHaveBeenCalledOnce();
    controller.abort();
    const response = await run;
    expect(response.status).toBe(503);
    noCookies(response);
    pending.reject(new Error("private reader detail"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the original rejection and discloses no private reader failure", async () => {
    rpc.verifyMessage.mockRejectedValue(
      new Error("private signer endpoint token"),
    );
    const response = await begin();
    expect(response.status).toBe(503);
    noCookies(response);
    expect(await response.text()).not.toContain("private signer");
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves a rejected signature without creating a session", async () => {
    rpc.verifyMessage.mockResolvedValue(false);
    const response = await begin();
    expect(response.status).toBe(401);
    noCookies(response);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves durable conflict without retry or cookie mutation", async () => {
    fetcher.mockResolvedValue(new Response(null, { status: 409 }));
    const response = await begin();
    expect(response.status).toBe(409);
    noCookies(response);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
