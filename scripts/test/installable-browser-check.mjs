import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export function installedBrowserLaunchOptions(chromiumExecutable) {
  return {
    ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    headless: true,
    chromiumSandbox: true,
  };
}

/** Read-only browser checks against an already installed artifact. */
export async function checkInstalledBrowser({
  baseURL,
  apiBase = "",
  rpcURL = "",
  playwrightModule,
  chromiumExecutable,
  outputDirectory,
  label,
}) {
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const browser = await chromium.launch(
    installedBrowserLaunchOptions(chromiumExecutable),
  );
  const results = [];
  await mkdir(outputDirectory, { recursive: true });
  try {
    for (const [name, viewport] of [
      ["desktop", { width: 1440, height: 1000 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        let seenRuntimeRequest = false;
        let blockedExternalRequests = 0;
        await page.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== new URL(baseURL).origin) {
            blockedExternalRequests++;
            return route.abort();
          }
          if (url.pathname === `${apiBase}/v1/market/activity`) {
            seenRuntimeRequest = true;
            return route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({
                detail: "TEST_ONLY isolated upstream unavailable",
              }),
            });
          }
          return route.continue();
        });
        const activityStarted = performance.now();
        await page.goto(`${baseURL}/market/activity`, {
          waitUntil: "networkidle",
        });
        await page
          .getByRole("heading", { name: "The mirrored history." })
          .waitFor();
        await page.waitForFunction(() =>
          document.body.innerText.toLowerCase().includes("unavailable"),
        );
        const config = await page.evaluate(
          () => window.__ARTFI_PUBLIC_CONFIG__,
        );
        assert.equal(config?.NEXT_PUBLIC_API_URL || "", apiBase);
        assert.equal(config?.NEXT_PUBLIC_BASE_RPC_URL || "", rpcURL);
        assert.ok(seenRuntimeRequest, "Browser must use the runtime API base");
        assert.ok(
          Object.keys(config).every((key) => key.startsWith("NEXT_PUBLIC_")),
        );
        const activityReadyMs = performance.now() - activityStarted;
        await page.screenshot({
          path: join(outputDirectory, `${label}-${name}-runtime.png`),
          fullPage: true,
        });
        const nftStarted = performance.now();
        await page.goto(`${baseURL}/nft`, { waitUntil: "networkidle" });
        await page.locator("h1").waitFor();
        assert.deepEqual(
          errors,
          [],
          "Installed pages must not raise browser errors",
        );
        const nftReadyMs = performance.now() - nftStarted;
        await page.screenshot({
          path: join(outputDirectory, `${label}-${name}-nft.png`),
          fullPage: true,
        });
        results.push({
          viewport: name,
          result: "PASSED",
          runtimeRequestObserved: true,
          externalRequestsBlocked: true,
          blockedExternalRequests,
          pageReadiness: [
            {
              path: "/market/activity",
              durationMs: Math.round(activityReadyMs * 100) / 100,
              navigationInContext: 1,
              readyCondition:
                "networkidle, visible activity heading, explicit unavailable state, expected runtime configuration and observed API-base request",
            },
            {
              path: "/nft",
              durationMs: Math.round(nftReadyMs * 100) / 100,
              navigationInContext: 2,
              readyCondition: "networkidle, visible h1 and no page errors",
            },
          ].map((observation) => ({
            ...observation,
            phase: label,
            viewport: { name, ...viewport },
            clock: "monotonic test-host performance.now",
            cacheCondition: {
              browserContext: "new for each viewport and configuration phase",
              browserHTTPCache: "disabled by Playwright request routing",
              applicationProcess: "already started and health-verified",
              serverAndFilesystemCaches:
                "not cleared or independently measured",
            },
            scope: "observed isolated loopback page readiness only",
            changesPassCriteria: false,
          })),
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}
