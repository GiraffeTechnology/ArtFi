import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/portfolio/[address]/history/route";
import { requireUserSession, UserAuthError } from "./user-auth";
import { administrationRequestTimeoutMs } from "./administration-transport";
import { initialIndexedHistoryFilter as initial } from "./portfolio-indexed-history";

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
const owner = "0x1000000000000000000000000000000000000001";
const foreign = "0x1000000000000000000000000000000000000002";
const empty = () => ({
  address: owner,
  chainId: 560048,
  scope: "indexed_chain_events",
  filters: { ...initial },
  pageSize: 10,
  total: 0,
  data: [],
});
const upstream = vi.fn();
const context = { params: Promise.resolve({ address: owner }) };
const request = (query = "") =>
  new Request(
    `https://app.example.invalid/api/portfolio/${owner}/history${query}`,
    {
      headers: {
        authorization: "TEST_ONLY_UNTRUSTED_BROWSER",
        cookie: "TEST_ONLY_BROWSER_COOKIE",
      },
    },
  );
beforeEach(() => {
  vi.stubEnv("ARTFI_API_URL", "https://api.example.invalid/base/");
  vi.stubGlobal("fetch", upstream);
  upstream.mockReset().mockResolvedValue(Response.json(empty()));
  vi.mocked(requireUserSession)
    .mockReset()
    .mockResolvedValue({
      accessToken: "TEST_ONLY_ORIGINAL_SERVER_SESSION",
    } as Awaited<ReturnType<typeof requireUserSession>>);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("private indexed history BFF", () => {
  it("forwards only the original server session token to the original authenticated Go route", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(empty());
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(requireUserSession).toHaveBeenCalledExactlyOnceWith(owner);
    const [url, init] = upstream.mock.calls[0];
    expect(String(url)).toBe(
      `https://api.example.invalid/base/v1/portfolio/${owner}/history?status=all&order=newest&page=1`,
    );
    expect(init.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer TEST_ONLY_ORIGINAL_SERVER_SESSION",
    });
    expect(JSON.stringify(init)).not.toContain("TEST_ONLY_UNTRUSTED_BROWSER");
    expect(JSON.stringify(init)).not.toContain("TEST_ONLY_BROWSER_COOKIE");
  });
  it.each([401, 403])(
    "preserves original session HTTP%s without querying the index",
    async (status) => {
      vi.mocked(requireUserSession).mockRejectedValueOnce(
        new UserAuthError(status, "TEST_ONLY_INTERNAL_AUTH"),
      );
      const response = await GET(request(), context);
      expect(response.status).toBe(status);
      expect(upstream).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain("TEST_ONLY_INTERNAL_AUTH");
    },
  );
  it.each([401, 403])(
    "preserves Go session HTTP%s without echoing its error body",
    async (status) => {
      upstream.mockResolvedValueOnce(
        Response.json({ detail: "TEST_ONLY_INTERNAL_GO_REASON" }, { status }),
      );
      const response = await GET(request(), context);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(
        "TEST_ONLY_INTERNAL_GO_REASON",
      );
    },
  );
  it.each([
    "?chainId=1",
    "?address=foreign",
    "?pageSize=100",
    "?page=0",
    "?status=all&status=removed",
  ])("rejects identity overrides or ambiguity: %s", async (query) => {
    expect((await GET(request(query), context)).status).toBe(400);
    expect(requireUserSession).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
  it("refuses a successful upstream page belonging to another wallet", async () => {
    upstream.mockResolvedValueOnce(
      Response.json({ ...empty(), address: foreign }),
    );
    const response = await GET(request(), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(foreign);
  });
  it("bounds the original session lookup and never forwards after a late completion", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    vi.mocked(requireUserSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ accessToken: "TEST_ONLY_LATE" } as Awaited<
              ReturnType<typeof requireUserSession>
            >);
        }),
    );
    const pending = GET(request(), context);
    await vi.advanceTimersByTimeAsync(administrationRequestTimeoutMs + 1);
    expect((await pending).status).toBe(503);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("does not decode or expose a non-JSON upstream success", async () => {
    upstream.mockResolvedValueOnce(
      new Response("TEST_ONLY_PRIVATE", {
        headers: { "content-type": "text/plain" },
      }),
    );
    const response = await GET(request(), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("TEST_ONLY_PRIVATE");
  });
});
