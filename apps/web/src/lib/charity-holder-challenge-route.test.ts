import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ register: vi.fn(), origin: vi.fn() }));
vi.mock("./charity-holder-challenge-store", () => ({
  registerHolderChallenge: mocks.register,
}));
vi.mock("./operator-auth", () => ({ configuredOrigin: mocks.origin }));
import { POST } from "../app/api/charity/holder/challenge/route";
import { readHolderChallenge } from "./charity-holder-auth";
function request(signal?: AbortSignal) {
  return new Request("https://artfi.example/api/charity/holder/challenge", {
    method: "POST",
    body: JSON.stringify({
      address: "0x1111111111111111111111111111111111111111",
      tokenId: "7",
    }),
    signal,
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv(
    "ARTFI_CHARITY_EDITIONS_ADDRESS",
    "0x2222222222222222222222222222222222222222",
  );

  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
  vi.stubEnv(
    "ARTFI_CHARITY_HOLDER_SESSION_SECRET",
    "synthetic-test-only-holder-registration-secret",
  );
  mocks.register.mockResolvedValue(undefined);
  mocks.origin.mockReturnValue("https://artfi.example");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function noCookie(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
}
describe("persistent original charity challenge before cookie", () => {
  it("registers the actual signed challenge before returning the original cookie and message", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [token, challenge, origin] = mocks.register.mock.calls[0];
    expect(readHolderChallenge(token)).toEqual(challenge);
    expect(origin).toBe("https://artfi.example");
    expect(challenge.tokenId).toBe("7");
    expect(challenge.expiresAt).toBe(Date.now() + 300000);
    const body = await response.json();
    expect(body.message).toBe(challenge.message);
    const cookies = response.headers.get("set-cookie")!;
    expect(cookies).toContain("artfi_charity_holder_challenge=");
    expect(cookies).toContain("Max-Age=300");
    expect(cookies).toContain("HttpOnly");
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
  it("does not return a cookie when registration is unavailable or uncertain", async () => {
    mocks.register.mockRejectedValue(new Error("private SQL unknown result"));
    const response = await POST(request());
    noCookie(response);
    expect(await response.text()).not.toContain("private SQL");
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
  it("does not register an invalid edition", async () => {
    const req = new Request(request().url, {
      method: "POST",
      body: JSON.stringify({ address: "invalid", tokenId: "../master" }),
    });
    noCookie(await POST(req));
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it("bounds a body that never completes", async () => {
    const req = new Request(request().url, {
      method: "POST",
      body: new ReadableStream({
        start() {},
        cancel() {
          return new Promise(() => {});
        },
      }),
      duplex: "half",
    } as RequestInit);
    const pending = POST(req);
    await vi.advanceTimersByTimeAsync(8000);
    noCookie(await pending);
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it("does not return a late cookie after stalled registration", async () => {
    let finish!: () => void;
    mocks.register.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = POST(request());
    await vi.waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(8000);
    noCookie(await pending);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
  it("does not return a cookie after cancellation during registration", async () => {
    const controller = new AbortController();
    mocks.register.mockImplementation(async () => {
      controller.abort();
    });
    noCookie(await POST(request(controller.signal)));
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
  it("does not register an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    noCookie(await POST(request(controller.signal)));
    expect(mocks.register).not.toHaveBeenCalled();
  });
});
