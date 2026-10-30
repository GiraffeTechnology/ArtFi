import { expect, test } from "@playwright/test";

// Server-rendering checks complement, but do not replace, product-lines.spec.ts
// browser interaction and accessibility coverage.
test("product routes render three distinct product entry points", async ({
  request,
}) => {
  for (const [path, heading] of [
    ["/", "Three ways to participate in art."],
    ["/nft", "Digital art, independently collected."],
    ["/rwa", "One artwork. Its receipt. Its record."],
    ["/market/fractionals", "Fractional trading &amp; DAO."],
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    const html = await response.text();
    expect(html, path).toContain(`<h1>${heading}</h1>`);
    for (const href of ["/nft", "/rwa", "/market/fractionals"]) {
      expect(html, path).toContain(`href="${href}"`);
    }
  }
});

test("inherited workflow routes remain available beside the new product entries", async ({
  request,
}) => {
  // Eleven distinct routes may each compile on a cold Next development server.
  test.setTimeout(90_000);
  for (const path of [
    "/market/rwa",
    "/market/activity",
    "/market/rwa/blue-hour-archive",
    "/market/fractionals/blue-hour-archive",
    "/charity",
    "/charity/1",
    "/dao",
    "/portfolio",
    "/projects",
    "/projects/material-memory",
    "/operations",
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(await response.text(), path).toMatch(/<h1[ >]/);
  }
});

test("mint entry links select the corresponding existing product flow", async ({
  request,
}) => {
  for (const [path, selectedId] of [
    ["/create/rwa", "mint-tab-erc721"],
    ["/create/rwa?standard=erc1155", "mint-tab-erc1155"],
    ["/create/rwa?standard=unknown", "mint-tab-erc721"],
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    const html = await response.text();
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    const selected = buttons.find((button) =>
      button.includes(`id="${selectedId}"`),
    );
    expect(selected, path).toContain('aria-selected="true"');
  }
});
