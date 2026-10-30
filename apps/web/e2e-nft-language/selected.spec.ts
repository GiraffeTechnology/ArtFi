const copy: Record<string, Record<string, string>> = {
  en: {
    "Confirm in wallet": "Confirm in wallet",
    "Close review": "Close review",
    "Discard unsigned review": "Discard unsigned review",
    "Wallet action review": "Wallet action review",
  },
  zh: {
    "Confirm in wallet": "在钱包中确认",
    "Close review": "关闭审阅",
    "Discard unsigned review": "放弃未签名审阅",
    "Wallet action review": "钱包操作审阅",
  },
  zht: {
    "Confirm in wallet": "在錢包中確認",
    "Close review": "關閉審閱",
    "Discard unsigned review": "放棄未簽名審閱",
    "Wallet action review": "錢包操作審閱",
  },
  fr: {
    "Confirm in wallet": "Confirmer dans le portefeuille",
    "Close review": "Fermer la vérification",
    "Discard unsigned review": "Abandonner la vérification non signée",
    "Wallet action review": "Vérification de l’action du portefeuille",
  },
  es: {
    "Confirm in wallet": "Confirmar en la cartera",
    "Close review": "Cerrar revisión",
    "Discard unsigned review": "Descartar revisión sin firmar",
    "Wallet action review": "Revisión de la acción de la cartera",
  },
  de: {
    "Confirm in wallet": "In der Wallet bestätigen",
    "Close review": "Prüfung schließen",
    "Discard unsigned review": "Unsignierte Prüfung verwerfen",
    "Wallet action review": "Wallet-Aktion prüfen",
  },
  ko: {
    "Confirm in wallet": "지갑에서 확인",
    "Close review": "검토 닫기",
    "Discard unsigned review": "서명하지 않은 검토 취소",
    "Wallet action review": "지갑 작업 검토",
  },
  ja: {
    "Confirm in wallet": "ウォレットで確認",
    "Close review": "確認を閉じる",
    "Discard unsigned review": "未署名の確認を破棄",
    "Wallet action review": "ウォレット操作の確認",
  },
};
import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {} from "./fixtures/main";
import type { NftPlan, NftRequest } from "../src/lib/nft/model";
const origin = "https://nft-language-fixture.invalid",
  account = "0x1111111111111111111111111111111111111111",
  hash = `0x${"ab".repeat(32)}`,
  seaport = "0x0000000000000068F116a894984e2DB1123eB395";
