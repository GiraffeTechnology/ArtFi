import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  CHARITY_ABI,
  SAFE_ABI,
  TEST_MARKERS,
  validateAtomicReceiptManifest,
  verifyHoodiCharityAtomicReceipt,
} from "../release/lib/hoodi-charity-atomic-receipt.mjs";
const { Interface, AbiCoder, keccak256 } = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
)("ethers");
const charity = new Interface(CHARITY_ABI),
  safe = new Interface(SAFE_ABI);
const coder = AbiCoder.defaultAbiCoder();
const hash = (n) => "0x" + n.toString(16).padStart(64, "0");
const address = (n) => "0x" + n.toString(16).padStart(40, "0");
const ZERO = address(0);
// Artificial RPC fixtures only. No connection, deployment, artwork, signature or chain acceptance.
function fixture(count = 13) {
  const runtime = "0x60016000",
    safeRuntime = "0x60026000";
  const m = {
    schema: "artfi-hoodi-charity-atomic-receipt/v1",
    chainId: 560048,
    namespace: "TESTNET-AI-FIXTURE",
    testAssetMarkers: [...TEST_MARKERS],
    deployment: {
      collection: address(10),
      runtimeCodeHash: keccak256(runtime),
      safe: address(11),
      safeRuntimeCodeHash: keccak256(safeRuntime),
    },
    execution: {
      transactionHash: hash(100),
      safeTransactionId: "1",
      requestId: hash(101),
    },
    series: Array.from({ length: count }, (_, i) => ({
      tokenId: String(i + 1),
      artworkId: hash(i + 1000),
      masterArtworkHash: hash(i + 2000),
      metadataHash: hash(i + 3000),
      distributionWallet: address(20),
      metadataURI:
        "https://test.invalid/TESTNET-AI-FIXTURE/" + (i + 1) + ".json",
    })),
  };
  const block = { hash: hash(102), number: "0x64", timestamp: "0x3e8" };
  const batch = charity.encodeFunctionData("createSeriesBatch", [m.series]);
  const tx = {
    hash: m.execution.transactionHash,
    blockHash: block.hash,
    blockNumber: block.number,
    from: address(12),
    to: m.deployment.safe,
    input: safe.encodeFunctionData("execute", [1n]),
    value: "0x0",
  };
  const receipt = {
    transactionHash: tx.hash,
    blockHash: block.hash,
    blockNumber: block.number,
    status: "0x1",
    to: tx.to,
    logs: [],
  };
  function event(iface, name, args, target) {
    const data = iface.encodeEventLog(iface.getEvent(name), args);
    receipt.logs.push({
      ...data,
      address: target,
      transactionHash: tx.hash,
      blockHash: block.hash,
      blockNumber: block.number,
      logIndex: "0x" + receipt.logs.length.toString(16),
      removed: false,
    });
  }
  for (const s of m.series) {
    event(
      charity,
      "TransferSingle",
      [m.deployment.safe, ZERO, s.distributionWallet, BigInt(s.tokenId), 100n],
      m.deployment.collection,
    );
    event(
      charity,
      "URI",
      [s.metadataURI, BigInt(s.tokenId)],
      m.deployment.collection,
    );
    event(
      charity,
      "SeriesCreated",
      [
        BigInt(s.tokenId),
        s.artworkId,
        s.masterArtworkHash,
        s.distributionWallet,
        s.metadataHash,
        s.metadataURI,
      ],
      m.deployment.collection,
    );
  }
  event(
    safe,
    "TransactionExecuted",
    [
      1n,
      tx.from,
      keccak256(
        coder.encode(["uint256[]"], [m.series.map((s) => BigInt(s.tokenId))]),
      ),
    ],
    m.deployment.safe,
  );
  const action = [
    m.execution.requestId,
    m.deployment.collection,
    0n,
    batch,
    900n,
    2n,
    true,
  ];
  const calls = [],
    callResults = new Map(),
    overrides = new Map();
  let receiptReads = 0;
  async function send(method, params) {
    calls.push({ method, params: structuredClone(params) });
    if (overrides.has(method)) return overrides.get(method)(params, calls);
    if (method === "eth_chainId") return "0x88bb0";
    if (method === "eth_getTransactionReceipt") {
      receiptReads++;
      return structuredClone(receipt);
    }
    if (method === "eth_getTransactionByHash") return structuredClone(tx);
    if (method === "eth_getBlockByNumber")
      return structuredClone(
        ["finalized", "0x65"].includes(params[0])
          ? { ...block, number: "0x65", hash: hash(103) }
          : block,
      );
    if (method === "eth_getCode")
      return params[0] === m.deployment.safe ? safeRuntime : runtime;
    if (method === "eth_call") {
      const target = sameAddress(params[0].to, m.deployment.safe)
        ? safe
        : charity;
      const parsed = target.parseTransaction({ data: params[0].data });
      const name = parsed.name;
      if (callResults.has(name))
        return target.encodeFunctionResult(
          name,
          callResults.get(name)(parsed.args),
        );
      if (name === "transaction")
        return safe.encodeFunctionResult(name, [action]);
      if (name === "threshold") return safe.encodeFunctionResult(name, [2n]);
      if (name === "delaySeconds")
        return safe.encodeFunctionResult(name, [60n]);
      if (name === "totalSupply")
        return charity.encodeFunctionResult(name, [100n]);
      if (name === "series") {
        const s = m.series.find((s) => BigInt(s.tokenId) === parsed.args[0]);
        return charity.encodeFunctionResult(name, [
          [
            s.artworkId,
            s.masterArtworkHash,
            s.metadataHash,
            s.distributionWallet,
            1000n,
            0n,
            0n,
            hash(0),
            hash(0),
            s.metadataURI,
          ],
        ]);
      }
    }
    throw new Error("unexpected RPC method");
  }
  return {
    m,
    block,
    tx,
    receipt,
    action,
    calls,
    send,
    overrides,
    callResults,
    get receiptReads() {
      return receiptReads;
    },
  };
}
const sameAddress = (a, b) => a.toLowerCase() === b.toLowerCase();

