import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  administrationRequest,
  AdministrationRequestError,
} from "./administration";
import { GET, PUT } from "../app/api/administration/[...path]/route";
import {
  administrationText,
  administrationJSON,
  withAdministrationDeadline,
  administrationErrorMessage,
  administrationResponseByteLimit,
} from "./administration-transport";
const auth = vi.hoisted(() => ({ session: vi.fn(), origin: vi.fn() }));
vi.mock("@/lib/user-auth", () => ({
  requireUserSession: auth.session,
  assertUserRequestOrigin: auth.origin,
  UserAuthError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
const wallet = "0x" + "1".repeat(40),
  encoder = new TextEncoder();
const headers = { "content-type": "application/json" };
function pending() {
  return new Promise<never>(() => undefined);
}
function observe<T>(p: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = {
    settled: false,
  };
  void p.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}
function api(
  path = "admin/config",
  method = "GET",
  payload?: string | ReadableStream<Uint8Array>,
  signal?: AbortSignal,
) {
  const request = new Request(`https://web.test/api/administration/${path}`, {
    method,
    headers: {
      "x-artfi-wallet": wallet,
      "x-artfi-chain": "560048",
      "idempotency-key": "TEST_ONLY-identical-retry-key",
      ...headers,
    },
    body: payload,
    signal,
    ...(payload instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
  return (method === "GET" ? GET : PUT)(request, {
    params: Promise.resolve({ path: path.split("/") }),
  });
}
function hanging() {
  return new Response(
    new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        return pending();
      },
    }),
    { headers },
  );
}
function fixedStream(
  chunks: Uint8Array[],
  extraHeaders: Record<string, string> = {},
) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const x of chunks) c.enqueue(x);
        c.close();
      },
    }),
    { headers: { ...headers, ...extraHeaders } },
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("ARTFI_API_URL", "https://api.test/artfi");
  auth.session
    .mockReset()
    .mockResolvedValue({ accessToken: "TEST_ONLY-admin-token" });
  auth.origin.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("parent boundary defects", () => {
  it("browser header stall settles at the whole deadline without retry", async () => {
    const fetch = vi.fn(() => pending());
    vi.stubGlobal("fetch", fetch);
    const state = observe(
      administrationRequest(
        "admin/config",
        { address: wallet, chainId: 560048 },
        {
          method: "PUT",
          body: { revision: 1 },
          key: "TEST_ONLY-identical-retry-key",
        },
      ),
    );
    await vi.advanceTimersByTimeAsync(8001);
    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(AdministrationRequestError);
    expect((state.error as AdministrationRequestError).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("browser body stall settles even when cancellation never resolves", async () => {
    const fetch = vi.fn().mockResolvedValue(hanging());
    vi.stubGlobal("fetch", fetch);
    const state = observe(administrationRequest("admin/config"));
    await vi.advanceTimersByTimeAsync(8001);
    expect(state.settled).toBe(true);
    expect((state.error as AdministrationRequestError).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("browser rejects an untrusted error detail without exposing topology", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { detail: "private database topology and password" },
            { status: 403 },
          ),
        ),
    );
    const state = observe(administrationRequest("admin/config"));
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expect((state.error as Error).message).toBe(
      "This wallet does not have the required permission.",
    );
    expect((state.error as Error).message).not.toMatch(/topology|password/);
  });
  it("bridge refusal does not wait for an error body cancellation", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          return pending();
        },
      }),
      { status: 403 },
    );
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    const state = observe(api());
    await vi.advanceTimersByTimeAsync(8001);
    expect(state.settled).toBe(true);
    expect(state.value?.status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await state.value?.text()).not.toContain("TEST_ONLY-admin-token");
  });
  it("bridge ignores a never-settled header result after the whole deadline", async () => {
    const fetch = vi.fn(() => pending());
    vi.stubGlobal("fetch", fetch);
    const state = observe(api());
    await vi.advanceTimersByTimeAsync(8001);
    expect(state.settled).toBe(true);
    expect(state.value?.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await state.value?.text()).toContain("No change was confirmed");
  });
});
describe("bounded administration transport and bridge", () => {
  it("retains the exact revision/key and same-origin/no-store/redirect-error semantics", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ revision: 4 }));
    vi.stubGlobal("fetch", fetch);
    expect(
      await administrationRequest(
        "admin/config",
        { address: wallet, chainId: 560048 },
        {
          method: "PUT",
          body: { revision: 3 },
          key: "TEST_ONLY-identical-retry-key",
        },
      ),
    ).toEqual({ revision: 4 });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/administration/admin/config",
      expect.objectContaining({
        method: "PUT",
        body: '{"revision":3}',
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: expect.objectContaining({
          "x-artfi-wallet": wallet,
          "x-artfi-chain": "560048",
          "idempotency-key": "TEST_ONLY-identical-retry-key",
        }),
      }),
    );
  });
  it("cleans up a late ignored fetch response without publishing it", async () => {
    let release!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const state = observe(administrationRequest("admin/config"));
    await vi.advanceTimersByTimeAsync(8001);
    const before = state.error;
    const cancel = vi.fn();
    release(new Response(new ReadableStream({ cancel }), { headers }));
    await vi.advanceTimersByTimeAsync(1);
    expect(state.error).toBe(before);
    expect(state.value).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("pre-aborted browser request performs no fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      administrationRequest("admin/config", undefined, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("caller abort settles a browser stream once and prevents replay", async () => {
    const controller = new AbortController(),
      fetch = vi.fn().mockResolvedValue(hanging());
    vi.stubGlobal("fetch", fetch);
    const state = observe(
      administrationRequest("admin/config", undefined, {
        signal: controller.signal,
      }),
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expect((state.error as AdministrationRequestError).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 409, 422, 503])(
    "refusal %i is bounded even without a readable JSON error",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response("not JSON private text", { status })),
      );
      await expect(administrationRequest("admin/config")).rejects.toMatchObject(
        { status, message: administrationErrorMessage(status) },
      );
    },
  );
  it.each([
    "wrong-mime",
    "invalid-json",
    "invalid-utf8",
    "oversize",
    "declared-oversize",
    "invalid-length",
  ])("browser rejects %s without exposing the response", async (mode) => {
    const response =
      mode === "wrong-mime"
        ? new Response("private upstream text", {
            headers: { "content-type": "text/html" },
          })
        : mode === "invalid-json"
          ? new Response("private upstream text", { headers })
          : mode === "invalid-utf8"
            ? fixedStream([Uint8Array.of(0xc3, 0x28)])
            : mode === "oversize"
              ? fixedStream([
                  encoder.encode(
                    JSON.stringify({
                      value: "x".repeat(administrationResponseByteLimit),
                    }),
                  ),
                ])
              : fixedStream([encoder.encode("{}")], {
                  "content-length":
                    mode === "declared-oversize"
                      ? String(administrationResponseByteLimit + 1)
                      : "invalid",
                });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(administrationRequest("admin/config")).rejects.toMatchObject({
      status: 503,
      message: administrationErrorMessage(503),
    });
  });
  it("decodes split multibyte UTF-8 within the response budget", async () => {
    const raw = encoder.encode('{"notice":"日本語"}');
    const response = fixedStream([
      raw.slice(0, 12),
      raw.slice(12, 13),
      raw.slice(13),
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await administrationRequest("platform/config")).toEqual({
      notice: "日本語",
    });
  });
  it("bridge applies one budget to header and body phases combined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return hanging();
      }),
    );
    const state = observe(api());
    await vi.advanceTimersByTimeAsync(7999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(state.settled).toBe(true);
    expect(state.value?.status).toBe(503);
  });
  it("aborted slow authentication cannot later start an upstream request", async () => {
    let release!: (value: { accessToken: string }) => void;
    auth.session.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const state = observe(api());
    await vi.advanceTimersByTimeAsync(8001);
    expect(state.value?.status).toBe(503);
    release({ accessToken: "TEST_ONLY-late-token" });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("bridge bounds a stalled incoming mutation before sending anything", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        return pending();
      },
    });
    const state = observe(api("admin/config", "PUT", body));
    await vi.advanceTimersByTimeAsync(8001);
    expect(state.settled).toBe(true);
    expect(state.value?.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("bridge caller abort retires a pending request without replay", async () => {
    const controller = new AbortController(),
      fetch = vi.fn(() => pending());
    vi.stubGlobal("fetch", fetch);
    const state = observe(
      api("admin/config", "GET", undefined, controller.signal),
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.value?.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("response at the precise byte limit is accepted", async () => {
    const text = JSON.stringify({
      v: "x".repeat(administrationResponseByteLimit - 8),
    });
    expect(encoder.encode(text).length).toBe(administrationResponseByteLimit);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(text, { headers })),
    );
    expect(
      (await administrationRequest<{ v: string }>("admin/config")).v.length,
    ).toBe(administrationResponseByteLimit - 8);
  });
  it("a bridge oversized request fails before upstream dispatch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await api(
      "admin/config",
      "PUT",
      JSON.stringify({ text: "x".repeat(16384) }),
    );
    expect(response.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("shared reader enforces its requested limit and rejects invalid bounds", async () => {
    const signal = new AbortController().signal;
    await expect(
      administrationText(Response.json({ a: 1 }), 2, signal),
    ).rejects.toThrow();
    await expect(
      administrationText(Response.json({}), 0, signal),
    ).rejects.toThrow(RangeError);
    await expect(
      administrationJSON(new Response("{}"), signal),
    ).rejects.toThrow();
  });
  it("shared whole-operation cancellation does not await ignored work", async () => {
    const state = observe(withAdministrationDeadline(() => pending()));
    await vi.advanceTimersByTimeAsync(8001);
    expect(state.settled).toBe(true);
    expect((state.error as Error).message).toBe(
      administrationErrorMessage(503),
    );
  });
});
