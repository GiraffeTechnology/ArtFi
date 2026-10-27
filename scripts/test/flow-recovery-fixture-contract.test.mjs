import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const load = (source) =>
  import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: "transform" })).toString("base64")}`
  );
const spec = read("apps/web/e2e-market/flow-recovery.spec.ts");
const constants = spec.slice(
  spec.indexOf("const walletA"),
  spec.indexOf("/** Isolated"),
);
const holder = spec.slice(
  spec.indexOf("async function holderFixture"),
  spec.indexOf('test("holder access'),
);
const start = spec.indexOf('  await page.route("**/api/portfolio/**"');
const end = spec.indexOf("  // Use the same explicit permission flow", start);
assert.ok(start > 0 && end > start);
const fixture = await load(
  `${constants}\n${holder}\nexport { holderFixture, walletA, walletB };\nexport async function portfolioFixture(page, phase, notificationStatus) { let portfolioReads = 0; const heldWalletB = []; ${spec.slice(start, end)} }`,
);
const holderRuntime = await load(
  read("apps/web/src/lib/user-auth-json.ts") +
    "\n" +
    read("apps/web/src/lib/charity-holder-state.ts").replace(
      'import { readUserJSON } from "./user-auth-json";',
      "",
    ),
);
const portfolioRuntime = await load(
  read("apps/web/src/lib/portfolio-records-contract.ts"),
);
function routes() {
  const handlers = new Map();
  return {
    handlers,
    page: {
      route: async (pattern, callback) => handlers.set(pattern, callback),
    },
  };
}

test("actual holder fixture completes the strict original holder pipeline", async () => {
  const f = routes();
  const count = await fixture.holderFixture(f.page);
  const states = [];
  let signatures = 0;
  await holderRuntime.verifyHolderAccess({
    address: fixture.walletA,
    tokenId: "1",
    isCurrent: () => true,
    signMessage: async (message) => {
      assert.equal(message, "Test-only edition 1 ownership challenge");
      signatures++;
      return `0x${"11".repeat(65)}`;
    },
    update: (state) => states.push(state),
    request: async (url) => {
      const handler = f.handlers.get(`**${url}`);
      assert.ok(handler, url);
      let result;
      await handler({
        fulfill: ({ json }) => {
          result = Response.json(json);
        },
      });
      return result;
    },
  });
  assert.equal(states.at(-1).step, "verified");
  assert.equal(signatures, 1);
  assert.equal(count(), 1);
  assert.equal(states.at(-1).descriptor.byteLength, 20);
});

test("holder fixture does not authorize a different wallet or expired challenge", async () => {
  for (const [address, lifetime] of [
    [fixture.walletB, 600000],
    [fixture.walletA, -1],
  ]) {
    const f = routes();
    const count = await fixture.holderFixture(f.page, lifetime);
    const states = [];
    await holderRuntime.verifyHolderAccess({
      address,
      tokenId: "1",
      isCurrent: () => true,
      signMessage: async () => {
        assert.fail("invalid challenge must not prompt");
      },
      update: (state) => states.push(state),
      request: async (url) => {
        let result;
        await f.handlers.get(`**${url}`)({
          fulfill: ({ json }) => {
            result = Response.json(json);
          },
        });
        return result;
      },
    });
    assert.equal(states.at(-1).step, "error");
    assert.equal(count(), 0);
  }
});

for (const status of ["confirmed", "removed"]) {
  test(`actual portfolio fixture satisfies strict ${status} identity/time/message contract`, async () => {
    for (const address of [fixture.walletA, fixture.walletB]) {
      const f = routes();
      await fixture.portfolioFixture(f.page, "ready", status);
      let body;
      await f.handlers.get("**/api/portfolio/**")({
        request: () => ({
          url: () => `https://fixture.invalid/api/portfolio/${address}`,
        }),
        fulfill: ({ json }) => {
          body = json;
        },
      });
      const result = portfolioRuntime.parsePortfolioRecords(body, address);
      assert.equal(
        result.positions[0].symbol,
        address === fixture.walletA ? "WALLET_A_ONLY" : "WALLET_B_ONLY",
      );
      assert.equal(
        result.performance.items[0].costBasis,
        "900719925474099300000001",
      );
      assert.equal(result.notifications[0].status, status);
      assert.throws(() =>
        portfolioRuntime.parsePortfolioRecords(
          body,
          address === fixture.walletA ? fixture.walletB : fixture.walletA,
        ),
      );
      assert.throws(() =>
        portfolioRuntime.parsePortfolioRecords(
          {
            ...body,
            notifications: [
              { ...body.notifications[0], message: "made-up success" },
            ],
          },
          address,
        ),
      );
    }
  });
}
