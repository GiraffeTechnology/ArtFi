import { createHash } from "node:crypto";
import { expect, test as base, type Page } from "@playwright/test";
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
type Observation = {
  chainId: number;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  contractAddress: string;
  eventName: string;
  payload: { owner: string };
  confirmations: number;
  removed: boolean;
};
function observation(owner: string, index: number): Observation {
  // Synthetic indexer observations only. These are not actual chain receipts or rights evidence.
  return {
    chainId: fixture.chainId,
    transactionHash: `0x${createHash("sha256").update(`TEST_ONLY_HISTORY:${owner}:${index}`).digest("hex")}`,
    logIndex: index % 2,
    blockNumber: 200000 + Math.floor(index / 2),
    blockHash: "0x" + "a".repeat(64),
    contractAddress: index % 2 ? fixture.fractionToken : fixture.collection,
    eventName:
      index % 2 ? "TEST_ONLY_AlternateEvent" : "TEST_ONLY_HistoryEvent",
    payload: { owner },
    confirmations: 1,
    removed: false,
  };
}
async function index(event: Observation) {
  // The existing disposable Go service and TEST_ONLY indexer identity stay in Node.
  // No credential or indexer write is exposed to the browser.
  const response = await fetch(`${fixture.apiURL}/v1/indexer/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Indexer-Key": fixture.indexerKey,
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5000),
  });
  const status = response.status;
  await response.arrayBuffer();
  return status;
}
async function historyStatus(page: Page, owner: string, query = "") {
  return page.evaluate(
    async ({ owner, query }) => {
      const response = await fetch(`/api/portfolio/${owner}/history${query}`, {
        cache: "no-store",
      });
      const status = response.status;
      await response.arrayBuffer();
      return status;
    },
    { owner, query },
  );
}
for (const width of [1280, 390]) {
  test(`authenticated indexed history reaches older records and reconciles reorg at ${width}px`, async ({
    page,
    wallet,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/portfolio");
    expect(await historyStatus(page, wallet.address)).toBe(401);
    await expect(page.getByTestId("portfolio-indexed-history")).toHaveCount(0);
    await connectSessionWallet(page);
    await signInSessionWallet(page);
    const events = Array.from({ length: 115 }, (_, index) =>
      observation(wallet.address, index),
    );
    for (const event of events) expect(await index(event)).toBe(201);
    for (let indexNumber = 0; indexNumber < 2; indexNumber++)
      expect(
        await index(
          observation(fixture.paymentToken, width * 10 + indexNumber),
        ),
      ).toBe(201);
    const panel = page.getByTestId("portfolio-indexed-history");
    await panel
      .getByRole("button", { name: "Refresh all indexed history", exact: true })
      .click();
    await expect(panel).toContainText(
      "reports 115 matching participant event(s)",
    );
    await expect(
      panel.getByTestId("portfolio-indexed-history-entry"),
    ).toHaveCount(10);
    await panel
      .getByLabel("Indexed history order", { exact: true })
      .selectOption("oldest");
    await expect(
      panel.getByTestId("portfolio-indexed-history-entry").first(),
    ).toContainText(events[0].transactionHash);
    for (let pageNumber = 2; pageNumber <= 11; pageNumber++) {
      await panel
        .getByRole("button", { name: "Next indexed history page", exact: true })
        .click();
      await expect(panel).toContainText(`Indexed history page ${pageNumber}`);
    }
    await expect(
      panel.getByTestId("portfolio-indexed-history-entry").first(),
    ).toContainText(events[100].transactionHash);
    await panel
      .getByRole("button", { name: "Next indexed history page", exact: true })
      .click();
    await expect(
      panel.getByTestId("portfolio-indexed-history-entry"),
    ).toHaveCount(5);
    await expect(
      panel.getByRole("button", {
        name: "Next indexed history page",
        exact: true,
      }),
    ).toBeDisabled();
    await panel
      .getByLabel("Exact indexed event name", { exact: true })
      .fill("TEST_ONLY_HistoryEvent");
    await panel
      .getByLabel("Indexed contract address", { exact: true })
      .fill(fixture.collection);
    await panel
      .getByRole("button", {
        name: "Apply indexed history filters",
        exact: true,
      })
      .click();
    await expect(panel).toContainText(
      "reports 58 matching participant event(s)",
    );
    await expect(panel).toContainText("Indexed history page 1");
    await panel
      .getByLabel("Indexed history status", { exact: true })
      .selectOption("removed");
    await expect(panel).toContainText(
      "reports 0 matching participant event(s)",
    );
    expect(await index({ ...events[0], removed: true })).toBe(200);
    await panel
      .getByRole("button", { name: "Refresh all indexed history", exact: true })
      .click();
    await expect(panel).toContainText(
      "reports 1 matching participant event(s)",
    );
    await expect(panel).toContainText(
      "earlier indexed confirmation no longer applies",
    );
    expect(await historyStatus(page, fixture.paymentToken)).toBe(403);
    expect(await historyStatus(page, wallet.address, "?chainId=1")).toBe(400);
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(wallet.state.saleSigns).toBe(0);
    expect(wallet.state.publicationPosts).toBe(0);
    const logout = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/user/auth/logout" &&
        response.request().method() === "POST",
    );
    await visibleButton(page, "Sign out").click();
    expect((await logout).status()).toBe(200);
    await expect(page.getByTestId("portfolio-indexed-history")).toHaveCount(0);
    await expect(
      page.getByTestId("portfolio-indexed-history-entry"),
    ).toHaveCount(0);
    expect(await historyStatus(page, wallet.address)).toBe(401);
  });
}