const scope = {
  slug: "test-only-digital",
  chain: "ethereum" as const,
  contract: "0x2222222222222222222222222222222222222222" as const,
  standard: "erc1155" as const,
  label: "TEST_ONLY digital collection",
  charity: false,
};
const token = {
  tokenId: "7",
  name: "TEST_ONLY digital edition",
  contract: scope.contract,
  standard: scope.standard,
  collection: scope.slug,
};
type Operation = {
  id: string;
  status: string;
  walletStarted?: boolean;
  plan: NftPlan;
  transactionHash?: string;
  orderHash?: string;
};
async function open(
  page: Page,
  mode = "normal",
  kind: "signature" | "approval" | "transaction" = "signature",
) {
  const root = dirname(process.env.ARTFI_PORTFOLIO_FIXTURE!);
  const modules = new Map(
    readdirSync(root)
      .filter((n) => /^[a-zA-Z0-9_.-]+\.(js|css)$/.test(n))
      .map((n) => ["/" + n, readFileSync(join(root, n), "utf8")]),
  );
  const blocked: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const state = {
    translations: [] as { locale: string; texts: string[] }[],
    operation: null as Operation | null,
    prepare: 0,
    review: 0,
    start: 0,
    sign: 0,
    broadcast: 0,
    uncertain: 0,
    status: 0,
    reconcile: false,
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      blocked.push(url.href);
      return route.abort();
    }
    if (modules.has(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith(".css")
          ? "text/css"
          : "application/javascript",
        body: modules.get(url.pathname)!,
      });
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
      });
    if (url.pathname === "/api/language/v1/translate-page") {
      const body = route.request().postDataJSON() as {
        target_language: keyof typeof copy;
        texts: string[];
      };
      state.translations.push({
        locale: body.target_language,
        texts: body.texts,
      });
      const dictionary = copy[body.target_language];
      return route.fulfill({
        json: {
          degraded: false,
          translations: body.texts.map(
            (text) => dictionary[text] || `${body.target_language} ⟦${text}⟧`,
          ),
        },
      });
    }
    if (url.pathname.startsWith("/api/user/auth/"))
      return route.fulfill({
        json: {
          session: {
            id: "e".repeat(32),
            address: account,
            chainId: 1,
            expiresAt: Date.now() + 600000,
            accessExpiresAt: Date.now() + 600000,
          },
        },
      });
    if (!url.pathname.startsWith("/api/nft/")) {
      blocked.push(url.pathname);
      return route.abort();
    }
    const action = url.pathname.split("/").pop();
    if (action === "config")
      return route.fulfill({
        json: { collections: [scope], tradingEnabled: true },
      });
    if (action === "catalog")
      return route.fulfill({
        json: {
          data: [token],
          next: null,
          scope,
          source: "opensea",
          observedAt: "2026-10-19T11:00:00Z",
        },
      });
    if (action === "detail")
      return route.fulfill({
        json: {
          nft: token,
          scope,
          orders: [],
          ordersUnavailable: false,
          observedAt: "2026-10-19T11:00:00Z",
        },
      });
    const body = route.request().postDataJSON();
    if (action === "prepare") {
      state.prepare++;
      const request = body.request as NftRequest;
      const plan: NftPlan = {
        id: "TEST_ONLY-plan",
        operationId: body.operationId,
        sessionId: "e".repeat(32),
        chainId: 1,
        request,
        scope,
        expiresAt: Date.now() + 120000,
        kind,
        summary: "TEST_ONLY reviewed digital NFT",
        fees: [],
        ...(kind === "signature"
          ? {
              typedData: {
                domain: {
                  name: "Seaport",
                  version: "1.6",
                  chainId: 1,
                  verifyingContract: seaport,
                },
                primaryType: "OrderComponents",
                types: {
                  OrderComponents: [{ name: "offerer", type: "address" }],
                },
                message: { offerer: account },
              },
            }
          : {
              transaction: {
                to: kind === "approval" ? scope.contract : seaport,
                data: "0x12345678",
                value: "0",
              },
            }),
      };
      if (mode === "unknown-kind") Reflect.set(plan, "kind", "other");
      if (mode === "string-expiry")
        Reflect.set(plan, "expiresAt", String(Date.now() + 120000));
      if (mode === "odd-data") plan.transaction!.data = "0x123456789";
      if (mode === "mixed-data") Reflect.set(plan, "typedData", {});
      state.operation = {
        id: body.operationId,
        status: "awaiting-wallet",
        plan,
      };
      return route.fulfill({ json: state.operation });
    }
    if (!state.operation)
      return route.fulfill({
        status: 404,
        json: { detail: "TEST_ONLY no operation" },
      });
    if (action === "review") {
      state.review++;
      if (state.operation.walletStarted)
        return route.fulfill({
          status: 409,
          json: {
            detail:
              "A wallet request was already started. Reconcile it before another request.",
          },
        });
      if (mode === "changed-review")
        return route.fulfill({
          json: {
            ...state.operation,
            plan: {
              ...state.operation.plan,
              summary: "Unreviewed changed terms",
            },
          },
        });
    }
    if (action === "wallet-start") {
      state.start++;
      state.operation.walletStarted = true;
      if (mode === "start-ack-lost")
        return route.fulfill({
          status: 503,
          json: { detail: "TEST_ONLY wallet-start response lost" },
        });
    }
    if (action === "sign") {
      state.sign++;
      state.operation.status = "accepted";
      state.operation.orderHash = hash;
    }
    if (action === "broadcast") {
      state.broadcast++;
      state.operation.transactionHash = body.transactionHash;
      state.operation.status = state.reconcile ? "confirmed" : "submitted";
      if (mode === "broadcast-ack-lost" && !state.reconcile)
        return route.fulfill({
          status: 503,
          json: { detail: "TEST_ONLY broadcast acknowledgement lost" },
        });
    }
    if (action === "wallet-uncertain") {
      state.uncertain++;
      state.operation.status = "unknown";
    }
    if (action === "wallet-rejected") state.operation.status = "rejected";
    if (action === "status") {
      state.status++;
      if (state.reconcile) state.operation.status = "confirmed";
    }
    return route.fulfill({ json: state.operation });
  });
  await page.goto(origin);
  await expect(page.getByTestId("session-state")).toHaveText("authenticated");
  await page.evaluate((m) => window.nftFixture.setMode(m), mode);
  await page.getByRole("button", { name: "Inspect NFT", exact: true }).click();
  await page
    .getByRole("button", { name: "Create listing", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Wallet action review", exact: true }),
  ).toBeVisible();
  return {
    state,
    async clean(signs = 0, sends = 0) {
      expect(await page.evaluate(() => window.nftFixture.dump())).toMatchObject(
        { signs, sends },
      );
      expect(blocked).toEqual([]);
      expect(errors).toEqual([]);
    },
  };
}

for (const locale of ["en", "zh", "zht", "fr", "es", "de", "ko", "ja"] as const)
  test(`localized review controls ${locale} preserve facts and original wallet request`, async ({
    page,
  }) => {
    const c = await open(page),
      original = structuredClone(c.state.operation!.plan);
    await page.locator(".language-switcher select").selectOption(locale);
    const review = page.locator(".nft-review");
    await expect(
      review.getByRole("button", {
        name: copy[locale]["Confirm in wallet"],
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      review.getByRole("button", {
        name: copy[locale]["Close review"],
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      review.getByRole("button", {
        name: copy[locale]["Discard unsigned review"],
        exact: true,
      }),
    ).toBeVisible();
    await expect(review).toHaveAttribute(
      "aria-label",
      copy[locale]["Wallet action review"],
    );
    expect(c.state.operation!.plan).toEqual(original);
    const sources = c.state.translations.flatMap((row) => row.texts);
    for (const fact of [
      original.summary,
      original.request.account,
      original.scope.contract,
      original.scope.label,
    ])
      expect(sources.some((source) => source.includes(fact))).toBe(false);
    await expect(
      review
        .locator("[data-no-translate]")
        .filter({ hasText: original.summary }),
    ).toHaveText(original.summary);
    await review
      .getByRole("button", {
        name: copy[locale]["Confirm in wallet"],
        exact: true,
      })
      .click();
    await expect(
      review.locator("[data-no-translate]").filter({ hasText: /^accepted$/ }),
    ).toHaveText("accepted");
    expect(c.state.sign).toBe(1);
    expect(c.state.start).toBe(1);
    expect(c.state.broadcast).toBe(0);
    expect(c.state.operation!.plan).toEqual(original);
    await c.clean(1, 0);
    await page.locator(".language-switcher select").selectOption("en");
    await expect(
      review.getByRole("button", { name: "Close review", exact: true }),
    ).toBeVisible();
  });
