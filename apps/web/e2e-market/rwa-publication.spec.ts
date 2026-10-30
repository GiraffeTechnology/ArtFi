import { expect, test, type Page } from "@playwright/test";
import { sha256, stringToHex } from "viem";
import { sourceEvidenceFixture } from "../src/test/rwa-source-fixture";
import {
  rwaPublicationAssetSchema,
  type RWAPublication,
} from "../src/lib/rwa-publication";
import { isolatedSourceAsset } from "./rwa-catalog-fixture";

const wallet = "0x1000000000000000000000000000000000000010";
const otherWallet = "0x1000000000000000000000000000000000000020";
const storageKey = `artfi:rwa-publication:560048:${wallet}`;

async function publicationFixture(
  page: Page,
  section: "whole" | "fractional" = "whole",
) {
  const catalog = isolatedSourceAsset(section);
  const asset = rwaPublicationAssetSchema.parse({
    slug: catalog.slug,
    title: catalog.title,
    artist: catalog.artist,
    year: catalog.year,
    medium: catalog.medium,
    location: catalog.location,
    description: catalog.description,
    imageUrl: catalog.imageUrl ?? "",
    section: catalog.section,
    rights: catalog.rights,
    provenance: catalog.provenance,
    binding: catalog.binding,
  });
  const contextHash = sha256(
    stringToHex(
      JSON.stringify({ domain: "ArtFi public RWA catalog v1", asset }),
    ),
  );
  const source = sourceEvidenceFixture(contextHash, {
    section,
    underlyingAssetId: asset.binding.underlyingAssetId,
    rights: asset.rights,
  });
  const result = {
    ...catalog,
    grounding: {
      ...catalog.grounding,
      sourceId: source.sourceEvidence.sourceId,
      sourceAssetId: source.sourceEvidence.sourceAssetId,
      evidenceId: source.sourceEvidence.evidenceId,
    },
  };
  const state = {
    asset,
    source,
    authenticated: true,
    sessionId: "TEST_ONLY-ordinary-publisher-session",
    drafts: [] as { body: unknown; key: string }[],
    publications: [] as {
      body: RWAPublication;
      key: string;
      wallet: string;
      chain: string;
    }[],
    receipts: new Map<string, typeof result>(),
    interruptNext: false,
    hold: undefined as "draft" | "publication" | undefined,
    release: undefined as (() => void) | undefined,
  };
  // All requests remain in the isolated browser fixture, including evidence URLs.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" || url.hostname === "localhost"
      ? route.continue()
      : route.abort("blockedbyclient");
  });
  await page.addInitScript(
    ({ wallet }) => {
      let account =
        sessionStorage.getItem("TEST_ONLY-publication-wallet") || wallet;
      let authorized =
        sessionStorage.getItem("TEST_ONLY-publication-authorized") === "true";
      let chain = "0x88bb0";
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      const permissions = () => [
        {
          parentCapability: "eth_accounts",
          caveats: [{ type: "restrictReturnedAccounts", value: [account] }],
        },
      ];
      Object.defineProperty(window, "publicationWallet", {
        value: {
          account(next: string) {
            account = next;
            sessionStorage.setItem("TEST_ONLY-publication-wallet", next);
            listeners.accountsChanged?.forEach((listener) => listener([next]));
          },
          chain(next: string) {
            chain = next;
            listeners.chainChanged?.forEach((listener) => listener(next));
          },
        },
      });
      Object.defineProperty(window, "ethereum", {
        value: {
          isMetaMask: true,
          on(event: string, listener: (...args: unknown[]) => void) {
            (listeners[event] ||= []).push(listener);
          },
          removeListener(
            event: string,
            listener: (...args: unknown[]) => void,
          ) {
            listeners[event] =
              listeners[event]?.filter((entry) => entry !== listener) ?? [];
          },
          async request({ method }: { method: string }) {
            if (method === "eth_accounts") return authorized ? [account] : [];
            if (
              method === "eth_requestAccounts" ||
              method === "wallet_requestPermissions"
            ) {
              authorized = true;
              sessionStorage.setItem(
                "TEST_ONLY-publication-authorized",
                "true",
              );
              return method === "eth_requestAccounts"
                ? [account]
                : permissions();
            }
            if (method === "wallet_getPermissions")
              return authorized ? permissions() : [];
            if (method === "eth_chainId") return chain;
            if (method === "wallet_getCapabilities") return {};
            throw new Error(
              `Unexpected TEST_ONLY publication wallet request: ${method}`,
            );
          },
        },
      });
    },
    { wallet },
  );
  await page.route("**/test-hoodi-rpc", async (route) => {
    const input = route.request().postDataJSON();
    const answer = (value: { id: number; method: string }) => ({
      jsonrpc: "2.0",
      id: value.id,
      result: value.method === "eth_chainId" ? "0x88bb0" : "0x0",
    });
    await route.fulfill({
      json: Array.isArray(input) ? input.map(answer) : answer(input),
    });
  });
  await page.route("**/api/user/auth/*", async (route) => {
    if (route.request().url().endsWith("/logout")) {
      state.authenticated = false;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill(
      state.authenticated
        ? {
            json: {
              session: {
                id: state.sessionId,
                address: wallet,
                chainId: 560048,
                expiresAt: 4e12,
                accessExpiresAt: 4e12,
              },
            },
          }
        : { status: 401, json: { detail: "TEST_ONLY sign in required" } },
    );
  });
  const pause = async (boundary: typeof state.hold) => {
    if (state.hold !== boundary) return;
    await new Promise<void>((resolve) => {
      state.release = () => {
        state.hold = undefined;
        resolve();
      };
    });
  };
  await page.route("**/api/rwa/publication/drafts", async (route) => {
    state.drafts.push({
      body: route.request().postDataJSON(),
      key: route.request().headers()["idempotency-key"],
    });
    await pause("draft");
    await route.fulfill({ json: { asset, contextHash, executable: false } });
  });
  await page.route("**/api/rwa/publication/assets/*", async (route) => {
    const request = route.request();
    const value = {
      body: request.postDataJSON() as RWAPublication,
      key: request.headers()["idempotency-key"],
      wallet: request.headers()["x-artfi-wallet"],
      chain: request.headers()["x-artfi-chain"],
    };
    state.publications.push(value);
    // A durable publication may be recorded before its HTTP response is lost.
    state.receipts.set(value.key, result);
    await pause("publication");
    if (state.interruptNext) {
      state.interruptNext = false;
      return route.abort("failed");
    }
    await route.fulfill({ json: state.receipts.get(value.key) });
  });
  return state;
}

