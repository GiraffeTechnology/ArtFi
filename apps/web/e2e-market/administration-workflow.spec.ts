import { expect, test, type Page } from "@playwright/test";
import { editionCall } from "../src/test/flow-chain-fixture";
import type { Hex } from "viem";
import type { ModerationCase } from "../src/lib/administration";
const wallet = "0x1000000000000000000000000000000000000010";
async function fixture(page: Page) {
  const state = {
    authenticated: true,
    admin: true,
    failNext: false,
    cases: [] as ModerationCase[],
    mutations: [] as {
      path: string;
      body: Record<string, unknown>;
      key: string;
    }[],
    notice: {
      revision: 1,
      noticeEnabled: false,
      noticeText: "",
      updatedAt: "2026-10-05T00:00:00Z",
    },
  };
  await page.addInitScript(
    ({ wallet }) => {
      let authorized = false,
        account = wallet;
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const permissions = () => [
        {
          parentCapability: "eth_accounts",
          caveats: [{ type: "restrictReturnedAccounts", value: [account] }],
        },
      ];
      Object.defineProperty(window, "adminChangeAccount", {
        value: (next: string) => {
          account = next;
          listeners.accountsChanged?.forEach((listener) => listener([next]));
        },
      });
      Object.defineProperty(window, "ethereum", {
        value: {
          isMetaMask: true,
          on(event: string, listener: (...args: unknown[]) => void) {
            (listeners[event] ||= []).push(listener);
          },
          removeListener() {},
          async request({ method }: { method: string }) {
            if (method === "eth_accounts") return authorized ? [account] : [];
            if (method === "eth_requestAccounts") {
              authorized = true;
              return [account];
            }
            if (method === "wallet_requestPermissions") {
              authorized = true;
              return permissions();
            }
            if (method === "wallet_getPermissions")
              return authorized ? permissions() : [];
            if (method === "eth_chainId") return "0x88bb0";
            if (method === "wallet_getCapabilities") return {};
            throw Error(
              `Unexpected non-signing admin fixture action ${method}`,
            );
          },
        },
      });
    },
    { wallet },
  );
  await page.route("**/test-hoodi-rpc", async (route) => {
    const raw = route.request().postDataJSON();
    const answer = (q: { id: number; method: string; params?: unknown[] }) => ({
      id: q.id,
      jsonrpc: "2.0",
      result:
        q.method === "eth_chainId"
          ? "0x88bb0"
          : q.method === "eth_call"
            ? editionCall((q.params![0] as { data: Hex }).data)
            : "0x0",
    });
    await route.fulfill({
      json: Array.isArray(raw) ? raw.map(answer) : answer(raw),
    });
  });
  await page.route("**/api/user/auth/*", async (route) => {
    if (route.request().url().endsWith("/logout")) {
      state.authenticated = false;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill(
      state.authenticated
        ? {
            json: {
              session: {
                id: "isolated-admin-session",
                address: wallet,
                chainId: 560048,
                expiresAt: 4000000000000,
                accessExpiresAt: 4000000000000,
              },
            },
          }
        : { status: 401, json: { detail: "Sign in" } },
    );
  });
  await page.route("**/api/administration/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace(
        "/api/administration/",
        "",
      );
    if (path.startsWith("admin/") && !state.admin) {
      await route.fulfill({
        status: 403,
        json: { detail: "No moderation role." },
      });
      return;
    }
    if (
      (path.startsWith("admin/") || path.startsWith("user/")) &&
      !state.authenticated
    ) {
      await route.fulfill({ status: 401, json: { detail: "Sign in" } });
      return;
    }
    if (request.method() !== "GET") {
      const body = request.postDataJSON(),
        key = request.headers()["idempotency-key"];
      state.mutations.push({ path, body, key });
      if (state.failNext) {
        state.failNext = false;
        await route.abort("failed");
        return;
      }
      if (path === "user/moderation/cases")
        state.cases = [
          {
            id: "a".repeat(32),
            reporter: wallet,
            target: body.target,
            category: body.category,
            details: body.details,
            status: "open",
            decision: "none",
            decisionReason: "",
            publicNotice: "",
            revision: 1,
            appealStatus: "none",
            appealStatement: "",
            appealResponse: "",
            createdAt: "2026-10-05T00:00:00Z",
            updatedAt: "2026-10-05T00:00:00Z",
          },
        ];
      else if (path.endsWith("/appeals")) {
        Object.assign(state.cases[0], {
          revision: state.cases[0].revision + 1,
          status: "appealed",
          appealStatus: "pending",
          appealStatement: body.statement,
        });
      } else if (path.endsWith("/decisions")) {
        Object.assign(state.cases[0], {
          revision: state.cases[0].revision + 1,
          status: "resolved",
          decision: body.decision,
          decisionReason: body.reason,
          publicNotice: body.publicNotice,
          appealStatus:
            body.action === "uphold_appeal"
              ? "upheld"
              : state.cases[0].appealStatus,
        });
      } else if (path === "admin/config") {
        Object.assign(state.notice, body, {
          revision: state.notice.revision + 1,
        });
      }
      await route.fulfill({
        json: path === "admin/config" ? state.notice : state.cases[0],
      });
      return;
    }
    if (path === "admin/session") {
      await route.fulfill({ json: { role: "moderator" } });
      return;
    }
    if (path === "admin/config" || path === "platform/config") {
      await route.fulfill({ json: state.notice });
      return;
    }
    if (path === "admin/audit") {
      await route.fulfill({
        json: {
          data: state.mutations.map((entry, index) => ({
            id: String(index + 1),
            occurredAt: "2026-10-05T00:00:00Z",
            action: entry.path,
            resourceType: "moderation",
            requestId: entry.key,
            metadata: {
              actor: wallet,
              resourceId: "a".repeat(32),
              previousRevision: 1,
              snapshot: entry.body,
            },
          })),
          nextCursor: "",
        },
      });
      return;
    }
    if (path === "moderation/notices") {
      await route.fulfill({
        json: {
          data: state.cases
            .filter((item) => item.publicNotice)
            .map((item) => ({
              id: item.id,
              target: item.target,
              notice: item.publicNotice,
              updatedAt: item.updatedAt,
            })),
          page: 1,
          pageSize: 20,
          hasMore: false,
        },
      });
      return;
    }
    await route.fulfill({
      json: { data: state.cases, page: 1, pageSize: 20, hasMore: false },
    });
  });
  return state;
}
async function connect(page: Page) {
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: /Browser Wallet|MetaMask|Injected/ })
    .first()
    .click();
  await expect(
    page.getByText("Signed in", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
}
function resolvedCase(): ModerationCase {
  return {
    id: "a".repeat(32),
    reporter: wallet,
    target: "Isolated NFT content reference",
    category: "misleading_metadata",
    details: "TEST ONLY private report evidence",
    status: "resolved",
    decision: "no_action",
    decisionReason: "TEST ONLY initial reviewed decision",
    publicNotice: "",
    revision: 3,
    appealStatus: "none",
    appealStatement: "",
    appealResponse: "",
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
  };
}
test("private report retries reuse their request identity and sign-out clears report details", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/support");
  await expect(
    page.getByRole("button", { name: "Submit private report" }),
  ).toHaveCount(0);
  await connect(page);
  await page
    .getByLabel("Content reference", { exact: true })
    .fill("Isolated NFT content reference");
  await page
    .getByLabel("Explanation and evidence references")
    .fill("TEST ONLY private report evidence");
  state.failNext = true;
  await page.getByRole("button", { name: "Submit private report" }).click();
  await expect.poll(() => state.mutations.length).toBe(1);
  await page.getByRole("button", { name: "Submit private report" }).click();
  await expect(
    page.getByText("TEST ONLY private report evidence", { exact: true }),
  ).toBeVisible();
  expect(state.mutations).toHaveLength(2);
  expect(state.mutations[0].key).toBe(state.mutations[1].key);
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.getByText("TEST ONLY private report evidence", { exact: true }),
  ).not.toBeVisible();
});
test("owner appeal and admin resolution remain separate reviewed actions", async ({
  page,
}) => {
  const state = await fixture(page);
  state.cases = [resolvedCase()];
  await page.goto("/support");
  await connect(page);
  await page
    .getByLabel("Private appeal statement")
    .fill("TEST ONLY corrected source reference for appeal");
  await page
    .getByRole("button", { name: "Submit appeal", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Appeal: pending" }),
  ).toBeVisible();
  await page.goto("/admin");
  await connect(page);
  await page.getByLabel("Action").selectOption("uphold_appeal");
  await page.getByLabel("Content outcome").selectOption("content_warning");
  await page
    .getByLabel("Explanation for the case record")
    .fill("TEST ONLY reviewed source mismatch");
  await page
    .getByLabel("Public warning text")
    .fill("TEST ONLY public metadata clarification");
  await expect(
    page.getByRole("button", { name: "Save moderation decision" }),
  ).toBeDisabled();
  await page
    .getByLabel("I reviewed the reference and warning for public disclosure.")
    .check();
  await page.getByRole("button", { name: "Save moderation decision" }).click();
  await expect(
    page.getByRole("heading", { name: "Appeal: upheld" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Durable audit history" }),
  ).toBeVisible();
  expect(state.mutations).toHaveLength(2);
  expect(state.mutations[1].body.revision).toBe(4);
});
test("missing moderation role and account switch cannot retain private admin content", async ({
  page,
}) => {
  const state = await fixture(page);
  state.cases = [resolvedCase()];
  state.admin = false;
  await page.goto("/admin");
  await connect(page);
  await expect(
    page.getByText("No moderation role.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("TEST ONLY private report evidence", { exact: true }),
  ).toHaveCount(0);
  state.admin = true;
  await page.reload();
  await connect(page);
  await expect(
    page.getByText("TEST ONLY private report evidence", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { adminChangeAccount: (address: string) => void }
    ).adminChangeAccount("0x1000000000000000000000000000000000000020");
  });
  await expect(
    page.getByText("TEST ONLY private report evidence", { exact: true }),
  ).not.toBeVisible();
});
