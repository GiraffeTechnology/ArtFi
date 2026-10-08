import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, test } from "@playwright/test";

type HarnessPort = {
  onMessage: { addListener: (fn: (value: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  disconnect: () => void;
  messages: ((value: unknown) => void)[];
};
type LifecycleHarness = {
  accountEvents: string[][];
  statePorts: HarnessPort[];
  workerAccounts: string[];
  connectFailures: number;
  accountListener: (accounts: string[]) => void;
  testProvider: {
    on: (event: string, callback: (accounts: string[]) => void) => void;
    removeListener: (
      event: string,
      callback: (accounts: string[]) => void,
    ) => void;
  };
  chrome: {
    runtime: {
      sendMessage: () => Promise<{ ok: boolean; result: string[] }>;
      connect: (input: { name: string }) => HarnessPort;
    };
  };
  emitAccounts: (accounts: string[]) => void;
};

// Exercise the real page-provider/relay code against a synthetic service worker.
// This does not claim installed-extension permission or production signer acceptance.
function extensionScript(name: string) {
  return ts.transpile(
    readFileSync(
      resolve(__dirname, `../../wallet-extension/src/${name}.ts`),
      "utf8",
    ),
    { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
  );
}
test("reinjecting the provider and bridge keeps one wallet identity and one dispatch", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const w = window as unknown as {
      announcements: {
        info: { uuid: string };
        provider: { request: (args: { method: string }) => Promise<unknown> };
      }[];
      calls: { type: string; method: string; origin?: string }[];
      chrome: {
        runtime: {
          sendMessage: (value: {
            type: string;
            method: string;
          }) => Promise<unknown>;
        };
      };
    };
    w.announcements = [];
    w.calls = [];
    window.addEventListener("eip6963:announceProvider", (event) =>
      w.announcements.push((event as CustomEvent).detail),
    );
    w.chrome = {
      runtime: {
        sendMessage: async (value) => {
          w.calls.push(value);
          return value.method === "eth_chainId"
            ? { ok: true, result: "0x88bb0" }
            : { ok: false, code: 4200, error: "TEST ONLY unsupported signing" };
        },
      },
    };
  });
  for (let index = 0; index < 2; index++) {
    await page.addScriptTag({ content: extensionScript("provider") });
    await page.addScriptTag({ content: extensionScript("bridge") });
  }
  const result = await page.evaluate(async () => {
    const w = window as unknown as {
      announcements: {
        info: { uuid: string };
        provider: { request: (args: { method: string }) => Promise<unknown> };
      }[];
      calls: { type: string; method: string; origin?: string }[];
    };
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const chain = await w.announcements[0]!.provider.request({
      method: "eth_chainId",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      chain,
      identities: new Set(w.announcements.map((entry) => entry.info.uuid)).size,
      calls: w.calls,
    };
  });
  expect(result.chain).toBe("0x88bb0");
  expect.soft(result.identities).toBe(1);
  expect(result.calls).toEqual([
    { type: "provider.request", method: "eth_chainId", params: [] },
  ]);
  const boundaries = await page.evaluate(async () => {
    const w = window as unknown as {
      announcements: {
        provider: { request: (args: { method: string }) => Promise<unknown> };
      }[];
      calls: unknown[];
    };
    w.calls.length = 0;
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "https://untrusted.example",
        data: {
          channel: "artfi-wallet:request",
          id: "foreign",
          method: "eth_chainId",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const foreignDispatches = w.calls.length;
    try {
      await w.announcements[0]!.provider.request({ method: "personal_sign" });
      return { foreignDispatches, code: null };
    } catch (error) {
      return { foreignDispatches, code: (error as { code: number }).code };
    }
  });
  expect(boundaries).toEqual({ foreignDispatches: 0, code: 4200 });
});

test("provider account events clear stale accounts on lock, unlock, revoke and reconnect", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const w = window as unknown as LifecycleHarness;
    w.accountEvents = [];
    w.statePorts = [];
    w.workerAccounts = [];
    w.connectFailures = 0;
    window.addEventListener("eip6963:announceProvider", (event) => {
      w.testProvider = (event as CustomEvent).detail.provider;
    });
    w.chrome = {
      runtime: {
        sendMessage: async () => ({ ok: true, result: w.workerAccounts }),
        connect: ({ name }: { name: string }) => {
          if (name !== "artfi-provider-state")
            throw Error("Unexpected state channel");
          if (w.connectFailures > 0) {
            w.connectFailures--;
            throw Error("TEST ONLY restarting worker");
          }
          const messages: ((value: unknown) => void)[] = [],
            disconnected: (() => void)[] = [];
          const port = {
            onMessage: {
              addListener: (fn: (value: unknown) => void) => messages.push(fn),
            },
            onDisconnect: {
              addListener: (fn: () => void) => disconnected.push(fn),
            },
            disconnect: () => disconnected.forEach((fn) => fn()),
            messages,
          };
          w.statePorts.push(port);
          setTimeout(
            () =>
              messages.forEach((fn) =>
                fn({
                  type: "provider.accountsChanged",
                  accounts: w.workerAccounts,
                }),
              ),
            0,
          );
          return port;
        },
      },
    };
    w.emitAccounts = (accounts: string[]) => {
      w.workerAccounts = accounts;
      const port = w.statePorts.at(-1);
      port?.messages.forEach((fn: (value: unknown) => void) =>
        fn({ type: "provider.accountsChanged", accounts }),
      );
    };
  });
  await page.addScriptTag({ content: extensionScript("provider") });
  await page.evaluate(() => {
    const w = window as unknown as LifecycleHarness;
    w.accountListener = (accounts: string[]) => w.accountEvents.push(accounts);
    w.testProvider.on("accountsChanged", w.accountListener);
  });
  await page.addScriptTag({ content: extensionScript("bridge") });
  const account = "0x1111111111111111111111111111111111111111";
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as LifecycleHarness).statePorts.length,
      ),
    )
    .toBe(1);
  await page.addScriptTag({ content: extensionScript("provider") });
  await page.addScriptTag({ content: extensionScript("bridge") });
  expect(
    await page.evaluate(
      () => (window as unknown as LifecycleHarness).statePorts.length,
    ),
  ).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as LifecycleHarness).accountEvents,
      ),
    )
    .toEqual([[]]);
  await page.evaluate(() => {
    (window as unknown as LifecycleHarness).accountEvents.length = 0;
  });
  for (const accounts of [[account], [account], [], [], [account], []]) {
    await page.evaluate(
      (value) => (window as unknown as LifecycleHarness).emitAccounts(value),
      accounts,
    );
  }
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as LifecycleHarness).accountEvents,
      ),
    )
    .toEqual([[account], [], [account], []]);
  await page.evaluate(
    (value) => (window as unknown as LifecycleHarness).emitAccounts(value),
    [account],
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as LifecycleHarness).accountEvents.length,
      ),
    )
    .toBe(5);
  await page.evaluate(() => {
    const w = window as unknown as LifecycleHarness;
    w.workerAccounts = [];
    w.connectFailures = 2;
    w.statePorts.at(-1)!.disconnect();
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as LifecycleHarness).accountEvents.at(-1),
      ),
    )
    .toEqual([]);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as LifecycleHarness).statePorts.length,
      ),
    )
    .toBe(2);
  await page.evaluate(
    (value) => {
      const w = window as unknown as LifecycleHarness;
      w.statePorts[0]!.messages.forEach((fn) =>
        fn({ type: "provider.accountsChanged", accounts: value }),
      );
    },
    [account],
  );
  await page.waitForTimeout(50);
  expect(
    await page.evaluate(() =>
      (window as unknown as LifecycleHarness).accountEvents.at(-1),
    ),
  ).toEqual([]);
  await page.evaluate(() => {
    const w = window as unknown as LifecycleHarness;
    w.testProvider.removeListener("accountsChanged", w.accountListener);
    w.accountEvents.length = 0;
  });
  await page.evaluate(
    (value) => (window as unknown as LifecycleHarness).emitAccounts(value),
    [account],
  );
  await page.waitForTimeout(50);
  expect(
    await page.evaluate(
      () => (window as unknown as LifecycleHarness).accountEvents,
    ),
  ).toEqual([]);
  await page.evaluate(() => {
    const w = window as unknown as LifecycleHarness;
    w.testProvider.on("accountsChanged", (accounts) => {
      accounts[0] = "0x2222222222222222222222222222222222222222";
      throw Error("TEST ONLY broken consumer");
    });
    w.testProvider.on("accountsChanged", w.accountListener);
    w.emitAccounts([]);
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as LifecycleHarness).accountEvents,
      ),
    )
    .toEqual([[]]);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(
      () => (window as unknown as LifecycleHarness).statePorts.length,
    ),
  ).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as LifecycleHarness).statePorts.length,
      ),
    )
    .toBe(3);
});
