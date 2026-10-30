import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readNativeOrderPage,
  validNativeOrderQuery,
} from "./native-order-page";
import { nativeOrderFromAuthorization } from "./native-order";
import { GET } from "../app/api/orders/route";

vi.mock("@/lib/user-auth", () => ({
  requireUserSession: vi.fn(),
  UserAuthError: class extends Error {
    status = 401;
  },
}));
vi.mock("@/lib/native-order-verification", () => ({
  verifyNativeOrderSale: vi.fn(),
  OrderVerificationUnavailable: class extends Error {},
}));
const market = "0x1000000000000000000000000000000000000001";
const asset = "0x1000000000000000000000000000000000000002";
const seller = "0x1000000000000000000000000000000000000003";
function order(
  kind: "whole" | "fraction" = "whole",
  salt = "1",
  venue: Address = market,
) {
  return {
    ...nativeOrderFromAuthorization(
      kind,
      JSON.stringify({
        intent: {
          seller,
          paymentToken: asset,
          buyer: "0x0000000000000000000000000000000000000000",
          salt,
          startsAt: 1000,
          endsAt: 2000,
          epoch: "0",
          ...(kind === "whole"
            ? { collection: asset, tokenId: "1", price: "2" }
            : { assetToken: asset, maxAmount: "10", unitPrice: "2" }),
        },
        signature: "0x",
      }),
      venue,
    ),
    createdAt: "2026-10-02T10:00:00Z",
  };
}
const scope = (kind = "whole") =>
  new URLSearchParams({
    kind,
    chainId: "560048",
    marketAddress: market,
    assetAddress: asset,
    sellerAddress: seller,
    ...(kind === "whole" ? { tokenId: "1" } : {}),
    page: "2",
    pageSize: "20",
  });
const page = () => ({ data: [order()], total: 25, page: 2, pageSize: 20 });
describe("native signed order page admission", () => {
  it.each(["whole", "fraction"] as const)(
    "reads the exact %s scope and detaches signed terms",
    (kind) => {
      const input = { ...page(), data: [order(kind)] };
      const output = readNativeOrderPage(input, scope(kind));
      expect(output).toEqual(input);
      expect(output).not.toBe(input);
      expect(output.data[0].intent).not.toBe(input.data[0].intent);
      input.data[0].intent.salt = "99";
      expect(output.data[0].intent.salt).toBe("1");
    },
  );
  it("uses the native default page and size without requiring filters", () => {
    expect(
      readNativeOrderPage(
        { data: [order(), order("fraction")], total: 2, page: 1, pageSize: 20 },
        new URLSearchParams(),
      ).data,
    ).toHaveLength(2);
  });
  it("preserves an empty later page and does not invent an atomic count snapshot", () => {
    expect(
      readNativeOrderPage({ ...page(), data: [], total: 0 }, scope()).data,
    ).toEqual([]);
    expect(
      readNativeOrderPage({ ...page(), total: 0 }, scope()).data,
    ).toHaveLength(1);
  });
  it.each([
    null,
    [],
    {},
    { ...page(), page: 1 },
    { ...page(), page: "2" },
    { ...page(), pageSize: 100 },
    { ...page(), total: -1 },
    { ...page(), total: 1.5 },
    { ...page(), total: "25" },
    { ...page(), total: 2 ** 53 },
    { ...page(), data: null },
    {
      ...page(),
      data: Array.from({ length: 21 }, (_, i) => order("whole", String(i))),
    },
    { ...page(), internalCredential: "private" },
  ])("refuses a malformed or different page (%j)", (value) =>
    expect(() => readNativeOrderPage(value, scope())).toThrow(),
  );
  it.each([
    ["kind", "fraction"],
    ["chainId", "1"],
    ["marketAddress", seller],
    ["assetAddress", seller],
    ["sellerAddress", market],
    ["tokenId", "2"],
  ])("refuses a mismatched %s filter", (key, value) => {
    const query = scope();
    query.set(key, value);
    expect(() => readNativeOrderPage(page(), query)).toThrow();
  });
  it("rejects token selection for fractions and duplicate immutable identities", () => {
    const query = scope("fraction");
    query.set("tokenId", "1");
    expect(() =>
      readNativeOrderPage({ ...page(), data: [order("fraction")] }, query),
    ).toThrow();
    expect(() =>
      readNativeOrderPage({ ...page(), data: [order(), order()] }, scope()),
    ).toThrow();
  });
  it("keeps the same intent in distinct markets when the query does not select one", () => {
    const a = order();
    const b = order("whole", "1", seller);
    expect(
      readNativeOrderPage(
        { data: [a, b], total: 2, page: 1, pageSize: 20 },
        new URLSearchParams(),
      ).data,
    ).toHaveLength(2);
  });
  it.each([
    { ...order(), intentHash: `0x${"00".repeat(32)}` },
    { ...order(), verified: true },
    { ...order(), chainId: 1 },
    { ...order(), intent: { ...order().intent, price: "3" } },
    { ...order(), createdAt: "invalid" },
  ])("rejects the entire page when any signed record is malformed", (bad) => {
    expect(() =>
      readNativeOrderPage(
        { ...page(), data: [order("whole", "2"), bad] },
        scope(),
      ),
    ).toThrow();
  });
  it.each([
    "kind=whole&kind=fraction",
    "page=0",
    "page=01",
    "pageSize=101",
    "page=1000001",
    "chainId=1",
    "verified=true",
    "tokenId=01",
    "sellerAddress=invalid",
  ])("retains invalid query rejection: %s", (query) =>
    expect(validNativeOrderQuery(new URLSearchParams(query))).toBe(false),
  );
});

const fetcher = vi.fn();
beforeEach(() => {
  vi.stubEnv("ARTFI_API_URL", "https://api.example.invalid/base/");
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockResolvedValue(Response.json(page()));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("native order GET page boundary", () => {
  it("serves only the admitted requested page without forwarding private headers", async () => {
    const query = scope();
    const response = await GET(
      new Request(`https://app.example.test/api/orders?${query}`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page());
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      `https://api.example.invalid/base/v1/orders?${query}`,
    );
    expect(options.headers).toBeUndefined();
    expect(options.redirect).toBe("error");
  });
  it.each([
    { ...page(), page: 1 },
    { ...page(), data: [order("fraction")] },
    { ...page(), internalCredential: "secret-from-upstream" },
  ])(
    "does not return a mismatched or extra-field success payload",
    async (value) => {
      fetcher.mockResolvedValue(Response.json(value));
      const response = await GET(
        new Request(`https://app.example.test/api/orders?${scope()}`),
      );
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("secret-from-upstream");
    },
  );
  it("keeps an upstream refusal and sanitizes its private body", async () => {
    fetcher.mockResolvedValue(
      Response.json({ detail: "private-upstream" }, { status: 429 }),
    );
    const response = await GET(
      new Request(`https://app.example.test/api/orders?${scope()}`),
    );
    expect(response.status).toBe(429);
    expect(await response.text()).not.toContain("private-upstream");
  });
  it("rejects invalid filters before contacting the configured service", async () => {
    expect(
      (await GET(new Request("https://app.example.test/api/orders?page=0")))
        .status,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
