import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const journeys = [
  ["/", "Three ways to participate in art."],
  ["/nft", "Digital art, independently collected."],
  ["/rwa", "One artwork. Its receipt. Its record."],
  ["/projects", "Context assembled before assets move."],
  ["/projects/material-memory", "Material Memory"],
  ["/market/rwa", "Live market signals."],
  ["/market/activity", "The mirrored history."],
  ["/market/rwa/blue-hour-archive", "Blue Hour Archive"],
  ["/market/fractionals", "Fractional trading & DAO."],
  ["/market/fractionals/blue-hour-archive", "Blue Hour Archive"],
  ["/portfolio", "Your wallet portfolio."],
  ["/dao", "The holders govern the corresponding physical asset."],
  ["/create/rwa", "Mint, verify, and route the token."],
  ["/charity", "Charity editions."],
  ["/charity/1", "Edition 1."],
  ["/operations", "Dependency status."],
] as const;

for (const [path, heading] of journeys) {
  test(`${path} is readable and free of serious accessibility violations`, async ({
    page,
  }) => {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { level: 1, name: heading }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "No real assets or real money · Wallet-confirmed writes where configured",
      ),
    ).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
}

test("wallet entry point never implies a transaction", async ({ page }) => {
  await page.goto("/portfolio");
  await expect(
    page.getByRole("button", { name: "Connect wallet" }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Connecting a wallet is not sign-in.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /buy|mint|bid|claim/i }),
  ).toHaveCount(0);
});

test("approved brand identity and attribution boundaries are present", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("img", { name: "ArtCCH" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "ArtCCH TM: ArtFi home" }),
  ).toContainText("：ArtFi");
  // WEB-001: the homepage action area contains actions, not a redundant mirror-status badge.
  await expect(page.locator(".overview-actions .mirror-badge")).toHaveCount(0);
  const languageSelector = page.getByRole("combobox", {
    name: "Language",
  });
  await expect(languageSelector).toHaveValue("en");
  await expect(languageSelector.locator("option")).toHaveText([
    "EN",
    "简",
    "繁",
    "FR",
    "ES",
    "DE",
    "한",
    "日",
  ]);
  await expect(
    languageSelector.getByRole("option", { name: "Français" }),
  ).toHaveCount(1);
  await expect(page.locator(".language-switcher__icon")).toHaveCount(0);
  expect(
    await languageSelector.evaluate(
      (element) => getComputedStyle(element).appearance,
    ),
  ).not.toBe("none");
  await expect(page.locator(".technical-support__label")).toHaveText(
    "Technical support:",
  );
  await expect(page.locator(".technical-support__name")).toHaveText(
    "Giraffe ArtFi Corp.",
  );
  const supportMark = page.locator(".technical-support__mark");
  await expect(supportMark).toBeVisible();
  const supportLogo = supportMark.locator("img");
  await expect(supportLogo).toHaveCount(1);
  await expect(supportLogo).toHaveAttribute("src", /giraffe-head-color\.png/);
  const supportMetrics = await page.evaluate(() => {
    const mark = document.querySelector<HTMLElement>(
      ".technical-support__mark",
    );
    const name = document.querySelector<HTMLElement>(
      ".technical-support__name",
    );
    if (!mark || !name) return null;
    return {
      alignItems: getComputedStyle(mark.parentElement!).alignItems,
      diameter: mark.getBoundingClientRect().width,
      nameFontSize: Number.parseFloat(getComputedStyle(name).fontSize),
    };
  });
  expect(supportMetrics).not.toBeNull();
  expect(supportMetrics!.alignItems).toBe("center");
  expect(supportMetrics!.diameter).toBeLessThanOrEqual(
    supportMetrics!.nameFontSize * 2,
  );
  await expect(page.getByText(/Bazaar/i)).toHaveCount(0);
});

