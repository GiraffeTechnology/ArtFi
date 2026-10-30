import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

type Request = { target_language: string; texts: string[] };
async function open(
  page: Page,
  reply: (body: Request) => Promise<string[]> | string[] = (body) =>
    body.texts.map((text) => `${body.target_language}:${text}`),
) {
  const calls: Request[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = readFileSync(
    process.env.ARTFI_STATIC_SELECT_FIXTURE!,
    "utf8",
  );
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://artfi-fixture.invalid") return route.abort();
    if (url.pathname === "/fixture.js")
      return route.fulfill({
        contentType: "application/javascript",
        body: fixture,
      });
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div><script src="/fixture.js"></script>',
      });
    if (url.pathname !== "/api/language/v1/translate-page")
      return route.abort();
    const body = route.request().postDataJSON() as Request;
    calls.push(body);
    try {
      await route.fulfill({
        json: { translations: await reply(body), degraded: false },
      });
    } catch {
      await route.fulfill({ status: 503, body: "Unavailable" });
    }
  });
  await page.goto("http://artfi-fixture.invalid/");
  await expect
    .poll(async () => ({
      ready: await page.locator("#status").count(),
      errors,
    }))
    .toEqual({ ready: 1, errors: [] });
  await expect(page.locator("#status")).toHaveText("idle");
  return calls;
}
async function locale(
  page: Page,
  value: "en" | "zh" | "zht" | "fr" | "es" | "de" | "ko" | "ja",
) {
  await page.evaluate((next) => window.fixture.locale(next), value);
}
async function semanticState(page: Page) {
  return page.evaluate(() => ({
    options: [...document.querySelectorAll("option")].map((option) => ({
      value: option.value,
      text: option.textContent,
      selected: option.selected,
    })),
    form: [...new FormData(document.querySelector("form")!).entries()],
    events: window.fixture.events,
  }));
}

test("seven translated locales and English restore preserve values, selection, raw text, forms and events", async ({
  page,
}) => {
  const calls = await open(page);
  const before = await semanticState(page);
  for (const next of ["zh", "zht", "fr", "es", "de", "ko", "ja"] as const) {
    await locale(page, next);
    await expect(page.locator("#public option").nth(1)).toHaveAttribute(
      "label",
      `${next}:Active at snapshot`,
    );
    await expect(page.locator("#implicit option")).toHaveAttribute(
      "label",
      `${next}:Implicit choice`,
    );
    expect(await semanticState(page)).toEqual(before);
  }
  expect(
    calls.every((call) =>
      call.texts.every((text) =>
        ["All states", "Active at snapshot", "Implicit choice"].includes(text),
      ),
    ),
  ).toBe(true);
  await locale(page, "en");
  await expect(page.locator("#status")).toHaveText("idle");
  await expect(page.locator("#public option").nth(0)).not.toHaveAttribute(
    "label",
  );
  await expect(page.locator("#public option").nth(1)).toHaveAttribute(
    "label",
    "Active at snapshot",
  );
  expect(await semanticState(page)).toEqual(before);
});

test("unmarked and skipped private options never enter translation; explicit opt-in removal restores exact labels", async ({
  page,
}) => {
  const calls = await open(page);
  await locale(page, "fr");
  await expect(page.locator("#status")).toHaveText("ready");
  for (const id of ["private", "skipped", "group"])
    await expect(page.locator(`#${id} option`)).not.toHaveAttribute("label");
  expect(calls.flatMap((call) => call.texts)).not.toContain(
    "Private account label",
  );
  await page
    .locator("#public")
    .evaluate((select) => select.removeAttribute("data-translate-options"));
  await expect(page.locator("#public option").nth(0)).not.toHaveAttribute(
    "label",
  );
  await expect(page.locator("#public option").nth(1)).toHaveAttribute(
    "label",
    "Active at snapshot",
  );
  await page
    .locator("#group optgroup")
    .evaluate((group) => group.removeAttribute("data-translation-skip"));
  await expect(page.locator("#group option")).toHaveAttribute(
    "label",
    "fr:Group choice",
  );
});

