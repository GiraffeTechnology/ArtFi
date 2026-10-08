import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, test } from "@playwright/test";

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
