import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/portfolio/[address]/orders/route";
import { requireUserSession, UserAuthError } from "./user-auth";
import { administrationRequestTimeoutMs } from "./administration-transport";
import {
  publicationAsset,
  publicationPage,
  publicationSeller,
} from "./portfolio-publication.test-fixture";

vi.mock("@/lib/user-auth", () => ({
  requireUserSession: vi.fn(),
  UserAuthError: class extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
const upstream = vi.fn();
const context = (address = publicationSeller) => ({
  params: Promise.resolve({ address }),
});
const request = (query = "") =>
  new Request(
    `https://app.example.invalid/api/portfolio/${publicationSeller}/orders${query}`,
    {
      headers: {
        authorization: "TEST_ONLY_BROWSER_HEADER",
        cookie: "TEST_ONLY_BROWSER_COOKIE",
      },
    },
  );
beforeEach(() => {
  vi.stubEnv("ARTFI_API_URL", "https://api.example.invalid/base/");
  vi.stubGlobal("fetch", upstream);
  upstream.mockReset().mockResolvedValue(Response.json(publicationPage()));
  vi.mocked(requireUserSession)
    .mockReset()
    .mockResolvedValue({ accessToken: "TEST_ONLY_NOT_FORWARDED" } as Awaited<
      ReturnType<typeof requireUserSession>
    >);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("authenticated personal publication BFF", () => {
  it("binds the existing index to this session seller and strips browser credentials", async () => {
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(publicationPage());
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(requireUserSession).toHaveBeenCalledExactlyOnceWith(
      publicationSeller,
    );
    const [url, init] = upstream.mock.calls[0];
    const query = new URL(String(url)).searchParams;
    expect(String(url)).toContain(
      "https://api.example.invalid/base/v1/orders?",
    );
    expect(Object.fromEntries(query)).toEqual({
      chainId: "560048",
      sellerAddress: publicationSeller,
      page: "1",
      pageSize: "10",
    });
    expect(init.headers).toEqual({ accept: "application/json" });
    expect(init.redirect).toBe("error");
    expect(JSON.stringify(init)).not.toContain("TEST_ONLY_NOT_FORWARDED");
    expect(JSON.stringify(init)).not.toContain("TEST_ONLY_BROWSER");
  });
  it.each([401, 403])(
    "preserves original session HTTP%s before reading publications",
    async (status) => {
      vi.mocked(requireUserSession).mockRejectedValueOnce(
        new UserAuthError(status, "TEST_ONLY_PRIVATE_AUTH_REASON"),
      );
      const response = await GET(request(), context());
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain(
        "TEST_ONLY_PRIVATE_AUTH_REASON",
      );
      expect(upstream).not.toHaveBeenCalled();
    },
  );
  it.each([
    "?sellerAddress=foreign",
    "?chainId=1",
    "?pageSize=100",
    "?page=0",
    "?kind=whole&kind=fraction",
  ])(
    "rejects an identity/filter override before authentication: %s",
    async (query) => {
      expect((await GET(request(query), context())).status).toBe(400);
      expect(requireUserSession).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
    },
  );
  it("refuses an upstream success for a different seller", async () => {
    const value = publicationPage();
    value.data[0].intent.seller = publicationAsset;
    upstream.mockResolvedValueOnce(Response.json(value));
    const response = await GET(request(), context());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(publicationAsset);
  });
  it("does not echo private upstream error bodies", async () => {
    upstream.mockResolvedValueOnce(
      Response.json(
        { detail: "TEST_ONLY_INTERNAL_DIAGNOSTIC" },
        { status: 500 },
      ),
    );
    const response = await GET(request(), context());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(
      "TEST_ONLY_INTERNAL_DIAGNOSTIC",
    );
  });
  it("bounds a stalled original session read and never contacts the index after late completion", async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    vi.mocked(requireUserSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () =>
            resolve({ accessToken: "TEST_ONLY" } as Awaited<
              ReturnType<typeof requireUserSession>
            >);
        }),
    );
    const pending = GET(request(), context());
    await vi.advanceTimersByTimeAsync(administrationRequestTimeoutMs + 1);
    expect((await pending).status).toBe(503);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(upstream).not.toHaveBeenCalled();
  });
});
