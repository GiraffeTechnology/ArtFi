import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const journeys = [
  ["/", "Art, provenance, and transparent ownership."],
  ["/projects", "Context assembled before assets move."],
  ["/projects/material-memory", "Material Memory"],
  ["/market/rwa", "Live market signals."],
  ["/market/rwa/blue-hour-archive", "Blue Hour Archive"],
  ["/market/fractionals", "Understand the position before the transaction."],
  ["/market/fractionals/blue-hour-archive", "Blue Hour Archive"],
  ["/portfolio", "Your public portfolio."],
  ["/dao", "Governance, made legible."],
  ["/create/rwa", "Commit the record before the token."],
] as const;

for (const [path, heading] of journeys) {
  test(`${path} is readable and free of serious accessibility violations`, async ({
    page,
  }) => {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { level: 1, name: heading }),
    ).toBeVisible();
    await expect(page.getByText("No in-app order execution")).toBeVisible();
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
  await expect(page.getByText("No signature is requested.")).toBeVisible();
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
  await expect(page.getByLabel("Language / 语言")).toHaveValue("en");
  await expect(page.getByLabel("Language / 语言").locator("option")).toHaveText(
    ["EN", "简", "繁", "日"],
  );
  await expect(
    page.getByText("Technical support: Giraffe ArtFi Corp."),
  ).toHaveCount(1);
  await expect(page.getByText(/Bazaar/i)).toHaveCount(0);
});

test("RWA creation is wallet and Sepolia gated", async ({ page }) => {
  await page.goto("/create/rwa");
  await expect(
    page.getByText("Connect an external wallet to continue."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review and mint on Sepolia" }),
  ).toBeDisabled();
  await expect(
    page.getByText("The application never receives a private key."),
  ).toBeVisible();
});

test("production health endpoint reports the enforced operating mode", async ({
  request,
}) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toEqual({
    chainId: 11155111,
    marketplaceMode: "external-mirror",
    service: "artfi-web",
    status: "ok",
  });
});
