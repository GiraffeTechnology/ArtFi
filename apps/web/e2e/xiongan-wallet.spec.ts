import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const walletURL = "https://xiongan.8415wallet.com/web/index.html";
const linkName = "Open Xiongan Wallet (new tab)";
const walletCalls = new WeakMap<Page, string[]>();

test.beforeEach(async ({ context, page }) => {
  const calls: string[] = [];
  walletCalls.set(page, calls);
  // Keep evidence in the test process so reload and navigation cannot erase it.
  await page.exposeFunction("__recordWalletCall", (method: string) => {
    calls.push(method);
  });
  // Navigation fixture only; deployed Xiongan availability is checked separately.
  await context.route(walletURL, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Xiongan destination fixture</h1>",
    }),
  );
  await page.addInitScript(() => {
    Object.assign(window, {
      ethereum: {
        on() {},
        removeListener() {},
        async request({ method }: { method: string }) {
          await (
            window as unknown as {
              __recordWalletCall: (method: string) => Promise<void>;
            }
          ).__recordWalletCall(method);
          if (method === "eth_accounts") return [];
          if (method === "eth_chainId") return "0x88bb0";
          throw new Error(
            "No wallet permission, signing or transaction in this test",
          );
        },
      },
    });
  });
});

test.afterEach(async ({ page }) => {
  const calls = walletCalls.get(page)!;
  expect(
    calls.filter((method) => !["eth_accounts", "eth_chainId"].includes(method)),
  ).toEqual([]);
});

test("overview and menu expose an isolated Xiongan entry while preserving portfolio", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  const tools = page.getByRole("navigation", {
    name: "ArtFi tools",
    exact: true,
  });
  await expect(
    tools.getByRole("link", { name: "Wallet", exact: true }),
  ).toHaveAttribute("href", "/portfolio");
  await expect(tools.getByRole("link", { name: linkName })).toHaveAttribute(
    "href",
    walletURL,
  );

  const menu = page.locator(isMobile ? ".mobile-menu" : ".tools-menu");
  await menu.locator("summary").click();
  const link = menu.getByRole("link", { name: linkName });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(walletURL);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  await popup.close();
  await expect(menu).not.toHaveAttribute("open", "");
  await expect(page).toHaveURL(/\/$/);
  await tools.getByRole("link", { name: "Wallet", exact: true }).click();
  await expect(page).toHaveURL(/\/portfolio$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/portfolio$/);
});

test("portfolio and repeated wallet-modal links never claim a connection", async ({
  page,
}) => {
  await page.goto("/portfolio");
  const entry = page.getByRole("region", { name: "Xiongan Wallet DApp" });
  await expect(entry).toContainText(
    "Opening it does not connect a wallet to ArtFi",
  );
  await expect(entry.getByRole("link", { name: linkName })).toHaveAttribute(
    "href",
    walletURL,
  );
  await expect(
    page.getByRole("heading", { name: "Your public portfolio." }),
  ).toBeVisible();

  const connect = page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .filter({ visible: true })
    .first();
  for (const dismiss of ["Escape", "Close"] as const) {
    await connect.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Browser Wallet" }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Xiongan/ })).toHaveCount(
      0,
    );
    await expect(dialog).toContainText(
      "Connect your browser wallet separately in each app",
    );
    const link = dialog.getByRole("link", { name: linkName });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", walletURL);
    const popupPromise = page.waitForEvent("popup");
    await link.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(walletURL);
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await popup.close();
    await expect(dialog).toBeVisible();
    if (dismiss === "Escape") await page.keyboard.press("Escape");
    else
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(connect).toHaveText("Connect wallet");
    await expect(page).toHaveURL(/\/portfolio$/);
  }
  await page.reload();
  await expect(entry).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
});
