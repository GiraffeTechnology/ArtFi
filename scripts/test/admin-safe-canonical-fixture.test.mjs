import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import test from "node:test";
import { fixtureMining } from "../../apps/web/src/test/fixture-mining.ts";
const read = (p) =>
  readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const safeHash = `0x${"95".repeat(32)}`;
const baseHash = `0x${"74".repeat(32)}`;
function fixture() {
  const baseMining = fixtureMining(baseHash);
  const context = vm.createContext({
    setupAddresses: {},
    createSetupChainFixture: () => ({
      rpc: ({ params }) => ({ result: baseMining.block(params[0], 105) }),
    }),
  });
  const source = read("apps/web/src/test/admin-safe-chain-fixture.ts")
    .replace(/import[\s\S]*?from\s+"[^"]+";\n/g, "")
    .replaceAll("export ", "");
  vm.runInContext(
    stripTypeScriptTypes(source) +
      "\nglobalThis.fixture = createAdminSafeChainFixture();",
    context,
  );
  const f = context.fixture;
  f.state.transactions.push({
    hash: `0x${"01".repeat(32)}`,
    from: `0x${"01".repeat(20)}`,
    to: `0x${"02".repeat(20)}`,
    data: "0x12345678",
    nonce: 0,
    mined: true,
    logs: [],
  });
  return f;
}
const rpc = (f, method, arg) => {
  const result = f.rpc({ id: 1, method, params: [arg] });
  assert.equal(result.error, undefined);
  return result.result;
};
test("safe block identity matches its receipt and transaction, pending stays unmined", () => {
  const f = fixture();
  const hash = f.state.transactions[0].hash;
  const receipt = rpc(f, "eth_getTransactionReceipt", hash);
  assert.equal(receipt.blockHash, safeHash);
  assert.equal(rpc(f, "eth_getTransactionByHash", hash).blockHash, safeHash);
  assert.equal(
    rpc(f, "eth_getBlockByNumber", receipt.blockNumber).hash,
    safeHash,
  );
  assert.equal(rpc(f, "eth_getBlockByNumber", "latest").hash, safeHash);
  assert.equal(rpc(f, "eth_getBlockByNumber", "pending").hash, null);
  f.state.transactions[0].mined = false;
  f.state.receiptPending = true;
  assert.equal(rpc(f, "eth_getTransactionReceipt", hash), null);
  assert.equal(rpc(f, "eth_getTransactionByHash", hash).blockHash, null);
});
test("actual canonical verifier accepts the safe fixture identity and rejects the old base identity", async () => {
  const source = read("apps/web/src/lib/market-canonical-receipt.ts")
    .replace(/^import[^\n]+\n/, "")
    .replaceAll("export ", "");
  const context = vm.createContext({
    zeroHash: `0x${"00".repeat(32)}`,
    isAddress: (s) => /^0x[\da-f]{40}$/i.test(s),
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(
    stripTypeScriptTypes(source) + "\nglobalThis.verify = verifyMarketReceipt;",
    context,
  );
  const f = fixture();
  const hash = f.state.transactions[0].hash;
  const client = {
    getChainId: async () => 560048,
    getTransaction: async () => {
      const tx = rpc(f, "eth_getTransactionByHash", hash);
      return {
        ...tx,
        nonce: Number(BigInt(tx.nonce)),
        value: BigInt(tx.value),
        chainId: 560048,
        blockNumber: BigInt(tx.blockNumber),
      };
    },
    waitForTransactionReceipt: async () => {
      const r = rpc(f, "eth_getTransactionReceipt", hash);
      return { ...r, status: "success", blockNumber: BigInt(r.blockNumber) };
    },
    getBlock: async ({ blockNumber }) => {
      const b = rpc(f, "eth_getBlockByNumber", `0x${blockNumber.toString(16)}`);
      return { ...b, number: BigInt(b.number) };
    },
  };
  assert.equal((await context.verify(client, hash)).expected, hash);
  await assert.rejects(
    context.verify(
      {
        ...client,
        getBlock: async (p) => ({
          ...(await client.getBlock(p)),
          hash: baseHash,
        }),
      },
      hash,
    ),
    /Noncanonical receipt/,
  );
});
