import {
  expect,
  test as base,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  type NativeOrder,
  type NativeOrderKind,
} from "../src/lib/native-order";
import {
  assetPath,
  sessionCookies,
  sessionEnvironment as fixture,
} from "./environment";
import {
  assertReadOnlyWallet,
  connectSessionWallet,
  ephemeralSigner,
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

type PublicSession = {
  id: string;
  address: string;
  chainId: number;
  expiresAt: number;
  accessExpiresAt: number;
};

async function sessionMetadata(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/user/auth/session", {
      cache: "no-store",
    });
    const body = await response.json();
    // Only the public allowlist crosses back to assertions. Unexpected values are never printed.
    const session = body.session;
    return {
      status: response.status,
      noStore:
        response.headers.get("cache-control")?.includes("no-store") === true,
      publicKeysOnly:
        Object.keys(body).length === 1 &&
        Object.keys(body)[0] === "session" &&
        (!session ||
          Object.keys(session).sort().join(",") ===
            "accessExpiresAt,address,chainId,expiresAt,id"),
      session: session
        ? ({
            id: session.id,
            address: session.address,
            chainId: session.chainId,
            expiresAt: session.expiresAt,
            accessExpiresAt: session.accessExpiresAt,
          } as PublicSession)
        : null,
    };
  });
}

async function cookieState(context: BrowserContext) {
  const cookies = await context.cookies(
    fixture.webURL + "/api/user/auth/session",
  );
  const access = cookies.find(
    (cookie) => cookie.name === sessionCookies.access,
  );
  const refresh = cookies.find(
    (cookie) => cookie.name === sessionCookies.refresh,
  );
  return {
    // These two values remain in Node only. Never pass this object to an expect or log call.
    access: access?.value ?? "",
    refresh: refresh?.value ?? "",
    metadata: [access, refresh].map((cookie) => ({
      present: Boolean(cookie?.value),
      httpOnly: cookie?.httpOnly,
      sameSite: cookie?.sameSite,
      path: cookie?.path,
      localHTTP: cookie?.secure === false,
      unexpired:
        typeof cookie?.expires === "number" &&
        cookie.expires > Date.now() / 1000,
    })),
    challengeCleared: !cookies.some(
      (cookie) => cookie.name === sessionCookies.challenge,
    ),
  };
}

async function publicOrders(
  sellerAddress: string,
  kind: NativeOrderKind = "whole",
) {
  const query = new URLSearchParams({
    chainId: String(fixture.chainId),
    sellerAddress,
    kind,
  });
  const response = await fetch(`${fixture.apiURL}/v1/orders?${query}`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { data: NativeOrder[]; total: number };
}

async function browserPostOrder(page: Page, order: unknown) {
  return page.evaluate(async (order) => {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order }),
    });
    // Negative calls return status only; no credentials, headers or error bodies are retained.
    await response.body?.cancel();
    return response.status;
  }, order);
}

async function revokedStatus(action: "session" | "refresh", token: string) {
  // Native fetch avoids Playwright request diagnostics containing the bearer credential/token.
  // This helper never reads a token response and only returns an HTTP status.
  try {
    const response = await fetch(`${fixture.apiURL}/v1/user/auth/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fixture.bridgeToken}`,
      },
      body: JSON.stringify(
        action === "session" ? { accessToken: token } : { refreshToken: token },
      ),
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    throw new Error(
      "The TEST_ONLY revocation probe could not reach the local API.",
    );
  }
}

