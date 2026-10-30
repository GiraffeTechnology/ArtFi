import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../app/api/orders/route";
import { GET as detailGET } from "../app/api/orders/[intentHash]/route";
import { nativeOrderFromAuthorization } from "./native-order";
import { boundedOrderText, nativeOrderResponse } from "./native-order-upstream";

const auth = vi.hoisted(() => ({ session: vi.fn(), verification: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/user-auth", () => ({
  requireUserSession: auth.session,
  UserAuthError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/native-order-verification", () => ({
  verifyNativeOrderSale: auth.verification,
  OrderVerificationUnavailable: class extends Error {},
}));
const address = `0x${"1".repeat(40)}`;
const market = `0x${"2".repeat(40)}` as const;
const order = nativeOrderFromAuthorization(
  "whole",
  JSON.stringify({
    intent: {
      seller: address,
      collection: address,
      tokenId: "1",
      paymentToken: address,
      price: "2",
      buyer: `0x${"0".repeat(40)}`,
      salt: "1",
      startsAt: 1000,
      endsAt: 2000,
      epoch: "0",
    },
    signature: "0x",
  }),
  market,
);
const fetcher = vi.fn<typeof fetch>();
function request(
  body: BodyInit = JSON.stringify({ order }),
  signal?: AbortSignal,
) {
  return new Request("https://artfi.example/api/orders", {
    method: "POST",
    signal,
    headers: {
      origin: "https://artfi.example",
      "content-type": "application/json",
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
function stalled() {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel,
  });
  return { body, cancel };
}
beforeEach(() => {
  vi.stubEnv("ARTFI_WEB_URL", "https://artfi.example");
  vi.stubEnv("ARTFI_API_URL", "https://api.example.invalid/existing-prefix");
  vi.stubEnv("ARTFI_INDEXER_SHARED_KEY", "TEST_ONLY_INDEXER_KEY");
  auth.session
    .mockReset()
    .mockResolvedValue({ accessToken: "TEST_ONLY_USER_ACCESS" });
  auth.verification.mockReset().mockResolvedValue(undefined);
  fetcher.mockReset();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("bounded native order body reads", () => {
  it("preserves split UTF8 code points and counts bytes instead of code units", async () => {
    const bytes = new TextEncoder().encode("English €漢字");
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (offset === bytes.length) c.close();
        else c.enqueue(bytes.slice(offset, ++offset));
      },
    });
    expect(await boundedOrderText(body, bytes.length)).toBe("English €漢字");
    await expect(
      boundedOrderText(new Response("€").body, 2),
    ).rejects.toMatchObject({ reason: "too-large" });
  });
  it("retains the larger existing fraction-book quota", async () => {
    const text = "x".repeat(3 * 1024 * 1024);
    expect(
      (await boundedOrderText(new Response(text).body, 12 * 1024 * 1024))
        .length,
    ).toBe(text.length);
  });
  it("refuses oversized data without waiting for cancellation to finish", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(9));
      },
      cancel,
    });
    await expect(boundedOrderText(body, 8)).rejects.toMatchObject({
      reason: "too-large",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
  it("settles a stalled read at the bounded default deadline", async () => {
    vi.useFakeTimers();
    const s = stalled();
    const pending = expect(boundedOrderText(s.body, 32)).rejects.toMatchObject({
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(15001);
    await pending;
    expect(s.cancel).toHaveBeenCalledTimes(1);
    expect(s.body.locked).toBe(false);
  });
  it.each(["before", "during"] as const)(
    "honors an external abort %s reading",
    async (when) => {
      const abort = new AbortController(),
        s = stalled();
      if (when === "before") abort.abort();
      const pending = expect(
        boundedOrderText(s.body, 32, { signal: abort.signal }),
      ).rejects.toMatchObject({ reason: "aborted" });
      abort.abort();
      await pending;
      expect(s.cancel).toHaveBeenCalledTimes(1);
      expect(s.body.locked).toBe(false);
    },
  );
  it("rejects invalid UTF8 and redacts an underlying read exception", async () => {
    await expect(
      boundedOrderText(new Response(new Uint8Array([0xc3, 0x28])).body, 32),
    ).rejects.toMatchObject({ reason: "invalid" });
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw Error("TEST_ONLY_PRIVATE_UPSTREAM");
      },
    });
    await expect(boundedOrderText(body, 32)).rejects.toMatchObject({
      reason: "invalid",
      message: "The order payload could not be read.",
    });
  });
  it("returns a sanitized conflict without parsing or waiting for its body", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = await nativeOrderResponse(
      new Response(new ReadableStream({ cancel }), { status: 409 }),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      detail: "The order service could not complete this request.",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("native order route read failures", () => {
  it("ends a stalled publication body before session verification or forwarding", async () => {
    vi.useFakeTimers();
    const s = stalled();
    const pending = POST(request(s.body));
    await vi.advanceTimersByTimeAsync(5001);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(auth.session).not.toHaveBeenCalled();
    expect(auth.verification).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(s.cancel).toHaveBeenCalledTimes(1);
  });
  it("refuses oversized publication bytes even if cancellation never finishes", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(32769));
      },
      cancel,
    });
    expect((await POST(request(body))).status).toBe(413);
    expect(auth.session).not.toHaveBeenCalled();
    expect(auth.verification).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("refuses invalidUTF8 before authentication or publication", async () => {
    expect((await POST(request(new Uint8Array([0xff])))).status).toBe(400);
    expect(auth.session).not.toHaveBeenCalled();
    expect(auth.verification).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps a timed-out publication response unknown and does not submit twice", async () => {
    vi.useFakeTimers();
    const s = stalled();
    fetcher.mockResolvedValue(new Response(s.body));
    const pending = POST(request());
    await vi.advanceTimersByTimeAsync(5001);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(auth.session).toHaveBeenCalledTimes(1);
    expect(auth.verification).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.example.invalid/existing-prefix/v1/indexer/signed-orders",
    );
    expect(options!.body).toBe(JSON.stringify(order));
    const text = await response.text();
    expect(text).not.toContain("TEST_ONLY_INDEXER_KEY");
    expect(text).not.toContain("TEST_ONLY_USER_ACCESS");
    expect(s.cancel).toHaveBeenCalledTimes(1);
  });
  it.each(["list", "detail"] as const)(
    "bounds a stalled %s response without private headers",
    async (view) => {
      vi.useFakeTimers();
      const s = stalled();
      fetcher.mockResolvedValue(new Response(s.body));
      const pending =
        view === "list"
          ? GET(new Request("https://artfi.example/api/orders?kind=whole"))
          : detailGET(
              new Request(
                `https://artfi.example/api/orders/${order.intentHash}?chainId=560048&marketAddress=${market}`,
              ),
              { params: Promise.resolve({ intentHash: order.intentHash }) },
            );
      await vi.advanceTimersByTimeAsync(5001);
      expect((await pending).status).toBe(503);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1]!.headers).toBeUndefined();
      expect(s.cancel).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves a durable conflict without replay or exposing private upstream bytes", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    fetcher.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), { status: 409 }),
    );
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await response.text()).not.toContain("TEST_ONLY_");
  });
});
