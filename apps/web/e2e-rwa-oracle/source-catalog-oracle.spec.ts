import { expect, test } from "@playwright/test";
import { sourceOracleAsset } from "../src/test/rwa-oracle-source-fixture";

for (const section of ["whole", "fractional"] as const) {
  test(`${section} source detail consumes successful real Oracle wrappers and rereads on refresh`, async ({
    page,
  }) => {
    const asset = sourceOracleAsset(section);
    const endpoint = `/api/rwa/assets/${asset.slug}`;
    const wrapperReads: string[] = [];
    const oldSampleReads: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith(`${endpoint}/`)) wrapperReads.push(path);
      if (/^\/api\/assets\/.+\/(oracle|projection)$/.test(path))
        oldSampleReads.push(path);
    });
    // No page.route mock: list, detail, and both wrappers reach the Next server.
    await page.goto(section === "whole" ? "/rwa" : "/market/fractionals");
    const catalog = page.getByRole("region", {
      name:
        section === "whole"
          ? "Approved whole-artwork catalog"
          : "Approved fractional asset catalog",
    });
    await expect(
      catalog.getByRole("heading", { name: asset.title }),
    ).toBeVisible();
    const oracleResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `${endpoint}/oracle` &&
        response.status() === 200,
    );
    const projectionResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `${endpoint}/projection` &&
        response.status() === 200,
    );
    await catalog
      .getByRole("link", { name: "Inspect source-bound asset" })
      .click();
    await expect(
      page.getByRole("heading", { name: asset.title, exact: true }),
    ).toBeVisible();
    expect((await (await oracleResponse).json()).token.binding).toEqual({
      chainId: String(asset.binding.chainId),
      contract: asset.binding.collectionAddress,
      tokenId: asset.binding.tokenId,
      assetId: asset.binding.assetId,
    });
    expect((await (await projectionResponse).json()).tokenId).toBe(
      asset.binding.tokenId,
    );
    const facts = page.getByTestId("oracle-facts");
    const projection = page.getByRole("region", {
      name: "ERC-8415 register projection",
    });
    await expect(facts).toContainText(
      `TEST_ONLY-registry-${asset.binding.tokenId}`,
    );
    await expect(facts).toContainText("IN_CUSTODY");
    await expect(page.getByTestId("projection-facts")).toBeVisible();
    await expect(projection).toContainText(
      "The tradeable position differs from the recorded holder",
    );
    await expect(
      page.getByRole("region", { name: "Approved-source correspondence" }),
    ).toContainText("TESTNET / NO REAL-WORLD VALUE / NO LEGAL EFFECT");

    await projection
      .getByLabel("Historical instant (Unix seconds)")
      .fill("1500");
    const history = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `${endpoint}/projection` &&
        new URL(response.url()).searchParams.get("instant") === "1500",
    );
    await projection.getByRole("button", { name: "Read this instant" }).click();
    expect((await (await history).json()).instant).toBe("1500");
    await expect(projection).toContainText("1500 Unix seconds");
    await expect(projection).toContainText("Final for the queried instant");

    const beforeRefresh = wrapperReads.length;
    const refreshedOracle = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `${endpoint}/oracle`,
    );
    const refreshedProjection = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `${endpoint}/projection`,
    );
    await page
      .getByRole("button", { name: "Refresh approved-source record" })
      .click();
    expect((await refreshedOracle).status()).toBe(200);
    expect((await refreshedProjection).status()).toBe(200);
    await expect(facts).toContainText(
      `TEST_ONLY-registry-${asset.binding.tokenId}`,
    );
    await expect(page.getByTestId("projection-facts")).toBeVisible();
    expect(wrapperReads.length).toBeGreaterThan(beforeRefresh);
    expect(oldSampleReads).toEqual([]);
    expect(
      await page
        .getByTestId("asset-holder-authority")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    await page.getByTestId("asset-holder-authority").screenshot({
      path: test.info().outputPath(`${section}-source-oracle.png`),
    });
  });
}