test("explicit wallet connection and signed login create only a private durable session, restored on reload", async ({
  page,
  context,
  wallet,
}) => {
  await page.goto(assetPath("whole"));
  await expect(visibleButton(page, "Connect wallet")).toBeEnabled();
  await expect(visibleButton(page, "Sign in")).toBeDisabled();
  const initiallyDisconnected = await page.evaluate(async () => {
    const ethereum = (
      window as unknown as {
        ethereum: { request: (input: { method: string }) => Promise<string[]> };
      }
    ).ethereum;
    return (await ethereum.request({ method: "eth_accounts" })).length === 0;
  });
  expect(initiallyDisconnected).toBe(true);
  expect(wallet.state.personalSigns).toBe(0);
  expect((await publicOrders(wallet.address)).total).toBe(0);

  await connectSessionWallet(page);
  // Connecting grants wallet access, but does not silently sign in or authorize any sale.
  await expect(visibleButton(page, "Sign in")).toBeEnabled();
  expect(wallet.state.personalSigns).toBe(0);
  expect((await sessionMetadata(page)).status).toBe(401);
  await signInSessionWallet(page);
  const before = await sessionMetadata(page);
  expect(before.status).toBe(200);
  expect(before.publicKeysOnly).toBe(true);
  expect(before.noStore).toBe(true);
  expect(before.session?.address.toLowerCase()).toBe(wallet.address);
  expect(before.session?.chainId).toBe(fixture.chainId);
  expect(Number.isSafeInteger(before.session?.expiresAt)).toBe(true);
  expect(Number.isSafeInteger(before.session?.accessExpiresAt)).toBe(true);
  expect(
    (before.session?.expiresAt ?? 0) > (before.session?.accessExpiresAt ?? 0),
  ).toBe(true);
  const cookies = await cookieState(context);
  expect(cookies.metadata).toEqual([
    {
      present: true,
      httpOnly: true,
      sameSite: "Strict",
      path: "/api",
      localHTTP: true,
      unexpired: true,
    },
    {
      present: true,
      httpOnly: true,
      sameSite: "Strict",
      path: "/api/user/auth",
      localHTTP: true,
      unexpired: true,
    },
  ]);
  expect(cookies.challengeCleared).toBe(true);
  const browserCannotReadCredentials = await page.evaluate(() => {
    const values = [
      document.cookie,
      ...Object.values(window.localStorage),
      ...Object.values(window.sessionStorage),
    ];
    return values.every(
      (value) =>
        !/artfi_user_(access|refresh|challenge)|accessToken|refreshToken|Bearer\s|eyJhbGciOiJIUzI1Ni/i.test(
          String(value),
        ),
    );
  });
  expect(browserCannotReadCredentials).toBe(true);

  await page.reload();
  await expect(visibleButton(page, "Sign out")).toBeVisible();
  await expect(
    page.locator(".wallet-button--connected:visible").first(),
  ).toBeVisible();
  const restored = await sessionMetadata(page);
  expect(restored.publicKeysOnly).toBe(true);
  expect(restored.session?.id).toBe(before.session?.id);
  expect(wallet.state.personalSigns).toBe(1);
  expect(wallet.state.saleSigns).toBe(0);
  expect(wallet.state.publicationPosts).toBe(0);
  expect((await publicOrders(wallet.address)).total).toBe(0);
});

test("missing access cookie rotates refresh, and explicit logout durably revokes old and current credentials", async ({
  page,
  context,
  wallet,
}) => {
  await page.goto(assetPath("whole"));
  await connectSessionWallet(page);
  await signInSessionWallet(page);
  const originalSession = await sessionMetadata(page);
  const before = await cookieState(context);
  expect(Boolean(before.access && before.refresh)).toBe(true);
  await context.clearCookies({ name: sessionCookies.access });
  const missingAccess = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/user/auth/session" &&
      response.status() === 401,
  );
  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/user/auth/refresh" &&
      response.request().method() === "POST",
  );
  await page.reload();
  await missingAccess;
  expect((await refreshed).status()).toBe(200);
  await expect(visibleButton(page, "Sign out")).toBeVisible();
  const rotated = await cookieState(context);
  expect(Boolean(rotated.access && rotated.refresh)).toBe(true);
  expect(rotated.refresh !== before.refresh).toBe(true);
  // JWT issuance in the same second may legitimately produce the same access token.
  expect((await sessionMetadata(page)).session?.id).toBe(
    originalSession.session?.id,
  );
  expect(wallet.state.personalSigns).toBe(1);

  const loggedOut = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/user/auth/logout" &&
      response.request().method() === "POST",
  );
  await visibleButton(page, "Sign out").click();
  expect((await loggedOut).status()).toBe(200);
  await expect(visibleButton(page, "Sign in")).toBeEnabled();
  const after = await cookieState(context);
  expect(Boolean(after.access || after.refresh)).toBe(false);
  expect((await sessionMetadata(page)).status).toBe(401);
  expect(await revokedStatus("session", before.access)).toBe(401);
  expect(await revokedStatus("session", rotated.access)).toBe(401);
  expect(await revokedStatus("refresh", before.refresh)).toBe(401);
  expect(await revokedStatus("refresh", rotated.refresh)).toBe(401);
  await page.reload();
  await expect(visibleButton(page, "Sign in")).toBeEnabled();
  expect(wallet.state.saleSigns).toBe(0);
  expect(wallet.state.publicationPosts).toBe(0);
  expect((await publicOrders(wallet.address)).total).toBe(0);
});

