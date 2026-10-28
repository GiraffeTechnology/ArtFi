import { expect, test as base, type Page } from "@playwright/test";
import type { NativeOrder } from "../src/lib/native-order";
import { sessionEnvironment as fixture } from "./environment";
import {
  assertReadOnlyWallet,
  connectSessionWallet,
  installSessionWallet,
  signInSessionWallet,
  visibleButton,
} from "./wallet";

const test = base.extend<{
  wallet: Awaited<ReturnType<typeof installSessionWallet>>;
}>({
  wallet: async ({ page }, provide) => {
    const wallet = await installSessionWallet(page);
    await provide(wallet);
    assertReadOnlyWallet(wallet.state);
  },
});

async function privateReadStatus(page: Page, address: string, query = "") {
  return page.evaluate(
    async ({ address, query }) => {
      const response = await fetch(`/api/portfolio/${address}/orders${query}`, {
        cache: "no-store",
      });
      const status = response.status;
      void response.body?.cancel().catch(() => undefined);
      return status;
    },
    { address, query },
  );
}
/** TEST_ONLY EIP-712 sale publications through the actual authenticated Next/Go
 * path and MySQL. Keys stay in the original ephemeral Node signer; no chain
 * transaction or live venue is contacted. No auth credentials are returned. */
async function publish(page: Page, order: NativeOrder) {
  return page.evaluate(async (order) => {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order }),
    });
    const status = response.status;
    void response.body?.cancel().catch(() => undefined);
    return status;
  }, order);
}

for (const width of [1280, 390]) {
  test(`personal publication history uses actual sessions, durable native records, filters and pages at ${width}px`, async ({
    page,
    wallet,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/portfolio");
    expect(await privateReadStatus(page, wallet.address)).toBe(401);
    await expect(page.getByTestId("portfolio-publications")).toHaveCount(0);
    await connectSessionWallet(page);
    await signInSessionWallet(page);
    for (let index = 0; index < 11; index++) {
      const order = await wallet.signedOrder(index % 2 ? "fraction" : "whole");
      expect(await publish(page, order)).toBe(201);
    }
    const panel = page.getByTestId("portfolio-publications");
    await expect(panel).toBeVisible();
    const loaded = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === `/api/portfolio/${wallet.address}/orders` &&
        response.request().method() === "GET"
      );
    });
    await panel
      .getByRole("button", { name: "Refresh published records", exact: true })
      .click();
    expect((await loaded).status()).toBe(200);
    await expect(panel.getByTestId("portfolio-publication-record")).toHaveCount(
      10,
    );
    await expect(panel).toContainText("index reported 11 publication(s)");
    await panel
      .getByRole("button", { name: "Next publication page", exact: true })
      .click();
    await expect(panel.getByTestId("portfolio-publication-record")).toHaveCount(
      1,
    );
    await expect(panel).toContainText("Publication page 2");
    await panel
      .getByRole("button", { name: "Previous publication page", exact: true })
      .click();
    await expect(panel.getByTestId("portfolio-publication-record")).toHaveCount(
      10,
    );

    await panel
      .getByLabel("Published sale kind", { exact: true })
      .selectOption("fraction");
    await expect(panel.getByTestId("portfolio-publication-record")).toHaveCount(
      5,
    );
    await expect(
      panel
        .getByTestId("portfolio-publication-record")
        .getByRole("heading", {
          name: "Fractional sale authorization",
          exact: true,
        }),
    ).toHaveCount(5);
    await panel
      .getByLabel("Published asset or collection address", { exact: true })
      .fill(fixture.collection);
    await panel
      .getByRole("button", {
        name: "Apply publication asset filter",
        exact: true,
      })
      .click();
    await expect(panel.getByTestId("portfolio-publication-record")).toHaveCount(
      0,
    );
    await expect(panel).toContainText(
      "No publication was returned on this page",
    );
    await panel
      .getByRole("button", { name: "Reset publication filters", exact: true })
      .click();
    await expect(panel.getByTestId("portfolio-publication-record")).toHaveCount(
      10,
    );

    expect(await privateReadStatus(page, fixture.paymentToken)).toBe(403);
    expect(
      await privateReadStatus(
        page,
        wallet.address,
        `?sellerAddress=${fixture.paymentToken}`,
      ),
    ).toBe(400);
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(wallet.state.publicationPosts).toBe(11);
    expect(wallet.state.saleSigns).toBe(0);
    const loggedOut = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/user/auth/logout" &&
        response.request().method() === "POST",
    );
    await visibleButton(page, "Sign out").click();
    expect((await loggedOut).status()).toBe(200);
    await expect(page.getByTestId("portfolio-publications")).toHaveCount(0);
    await expect(page.getByTestId("portfolio-publication-record")).toHaveCount(
      0,
    );
    expect(await privateReadStatus(page, wallet.address)).toBe(401);
  });
}

test("an older whole-sale response cannot replace a newer fractional filter result", async ({
  page,
  wallet,
}) => {
  await page.goto("/portfolio");
  await connectSessionWallet(page);
  await signInSessionWallet(page);
  for (const kind of ["whole", "fraction"] as const)
    expect(await publish(page, await wallet.signedOrder(kind))).toBe(201);
  const panel = page.getByTestId("portfolio-publications");
  await panel
    .getByRole("button", { name: "Refresh published records", exact: true })
    .click();
  await expect(panel.getByTestId("portfolio-publication-record")).toHaveCount(
    2,
  );
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    const w = window as unknown as {
      TEST_ONLY_publicationHeld: boolean;
      TEST_ONLY_releasePublication: () => void;
    };
    w.TEST_ONLY_publicationHeld = false;
    let intercepted = false;
    window.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        location.href,
      );
      if (
        !intercepted &&
        url.pathname.includes("/api/portfolio/") &&
        url.pathname.endsWith("/orders") &&
        url.searchParams.get("kind") === "whole"
      ) {
        intercepted = true;
        // Return an actual server response late despite the retired browser
        // request's abort; credentials and the response remain inside the page.
        const response = await original(input, { ...init, signal: undefined });
        w.TEST_ONLY_publicationHeld = true;
        return new Promise<Response>((resolve) => {
          w.TEST_ONLY_releasePublication = () => resolve(response);
        });
      }
      return original(input, init);
    };
  });
  await panel
    .getByLabel("Published sale kind", { exact: true })
    .selectOption("whole");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { TEST_ONLY_publicationHeld: boolean })
            .TEST_ONLY_publicationHeld,
      ),
    )
    .toBe(true);
  await panel
    .getByLabel("Published sale kind", { exact: true })
    .selectOption("fraction");
  await expect(panel.getByTestId("portfolio-publication-record")).toHaveCount(
    1,
  );
  await expect(
    panel
      .getByTestId("portfolio-publication-record")
      .getByRole("heading", {
        name: "Fractional sale authorization",
        exact: true,
      }),
  ).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { TEST_ONLY_releasePublication: () => void }
    ).TEST_ONLY_releasePublication(),
  );
  await page.waitForTimeout(100);
  await expect(panel.getByTestId("portfolio-publication-record")).toHaveCount(
    1,
  );
  await expect(
    panel
      .getByTestId("portfolio-publication-record")
      .getByRole("heading", {
        name: "Fractional sale authorization",
        exact: true,
      }),
  ).toBeVisible();
  expect(wallet.state.publicationPosts).toBe(2);
  expect(wallet.state.saleSigns).toBe(0);
});
