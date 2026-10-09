import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publicRuntimeConfig,
  publicRuntimeScript,
  publicSetting,
} from "./public-runtime-config";

afterEach(() => vi.unstubAllGlobals());
describe("public runtime configuration", () => {
  it("exposes only allowlisted public values and preserves missing configuration", () => {
    expect(
      publicRuntimeConfig({
        OPENSEA_API_KEY: "private",
        ARTFI_USER_SESSION_SECRET: "private",
        NEXT_PUBLIC_API_URL: "",
        NEXT_PUBLIC_BASE_RPC_URL: "https://rpc.example.test",
      }),
    ).toEqual({ NEXT_PUBLIC_BASE_RPC_URL: "https://rpc.example.test" });
  });
  it("reads server values at runtime and supports removing a previous value", () => {
    const previous = process.env.NEXT_PUBLIC_API_URL;
    try {
      process.env.NEXT_PUBLIC_API_URL = "https://one.example.test";
      expect(publicSetting("NEXT_PUBLIC_API_URL")).toBe(
        "https://one.example.test",
      );
      delete process.env.NEXT_PUBLIC_API_URL;
      expect(publicSetting("NEXT_PUBLIC_API_URL")).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = previous;
    }
  });
  it("uses the bootstrap in the browser without server environment access", () => {
    vi.stubGlobal("window", {
      __ARTFI_PUBLIC_CONFIG__: { NEXT_PUBLIC_API_URL: "/backend" },
    });
    expect(publicSetting("NEXT_PUBLIC_API_URL")).toBe("/backend");
    expect(publicSetting("NEXT_PUBLIC_ARTFI_FRACTION_SLUG")).toBeUndefined();
  });
  it("cannot close its script element or inject executable source", () => {
    const value = '</script><script>alert("x")</script>\u2028&';
    const source = publicRuntimeScript({ NEXT_PUBLIC_API_URL: value });
    expect(source).not.toContain("<");
    expect(source).not.toContain("&");
    const window: { __ARTFI_PUBLIC_CONFIG__?: unknown } = {};
    new Function("window", source)(window);
    expect(window.__ARTFI_PUBLIC_CONFIG__).toEqual({
      NEXT_PUBLIC_API_URL: value,
    });
  });
});
