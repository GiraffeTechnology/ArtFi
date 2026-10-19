import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  owns: vi.fn(),
  read: vi.fn(),
  grant: vi.fn(),
  origin: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("./operator-auth", () => ({ configuredOrigin: mocks.origin }));
vi.mock("./charity-holder-auth", async () => {
  const real = await vi.importActual<typeof import("./charity-holder-auth")>(
    "./charity-holder-auth",
  );
  return {
    ...real,
    readHolderChallenge: mocks.read,
    createHolderGrant: mocks.grant,
    verifyHolderOwnership: mocks.owns,
  };
});
import { POST } from "../app/api/charity/holder/verify/route";
const holder = "0x1111111111111111111111111111111111111111";
const signature = `0x${"11".repeat(65)}`;
let issued: any;
let auth: typeof import("./charity-holder-auth");
let cookieToken: string | undefined;
function request(
  body: unknown = { address: holder, signature },
  signal?: AbortSignal,
) {
  return new Request("https://artfi.example/api/charity/holder/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}
function noGrant(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(mocks.grant).not.toHaveBeenCalled();
}
beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
  vi.stubEnv(
    "ARTFI_CHARITY_HOLDER_SESSION_SECRET",
    "synthetic-test-only-original-holder-challenge-key",
  );
  auth = await vi.importActual<typeof import("./charity-holder-auth")>(
    "./charity-holder-auth",
  );
  issued = auth.createHolderChallenge(holder, "7", "https://artfi.example");
  cookieToken = issued.token;
  mocks.cookies.mockResolvedValue({
    get: () => (cookieToken ? { value: cookieToken } : undefined),
  });
  mocks.read.mockImplementation(auth.readHolderChallenge);
  mocks.grant.mockImplementation(auth.createHolderGrant);
  mocks.owns.mockResolvedValue(true);
  mocks.origin.mockReturnValue("https://artfi.example");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("holder verification original challenge and finite return", () => {
  it("keeps the original valid signature and holder flow with the original cookies", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      verified: true,
      address: holder,
      tokenId: "7",
      holderBenefit: "watermarked-copy-after-ownership-verification",
    });
    expect(Date.parse(body.expiresAt)).toBe(Date.now() + 600000);
    expect(mocks.owns).toHaveBeenCalledExactlyOnceWith(
      holder,
      "7",
      issued.challenge.message,
      signature,
    );
    expect(mocks.grant).toHaveBeenCalledExactlyOnceWith(holder, "7");
    const cookies = response.headers.get("set-cookie")!;
    expect(cookies).toContain("artfi_charity_holder_grant=");
    expect(cookies).toContain("HttpOnly");
    expect(cookies.toLowerCase()).toContain("samesite=strict");
    expect(cookies).toContain("Secure");
    expect(cookies).toContain("Max-Age=600");
    expect(cookies).toContain("artfi_charity_holder_challenge=;");
    expect(cookies).toContain("Max-Age=0");
  });
  it.each([
    "missing-cookie",
    "tampered-cookie",
    "expired-cookie",
    "wrong-address",
    "missing-address",
    "invalid-signature",
  ])("refuses original invalid challenge input: %s", async (mode) => {
    let body: any = { address: holder, signature };
    if (mode === "missing-cookie") cookieToken = undefined;
    if (mode === "tampered-cookie") cookieToken += "bad";
    if (mode === "expired-cookie") vi.setSystemTime(issued.challenge.expiresAt);
    if (mode === "wrong-address")
      body.address = "0x2222222222222222222222222222222222222222";
    if (mode === "missing-address") delete body.address;
    if (mode === "invalid-signature") body.signature = "invalid";
    const response = await POST(request(body));
    noGrant(response, 401);
    expect(mocks.owns).not.toHaveBeenCalled();
  });
  it("keeps the existing nonholder refusal", async () => {
    mocks.owns.mockResolvedValue(false);
    noGrant(await POST(request()), 403);
  });
  it("keeps unavailable ownership checks private", async () => {
    mocks.owns.mockRejectedValue(new Error("private RPC internal failure"));
    const response = await POST(request());
    noGrant(response, 503);
    expect(await response.text()).not.toContain("private RPC");
  });
  it.each(["expired", "changed-key"])(
    "holder-verification regression no grant after %s original challenge during ownership read",
    async (mode) => {
      mocks.owns.mockImplementation(async () => {
        if (mode === "expired") vi.setSystemTime(issued.challenge.expiresAt);
        else
          vi.stubEnv(
            "ARTFI_CHARITY_HOLDER_SESSION_SECRET",
            "different-synthetic-test-only-original-challenge-key",
          );
        return true;
      });
      noGrant(await POST(request()), 401);
      expect(mocks.owns).toHaveBeenCalledTimes(1);
    },
  );
  it("does not read or grant for a caller already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await POST(request(undefined, controller.signal));
    noGrant(response, 503);
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.owns).not.toHaveBeenCalled();
  });
  it("holder-verification regression no late grant after caller cancellation", async () => {
    const controller = new AbortController();
    let finish!: (value: boolean) => void;
    mocks.owns.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = POST(request(undefined, controller.signal));
    await vi.waitFor(() => expect(mocks.owns).toHaveBeenCalledTimes(1));
    controller.abort();
    finish(true);
    noGrant(await pending, 503);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it.each(["body", "cookie", "ownership"])(
    "holder-verification regression bounded %s with no late grant",
    async (phase) => {
      let finish: undefined | ((value: any) => void);
      let req = request();
      if (phase === "body")
        req = new Request(req.url, {
          method: "POST",
          body: new ReadableStream({
            start() {},
            cancel() {
              return new Promise(() => {});
            },
          }),
          duplex: "half",
        } as RequestInit);
      if (phase === "cookie")
        mocks.cookies.mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
      if (phase === "ownership")
        mocks.owns.mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
      const pending = POST(req);
      await vi.advanceTimersByTimeAsync(8000);
      const response = await pending;
      noGrant(response, 503);
      if (phase === "body") {
        expect(mocks.cookies).not.toHaveBeenCalled();
        expect(mocks.owns).not.toHaveBeenCalled();
      }
      if (phase === "cookie") {
        finish?.({ get: () => ({ value: issued.token }) });
      }
      if (phase === "ownership") finish?.(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.grant).not.toHaveBeenCalled();
    },
  );
  it.each(["declared", "streamed"])(
    "rejects %s oversized authentication input before ownership read",
    async (mode) => {
      const body = JSON.stringify({
        address: holder,
        signature,
        padding: "x".repeat(16384),
      });
      const req = new Request(
        "https://artfi.example/api/charity/holder/verify",
        {
          method: "POST",
          body,
          headers:
            mode === "declared"
              ? { "content-length": String(body.length) }
              : {},
        },
      );
      noGrant(await POST(req), 503);
      expect(mocks.owns).not.toHaveBeenCalled();
    },
  );
  it("does not reveal origin configuration errors", async () => {
    mocks.origin.mockImplementation(() => {
      throw new Error("private origin configuration");
    });
    const response = await POST(request());
    noGrant(response, 503);
    expect(await response.text()).not.toContain("private origin");
  });
});