type Fixture = Awaited<ReturnType<typeof publicationFixture>>;
const metadataInput = (page: Page) =>
  page.getByRole("textbox", {
    name: "Public asset metadata (JSON)",
    exact: true,
  });
const evidenceInput = (page: Page) =>
  page.getByRole("textbox", {
    name: "Signed source evidence (JSON)",
    exact: true,
  });
const prepareButton = (page: Page) =>
  page.getByRole("button", {
    name: "Prepare public source-review draft",
    exact: true,
  });
const publishButton = (page: Page) =>
  page.getByRole("button", {
    name: "Verify source and publish public record",
    exact: true,
  });
const retryButton = (page: Page) =>
  page.getByRole("button", { name: "Retry saved publication", exact: true });
const publishedLink = (page: Page) =>
  page.getByRole("link", { name: /^Open published TEST ONLY/ });
async function openPublication(page: Page) {
  await page.goto("/rwa/activate");
  await expect(
    page.getByRole("heading", {
      name: "Sign in to publish source-verified assets",
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: /Browser Wallet|MetaMask|Injected/ })
    .first()
    .click();
  await expect(metadataInput(page)).toBeVisible();
}
async function reviewPublication(page: Page, state: Fixture) {
  await metadataInput(page).fill(JSON.stringify(state.asset));
  await prepareButton(page).click();
  await expect(
    page.getByLabel("Unsigned public source-review draft", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: state.asset.title, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(state.asset.rights, { exact: true }),
  ).toBeVisible();
  await evidenceInput(page).fill(JSON.stringify(state.source.sourceEvidence));
}
async function savedPublication(page: Page) {
  return page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key) || "null"),
    storageKey,
  );
}

for (const section of ["whole", "fractional"] as const) {
  test(`${section} source publication reviews exact public metadata before importing and publishing`, async ({
    page,
  }) => {
    const state = await publicationFixture(page, section);
    await openPublication(page);
    await metadataInput(page).fill(JSON.stringify(state.asset));
    await expect(publishButton(page)).toBeDisabled();
    await reviewPublication(page, state);
    const review = JSON.parse(
      await page
        .getByLabel("Unsigned public source-review draft", { exact: true })
        .inputValue(),
    );
    expect(review).toEqual({
      asset: state.asset,
      contextHash: state.source.sourceEvidence.contextHash,
      executable: false,
    });
    expect(state.publications).toHaveLength(0);
    await publishButton(page).click();
    await expect(publishedLink(page)).toHaveAttribute(
      "href",
      section === "whole"
        ? `/rwa/assets/${state.asset.slug}`
        : `/market/fractionals/assets/${state.asset.slug}`,
    );
    expect(state.publications).toHaveLength(1);
    expect(state.publications[0]).toMatchObject({
      wallet,
      chain: "560048",
      body: {
        revision: 0,
        asset: state.asset,
        evidence: state.source.sourceEvidence,
      },
    });
    expect(await savedPublication(page)).toBeNull();
    await expect(publishButton(page)).toBeDisabled();
    await expect(page.getByRole("status")).toContainText(
      "does not transfer a token",
    );
  });
}

