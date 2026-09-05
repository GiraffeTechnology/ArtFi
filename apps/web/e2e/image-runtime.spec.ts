import { expect, test } from "@playwright/test";

test("visible brand images decode in the browser", async ({ page }) => {
  await page.goto("/");
  for (const locator of [
    page.getByRole("img", { name: "ArtCCH", exact: true }),
    page.locator(".technical-support__mark img"),
  ]) {
    await expect(locator).toHaveCount(1);
    await expect(locator).toBeVisible();
    const decoded = await locator.evaluate(async (element) => {
      if (!(element instanceof HTMLImageElement)) throw new Error("NOT_IMAGE");
      await element.decode();
      return {
        complete: element.complete,
        width: element.naturalWidth,
        height: element.naturalHeight,
        source: element.currentSrc,
      };
    });
    expect(decoded.complete).toBe(true);
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
    expect(new URL(decoded.source).origin).toBe(new URL(page.url()).origin);
  }
});

test("all approved standalone brand assets decode rather than merely return image MIME", async ({
  page,
}) => {
  await page.goto("/");
  for (const path of [
    "/brand/artcch-logo-master.svg",
    "/brand/artwork-a.svg",
    "/brand/giraffe-head-color.png",
  ]) {
    const response = await page.request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(
      /^image\/(svg\+xml|png)/,
    );
    const dimensions = await page.evaluate(async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, path);
    expect(dimensions.width).toBeGreaterThan(0);
    expect(dimensions.height).toBeGreaterThan(0);
  }
});

test("image optimizer negotiates non-AVIF output from a benign PNG and the result decodes", async ({
  page,
}) => {
  await page.goto("/");
  // Benign existing local PNG only: no exploit payload, remote URL or AVIF decoder input.
  const path = "/_next/image?url=%2Fbrand%2Fgiraffe-head-color.png&w=64&q=75";
  const response = await page.request.get(path, {
    headers: { Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
  });
  expect(response.status()).toBe(200);
  const contentType = response.headers()["content-type"].split(";")[0];
  expect(contentType).not.toBe("image/avif");
  expect(["image/webp", "image/png"]).toContain(contentType);
  const body = await response.body();
  expect(body.length).toBeGreaterThan(0);
  const dimensions = await page.evaluate(
    async ({ data, type }) => {
      const bytes = Uint8Array.from(atob(data), (character) =>
        character.charCodeAt(0),
      );
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    { data: body.toString("base64"), type: contentType },
  );
  expect(dimensions.width).toBeGreaterThan(0);
  expect(dimensions.width).toBeLessThanOrEqual(64);
  expect(dimensions.height).toBeGreaterThan(0);
});
