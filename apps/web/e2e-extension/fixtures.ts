import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Worker,
} from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type ExtensionAPI = {
  runtime: {
    getManifest(): {
      manifest_version: number;
      permissions: string[];
      optional_permissions: string[];
    };
    sendMessage(message: Record<string, unknown>): Promise<unknown>;
  };
  permissions: {
    getAll(): Promise<{ permissions?: string[]; origins?: string[] }>;
  };
  storage: { local: { get(keys: string[]): Promise<Record<string, unknown>> } };
};

export interface InstalledExtension {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  restartBrowser(): Promise<InstalledExtension>;
}

export const test = base.extend<{
  installed: InstalledExtension;
  origin: string;
}>({
  origin: async ({}, provide) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      });
      response.end(`<!doctype html><title>ArtFi TEST_ONLY localhost</title>
        <h1>Public synthetic extension acceptance site</h1>
        <script>
          window.artfiAnnouncements = [];
          window.addEventListener('eip6963:announceProvider', event => {
            window.artfiAnnouncements.push(event.detail.info.rdns);
          });
          window.dispatchEvent(new Event('eip6963:requestProvider'));
        </script>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "localhost", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing ephemeral localhost port");
      await provide(`http://localhost:${address.port}`);
    } finally {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      // Only this disposable fixture's connections are closed. Browser keep-alives
      // must not block teardown before the browser-context fixture is closed.
      server.closeAllConnections();
      await closed;
    }
  },
  installed: async ({}, provide, testInfo) => {
    const extensionPath = path.resolve(
      __dirname,
      "../../wallet-extension/dist",
    );
    const sourceManifest = await readFile(
      path.resolve(extensionPath, "../manifest.json"),
      "utf8",
    );
    expect(
      await readFile(path.join(extensionPath, "manifest.json"), "utf8"),
    ).toBe(sourceManifest);
    const manifest = JSON.parse(sourceManifest);
    expect(manifest.permissions).toEqual(["storage", "alarms", "activeTab"]);
    expect(manifest.optional_permissions).toEqual(["scripting"]);
    expect(manifest.optional_host_permissions).toEqual([
      "https://*/*",
      "http://localhost/*",
    ]);
    expect(manifest.content_scripts).toBeUndefined();

    const profile = await mkdtemp(
      path.join(tmpdir(), "artfi-installed-extension-"),
    );
    let context: BrowserContext | undefined;
    const launch = async (
      wakeExtensionId?: string,
    ): Promise<InstalledExtension> => {
      context = await chromium.launchPersistentContext(profile, {
        channel: "chromium", // Full Playwright-bundled Chromium, never headless-shell.
        headless: true,
        chromiumSandbox: true,
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
        ],
      });
      // The fixture has no external dependencies. Fail closed for page traffic.
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (
          url.protocol === "chrome-extension:" ||
          (url.protocol === "http:" && url.hostname === "localhost")
        ) {
          await route.continue();
        } else {
          await route.abort("blockedbyclient");
        }
      });
      if (wakeExtensionId) {
        // A previously registered MV3 worker may start lazily. Wake it through
        // the actual popup's runtime messages, not a mocked worker invocation.
        const popup = await context.newPage();
        await popup.goto(`chrome-extension://${wakeExtensionId}/popup.html`);
      }
      const worker =
        context
          .serviceWorkers()
          .find((worker) => worker.url().startsWith("chrome-extension://")) ??
        (await context.waitForEvent("serviceworker", {
          predicate: (worker) => worker.url().startsWith("chrome-extension://"),
          timeout: 15_000,
        }));
      const extensionId = new URL(worker.url()).hostname;
      expect(worker.url()).toBe(
        `chrome-extension://${extensionId}/background.js`,
      );
      const permissions = await worker.evaluate(() =>
        (
          globalThis as unknown as { chrome: ExtensionAPI }
        ).chrome.permissions.getAll(),
      );
      expect(permissions.permissions).not.toContain("scripting");
      expect(permissions.origins ?? []).toEqual([]);
      await testInfo.attach("installed-extension-scope", {
        body: JSON.stringify(
          {
            browserVersion: context.browser()?.version(),
            worker: worker.url(),
            permissions,
            scope:
              "Prepermission only. No host approval, page provider, or full acceptance is claimed.",
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      return {
        context,
        worker,
        extensionId,
        restartBrowser: async () => {
          // Reuse only this test's temporary profile. No permissions or storage
          // are seeded, modified, or copied during the browser restart.
          await context?.close();
          const restarted = await launch(extensionId);
          expect(restarted.extensionId).toBe(extensionId);
          return restarted;
        },
      };
    };
    try {
      await provide(await launch());
    } finally {
      try {
        await context?.close();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    }
  },
});
export { expect };
