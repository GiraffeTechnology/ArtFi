import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../app/api/orders/route";
import { GET as detailGET } from "../app/api/orders/[intentHash]/route";
import { nativeOrderFromAuthorization } from "./native-order";

import { UserAuthError } from "./user-auth";

const verification = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => vi.fn());
vi.mock("@/lib/user-auth", () => ({
  requireUserSession: session,
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
  verifyNativeOrderSale: verification,
  OrderVerificationUnavailable: class extends Error {},
}));
const market = "0x1000000000000000000000000000000000000001";
const asset = "0x1000000000000000000000000000000000000002";
const order = nativeOrderFromAuthorization(
  "whole",
  JSON.stringify({
    intent: {
      seller: asset,
      collection: asset,
      tokenId: "1",
      paymentToken: asset,
      price: "2",
      buyer: "0x0000000000000000000000000000000000000000",
      salt: "1",
      startsAt: 1000,
      endsAt: 2000,
      epoch: "0",
    },
    signature: "0x",
  }),
  market,
);
const fetcher = vi.fn();
function request(body: unknown = { order }, origin = "https://io.artcch.com") {
  return new Request("https://io.artcch.com/api/orders", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.stubEnv("ARTFI_WEB_URL", "https://io.artcch.com");
  vi.stubEnv("ARTFI_API_URL", "https://api.example.invalid");
  vi.stubEnv("ARTFI_INDEXER_SHARED_KEY", "test-only-existing-indexer-key");
  vi.stubGlobal("fetch", fetcher);
  verification.mockResolvedValue(undefined);
  session.mockResolvedValue({ accessToken: "test-only-user-access-token" });
  fetcher.mockResolvedValue(
    Response.json(
      { ...order, createdAt: "2026-10-02T10:00:00Z" },
      { status: 201 },
    ),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("native order HTTP boundary", () => {
  it("verifies before forwarding to the internal indexer path and never returns its credential", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(session).toHaveBeenCalledWith(String(order.intent.seller));
    expect(verification).toHaveBeenCalledWith(order);
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.example.invalid/v1/indexer/signed-orders",
    );
    expect(options.headers["X-Indexer-Key"]).toBe(
      "test-only-existing-indexer-key",
    );
    expect(options.headers.Authorization).toBe(
      "Bearer test-only-user-access-token",
    );
    expect(options.redirect).toBe("error");
    expect(options.body).toBe(JSON.stringify(order));
    const responseText = await response.text();
    expect(responseText).not.toContain("test-only-existing-indexer-key");
    expect(responseText).not.toContain("test-only-user-access-token");
  });
  it.each([401, 403])(
    "refuses a missing or different-seller session (%i) before verification or persistence",
    async (status) => {
      session.mockRejectedValue(
        new UserAuthError(status, "Sign in with the seller wallet."),
      );
      expect((await POST(request())).status).toBe(status);
      expect(verification).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("preserves the configured bridge prefix while forwarding the seller session", async () => {
    vi.stubEnv(
      "ARTFI_API_URL",
      "https://api.example.invalid/existing-bridge/artfi/",
    );
    expect((await POST(request())).status).toBe(201);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://api.example.invalid/existing-bridge/artfi/v1/indexer/signed-orders",
    );
  });
  it("rejects unverified publication before the durable request", async () => {
    verification.mockRejectedValue(new Error("bad signature"));
    expect((await POST(request())).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects a foreign origin, caller verified flags and oversized bodies", async () => {
    expect(
      (await POST(request(undefined, "https://other.example"))).status,
    ).toBe(403);
    expect(
      (
        await POST(
          request({
            order: { ...order, verified: true },
          }),
        )
      ).status,
    ).toBe(400);
    expect((await POST(request({ padding: "x".repeat(33000) }))).status).toBe(
      413,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports unavailable when the existing internal credential is not configured", async () => {
    vi.stubEnv("ARTFI_INDEXER_SHARED_KEY", "");
    expect((await POST(request())).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not turn a persistence outage into a successful empty list", async () => {
    fetcher.mockResolvedValue(
      Response.json({ detail: "internal topology" }, { status: 503 }),
    );
    const response = await GET(
      new Request("https://io.artcch.com/api/orders?kind=whole"),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("internal topology");
  });
  it("refuses unknown list filters and malformed linked order hashes", async () => {
    expect(
      (await GET(new Request("https://io.artcch.com/api/orders?verified=true")))
        .status,
    ).toBe(400);
    expect(
      (
        await detailGET(new Request("https://io.artcch.com/api/orders/bad"), {
          params: Promise.resolve({ intentHash: "bad" }),
        })
      ).status,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("loads a hash only with the exact public scope and without server credentials", async () => {
    const query = `chainId=560048&marketAddress=${market}`;
    const response = await detailGET(
      new Request(
        `https://io.artcch.com/api/orders/${order.intentHash}?${query}`,
      ),
      { params: Promise.resolve({ intentHash: order.intentHash }) },
    );
    expect(response.status).toBe(201);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      `https://api.example.invalid/v1/orders/${order.intentHash}?${query}`,
    );
    expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
  });
});
