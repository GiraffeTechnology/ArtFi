import { expect, test, type Page } from "@playwright/test";
import { translationPageTimeoutMs } from "../src/lib/translation-page-client";

// Real application provider and browser DOM, with a synthetic translation
// transport. These cases do not attest translation quality or a live provider.
const host = "#artfi-language-regression";
const selector = ".language-switcher select";

async function setup(page: Page, source: string, failFor?: string) {
  const requests: string[][] = [];
  await page.addInitScript(() => {
    localStorage.setItem("artfi-ui-language", "en");
  });
  await page.route("**/api/language/v1/translate-page", async (route) => {
    const body = route.request().postDataJSON() as {
      target_language: string;
      texts: string[];
    };
    requests.push(body.texts);
    await route.fulfill({
      status: failFor && body.texts.includes(failFor) ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify({
        degraded: false,
        translations: body.texts.map(
          (text) => `[${body.target_language}] ${text}`,
        ),
      }),
    });
  });
  await page.goto("/");
  await expect(page.locator(selector)).toHaveValue("en");
  await page.evaluate((text) => {
    const section = document.createElement("section");
    section.id = "artfi-language-regression";
    const status = document.createElement("p");
    status.textContent = text;
    status.setAttribute("aria-label", text);
    section.append(status);
    document.body.append(section);
  }, source);
  return requests;
}

async function updateSource(page: Page, source: string) {
  await page.evaluate((text) => {
    const status = document.querySelector("#artfi-language-regression p")!;
    const node = status.firstChild!;
    // Preserve the Text instance, as a normal React text update does.
    node.nodeValue = text;
    status.setAttribute("aria-label", text);
    if (status.firstChild !== node) throw new Error("TEXT_NODE_REPLACED");
  }, source);
}

async function holdTranslation(
  page: Page,
  source: string,
  phase: "headers" | "body",
) {
  await page.evaluate(
    ({ source, phase }) => {
      type Gate = { started: boolean; completed: boolean; release: () => void };
      const state = window as typeof window & { __artfiLanguageGate?: Gate };
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gate: Gate = { started: false, completed: false, release };
      state.__artfiLanguageGate = gate;
      const originalFetch = window.fetch.bind(window);
      let used = false;
      window.fetch = async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        if (
          used ||
          !url.includes("/api/language/v1/translate-page") ||
          !body?.texts?.includes(source)
        ) {
          return originalFetch(input, init);
        }
        used = true;
        const result = {
          degraded: false,
          translations: body.texts.map(
            (text: string) => `[${body.target_language}] ${text}`,
          ),
        };
        if (phase === "headers") {
          gate.started = true;
          await pending;
        }
        if (phase === "body") {
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              gate.started = true;
              await pending;
              gate.completed = true;
              try {
                controller.enqueue(
                  new TextEncoder().encode(JSON.stringify(result)),
                );
                controller.close();
              } catch {
                // Timeout or a locale change already cancelled this response.
              }
            },
          });
          return new Response(stream, { status: 200 });
        }
        gate.completed = true;
        return Response.json(result);
      };
    },
    { source, phase },
  );
}

async function waitForHeldTranslation(page: Page) {
  await page.waitForFunction(
    () =>
      (
        window as typeof window & {
          __artfiLanguageGate?: { started: boolean };
        }
      ).__artfiLanguageGate?.started === true,
  );
}

