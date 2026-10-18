import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
const fixtureServers: Server[] = [];
test.afterEach(async () => {
  for (const server of fixtureServers.splice(0))
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});
const originalOrigin = "https://charity-holder-fixture.invalid";
const testHolderBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
  "base64",
);
const testHolderDigest = createHash("sha256")
  .update(testHolderBytes)
  .digest("hex");
const first = "0x6666666666666666666666666666666666666666";
const second = "0x7777777777777777777777777777777777777777";
type Mode =
  | "normal"
  | "hold-challenge"
  | "hold-verify"
  | "hold-descriptor"
  | "false-verified"
  | "bad-descriptor"
  | "not-holder";
async function open(page: Page, localDownload = false) {
  const bundle = readFileSync(process.env.ARTFI_PORTFOLIO_FIXTURE!, "utf8");
  const css = readFileSync(
    process.env.ARTFI_PORTFOLIO_FIXTURE!.replace(/fixture\.js$/, "style.css"),
    "utf8",
  );
  const now = Date.now();
  const state = {
    mode: "normal" as Mode,
    counts: { challenge: 0, verify: 0, descriptor: 0, file: 0 },
    blocked: [] as string[],
    aborted: [] as string[],
    lastChallenge: { address: first, tokenId: "7" },
    release: undefined as (() => void) | undefined,
    settled: false,
  };
  let origin = originalOrigin;
  if (localDownload) {
    // Chromium download requests bypass page.route here (R1-R3 recorded file:0).
    // This test-owned loopback server serves only fixed synthetic download bytes.
    const server = createServer((request, response) => {
      if (
        request.method !== "GET" ||
        request.url !== "/api/charity/editions/7/holder-asset/file"
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      state.counts.file += 1;
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Disposition":
          'attachment; filename="TEST_ONLY-watermarked.bin"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(testHolderBytes);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    fixtureServers.push(server);
    origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  }
  await page.clock.install({ time: new Date(now) });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/charity/"))
      state.aborted.push(url.pathname);
  });
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      state.blocked.push(url.origin);
      return route.abort();
    }
    if (url.pathname === "/fixture.js")
      return route.fulfill({
        contentType: "application/javascript; charset=utf-8",
        body: bundle,
      });
    if (url.pathname === "/style.css")
      return route.fulfill({
        contentType: "text/css; charset=utf-8",
        body: css,
      });
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/fixture.js"></script>',
      });
    let response: unknown,
      status = 200,
      held = false;
    if (url.pathname === "/api/charity/holder/challenge") {
      state.counts.challenge++;
      const body = request.postDataJSON() as {
        address: string;
        tokenId: string;
      };
      state.lastChallenge = {
        address: body.address,
        tokenId: BigInt(body.tokenId).toString(),
      };
      response = {
        ...state.lastChallenge,
        message: `TEST_ONLY holder challenge ${body.address} edition ${body.tokenId}`,
        expiresAt: new Date(now + 300_000).toISOString(),
      };
      held = state.mode === "hold-challenge";
    } else if (url.pathname === "/api/charity/holder/verify") {
      state.counts.verify++;
      const body = request.postDataJSON() as {
        address: string;
        signature: string;
      };
      expect(body.signature).toBe("0x" + "12".repeat(65));
      if (state.mode === "not-holder") {
        status = 403;
        response = { detail: "TEST_ONLY wallet does not hold this edition." };
      } else
        response = {
          verified: state.mode !== "false-verified",
          address: body.address,
          tokenId: state.lastChallenge.tokenId,
          expiresAt: new Date(now + 600_000).toISOString(),
          holderBenefit: "watermarked-copy-after-ownership-verification",
        };
      held = state.mode === "hold-verify";
    } else if (
      /^\/api\/charity\/editions\/[0-9]+\/holder-asset\/file$/.test(
        url.pathname,
      )
    ) {
      if (localDownload) return route.continue();
      state.counts.file++;
      return route.fulfill({
        contentType: "image/png",
        headers: {
          "Content-Disposition":
            "attachment; filename=TEST_ONLY-watermarked.bin",
          "Cache-Control": "no-store",
        },
        body: testHolderBytes,
      });
    } else if (
      /^\/api\/charity\/editions\/[0-9]+\/holder-asset$/.test(url.pathname)
    ) {
      state.counts.descriptor++;
      response = {
        tokenId: url.pathname.split("/")[4],
        class: "watermarked-holder",
        contentType: "image/png",
        byteLength: Buffer.byteLength(testHolderBytes),
        sha256: state.mode === "bad-descriptor" ? "invalid" : testHolderDigest,
        objectKey: "TEST_ONLY/watermarked",
        artworkPreview: "not-provided",
        rights:
          "This edition conveys no copyright, physical title, possession, redemption, commercial-use or reproduction right.",
      };
      held = state.mode === "hold-descriptor";
    } else {
      state.blocked.push(url.pathname);
      return route.abort();
    }
    if (held)
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    try {
      return await route.fulfill({ status, json: response });
    } catch {
      return;
    } finally {
      if (held) state.settled = true;
    }
  });
  await page.goto(origin + "/");
  const connect = async (name: "A" | "B" = "A") => {
    await page
      .getByRole("button", { name: `Connect TEST_ONLY ${name}`, exact: true })
      .click();
    await expect(page.getByTestId("actual-wallet-state")).toContainText(
      name === "A" ? first : second,
    );
  };
  return { state, connect };
}
const panel = (page: Page) => page.getByTestId("charity-holder-access");
const verify = (page: Page) =>
  panel(page).getByRole("button", { name: "Verify ownership", exact: true });
