import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const consoleSource = readFileSync(
  resolve(process.cwd(), "../../scripts/agent/agent-console.mjs"),
  "utf8",
);
const intentSource = readFileSync(
  resolve(process.cwd(), "../../scripts/agent/bounded-intent.mjs"),
  "utf8",
);

interface AgentHarnessWindow extends Window {
  __agentHarness: {
    calls: {
      create: number;
      get: number;
      revoke: number;
      sign: number;
      walletRevoke: number;
    };
    current: {
      execution: { state: string; transactionHash?: string };
      fresh: boolean;
      grounding: { mintAuthority: Record<string, unknown>; state: string };
      observedAt: number;
      reconciliation: { accountingMatches?: boolean; state: string };
      recovery: { state: string };
      revocation: { state: string };
    };
    remount: () => void;
  };
}

test("TEST_ONLY Agent console exposes safe lifecycle and restart recovery", async ({
  page,
}) => {
  await page.setContent(`<!doctype html>
    <html lang="zh-Hans">
      <head><title>ArtFi Agent TEST_ONLY browser contract</title></head>
      <body><main id="agent-console"></main></body>
    </html>`);
  await page.evaluate(
    async ({ agentConsoleSource, boundedIntentSource }) => {
      const intentUrl = URL.createObjectURL(
        new Blob([boundedIntentSource], { type: "text/javascript" }),
      );
      const resolvedConsoleSource = agentConsoleSource.replace(
        '"./bounded-intent.mjs"',
        JSON.stringify(intentUrl),
      );
      const consoleUrl = URL.createObjectURL(
        new Blob([resolvedConsoleSource], { type: "text/javascript" }),
      );
      const { mountAgentConsole } = (await import(consoleUrl)) as {
        mountAgentConsole: (
          root: HTMLElement,
          adapters: Record<string, unknown>,
        ) => { dispose: () => void };
      };
      const address = (byte: string) => `0x${byte.repeat(40)}`;
      const digest = (byte: string) => `0x${byte.repeat(64)}`;
      const now = Date.now();
      const draft = {
        operationId: "test-only-buy-1",
        mode: "TEST_ONLY_NO_REAL_VALUE",
        domain: {
          name: "ArtFi Bounded Intent",
          version: "1",
          chainId: "560048",
          verifyingContract: address("3"),
        },
        asset: { chainId: "560048", contract: address("5"), tokenId: "7" },
        intent: {
          intentId: digest("7"),
          principal: address("1"),
          wallet: address("1"),
          assetScope: digest("a"),
          actionScope: "1",
          maxUnitPrice: "10",
          minUnitPrice: "10",
          maxTransactionValue: "10",
          maxAggregateExposure: "20",
          maxExecutions: "1",
          maxOpenOrders: "0",
          validFrom: "0",
          validUntil: "4102444800",
          allowedCounterpartyPolicy: digest("c"),
          allowedVenuePolicy: digest("d"),
          jurisdictionPolicy: digest("e"),
          slippageLimit: "0",
          settlementPolicy: digest("f"),
          nonce: "1",
          revocationRef: digest("8"),
        },
      };
      const calls = {
        create: 0,
        get: 0,
        revoke: 0,
        sign: 0,
        walletRevoke: 0,
      };
      let recordFailures = 1;
      const current = {
        ...structuredClone(draft),
        id: draft.operationId,
        executor: draft.domain.verifyingContract,
        execution: { state: "PREPARED" },
        grounding: {
          state: "CURRENT",
          mintAuthority: {
            status: "EXCLUSIVE_AT_PINNED_BLOCK",
            requestedBlockNumber: 123,
            requestedBlockHash: digest("9"),
          },
        },
        reconciliation: { state: "UNKNOWN" },
        recovery: { state: "UNKNOWN" },
        revocation: { state: "NOT_REQUESTED" },
        fresh: true,
        observedAt: now,
      };
      const api = {
        async prepareIntent(input: Record<string, string>) {
          return {
            ...structuredClone(draft),
            asset: {
              chainId: "560048",
              contract: input.contract,
              tokenId: input.tokenId,
            },
            intent: {
              ...structuredClone(draft.intent),
              maxUnitPrice: input.maxUnitPrice,
              validUntil: input.validUntil,
            },
          };
        },
        async createIntent() {
          calls.create += 1;
          return { id: draft.operationId };
        },
        async getIntent() {
          calls.get += 1;
          return structuredClone(current);
        },
        async recordRevocation(id: string, transactionHash: string) {
          calls.revoke += 1;
          if (transactionHash !== digest("b").toLowerCase())
            throw new Error("REVOCATION_HASH_NOT_CANONICAL");
          if (recordFailures-- > 0)
            throw new Error("RECORD_TEMPORARILY_UNAVAILABLE");
          current.revocation.state = "PENDING";
          return { id, state: "PENDING" };
        },
      };
      const wallet = {
        async signIntent() {
          calls.sign += 1;
          return `0x${"11".repeat(65)}`;
        },
        async revokeNonce() {
          calls.walletRevoke += 1;
          return { transactionHash: `0x${"bB".repeat(32)}` };
        },
      };
      const root = document.querySelector<HTMLElement>("#agent-console");
      if (!root) throw new Error("TEST_ROOT_MISSING");
      const revocationEntries = new Map<string, string>();
      const revocationStorage = {
        getItem(key: string) {
          return revocationEntries.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          revocationEntries.set(key, value);
        },
        removeItem(key: string) {
          revocationEntries.delete(key);
        },
      };
      const adapters = {
        api,
        wallet,
        maxObservationAgeMs: 30_000,
        revocationStorage,
      };
      let controller = mountAgentConsole(root, adapters);
      const harness = {
        calls,
        current,
        remount() {
          controller.dispose();
          controller = mountAgentConsole(root, adapters);
        },
      };
      (window as unknown as AgentHarnessWindow).__agentHarness = harness;
    },
    { agentConsoleSource: consoleSource, boundedIntentSource: intentSource },
  );

  await expect(
    page.getByRole("heading", { level: 1, name: "ArtFi Agent" }),
  ).toBeVisible();
  await expect(page.getByText(/TEST_ONLY_NO_REAL_VALUE/)).toBeVisible();

  await page.getByLabel("NFT 合约地址").fill(`0x${"5".repeat(40)}`);
  await page.getByLabel("Token ID").fill("7");
  await page.getByLabel("最高单价（最小货币单位）").fill("10");
  await page.getByLabel("到期 Unix 秒").fill("4102444800");
  await page.getByRole("button", { name: "准备授权草案" }).click();
  await expect(
    page.getByText("请核对全部授权字段后，用自己的钱包签名。"),
  ).toBeVisible();
  await expect(
    page.getByText('"operationId": "test-only-buy-1"'),
  ).toBeVisible();

  await page.getByRole("button", { name: "钱包签名并创建 intent" }).click();
  await expect(
    page.getByText("已读取服务端状态；历史铸造不代表当前可交易。"),
  ).toBeVisible();
  await expect(
    page.locator("dt", { hasText: "执行" }).locator("+ dd"),
  ).toContainText("PREPARED");
  await expect(
    page.getByRole("button", { name: "通过钱包撤销 nonce" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "通过钱包撤销 nonce" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "RECORD_TEMPORARILY_UNAVAILABLE",
  );
  await page.evaluate(() => {
    (window as unknown as AgentHarnessWindow).__agentHarness.remount();
  });
  await page.getByLabel("Intent / operation ID").fill("test-only-buy-1");
  await page.getByRole("button", { name: "读取最新状态" }).click();
  await expect(
    page.getByRole("button", { name: "重试记录已提交撤销" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "重试记录已提交撤销" }).click();
  await expect(
    page.locator("dt", { hasText: "撤销" }).locator("+ dd"),
  ).toHaveText("PENDING");
  await expect(
    page.getByRole("button", { name: "通过钱包撤销 nonce" }),
  ).toBeDisabled();

  await page.evaluate(() => {
    const harness = (window as unknown as AgentHarnessWindow).__agentHarness;
    harness.current.execution.state = "SAFE_DEGRADED";
    harness.current.grounding.state = "CURRENT";
    harness.current.reconciliation.state = "RECONCILING";
    harness.current.recovery.state = "SAFE_DEGRADED";
    harness.current.revocation.state = "UNKNOWN";
    harness.current.fresh = false;
    harness.current.observedAt = Date.now() - 60_000;
  });
  await page.getByRole("button", { name: "读取最新状态" }).click();
  await expect(
    page.locator("dt", { hasText: "Grounding" }).locator("+ dd"),
  ).toContainText("STALE");
  await expect(page.getByRole("status")).toContainText("来源过期");

  await page.evaluate(() => {
    const harness = (window as unknown as AgentHarnessWindow).__agentHarness;
    harness.current.execution.state = "TERMINAL_REJECTED";
    harness.current.grounding.state = "STALE";
    harness.current.reconciliation.state = "UNKNOWN";
    harness.current.recovery.state = "STOPPED";
    harness.current.revocation.state = "CONFIRMED";
    harness.current.fresh = true;
    harness.current.observedAt = Date.now();
    harness.remount();
  });
  await page.getByLabel("Intent / operation ID").fill("test-only-buy-1");
  await page.getByRole("button", { name: "读取最新状态" }).click();
  await expect(
    page.locator("dt", { hasText: "恢复" }).locator("+ dd"),
  ).toContainText("STOPPED");
  await expect(
    page.locator("dt", { hasText: "执行" }).locator("+ dd"),
  ).toContainText("TERMINAL_REJECTED");

  const calls = await page.evaluate(
    () => (window as unknown as AgentHarnessWindow).__agentHarness.calls,
  );
  expect(calls).toEqual({
    create: 1,
    get: 5,
    revoke: 2,
    sign: 1,
    walletRevoke: 1,
  });
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
});
