import { expect, test, type Page } from "@playwright/test";
import { Wallet, AbiCoder, keccak256, id } from "ethers";

test.skip(
  process.env.ARTFI_AGENT_REAL_BROWSER_FIXTURE !== "1",
  "Run scripts/agent/test-mysql.sh with ARTFI_AGENT_RUN_BROWSER=1; this requires the isolated real-service fixture.",
);
const web = "http://127.0.0.1:3000";
async function installReadOnlyWallet(page: Page, address: string) {
  await page.addInitScript(
    ({ address }) => {
      let authorized =
        sessionStorage.getItem("TEST_ONLY_AGENT_CONNECTED") === "1";
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const emit = () =>
        listeners
          .get("accountsChanged")
          ?.forEach((callback) => callback([address]));
      const permit = () => {
        authorized = true;
        sessionStorage.setItem("TEST_ONLY_AGENT_CONNECTED", "1");
        emit();
        return [{ parentCapability: "eth_accounts" }];
      };
      Object.defineProperty(window, "ethereum", {
        value: {
          isMetaMask: true,
          on(name: string, callback: (...args: unknown[]) => void) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name)!.add(callback);
          },
          removeListener(name: string, callback: (...args: unknown[]) => void) {
            listeners.get(name)?.delete(callback);
          },
          async request({ method }: { method: string }) {
            if (method === "eth_accounts") return authorized ? [address] : [];
            if (method === "eth_requestAccounts") {
              permit();
              return [address];
            }
            if (method === "wallet_requestPermissions") return permit();
            if (method === "wallet_getPermissions")
              return authorized ? [{ parentCapability: "eth_accounts" }] : [];
            if (method === "eth_chainId") return "0x88bb0";
            if (method === "net_version") return "560048";
            if (method === "wallet_getCapabilities") return {};
            throw Error(
              "TEST_ONLY browser refuses wallet signing and chain writes; test keys stay in Node.",
            );
          },
        },
      });
    },
    { address },
  );
}
test("real signed session → BFF → durable agent → lost-ack recovery → owner-approved handoff → logout", async ({
  page,
  context,
}) => {
  // Random test identity exists only in this Node closure. No private key is
  // passed to page scripts, application storage, the API or the agent runtime.
  const user = Wallet.createRandom();
  const response = await fetch("http://127.0.0.1:33328/test-only/info");
  const fixture = await response.json();
  expect(fixture.mode).toBe("TEST_ONLY_NO_REAL_VALUE");
  await installReadOnlyWallet(page, user.address);
  const challenge = await page.request.post(`${web}/api/user/auth/challenge`, {
    headers: { origin: web },
    data: { address: user.address, chainId: 560048 },
  });
  expect(challenge.status()).toBe(200);
  const challengeBody = await challenge.json();
  const signature = await user.signMessage(challengeBody.message);
  const authenticated = await page.request.post(`${web}/api/user/auth/verify`, {
    headers: { origin: web },
    data: { address: challengeBody.address, chainId: 560048, signature },
  });
  expect(authenticated.status()).toBe(200);
  const session = (await authenticated.json()).session;
  expect(session.address.toLowerCase()).toBe(user.address.toLowerCase());
  const metadata = (await context.cookies(`${web}/api/user/auth/session`))
    .filter((cookie) => cookie.name === "artfi_user_access")
    .map((cookie) => ({ httpOnly: cookie.httpOnly, path: cookie.path }));
  expect(metadata).toEqual([{ httpOnly: true, path: "/api" }]);
  const now = Math.floor(Date.now() / 1000),
    policy = fixture.policy;
  const intent = {
    intentId: id(`TEST_ONLY_BROWSER_AUTHORITY_${user.address}`),
    principal: user.address,
    wallet: user.address,
    assetScope: keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["uint256", "address", "uint256"],
        [560048, fixture.asset, "0"],
      ),
    ),
    actionScope: "128",
    maxUnitPrice: "10",
    minUnitPrice: "10",
    maxTransactionValue: "10",
    maxAggregateExposure: "20",
    maxExecutions: "2",
    maxOpenOrders: "0",
    validFrom: String(now - 1),
    validUntil: String(now + 600),
    allowedCounterpartyPolicy: policy.allowedCounterpartyPolicy,
    allowedVenuePolicy: policy.allowedVenuePolicy,
    jurisdictionPolicy: policy.jurisdictionPolicy,
    slippageLimit: "0",
    settlementPolicy: policy.settlementPolicy,
    nonce: "1",
    revocationRef: id(`TEST_ONLY_REVOCATION_${user.address}`),
  };
  const domain = {
    name: "ArtFi Bounded Intent",
    version: "1",
    chainId: "560048",
    verifyingContract: policy.executor,
  };
  const types = {
    BoundedIntent: [
      ["intentId", "bytes32"],
      ["principal", "address"],
      ["wallet", "address"],
      ["assetScope", "bytes32"],
      ["actionScope", "uint256"],
      ["maxUnitPrice", "uint256"],
      ["minUnitPrice", "uint256"],
      ["maxTransactionValue", "uint256"],
      ["maxAggregateExposure", "uint256"],
      ["maxExecutions", "uint256"],
      ["maxOpenOrders", "uint256"],
      ["validFrom", "uint256"],
      ["validUntil", "uint256"],
      ["allowedCounterpartyPolicy", "bytes32"],
      ["allowedVenuePolicy", "bytes32"],
      ["jurisdictionPolicy", "bytes32"],
      ["slippageLimit", "uint256"],
      ["settlementPolicy", "bytes32"],
      ["nonce", "uint256"],
      ["revocationRef", "bytes32"],
    ].map(([name, type]) => ({ name, type })),
  };
  const operationId = `TEST_ONLY-browser-${user.address.slice(2, 14)}`;
  const body = {
    authority: {
      domain,
      intent,
      signature: await user.signTypedData(domain, types, intent),
    },
    request: {
      operationId,
      action: "PARTIAL_FILL",
      marketKind: "FRACTION",
      market: fixture.market,
      wallet: user.address,
      asset: { contract: fixture.asset, tokenId: "0" },
      paymentToken: fixture.payment,
      terms: { ...fixture.quote, quantity: "1" },
    },
  };
  await fetch("http://127.0.0.1:33328/test-only/control", {
    method: "POST",
    headers: {
      authorization: "Bearer TEST_ONLY_LOCAL_BROWSER_ADAPTER_CREDENTIAL",
      "content-type": "application/json",
    },
    body: JSON.stringify({ loseNextResponse: true }),
  });
  const headers = {
    origin: web,
    "x-artfi-wallet": user.address,
    "x-artfi-chain": "560048",
  };
  let created;
  await expect
    .poll(
      async () => {
        created = await page.request.post(`${web}/api/agent/actions`, {
          headers,
          data: body,
        });
        return created.status();
      },
      { timeout: 15000 },
    )
    .toBe(201);
  // Duplicate create uses the same immutable request and cannot add execution.
  expect(
    (
      await page.request.post(`${web}/api/agent/actions`, {
        headers,
        data: body,
      })
    ).status(),
  ).toBe(201);
  await page.goto("/agent");
  const connect = page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .filter({ visible: true })
    .first();
  if (await connect.isVisible()) {
    await connect.click();
    await page
      .getByRole("button", { name: /Browser Wallet|Injected|MetaMask/ })
      .filter({ visible: true })
      .first()
      .click();
  }
  await expect(
    page.getByRole("heading", { name: "Runtime capabilities" }),
  ).toBeVisible();
  await expect(
    page.getByText("The current Wallet requires owner confirmation", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByLabel("Operation ID", { exact: true }).fill(operationId);
  await expect
    .poll(
      async () => {
        const state = await page.request.get(
          `${web}/api/agent/actions/${operationId}`,
          { headers },
        );
        return (await state.json()).state;
      },
      { timeout: 15000 },
    )
    .toBe("COMPLETED");
  await page
    .getByRole("button", { name: "Read operation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: `Workflow ${operationId}` }),
  ).toBeVisible();
  await expect(
    page.getByText("FILL: COMPLETED", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("agent-runtime-verified.png"),
    fullPage: true,
  });
  const latest = await (
    await fetch("http://127.0.0.1:33328/test-only/info")
  ).json();
  expect(latest.executeCalls - fixture.executeCalls).toBe(1);
  await page
    .getByRole("link", {
      name: "Continue in the existing owner-confirmed market",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/market\/fractionals$/);
  await page.goto("/agent");
  const loggedOut = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/user/auth/logout") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  expect((await loggedOut).status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Your agent operations" }),
  ).toBeVisible();
  expect(
    (
      await page.request.get(`${web}/api/agent/actions/${operationId}`, {
        headers,
      })
    ).status(),
  ).toBe(401);
});