for (const count of [1, 13, 37]) {
  test(
    "accepts one finalized Safe batch with " + count + " symbolic series",
    async () => {
      const f = fixture(count),
        result = await verifyHoodiCharityAtomicReceipt(f.m, f.send);
      assert.equal(result.seriesCount, count);
      assert.equal(result.totalUnits, count * 100);
      assert.equal(result.wholeProductAccepted, false);
      assert.equal(result.metadataContentVerified, false);
      assert.equal(f.receiptReads, 2);
      assert(
        f.calls.every((c) =>
          [
            "eth_chainId",
            "eth_getTransactionReceipt",
            "eth_getTransactionByHash",
            "eth_getBlockByNumber",
            "eth_getCode",
            "eth_call",
          ].includes(c.method),
        ),
      );
      for (const c of f.calls.filter((c) =>
        ["eth_call", "eth_getCode"].includes(c.method),
      ))
        assert.deepEqual(c.params[1], {
          blockHash: f.block.hash,
          requireCanonical: true,
        });
    },
  );
}
test("rejects missing markers before any RPC", async () => {
  const f = fixture();
  f.m.testAssetMarkers.pop();
  await assert.rejects(verifyHoodiCharityAtomicReceipt(f.m, f.send), /markers/);
  assert.equal(f.calls.length, 0);
});
test("rejects mainnet and frozen Sepolia namespaces", () => {
  const f = fixture();
  f.m.chainId = 1;
  assert.throws(() => validateAtomicReceiptManifest(f.m));
  f.m.chainId = 560048;
  f.m.series[0].metadataURI = "https://test.invalid/ye-yongrun/UNIT-A01.json";
  assert.throws(() => validateAtomicReceiptManifest(f.m));
});
test("rejects frozen collection address even when the manifest says Hoodi", () => {
  const f = fixture();
  f.m.deployment.collection = "0xec7d57e6f91fe1d1eE1eC0cb1dF8E869088de104";
  assert.throws(() => validateAtomicReceiptManifest(f.m));
});
test("rejects duplicate identities and noncontiguous ids", () => {
  const f = fixture();
  f.m.series[1].artworkId = f.m.series[0].artworkId;
  assert.throws(() => validateAtomicReceiptManifest(f.m), /duplicate/);
  f.m.series[1].artworkId = hash(9000);
  f.m.series[1].tokenId = "99";
  assert.throws(() => validateAtomicReceiptManifest(f.m), /contiguous/);
});
test("rejects empty and oversized batches", () => {
  const f = fixture(1);
  f.m.series = [];
  assert.throws(() => validateAtomicReceiptManifest(f.m));
  assert.throws(() => validateAtomicReceiptManifest(fixture(38).m));
});
test("rejects URI credentials and unscoped paths", () => {
  const f = fixture();
  f.m.series[0].metadataURI =
    "https://user:pass@test.invalid/TESTNET-AI-FIXTURE/1";
  assert.throws(() => validateAtomicReceiptManifest(f.m));
  f.m.series[0].metadataURI = "https://test.invalid/other/1";
  assert.throws(() => validateAtomicReceiptManifest(f.m));
});
test("rejects extra fields and invalid positive uint256 identity", () => {
  const f = fixture();
  f.m.mainnetAuthorized = true;
  assert.throws(() => validateAtomicReceiptManifest(f.m));
  delete f.m.mainnetAuthorized;
  f.m.execution.safeTransactionId = "01";
  assert.throws(() => validateAtomicReceiptManifest(f.m));
});
test("manifest validation returns an independent snapshot", () => {
  const f = fixture(),
    copied = validateAtomicReceiptManifest(f.m);
  f.m.series[0].metadataHash = hash(9999);
  assert.notEqual(copied.series[0].metadataHash, f.m.series[0].metadataHash);
});
test("rejects an RPC chain mismatch", async () => {
  const f = fixture();
  f.overrides.set("eth_chainId", () => "0xaa36a7");
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /not Hoodi/,
  );
});
test("rejects pending and failed receipts", async () => {
  const f = fixture();
  f.receipt.status = "0x0";
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /unsuccessful/,
  );
  f.overrides.set("eth_getTransactionReceipt", () => null);
  await assert.rejects(verifyHoodiCharityAtomicReceipt(f.m, f.send), /receipt/);
});
test("rejects noncanonical and not-finalized blocks", async () => {
  const f = fixture();
  f.overrides.set("eth_getBlockByNumber", () => ({
    ...f.block,
    hash: hash(999),
  }));
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /not canonical/,
  );
  f.overrides.set("eth_getBlockByNumber", (params) =>
    params[0] === "finalized" ? { ...f.block, number: "0x63" } : f.block,
  );
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /not finalized/,
  );
});
test("rejects code mismatch and empty code", async () => {
  const f = fixture();
  f.overrides.set("eth_getCode", () => "0x");
  await assert.rejects(verifyHoodiCharityAtomicReceipt(f.m, f.send), /runtime/);
  f.overrides.set("eth_getCode", () => "0x6003");
  await assert.rejects(verifyHoodiCharityAtomicReceipt(f.m, f.send), /runtime/);
});
test("rejects direct creation and a wrong Safe action id", async () => {
  const f = fixture();
  f.tx.to = f.m.deployment.collection;
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /binding mismatch/,
  );
  f.tx.to = f.m.deployment.safe;
  f.tx.input = safe.encodeFunctionData("execute", [2n]);
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /bound Safe action/,
  );
});
test("rejects value-bearing transactions", async () => {
  const f = fixture();
  f.tx.value = "0x1";
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /binding mismatch/,
  );
});
test("rejects wrong stored request, target and execution state", async () => {
  for (const [index, value] of [
    [0, hash(999)],
    [1, address(999)],
    [2, 1n],
    [6, false],
  ]) {
    const f = fixture();
    f.action[index] = value;
    await assert.rejects(
      verifyHoodiCharityAtomicReceipt(f.m, f.send),
      /stored Safe action/,
    );
  }
});
test("rejects insufficient threshold and pending timelock", async () => {
  const f = fixture();
  f.callResults.set("threshold", () => [3n]);
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /threshold/,
  );
  f.callResults.delete("threshold");
  f.action[4] = 1001n;
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /timelock/,
  );
});
test("rejects mutated batch commitments in stored calldata", async () => {
  const f = fixture(),
    changed = structuredClone(f.m.series);
  changed[12].metadataHash = hash(9999);
  f.action[3] = charity.encodeFunctionData("createSeriesBatch", [changed]);
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /calldata commitment/,
  );
});
test("rejects missing last series and duplicate log index", async () => {
  const f = fixture();
  const last = f.receipt.logs.splice(f.receipt.logs.length - 2, 1)[0];
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /log count/,
  );
  f.receipt.logs.splice(f.receipt.logs.length - 1, 0, last);
  f.receipt.logs[1].logIndex = f.receipt.logs[0].logIndex;
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /duplicate receipt log/,
  );
});
test("rejects removed and foreign-transaction logs", async () => {
  const f = fixture();
  f.receipt.logs[0].removed = true;
  await assert.rejects(verifyHoodiCharityAtomicReceipt(f.m, f.send), /removed/);
  f.receipt.logs[0].removed = false;
  f.receipt.logs[0].transactionHash = hash(9999);
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /mismatched/,
  );
});
test("rejects wrong mint supply and recipient", async () => {
  for (const [recipient, supply] of [
    [address(999), 100n],
    [address(20), 99n],
  ]) {
    const f = fixture(),
      original = f.receipt.logs[0];
    Object.assign(
      original,
      charity.encodeEventLog(charity.getEvent("TransferSingle"), [
        f.m.deployment.safe,
        ZERO,
        recipient,
        1n,
        supply,
      ]),
    );
    await assert.rejects(
      verifyHoodiCharityAtomicReceipt(f.m, f.send),
      /mint event/,
    );
  }
});
test("rejects wrong stored supply", async () => {
  const f = fixture();
  f.callResults.set("totalSupply", () => [99n]);
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /stored supply/,
  );
});
test("rejects stored series commitment drift", async () => {
  const f = fixture();
  f.callResults.set("series", (args) => {
    const s = f.m.series[Number(args[0]) - 1];
    return [
      [
        s.artworkId,
        s.masterArtworkHash,
        hash(999),
        s.distributionWallet,
        1000n,
        0n,
        0n,
        hash(0),
        hash(0),
        s.metadataURI,
      ],
    ];
  });
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /stored series/,
  );
});
test("rejects Safe returned-id mismatch", async () => {
  const f = fixture();
  Object.assign(
    f.receipt.logs.at(-1),
    safe.encodeEventLog(safe.getEvent("TransactionExecuted"), [
      1n,
      f.tx.from,
      hash(9999),
    ]),
  );
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /return-data/,
  );
});
test("reorg during verification never becomes accepted", async () => {
  const f = fixture();
  let reads = 0;
  f.overrides.set("eth_getTransactionReceipt", () =>
    ++reads === 1
      ? structuredClone(f.receipt)
      : { ...f.receipt, blockHash: hash(999) },
  );
  await assert.rejects(verifyHoodiCharityAtomicReceipt(f.m, f.send), /changed/);
});
test("unsupported block-hash state reads fail without number fallback", async () => {
  const f = fixture();
  f.overrides.set("eth_getCode", () => {
    throw new Error("EIP-1898 unsupported");
  });
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /EIP-1898/,
  );
  assert.equal(f.calls.filter((c) => c.method === "eth_getCode").length, 1);
});
test("RPC failures are not retried or converted into a result", async () => {
  const f = fixture();
  f.overrides.set("eth_call", () => {
    throw new Error("timeout");
  });
  await assert.rejects(verifyHoodiCharityAtomicReceipt(f.m, f.send), /timeout/);
  assert.equal(f.calls.filter((c) => c.method === "eth_call").length, 1);
});
test("finalized tag must agree with its canonical height", async () => {
  const f = fixture();
  f.overrides.set("eth_getBlockByNumber", (params) =>
    params[0] === "finalized"
      ? { ...f.block, number: "0x65", hash: hash(103) }
      : f.block,
  );
  await assert.rejects(
    verifyHoodiCharityAtomicReceipt(f.m, f.send),
    /finalized block disagrees/,
  );
});
test("rejects trailing unbound bytes in inner and outer calldata", async () => {
  for (const inner of [true, false]) {
    const f = fixture();
    if (inner) f.action[3] += "00";
    else f.tx.input += "00";
    await assert.rejects(
      verifyHoodiCharityAtomicReceipt(f.m, f.send),
      /calldata is not canonical/,
    );
  }
});
