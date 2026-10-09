import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiRuntimeCommand, webRuntime } from "../e2e-runtime";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function commandWords(command: string) {
  return execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${command}`], {
    encoding: "utf8",
  })
    .trimEnd()
    .split("\n");
}

describe("isolated browser runtime selection", () => {
  it.each([undefined, ""])(
    "preserves source commands and fixture environment without a bundle (%s)",
    (bundleRoot) => {
      vi.stubEnv("ARTFI_E2E_BUNDLE_ROOT", bundleRoot);
      const env = { NEXT_PUBLIC_HOODI_RPC_URL: "http://127.0.0.1:3001/rpc" };
      expect(webRuntime("next dev --webpack", "127.0.0.1", 3001, env)).toEqual({
        command: "next dev --webpack",
        env,
      });
      expect(apiRuntimeCommand("go run ./cmd/server")).toBe(
        "go run ./cmd/server",
      );
    },
  );

  it("uses the bundled Node and standalone server with the assigned fixture address", () => {
    vi.stubEnv("ARTFI_E2E_BUNDLE_ROOT", "/tmp/TEST_ONLY-artfi-bundle");
    const runtime = webRuntime("next start", "127.0.0.1", 3005, {
      NEXT_PUBLIC_ETHEREUM_RPC_URL: "http://127.0.0.1:3005/TEST_ONLY-nft-rpc",
      ARTFI_API_URL: "",
      HOSTNAME: "ignored",
      PORT: "9999",
    });
    expect(commandWords(runtime.command)).toEqual([
      "/tmp/TEST_ONLY-artfi-bundle/runtime/bin/node",
      "/tmp/TEST_ONLY-artfi-bundle/runtime/web/apps/web/server.js",
    ]);
    expect(runtime.env).toEqual({
      NEXT_PUBLIC_ETHEREUM_RPC_URL: "http://127.0.0.1:3005/TEST_ONLY-nft-rpc",
      ARTFI_API_URL: "",
      HOSTNAME: "127.0.0.1",
      PORT: "3005",
    });
  });

  it("uses the precompiled API without invoking Go", () => {
    vi.stubEnv("ARTFI_E2E_BUNDLE_ROOT", "/tmp/TEST_ONLY-artfi-bundle");
    expect(commandWords(apiRuntimeCommand("go run ./cmd/server"))).toEqual([
      "/tmp/TEST_ONLY-artfi-bundle/runtime/bin/artfi-api",
    ]);
  });

  it("resolves relative bundle paths before launching from a server working directory", () => {
    vi.stubEnv("ARTFI_E2E_BUNDLE_ROOT", "TEST_ONLY-bundle");
    expect(commandWords(apiRuntimeCommand("go run ./cmd/server"))).toEqual([
      resolve("TEST_ONLY-bundle/runtime/bin/artfi-api"),
    ]);
  });

  it("keeps spaces, apostrophes and shell metacharacters literal in bundle paths", () => {
    const root = "/tmp/TEST_ONLY ArtFi user's $release; $(printf injected)";
    vi.stubEnv("ARTFI_E2E_BUNDLE_ROOT", root);
    expect(
      commandWords(webRuntime("next start", "0.0.0.0", "3000").command),
    ).toEqual([
      `${root}/runtime/bin/node`,
      `${root}/runtime/web/apps/web/server.js`,
    ]);
    expect(commandWords(apiRuntimeCommand("go run ./cmd/server"))).toEqual([
      `${root}/runtime/bin/artfi-api`,
    ]);
  });
});

describe("Playwright bundle configuration", () => {
  it.each([
    ["main", () => import("../playwright.config"), 3000, "0.0.0.0"],
    ["market", () => import("../playwright.market.config"), 3001, "127.0.0.1"],
    ["nft", () => import("../playwright.nft.config"), 3005, "127.0.0.1"],
    ["oracle", () => import("../playwright.oracle.config"), 3021, "127.0.0.1"],
    ["safe", () => import("../playwright.safe.config"), 3002, "127.0.0.1"],
  ] as const)(
    "uses the existing %s fixture listener",
    async (_, load, port, hostname) => {
      vi.stubEnv("ARTFI_E2E_BUNDLE_ROOT", "/tmp/TEST_ONLY-artfi-bundle");
      vi.stubEnv("ARTFI_E2E_BASE_URL", "");
      vi.stubEnv("ARTFI_SAFE_E2E_BASE_URL", "");
      const { default: config } = await load();
      expect(config).toMatchObject({
        use: { baseURL: `http://127.0.0.1:${port}` },
        webServer: {
          command:
            "'/tmp/TEST_ONLY-artfi-bundle/runtime/bin/node' '/tmp/TEST_ONLY-artfi-bundle/runtime/web/apps/web/server.js'",
          env: { HOSTNAME: hostname, PORT: String(port) },
        },
      });
    },
  );

  it("keeps main-suite external URL support without starting a bundle server", async () => {
    vi.stubEnv("ARTFI_E2E_BUNDLE_ROOT", "/tmp/TEST_ONLY-artfi-bundle");
    vi.stubEnv("ARTFI_E2E_BASE_URL", "http://127.0.0.1:3900/");
    const { default: config } = await import("../playwright.config");
    expect(config.use?.baseURL).toBe("http://127.0.0.1:3900");
    expect(config.webServer).toBeUndefined();
  });

  it("preserves main-suite source production mode", async () => {
    vi.stubEnv("ARTFI_E2E_BUNDLE_ROOT", "");
    vi.stubEnv("ARTFI_E2E_BASE_URL", "");
    vi.stubEnv("ARTFI_E2E_PRODUCTION", "1");
    const { default: config } = await import("../playwright.config");
    expect(config.webServer).toMatchObject({
      command: "node node_modules/next/dist/bin/next start --hostname 0.0.0.0",
    });
  });
});