test("in-flight old source cannot label a reused value; subsequent scan translates only current text", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const calls = await open(page, async (body) => {
    if (first) {
      first = false;
      await held;
    }
    return body.texts.map((text) => `fr:${text}`);
  });
  await locale(page, "fr");
  await expect.poll(() => calls.length).toBe(1);
  await page
    .locator("#implicit option")
    .evaluate((option: HTMLOptionElement) => {
      option.textContent = "Updated choice";
      option.value = "changed";
    });
  release();
  await expect(page.locator("#implicit option")).toHaveAttribute(
    "label",
    "fr:Updated choice",
  );
  await expect(page.locator("#implicit")).toHaveValue("changed");
  expect(calls.flatMap((call) => call.texts)).toContain("Updated choice");
});

test("detached options, moved ownership and authoritative labels reject stale helper bindings", async ({
  page,
}) => {
  await open(page);
  const actual = await page.evaluate(() => {
    const labels = window.fixture.labels;
    const root = document.body;
    const option =
      document.querySelector<HTMLOptionElement>("#implicit option")!;
    const binding = labels
      .collect(root)
      .find((binding) => binding.element === option)!;
    option.remove();
    const detached = labels.write(binding, "stale");
    document.querySelector("#public")!.append(option);
    const moved = labels.write(binding, "stale");
    const next = labels
      .collect(root)
      .find((binding) => binding.element === option)!;
    option.label = "Application replacement";
    const replaced = labels.write(next, "stale");
    return { detached, moved, replaced, label: option.label };
  });
  expect(actual).toEqual({
    detached: false,
    moved: false,
    replaced: false,
    label: "Application replacement",
  });
});

test("rendered labels are text-only and oversized or empty translations retain original display", async ({
  page,
}) => {
  await open(page, (body) =>
    body.texts.map((text) =>
      text === "All states"
        ? '<img src=x onerror="alert(1)">'
        : text === "Active at snapshot"
          ? "x".repeat(2401)
          : " ",
    ),
  );
  await locale(page, "de");
  await expect(page.locator("#public option").nth(0)).toHaveAttribute(
    "label",
    '<img src=x onerror="alert(1)">',
  );
  await expect(page.locator("img")).toHaveCount(0);
  await expect(page.locator("#public option").nth(1)).toHaveAttribute(
    "label",
    "Active at snapshot",
  );
  await expect(page.locator("#implicit option")).not.toHaveAttribute("label");
});

test("translation failure restores English and locale changes cannot apply an old response", async ({
  page,
}) => {
  let fail = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = await open(page, async (body) => {
    if (body.target_language === "fr") await held;
    if (fail) throw new Error("fixture failure");
    return body.texts.map((text) => `${body.target_language}:${text}`);
  });
  await locale(page, "fr");
  await expect.poll(() => calls.length).toBe(1);
  await locale(page, "ja");
  await expect(page.locator("#implicit option")).toHaveAttribute(
    "label",
    "ja:Implicit choice",
  );
  release();
  fail = true;
  await locale(page, "ko");
  await expect(page.locator("#status")).toHaveText("unavailable");
  await expect(page.locator("#implicit option")).not.toHaveAttribute("label");
  await expect(page.locator("#public option").nth(1)).toHaveAttribute(
    "label",
    "Active at snapshot",
  );
});

test("own label mutations do not loop and externally changed labels become authoritative", async ({
  page,
}) => {
  const calls = await open(page);
  await locale(page, "es");
  await expect(page.locator("#status")).toHaveText("ready");
  await page
    .locator("#public option")
    .nth(1)
    .evaluate((option: HTMLOptionElement) => {
      option.label = "Revised label";
    });
  await expect(page.locator("#public option").nth(1)).toHaveAttribute(
    "label",
    "es:Revised label",
  );
  expect(calls.flatMap((call) => call.texts)).toContain("Revised label");
  const count = calls.length;
  // Two animation frames span delivery of our own MutationObserver records.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(calls.length).toBe(count);
  await locale(page, "en");
  await expect(page.locator("#public option").nth(1)).toHaveAttribute(
    "label",
    "Revised label",
  );
});
