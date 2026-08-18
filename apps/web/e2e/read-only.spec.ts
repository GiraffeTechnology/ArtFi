import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const journeys = [
  ["/", "Art ownership, with the record attached."],
  ["/projects", "Context assembled before assets move."],
  ["/projects/material-memory", "Material Memory"],
  ["/market/rwa", "Documented works, ready for inspection."],
  ["/market/rwa/blue-hour-archive", "Blue Hour Archive"],
  ["/market/fractionals", "Understand the position before the transaction."],
  ["/market/fractionals/blue-hour-archive", "Blue Hour Archive"],
  ["/portfolio", "A public-address view, never a custody claim."],
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
      page.getByText("transactions are disabled in Stage 1"),
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
  await expect(page.getByText("No signature is requested.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /buy|mint|bid|claim/i }),
  ).toHaveCount(0);
});
