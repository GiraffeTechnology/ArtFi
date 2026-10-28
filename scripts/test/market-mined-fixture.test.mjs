import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { fixtureMining } from "../../apps/web/src/test/fixture-mining.ts";
const read = (p) =>
  readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const blockHash = `0x${"33".repeat(32)}`;

test("mined ledger retains pending identity until an actual receipt and binds exact block tags", () => {
  const m = fixtureMining(blockHash);
  assert.equal(m.inclusion("0x01").blockHash, null);
  m.observeReceipt("0x01");
  assert.deepEqual(m.inclusion("0x01"), {
    blockHash,
    blockNumber: "0x64",
    transactionIndex: "0x0",
  });
  assert.equal(m.inclusion("0x02").blockHash, null);
  assert.deepEqual(m.block("0x64", 103), { number: "0x64", hash: blockHash });
  assert.equal(m.block("latest", 103).number, "0x67");
  assert.deepEqual(m.block("pending", 103), { number: null, hash: null });
  assert.equal(m.block("earliest", 103).number, "0x0");
  assert.throws(() => m.block("invalid", 103));
});

for (const kind of ["auction", "settlement"]) {
  test(`${kind} actual RPC fixture preserves pending then binds mined transaction to receipt`, () => {
    const path =
      kind === "auction" ? "auction-workflow" : "confirmed-settlement";
    const src = read(`apps/web/e2e-market/${path}.spec.ts`);
    const start =
      kind === "auction"
        ? "const response = (rpc:"
        : "function result(request:";
    const end =
      kind === "auction"
        ? "    const data = route.request()"
        : "    const requests = Array.isArray(payload)";
    const snippet = src.slice(src.indexOf(start), src.indexOf(end));
    assert.ok(snippet.length > 100, "extract actual RPC function");
    const hash = kind === "auction" ? "0x01" : `0x${"11".repeat(32)}`;
    const state = {
      requests: [{ to: "0x123", data: "0x" }],
      block: 102,
      timestamp: 1000,
      creation: null,
      approve: "pending",
      fill: "pending",
      orders: [],
    };
    const context = vm.createContext({
      state,
      mining: fixtureMining(blockHash),
      blockHash,
      wallet: "0xabc",
      buyer: "0xabc",
      zero: "0x0",
      zeroAddress: "0x0",
      hashes: [hash],
      receiptsReady: false,
      confirm() {},
      decodeFunctionData() {
        throw Error("different ABI");
      },
      artFiFractionMarketAbi: [],
    });
    vm.runInContext(
      stripTypeScriptTypes(
        snippet +
          `\nglobalThis.rpc = ${kind === "auction" ? "response" : "result"};`,
      ),
      context,
    );
    const call = (method, value = hash) =>
      context.rpc({ id: 1, method, params: [value] }).result;
    assert.equal(call("eth_getTransactionByHash").blockHash, null);
    assert.equal(call("eth_getTransactionReceipt"), null);
    if (kind === "auction") context.receiptsReady = true;
    else state.approve = "success";
    const receipt = call("eth_getTransactionReceipt");
    assert.equal(receipt.blockNumber, "0x64");
    const tx = call("eth_getTransactionByHash");
    assert.equal(tx.blockHash, receipt.blockHash);
    assert.equal(tx.blockNumber, receipt.blockNumber);
    assert.equal(
      call("eth_getBlockByNumber", receipt.blockNumber).number,
      receipt.blockNumber,
    );
    assert.equal(call("eth_getBlockByNumber", "latest").number, "0x66");
    assert.equal(call("eth_getBlockByNumber", "pending").number, null);
  });
}

test("Vault intent fixture retains exact presentation across response and recovery, with negative overrides intact", () => {
  const src = read("apps/web/e2e-market/setup-recovery.spec.ts");
  const snippet = src.slice(
    src.indexOf("const vaultIntent ="),
    src.indexOf('  for (const kind of ["rwa", "vault"]'),
  );
  const presentation = {
    version: 1,
    description: "TEST_ONLY",
    avatar: { text: "DAO", palette: "teal" },
  };
  const state = {
    vaultIntents: [{ body: { presentation } }],
    vaultOverrides: {},
  };
  const context = vm.createContext({
    state,
    addresses: {},
    setupRequestIds: {},
  });
  vm.runInContext(
    stripTypeScriptTypes(snippet + "\nglobalThis.intent = vaultIntent;"),
    context,
  );
  assert.equal(context.intent({ presentation }).presentation, presentation);
  assert.equal(context.intent().presentation, presentation);
  state.vaultOverrides.presentation = undefined;
  assert.equal(
    context.intent().presentation,
    undefined,
    "negative mismatch fixture must remain possible",
  );
});

test("setup actual RPC fixture binds successful and reverted receipts without prematurely mining pending transactions", () => {
  const src = read("apps/web/src/test/setup-chain-fixture.ts")
    .replace(/import[\s\S]*?from\s+"[^"]+";\n/g, "")
    .replaceAll("export ", "");
  const context = vm.createContext({
    fixtureMining,
    rwaRegistryAbi: [],
    vaultFactoryAbi: [],
    erc721VaultApprovalAbi: [],
    artFiVaultAbi: [],
    parseAbi: () => [],
    zeroAddress: "0x0",
    zeroHash: "0x0",
    decodeFunctionData: () => ({ functionName: "unused", args: [] }),
  });
  vm.runInContext(
    stripTypeScriptTypes(
      src + "\nglobalThis.fixture = createSetupChainFixture();",
    ),
    context,
  );
  const fixture = context.fixture;
  for (const [index, outcome] of ["pending", "success", "reverted"].entries()) {
    const hash = `0x${String(index + 1).padStart(64, "0")}`;
    fixture.state.transactions.push({
      hash,
      from: "0xabc",
      to: "0xdef",
      data: "0x",
      nonce: index,
      action: "mint",
    });
    fixture.state.outcomes.mint = outcome;
    const call = (method, arg = hash) =>
      fixture.rpc({ id: 1, method, params: [arg] }).result;
    assert.equal(call("eth_getTransactionByHash").blockHash, null);
    const receipt = call("eth_getTransactionReceipt");
    if (outcome === "pending") {
      assert.equal(receipt, null);
      assert.equal(call("eth_getTransactionByHash").blockHash, null);
    } else {
      assert.equal(receipt.status, outcome === "success" ? "0x1" : "0x0");
      const tx = call("eth_getTransactionByHash");
      assert.equal(tx.blockHash, receipt.blockHash);
      assert.equal(tx.blockNumber, receipt.blockNumber);
      assert.equal(call("eth_getBlockByNumber", "0x64").number, "0x64");
    }
  }
});