const download = (page: Page) =>
  panel(page).getByRole("link", {
    name: "Download the watermarked copy",
    exact: true,
  });
async function width(page: Page) {
  const w = await page.evaluate(() => ({
    actual: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(w.actual).toBeLessThanOrEqual(w.viewport);
}
async function finishHeld(
  page: Page,
  state: { release?: () => void; settled: boolean },
) {
  state.release?.();
  await expect.poll(() => state.settled).toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
test("unsigned holder screen performs no proof or file requests", async ({
  page,
}) => {
  const { state } = await open(page);
  await expect(panel(page).getByRole("status")).toHaveText(
    "Ownership not yet verified",
  );
  await expect(verify(page)).toHaveCount(0);
  await expect(download(page)).toHaveCount(0);
  expect(state.counts).toEqual({
    challenge: 0,
    verify: 0,
    descriptor: 0,
    file: 0,
  });
  expect(state.blocked).toEqual([]);
});
test("verified flow displays exact public file facts and downloads only on explicit click", async ({
  page,
}) => {
  const { state, connect } = await open(page, true);
  await connect();
  await verify(page).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Ownership verified",
  );
  await expect(panel(page)).toContainText(testHolderDigest);
  await expect(panel(page).locator("img,canvas,iframe")).toHaveCount(0);
  expect(state.counts).toEqual({
    challenge: 1,
    verify: 1,
    descriptor: 1,
    file: 0,
  });
  await width(page);
  await page.screenshot({
    path: test.info().outputPath("holder-verified.png"),
    fullPage: true,
  });
  const downloading = page.waitForEvent("download");
  await download(page).click();
  const file = await downloading;
  console.log(
    JSON.stringify({
      actualBrowserSuggestedFilename: file.suggestedFilename(),
      actualDownloadURL: file.url(),
      requestCounts: state.counts,
      requestFailures: state.aborted,
      configuredAcceptDownloads: test.info().project.use.acceptDownloads,
    }),
  );
  expect(file.suggestedFilename()).toBe("TEST_ONLY-watermarked.bin");
  expect(await file.failure()).toBeNull();
  const path = test.info().outputPath("TEST_ONLY-watermarked.bin");
  await file.saveAs(path);
  const actualBytes = readFileSync(path);
  expect(actualBytes.equals(testHolderBytes)).toBe(true);
  expect(createHash("sha256").update(actualBytes).digest("hex")).toBe(
    testHolderDigest,
  );
  await expect(panel(page)).toContainText(`${actualBytes.length} bytes`);
  await expect(download(page)).toHaveAttribute("download", "");
  await expect(download(page)).toHaveAttribute(
    "href",
    "/api/charity/editions/7/holder-asset/file",
  );
  expect(state.counts.file).toBe(1);
  expect(state.blocked).toEqual([]);
});
test("declined mock wallet prompt makes no verification or download request", async ({
  page,
}) => {
  const { state, connect } = await open(page);
  await connect();
  await page.evaluate(() => {
    window.charityFixture.signMode = "reject";
  });
  await verify(page).click();
  await expect(panel(page).getByRole("alert")).toContainText("declined");
  await expect(download(page)).toHaveCount(0);
  expect(state.counts).toEqual({
    challenge: 1,
    verify: 0,
    descriptor: 0,
    file: 0,
  });
  expect(state.blocked).toEqual([]);
});
test("false verification status cannot enable the watermarked file", async ({
  page,
}) => {
  const { state, connect } = await open(page);
  state.mode = "false-verified";
  await connect();
  await verify(page).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Verification needs attention",
  );
  await expect(download(page)).toHaveCount(0);
  expect(state.counts).toEqual({
    challenge: 1,
    verify: 1,
    descriptor: 0,
    file: 0,
  });
  expect(state.blocked).toEqual([]);
});
test("malformed file facts are refused without a preview or file request", async ({
  page,
}) => {
  const { state, connect } = await open(page);
  state.mode = "bad-descriptor";
  await connect();
  await verify(page).click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "description was invalid",
  );
  await expect(download(page)).toHaveCount(0);
  await expect(panel(page).locator("img,canvas,iframe")).toHaveCount(0);
  expect(state.counts.file).toBe(0);
  await width(page);
  expect(state.blocked).toEqual([]);
});
test("holder refusal is visible and does not trigger automatic retries", async ({
  page,
}) => {
  const { state, connect } = await open(page);
  state.mode = "not-holder";
  await connect();
  await verify(page).click();
  await expect(panel(page).getByRole("alert")).toHaveText(
    "TEST_ONLY wallet does not hold this edition.",
  );
  await expect(verify(page)).toBeEnabled();
  await expect(download(page)).toHaveCount(0);
  expect(state.counts).toEqual({
    challenge: 1,
    verify: 1,
    descriptor: 0,
    file: 0,
  });
  expect(state.blocked).toEqual([]);
});
test("wallet change aborts a pending challenge without an old prompt", async ({
  page,
}) => {
  const { state, connect } = await open(page);
  state.mode = "hold-challenge";
  await connect();
  await verify(page).click();
  await expect.poll(() => state.counts.challenge).toBe(1);
  await connect("B");
  await expect(panel(page).getByRole("status")).toHaveText(
    "Ownership not yet verified",
  );
  await expect.poll(() => state.aborted.length).toBe(1);
  await finishHeld(page, state);
  expect(await page.evaluate(() => window.charityFixture.signatures)).toBe(0);
  expect(state.counts.verify).toBe(0);
  expect(state.counts.descriptor).toBe(0);
  await expect(download(page)).toHaveCount(0);
  expect(state.blocked).toEqual([]);
});
test("unmount aborts pending verification and a late response cannot reveal a file", async ({
  page,
}) => {
  const { state, connect } = await open(page);
  state.mode = "hold-verify";
  await connect();
  await verify(page).click();
  await expect.poll(() => state.counts.verify).toBe(1);
  await page
    .getByRole("button", { name: "Toggle TEST_ONLY screen", exact: true })
    .click();
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => state.aborted.length).toBe(1);
  await finishHeld(page, state);
  expect(state.counts.descriptor).toBe(0);
  await page
    .getByRole("button", { name: "Toggle TEST_ONLY screen", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Ownership not yet verified",
  );
  await expect(download(page)).toHaveCount(0);
  expect(state.blocked).toEqual([]);
});
test("edition change during a pending signature cannot submit the old proof", async ({
  page,
}) => {
  const { state, connect } = await open(page);
  await connect();
  await page.evaluate(() => {
    window.charityFixture.signMode = "hold";
  });
  await verify(page).click();
  await expect
    .poll(() => page.evaluate(() => window.charityFixture.signatures))
    .toBe(1);
  await page
    .getByRole("button", { name: "Switch TEST_ONLY edition", exact: true })
    .click();
  await expect(page.getByTestId("selected-edition")).toHaveText("8");
  await expect(panel(page).getByRole("status")).toHaveText(
    "Ownership not yet verified",
  );
  await page.evaluate(() => window.charityFixture.releaseSignature?.());
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(state.counts.verify).toBe(0);
  await expect(download(page)).toHaveCount(0);
  expect(state.blocked).toEqual([]);
});
test("grant expiry removes access without another signature or file request", async ({
  page,
}) => {
  const { state, connect } = await open(page);
  await connect();
  await verify(page).click();
  await expect(download(page)).toBeVisible();
  await page.clock.fastForward(600_001);
  await expect(panel(page).getByRole("alert")).toContainText("expired");
  await expect(download(page)).toHaveCount(0);
  expect(state.counts).toEqual({
    challenge: 1,
    verify: 1,
    descriptor: 1,
    file: 0,
  });
  expect(await page.evaluate(() => window.charityFixture.signatures)).toBe(1);
  expect(state.blocked).toEqual([]);
});