test("publication refuses an absent seller session, a different seller session, and missing sale authority", async ({
  page,
  wallet,
}) => {
  await page.goto(assetPath("whole"));
  const ownOrder = await wallet.signedOrder("whole");
  expect(await browserPostOrder(page, ownOrder)).toBe(401);
  await connectSessionWallet(page);
  await signInSessionWallet(page);
  const otherSigner = ephemeralSigner();
  const otherOrder = await otherSigner.signedOrder("whole");
  expect(await browserPostOrder(page, otherOrder)).toBe(403);
  const unsigned: Partial<NativeOrder> = { ...ownOrder };
  delete unsigned.signature;
  expect(await browserPostOrder(page, unsigned)).toBe(400);
  expect((await publicOrders(wallet.address)).total).toBe(0);
  expect((await publicOrders(otherSigner.address)).total).toBe(0);
  expect(wallet.state.personalSigns).toBe(1);
  expect(wallet.state.saleSigns).toBe(0);
  expect(wallet.state.publicationPosts).toBe(3);
});

for (const kind of ["whole", "fraction"] as const) {
  test(`${kind}: existing SaleIntent signing, explicit durable publication, idempotent retry and linked reload${kind === "fraction" ? " at 390px mobile" : ""}`, async ({
    page,
    wallet,
  }) => {
    if (kind === "fraction")
      await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(assetPath(kind));
    await connectSessionWallet(page);
    await signInSessionWallet(page);
    if (kind === "whole") {
      await page
        .getByLabel("Price, in the payment token's smallest unit", {
          exact: true,
        })
        .fill("123");
    } else {
      await page
        .getByLabel("Fractions to authorize, at most", { exact: true })
        .fill("10");
      await page
        .getByLabel(
          "Price per fraction, in the payment token's smallest unit",
          { exact: true },
        )
        .fill("41");
    }
    await page
      .getByLabel("Payment token", { exact: true })
      .fill(fixture.paymentToken);
    await expect(visibleButton(page, "Sign the sale terms")).toBeEnabled();
    await visibleButton(page, "Sign the sale terms").click();
    await expect(visibleButton(page, "Publish sale terms")).toBeEnabled();
    expect(wallet.state.personalSigns).toBe(1);
    expect(wallet.state.saleSigns).toBe(1);
    expect(wallet.state.publicationPosts).toBe(0);
    expect((await publicOrders(wallet.address, kind)).total).toBe(0);

    const firstResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/orders" &&
        response.request().method() === "POST",
    );
    await visibleButton(page, "Publish sale terms").click();
    const response = await firstResponse;
    expect(response.status()).toBe(201);
    const sent = response.request().postDataJSON() as { order: NativeOrder };
    expect(Object.keys(sent)).toEqual(["order"]);
    const saved = (await response.json()) as NativeOrder;
    expect(saved.intentHash).toBe(sent.order.intentHash);
    expect(saved.signature === sent.order.signature).toBe(true);
    expect(saved.intent.seller).toBe(wallet.address);
    expect(saved.createdAt !== undefined).toBe(true);
    await expect(
      page.getByRole("link", { name: "Open the published order", exact: true }),
    ).toBeVisible();

    const retryResponse = page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname === "/api/orders" &&
        result.request().method() === "POST",
    );
    await visibleButton(page, "Publish sale terms").click();
    const retry = await retryResponse;
    expect(retry.status()).toBe(200);
    const retried = (await retry.json()) as NativeOrder;
    expect(retried.intentHash).toBe(saved.intentHash);
    expect(retried.createdAt).toBe(saved.createdAt);
    expect(retried.signature === saved.signature).toBe(true);
    expect(wallet.state.personalSigns).toBe(1);
    expect(wallet.state.saleSigns).toBe(1);
    expect(wallet.state.publicationPosts).toBe(2);

    const directRead = await fetch(
      `${fixture.apiURL}/v1/orders/${saved.intentHash}?chainId=${fixture.chainId}&marketAddress=${saved.marketAddress}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    expect(directRead.status).toBe(200);
    const persisted = (await directRead.json()) as NativeOrder;
    expect(persisted.intent).toEqual(saved.intent);
    expect(persisted.signature === saved.signature).toBe(true);
    const listed = await publicOrders(wallet.address, kind);
    expect(listed.total).toBe(1);
    expect(listed.data.map((order) => order.intentHash)).toEqual([
      saved.intentHash,
    ]);

    await page
      .getByRole("link", { name: "Open the published order", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`[?&]order=${saved.intentHash}`));
    await expect(
      page.getByText(`Loaded order: ${saved.intentHash}`, { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(visibleButton(page, "Sign out")).toBeVisible();
    await expect(
      page.getByText(`Loaded order: ${saved.intentHash}`, { exact: true }),
    ).toBeVisible();
    if (kind === "fraction") {
      const restored = JSON.parse(
        await page
          .getByRole("textbox", { name: "Seller's authorization", exact: true })
          .inputValue(),
      );
      expect(restored.intent).toEqual(saved.intent);
      expect(restored.signature === saved.signature).toBe(true);
      expect(await page.evaluate(() => window.innerWidth)).toBe(390);
    }
    await expect(
      page
        .getByLabel("ArtFi sale orders")
        .getByText(/Open authorization/)
        .first(),
    ).toBeVisible();
    expect(wallet.state.personalSigns).toBe(1);
    expect(wallet.state.saleSigns).toBe(1);
    expect(wallet.state.publicationPosts).toBe(2);
  });
}

test("portfolio assets require signed login and disappear after logout", async ({
  page,
  wallet,
}) => {
  await page.goto("/portfolio");
  await connectSessionWallet(page);
  await expect(page.getByTestId("portfolio-wallet-gate")).toBeVisible();
  const portfolioStatus = () =>
    page.evaluate(async (address) => {
      const response = await fetch(`/api/portfolio/${address}`, {
        cache: "no-store",
      });
      await response.body?.cancel();
      return response.status;
    }, wallet.address);
  expect(await portfolioStatus()).toBe(401);
  expect(wallet.state.personalSigns).toBe(0);

  await signInSessionWallet(page);
  await expect(
    page.getByRole("heading", { name: "Authenticated portfolio", exact: true }),
  ).toBeVisible();
  expect(await portfolioStatus()).toBe(200);
  await expect(
    page.getByText(
      "No indexed token position is associated with this address.",
    ),
  ).toBeVisible();

  await visibleButton(page, "Sign out").click();
  await expect(page.getByTestId("portfolio-wallet-gate")).toBeVisible();
  await expect(
    page.getByText(
      "No indexed token position is associated with this address.",
    ),
  ).toHaveCount(0);
  await expect(visibleButton(page, "Sign in")).toBeEnabled();
  expect(await portfolioStatus()).toBe(401);
  await page.reload();
  await expect(page.getByTestId("portfolio-wallet-gate")).toBeVisible();
  expect(await portfolioStatus()).toBe(401);
});