test("interrupted source publication restores and retries the identical request after reload", async ({
  page,
}) => {
  const state = await publicationFixture(page);
  state.interruptNext = true;
  await openPublication(page);
  await reviewPublication(page, state);
  await publishButton(page).click();
  await expect(retryButton(page)).toBeEnabled();
  const saved = await savedPublication(page);
  expect(saved.body).toEqual(state.publications[0].body);
  expect(saved.key).toBe(state.publications[0].key);
  await page.reload();
  await expect(retryButton(page)).toBeEnabled();
  await expect(metadataInput(page)).toBeDisabled();
  await expect(evidenceInput(page)).toBeDisabled();
  await retryButton(page).click();
  await expect(publishedLink(page)).toBeVisible();
  expect(state.publications).toHaveLength(2);
  expect(state.publications[1]).toEqual(state.publications[0]);
  expect(state.receipts.size).toBe(1);
  expect(state.drafts).toHaveLength(1);
  expect(await savedPublication(page)).toBeNull();
});

test("repeated source publication clicks create one in-flight public request", async ({
  page,
}) => {
  const state = await publicationFixture(page);
  state.hold = "publication";
  await openPublication(page);
  await reviewPublication(page, state);
  await publishButton(page).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => Boolean(state.release)).toBe(true);
  await expect(
    page.getByRole("button", { name: "Verifying…", exact: true }),
  ).toBeDisabled();
  expect(state.publications).toHaveLength(1);
  state.release!();
  await expect(publishedLink(page)).toBeVisible();
  expect(state.publications).toHaveLength(1);
});

test("departing and returning during source publication requires recovery before showing confirmation", async ({
  page,
}) => {
  const state = await publicationFixture(page);
  state.hold = "publication";
  await openPublication(page);
  await reviewPublication(page, state);
  await publishButton(page).click();
  await expect.poll(() => Boolean(state.release)).toBe(true);
  const saved = await savedPublication(page);
  await page
    .getByRole("link", { name: "ArtCCH TM: ArtFi home", exact: true })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/rwa\/activate$/);
  await expect(retryButton(page)).toBeEnabled();
  const response = page.waitForResponse(
    (value) =>
      value.url().includes("/api/rwa/publication/assets/") &&
      value.status() === 200,
  );
  state.release!();
  await response;
  await expect(publishedLink(page)).toHaveCount(0);
  expect(await savedPublication(page)).toEqual(saved);
  await retryButton(page).click();
  await expect(publishedLink(page)).toBeVisible();
  expect(state.publications[1]).toEqual(state.publications[0]);
});

for (const change of ["wallet", "chain", "sign-out"] as const) {
  test(`source publication retires its private workspace on ${change} during a pending response`, async ({
    page,
  }) => {
    const state = await publicationFixture(page);
    state.hold = "publication";
    await openPublication(page);
    await reviewPublication(page, state);
    await publishButton(page).click();
    await expect.poll(() => Boolean(state.release)).toBe(true);
    const saved = await savedPublication(page);
    if (change === "sign-out")
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
    else
      await page.evaluate(
        ({ change, otherWallet }) => {
          const provider = (
            window as unknown as {
              publicationWallet: {
                account(next: string): void;
                chain(next: string): void;
              };
            }
          ).publicationWallet;
          if (change === "wallet") provider.account(otherWallet);
          else provider.chain("0x1");
        },
        { change, otherWallet },
      );
    await expect(
      page.getByRole("heading", {
        name: "Sign in to publish source-verified assets",
      }),
    ).toBeVisible();
    const response = page.waitForResponse(
      (value) =>
        value.url().includes("/api/rwa/publication/assets/") &&
        value.status() === 200,
    );
    state.release!();
    await response;
    await expect(metadataInput(page)).toHaveCount(0);
    await expect(publishedLink(page)).toHaveCount(0);
    expect(await savedPublication(page)).toEqual(saved);
    expect(state.publications).toHaveLength(1);
  });
}