test("eight-language selection persists and translates dynamic accessible copy", async ({
  page,
}) => {
  await page.route("**/api/language/v1/translate-page", async (route) => {
    const request = route.request().postDataJSON() as {
      target_language: string;
      texts: string[];
    };
    await route.fulfill({
      contentType: "application/json",
      json: {
        degraded: false,
        source_language: "en",
        target_language: request.target_language,
        translations: request.texts.map(
          (text) => `[${request.target_language.toUpperCase()}] ${text}`,
        ),
      },
    });
  });

  await page.goto("/dao");
  const selector = page.getByRole("combobox", { name: "Language" });
  await selector.selectOption("fr");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "[FR] The holders govern the corresponding physical asset.",
  );
  await expect(
    page.locator(
      '[aria-label="[FR] DAO ownership verification and governance"]',
    ),
  ).toHaveCount(1);
  await expect(page).toHaveTitle(/\[FR\]/);

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Language" })).toHaveValue(
    "fr",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");

  await page.getByRole("combobox", { name: "Language" }).selectOption("zht");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".mobile-menu summary").click();
  await expect(page.locator(".mobile-menu nav a").first()).toContainText(
    "[ZHT]",
  );
});

test("RWA creation is wallet and Hoodi gated", async ({ page }) => {
  await page.goto("/create/rwa");
  await expect(
    page.getByText("Connect an external wallet to continue."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review and mint on Hoodi" }),
  ).toBeDisabled();
  await expect(
    page.getByText("The application never receives a private key."),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: /ERC-721/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: /ERC-1155/ }).click();
  await expect(
    page.getByRole("heading", { name: "Package ready for review" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Review and mint ERC-1155 on Hoodi",
    }),
  ).toBeDisabled();
  await expect(
    page.getByText("No artwork master is uploaded here."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "All indexed ERC-721 and ERC-1155 NFTs.",
    }),
  ).toBeVisible();
});

test("wallet page exposes the fail-closed DAO linkage module", async ({
  page,
}) => {
  await page.goto("/portfolio");
  await expect(
    page.getByRole("heading", {
      name: "Link the holder wallet to its asset DAO.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open DAO verification" }),
  ).toHaveAttribute("href", "/dao");
  await expect(
    page.getByText("Displaying an NFT in a wallet is not enough."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Runtime positions and history" }),
  ).toBeVisible();
});

test("DAO page preserves the four-step creation flow without unlimited approval", async ({
  page,
}) => {
  await page.goto("/dao");
  await expect(
    page.getByRole("heading", {
      name: "Create the asset DAO in four controlled steps.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Step 1 · Create Vault" }),
  ).toBeDisabled();
  await expect(
    page.getByText("No collection-wide approval is requested."),
  ).toBeVisible();
  await expect(page.getByText(/setApprovalForAll/i)).toHaveCount(0);
});

test("market mirror exposes functional search, filters and sort controls", async ({
  page,
}) => {
  await page.goto("/market/rwa");
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
  await expect(page.getByLabel("Listing status")).toHaveValue("all");
  await expect(page.getByLabel("Sort")).toHaveValue("newest");
  await expect(page.getByText("OpenSea information mirror only")).toBeVisible();
  await expect(
    page.getByRole("main").locator('a[href*="opensea" i]'),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("contentinfo")
      .getByRole("link", { name: "OpenSea website" }),
  ).toHaveAttribute("href", "https://opensea.io/");
  await expect(
    page.getByRole("button", {
      name: /prepare external purchase|connect wallet to trade|confirm in external wallet/i,
    }),
  ).toHaveCount(0);
});

test("approved brand assets are served by the standalone runtime", async ({
  request,
}) => {
  for (const path of [
    "/brand/artcch-logo-master.svg",
    "/brand/artwork-a.svg",
    "/brand/giraffe-head-color.png",
  ]) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/");
  }
});

test("production health endpoint reports the enforced operating mode", async ({
  request,
}) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toEqual({
    chainId: 560048,
    buildRevision: /^[a-f0-9]{40}$/.test(process.env.ARTFI_BUILD_SHA ?? "")
      ? process.env.ARTFI_BUILD_SHA
      : null,
    sourceFingerprint: /^[a-f0-9]{64}$/.test(
      process.env.ARTFI_SOURCE_FINGERPRINT ?? "",
    )
      ? process.env.ARTFI_SOURCE_FINGERPRINT
      : null,
    marketplaceMode: "external-mirror",
    service: "artfi-web",
    status: "ok",
  });
});
