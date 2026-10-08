import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, dynamic, runtime } from "../app/api/wallet-config/route";
import { parseXionganWalletURL } from "./xiongan-wallet";
import {
  fetchXionganWalletConfig,
  walletConfigView,
} from "./xiongan-wallet-config";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const urls = [
  "https://wallet-a.example:18443/wallet/index.html",
  "https://wallet-b.example:29444/tenant/xiongan/",
];

describe("deployment wallet URL validation", () => {
  it.each([
    ...urls,
    "https://example.test:18080/custom/path",
    "https://example.test/a",
    "https://[::1]:19444/entry",
    "HTTPS://Wallet.Example:25443/custom",
  ])("preserves an explicitly configured full URL: %s", (url) => {
    expect(parseXionganWalletURL(url)).toEqual({ ok: true, url });
  });
  it.each([undefined, null, ""])("has no default for %s", (value) => {
    expect(parseXionganWalletURL(value)).toEqual({
      ok: false,
      code: "NOT_CONFIGURED",
    });
  });
  it.each([
    " ",
    "not-a-url",
    "/wallet",
    "//wallet.example/path",
    "https:wallet.example",
    "http://wallet.example/a",
    "javascript:alert(1)",
    "data:text/html,test",
    "https://user:password@example.test/wallet",
    "https://user@example.test/wallet",
    "https://example.test/?token=secret",
    "https://example.test/#account=private",
    "https://example.test:99999/",
    " https://example.test/",
    "https://example.test/\n",
    "https://example.test\\other",
    42,
    {},
  ])("rejects invalid, unsafe or payload-bearing configuration %s", (value) => {
    expect(parseXionganWalletURL(value)).toEqual({
      ok: false,
      code: "INVALID_CONFIG",
    });
  });
  it("reads deployment environment for every request, independent of build time", async () => {
    expect(dynamic).toBe("force-dynamic");
    expect(runtime).toBe("nodejs");
    for (const url of urls) {
      vi.stubEnv("ARTFI_XIONGAN_WALLET_URL", url);
      const response = await GET();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ ok: true, url });
    }
    vi.stubEnv("ARTFI_XIONGAN_WALLET_URL", "");
    expect(await (await GET()).json()).toEqual({
      ok: false,
      code: "NOT_CONFIGURED",
    });
    vi.stubEnv(
      "ARTFI_XIONGAN_WALLET_URL",
      "https://private:secret@example.test/",
    );
    const text = await (await GET()).text();
    expect(JSON.parse(text)).toEqual({ ok: false, code: "INVALID_CONFIG" });
    expect(text).not.toMatch(/private|secret|example/);
  });
});

describe("public configuration transport", () => {
  it("uses only the same-origin read route without credentials or cached redirects", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ ok: true, url: urls[0], private: "discard" }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await fetchXionganWalletConfig(new AbortController().signal),
    ).toEqual({ ok: true, url: urls[0] });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/wallet-config",
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it.each([
    { ok: false, code: "NOT_CONFIGURED" },
    { ok: false, code: "INVALID_CONFIG" },
  ])("preserves the public failure code %s", async (body) => {
    vi.stubGlobal("fetch", async () => Response.json(body));
    expect(
      await fetchXionganWalletConfig(new AbortController().signal),
    ).toEqual(body);
  });
  it.each([
    null,
    {},
    { ok: true },
    { ok: true, url: "javascript:alert(1)" },
    { ok: true, url: "https://user:pass@example.test" },
    { ok: false, code: "private error" },
  ])(
    "rejects malformed config %s without an old URL fallback",
    async (body) => {
      vi.stubGlobal("fetch", async () => Response.json(body));
      await expect(
        fetchXionganWalletConfig(new AbortController().signal),
      ).rejects.toThrow("Wallet configuration unavailable");
    },
  );
  it("uses AbortController without requiring AbortSignal.any or timeout", async () => {
    const any = vi.spyOn(AbortSignal, "any").mockImplementation(() => {
      throw new Error("unsupported");
    });
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      throw new Error("unsupported");
    });
    vi.stubGlobal("fetch", async () =>
      Response.json({ ok: true, url: urls[0] }),
    );
    try {
      expect(
        await fetchXionganWalletConfig(new AbortController().signal),
      ).toEqual({ ok: true, url: urls[0] });
      expect(any).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      any.mockRestore();
      timeout.mockRestore();
    }
  });
  it.each(["caller", "timeout"] as const)(
    "aborts the read and clears its timer on %s cancellation",
    async (source) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      vi.stubGlobal(
        "fetch",
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
      );
      const result = fetchXionganWalletConfig(controller.signal);
      const rejected = expect(result).rejects.toThrow("aborted");
      if (source === "caller") controller.abort();
      else await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("fails closed on API outage", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("unavailable", { status: 503 }),
    );
    await expect(
      fetchXionganWalletConfig(new AbortController().signal),
    ).rejects.toThrow("Wallet configuration unavailable");
  });
  it.each(["fetching", "paused"] as const)(
    "hides a cached destination while %s",
    (fetchStatus) => {
      const result = walletConfigView({
        fetchStatus,
        isPending: false,
        isError: false,
        data: { ok: true, url: urls[0] },
      });
      expect(result.ok).toBe(false);
    },
  );
  it("hides a previous destination on failure then adopts refreshed configuration", () => {
    expect(
      walletConfigView({
        fetchStatus: "idle",
        isPending: false,
        isError: true,
        data: { ok: true, url: urls[0] },
      }),
    ).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(
      walletConfigView({
        fetchStatus: "idle",
        isPending: false,
        isError: false,
        data: { ok: true, url: urls[1] },
      }),
    ).toEqual({ ok: true, url: urls[1] });
  });
});