async function releaseTranslation(page: Page) {
  await page.evaluate(() =>
    (
      window as typeof window & {
        __artfiLanguageGate?: { release: () => void };
      }
    ).__artfiLanguageGate?.release(),
  );
  await page.waitForFunction(
    () =>
      (
        window as typeof window & {
          __artfiLanguageGate?: { completed: boolean };
        }
      ).__artfiLanguageGate?.completed === true,
  );
  // Let the resumed transport/stream microtasks and resulting DOM writes complete.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

test("a reused text node retains its new status when returning to English", async ({
  page,
}) => {
  const pending = "Receipt pending Alder",
    confirmed = "Receipt confirmed Alder";
  await setup(page, pending);
  await page.locator(selector).selectOption("fr");
  await expect(page.locator(`${host} p`)).toHaveText(`[fr] ${pending}`);
  await updateSource(page, confirmed);
  await expect(page.locator(`${host} p`)).toHaveText(`[fr] ${confirmed}`);
  await expect(page.locator(`${host} p`)).toHaveAttribute(
    "aria-label",
    `[fr] ${confirmed}`,
  );
  await page.locator(selector).selectOption("en");
  await expect(page.locator(`${host} p`)).toHaveText(confirmed);
  await expect(page.locator(`${host} p`)).toHaveAttribute(
    "aria-label",
    confirmed,
  );
});

test("a mutation during translation is rescanned without restoring the old status", async ({
  page,
}) => {
  const pending = "Receipt pending Birch",
    confirmed = "Receipt confirmed Birch";
  await setup(page, pending);
  await holdTranslation(page, pending, "body");
  await page.locator(selector).selectOption("fr");
  await waitForHeldTranslation(page);
  try {
    await updateSource(page, confirmed);
  } finally {
    await releaseTranslation(page);
  }
  await expect(page.locator(`${host} p`)).toHaveText(`[fr] ${confirmed}`);
  await expect(page.locator(`${host} p`)).toHaveAttribute(
    "aria-label",
    `[fr] ${confirmed}`,
  );
  await page.locator(selector).selectOption("en");
  await expect(page.locator(`${host} p`)).toHaveText(confirmed);
});

for (const phase of ["headers", "body"] as const) {
  test(`a stalled ${phase} response falls back and permits a later translation`, async ({
    page,
  }) => {
    const source = `Receipt pending Juniper ${phase}`;
    await setup(page, source);
    await page.clock.install();
    await holdTranslation(page, source, phase);
    await page.locator(selector).selectOption("fr");
    await waitForHeldTranslation(page);
    try {
      await page.clock.fastForward(translationPageTimeoutMs + 1);
      await expect(page.locator(`${host} p`)).toHaveText(source);
      await expect(page.locator(`${host} p`)).toHaveAttribute(
        "aria-label",
        source,
      );
      await expect(page.locator("body")).not.toHaveAttribute(
        "aria-busy",
        "true",
      );
    } finally {
      await releaseTranslation(page);
    }
    // A late response cannot replace the authoritative English fallback.
    await expect(page.locator(`${host} p`)).toHaveText(source);
    await page.locator(selector).selectOption("en");
    await page.locator(selector).selectOption("fr");
    await expect(page.locator(`${host} p`)).toHaveText(`[fr] ${source}`);
    await expect(page.locator("body")).not.toHaveAttribute("aria-busy", "true");
  });

  test(`an obsolete locale cannot write a late ${phase} response`, async ({
    page,
  }) => {
    const source = `Receipt pending Cedar ${phase}`;
    await setup(page, source);
    await holdTranslation(page, source, phase);
    await page.locator(selector).selectOption("fr");
    await waitForHeldTranslation(page);
    try {
      await page.locator(selector).selectOption("en");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
    } finally {
      await releaseTranslation(page);
    }
    await expect(page.locator(`${host} p`)).toHaveText(source);
    await expect(page.locator(`${host} p`)).toHaveAttribute(
      "aria-label",
      source,
    );
    await expect(page.locator("body")).not.toHaveAttribute("aria-busy", "true");
  });
}

test("head and attribute changes retain their new authoritative source", async ({
  page,
}) => {
  const source = "Receipt pending Dogwood",
    updated = "Receipt confirmed Dogwood";
  await setup(page, source);
  await page.evaluate(() => {
    document.title = "ArtFi pending Dogwood";
    document.querySelector('meta[name="description"]')?.remove();
    const meta = document.createElement("meta");
    meta.name = "description";
    meta.content = "Artwork pending Dogwood";
    document.head.append(meta);
  });
  await page.locator(selector).selectOption("fr");
  await expect(page).toHaveTitle("[fr] ArtFi pending Dogwood");
  await page.evaluate(() => {
    document.title = "ArtFi confirmed Dogwood";
    document
      .querySelector('meta[name="description"]')!
      .setAttribute("content", "Artwork confirmed Dogwood");
    document
      .querySelector("#artfi-language-regression p")!
      .setAttribute("aria-label", "Receipt confirmed Dogwood");
  });
  await expect(page).toHaveTitle("[fr] ArtFi confirmed Dogwood");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "[fr] Artwork confirmed Dogwood",
  );
  await expect(page.locator(`${host} p`)).toHaveAttribute(
    "aria-label",
    `[fr] ${updated}`,
  );
  await page.locator(selector).selectOption("en");
  await expect(page).toHaveTitle("ArtFi confirmed Dogwood");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "Artwork confirmed Dogwood",
  );
  await expect(page.locator(`${host} p`)).toHaveAttribute(
    "aria-label",
    updated,
  );
});

test("translation failure keeps the newly updated English status", async ({
  page,
}) => {
  const pending = "Receipt pending Elm",
    confirmed = "Receipt confirmed Elm";
  const requests = await setup(page, pending, confirmed);
  await page.locator(selector).selectOption("fr");
  await expect(page.locator(`${host} p`)).toHaveText(`[fr] ${pending}`);
  const failed = page.waitForResponse(
    (response) =>
      response.url().includes("/api/language/v1/translate-page") &&
      response.status() === 503,
  );
  await updateSource(page, confirmed);
  await failed;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(requests.some((texts) => texts.includes(confirmed))).toBe(true);
  await expect(page.locator(`${host} p`)).toHaveText(confirmed);
  await expect(page.locator(`${host} p`)).toHaveAttribute(
    "aria-label",
    confirmed,
  );
});

test("private and no-translation surfaces remain excluded", async ({
  page,
}) => {
  const source = "Receipt pending Fir",
    excluded = "Private receipt Fir";
  const requests = await setup(page, source);
  await page.evaluate((text) => {
    const section = document.querySelector("#artfi-language-regression")!;
    section.setAttribute("data-no-translate", "true");
    const p = section.querySelector("p")!;
    p.textContent = text;
    p.setAttribute("aria-label", text);
  }, excluded);
  await page.locator(selector).selectOption("fr");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await page.locator(selector).selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(requests.flat()).not.toContain(excluded);
  await expect(page.locator(`${host} p`)).toHaveText(excluded);
  await expect(page.locator(`${host} p`)).toHaveAttribute(
    "aria-label",
    excluded,
  );
});
