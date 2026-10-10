import test from "node:test";
import assert from "node:assert/strict";
import { createListedOrderObserver } from "./listed-order-observer.mjs";
import {
  fixture,
  ethers,
  seaport,
  validation,
  readNftRequest,
  EIP_712_ORDER_TYPE,
  kernelRequestDigest,
  createNftSaleTermsVerifier,
  seller,
  buyer,
  nft,
  fee1,
  fee2,
  protocol,
  ZERO,
  ZERO_HASH,
  hash,
} from "./listed-order-observer.fixture.mjs";

// Official ABI, entirely synthetic receipts, code and EIP-1193 responses.
// No network client, signer, key, venue request or broadcast is instantiated.
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const rawLog = (l) => ({
  ...l,
  chainId: hex(l.chainId),
  blockNumber: hex(l.blockNumber),
  logIndex: hex(l.index),
});
function harness(f = fixture(), fills = [f]) {
  const calls = [],
    state = {
      head: 105,
      chainId: f.order.chainId,
      transform: (_request, result) => result,
    };
  const block = (n) => ({
    number: hex(n),
    hash:
      fills.find((i) => i.evidence.receipt.blockNumber === n)?.evidence.receipt
        .blockHash ??
      ethers.keccak256(ethers.toUtf8Bytes(`synthetic-block-${n}`)),
    timestamp: hex(200),
  });
  const readOnlyProvider = {
    sourceId: f.config.observationPolicy.sourceId,
    async request(req) {
      calls.push(structuredClone(req));
      const [arg] = req.params;
      let result;
      switch (req.method) {
        case "eth_chainId":
          result = hex(state.chainId);
          break;
        case "eth_getBlockByNumber":
          result = block(arg === "latest" ? state.head : Number(BigInt(arg)));
          break;
        case "eth_getLogs":
          result = fills
            .flatMap((i) => i.evidence.receipt.logs.slice(0, 1))
            .filter(
              (l) =>
                l.blockNumber >= Number(BigInt(arg.fromBlock)) &&
                l.blockNumber <= Number(BigInt(arg.toBlock)),
            )
            .map(rawLog);
          break;
        case "eth_getTransactionByHash": {
          const t = fills.find((i) => i.evidence.transaction.hash === arg)
            ?.evidence.transaction;
          result = t
            ? {
                ...t,
                chainId: hex(t.chainId),
                blockNumber: hex(t.blockNumber),
                nonce: hex(t.nonce),
                value: hex(t.value),
                input: t.data,
              }
            : null;
          break;
        }
        case "eth_getTransactionReceipt": {
          const r = fills.find(
            (i) => i.evidence.receipt.transactionHash === arg,
          )?.evidence.receipt;
          result = r
            ? {
                ...r,
                chainId: hex(r.chainId),
                blockNumber: hex(r.blockNumber),
                status: hex(r.status),
                logs: r.logs.map(rawLog),
              }
            : null;
          break;
        }
        case "eth_getCode":
          result = f.evidence.deploymentEvidence.runtimeCode;
          break;
        default:
          throw Error(`Unexpected RPC: ${req.method}`);
      }
      return state.transform(req, structuredClone(result));
    },
  };
  const config = {
    ...f.config,
    readOnlyProvider,
    scanPolicy: {
      fromBlock: 100,
      throughBlock: 103,
      blocksPerPage: 2,
      maxPagesPerRun: 2,
      maxLogsPerPage: 20,
      maxCandidatesPerRun: 20,
    },
    now: () => 1234000,
  };
  return { f, fills, config, calls, state, block };
}
function unknown(r, reason) {
  assert.equal(r.state, "UNKNOWN");
  assert.equal(r.verified, false);
  assert.deepEqual(r.fills, []);
  assert.equal(r.resendAuthorized, false);
  assert.equal(r.onchainOrderStatus, "NOT_EVALUATED");
  if (reason) assert.equal(r.reason, reason);
}
function relocate(f, n, tx = hash("d"), b = hash("e")) {
  Object.assign(f.evidence.transaction, {
    hash: tx,
    blockNumber: n,
    blockHash: b,
  });
  Object.assign(f.evidence.receipt, {
    transactionHash: tx,
    blockNumber: n,
    blockHash: b,
  });
  for (const l of f.evidence.receipt.logs)
    Object.assign(l, { transactionHash: tx, blockNumber: n, blockHash: b });
  return f;
}
function editSale(f, change) {
  const log = f.evidence.receipt.logs[0],
    a = seaport.parseLog(log).args;
  const args = [
    a.orderHash,
    a.offerer,
    a.zone,
    a.recipient,
    a.offer.map((x) => [...x]),
    a.consideration.map((x) => [...x]),
  ];
  change(args);
  Object.assign(
    log,
    seaport.encodeEventLog(seaport.getEvent("OrderFulfilled"), args),
  );
}

for (const chainId of ["1", "8453"])
  for (const standard of ["erc721", "erc1155"])
    test(`${chainId}/${standard}: exact fill uses existing evaluator and read-only bounded pages`, async () => {
      const h = harness(fixture({ chainId, standard })),
        r = await createListedOrderObserver(h.config)();
      assert.equal(r.state, "CONFIRMED", JSON.stringify(r));
      assert.equal(r.fills.length, 1);
      assert.equal(r.fills[0].fillId, `${chainId}:${hash("a")}:0`);
      assert.equal(r.fills[0].quantity, standard === "erc721" ? "1" : "4");
      assert.equal(r.fills[0].sellerNet, "900");
      assert.equal(r.fills[0].gross, "1000");
      assert.equal(r.fills[0].blockNumber, 100);
      assert.equal(r.fills[0].blockHash, hash("b"));
      assert.equal(r.fills[0].confirmations, 6);
      assert.equal(r.fills[0].saleComplete, true);
      assert.equal(r.nextCursor.nextBlock, 104);
      assert.equal(r.scanStatus, "SCANNED");
      assert.equal(r.cumulativeCompletion, "NOT_EVALUATED");
      assert.ok(Object.isFrozen(r.fills[0]));
      const scans = h.calls.filter((c) => c.method === "eth_getLogs");
      assert.deepEqual(
        scans.map((c) => [c.params[0].fromBlock, c.params[0].toBlock]),
        [
          ["0x64", "0x65"],
          ["0x66", "0x67"],
        ],
      );
      for (const c of scans) {
        assert.equal(c.params[0].address, protocol);
        assert.deepEqual(c.params[0].topics, [
          seaport.getEvent("OrderFulfilled").topicHash,
          ethers.zeroPadValue(seller, 32),
        ]);
        assert.ok(!c.params[0].topics.includes(h.f.order.binding.orderHash));
      }
      assert.deepEqual(h.calls.find((c) => c.method === "eth_getCode").params, [
        protocol,
        { blockHash: hash("b"), requireCanonical: true },
      ]);
      assert.ok(
        h.calls.every((c) =>
          [
            "eth_chainId",
            "eth_getBlockByNumber",
            "eth_getLogs",
            "eth_getTransactionByHash",
            "eth_getTransactionReceipt",
            "eth_getCode",
          ].includes(c.method),
        ),
      );
    });

test("identical duplicates within and across pages emit one stable fill; retry is consumer-idempotent", async () => {
  const h = harness();
  h.state.transform = (req, r) =>
    req.method === "eth_getLogs"
      ? [
          ...r,
          rawLog(h.f.evidence.receipt.logs[0]),
          rawLog(h.f.evidence.receipt.logs[0]),
        ]
      : r;
  const observe = createListedOrderObserver(h.config),
    first = await observe(),
    retry = await observe();
  assert.equal(first.fills.length, 1, JSON.stringify(first));
  assert.equal(retry.fills[0].fillId, first.fills[0].fillId);
  const existingConsumer = new Map();
  for (const batch of [first, retry])
    for (const fill of batch.fills) existingConsumer.set(fill.fillId, fill);
  assert.equal(
    [...existingConsumer.values()].reduce((n, f) => n + BigInt(f.quantity), 0n),
    1n,
  );
  assert.equal(
    [...existingConsumer.values()].reduce(
      (n, f) => n + BigInt(f.sellerNet),
      0n,
    ),
    900n,
  );
});

test("conflicting duplicate is UNKNOWN, atomic and does not advance cursor", async () => {
  const h = harness();
  h.state.transform = (req, r) =>
    req.method === "eth_getLogs" && r.length
      ? [...r, { ...r[0], blockHash: hash("9") }]
      : r;
  const r = await createListedOrderObserver(h.config)();
  unknown(r, "NFT_SALE_OBSERVER_CONFLICTING_DUPLICATE");
  assert.equal(r.nextCursor.nextBlock, 100);
});

test("bounded cursor resumes, rechecks checkpoint, and does not recount previous page", async () => {
  const h = harness();
  h.config.scanPolicy.maxPagesPerRun = 1;
  const observe = createListedOrderObserver(h.config),
    first = await observe();
  assert.equal(first.nextCursor.nextBlock, 102);
  assert.equal(first.scan.scannedThroughBlock, 101);
  const before = h.calls.length,
    second = await observe({ cursor: first.nextCursor });
  unknown(second, "NFT_SALE_OBSERVER_NO_VERIFIED_FILL");
  assert.equal(second.nextCursor.nextBlock, 104);
  assert.equal(second.scan.scannedThroughBlock, 103);
  assert.deepEqual(h.calls[before + 1], {
    method: "eth_getBlockByNumber",
    params: ["0x65", false],
  });
});

test("resumed cursor checkpoint reorg blocks before any new scan", async () => {
  const h = harness();
  h.config.scanPolicy.maxPagesPerRun = 1;
  const observe = createListedOrderObserver(h.config),
    first = await observe();
  h.state.transform = (req, r) =>
    req.method === "eth_getBlockByNumber" && req.params[0] === "0x65"
      ? { ...r, hash: hash("9") }
      : r;
  const before = h.calls.length,
    r = await observe({ cursor: first.nextCursor });
  unknown(r, "NFT_SALE_OBSERVER_CURSOR_REORG");
  assert.deepEqual(r.nextCursor, first.nextCursor);
  assert.equal(
    h.calls.slice(before).some((c) => c.method === "eth_getLogs"),
    false,
  );
});

test("cursor cannot be borrowed from another order, pin or scan window", async () => {
  const h = harness(),
    first = await createListedOrderObserver(h.config)();
  for (const mutate of [
    (c) => (c.expectedOrder.binding.orderHash = hash("9")),
    (c) => (c.allowedDeployments[0].reviewEvidenceSha256 = "9".repeat(64)),
    (c) => c.scanPolicy.throughBlock++,
  ]) {
    const other = harness();
    mutate(other.config);
    unknown(
      await createListedOrderObserver(other.config)({
        cursor: first.nextCursor,
      }),
      "NFT_SALE_OBSERVER_CURSOR_INVALID",
    );
    assert.equal(other.calls.length, 0);
  }
});

test("tampered in-range public cursor can never establish earlier coverage, completion or absence", async () => {
  const h = harness(),
    observe = createListedOrderObserver(h.config),
    first = await observe();
  for (const nextBlock of [103, 104]) {
    const tampered = {
      ...first.nextCursor,
      nextBlock,
      checkpoint: { number: nextBlock - 1, hash: h.block(nextBlock - 1).hash },
    };
    const r = await observe({ cursor: tampered });
    unknown(r, "NFT_SALE_OBSERVER_NO_VERIFIED_FILL");
    assert.equal(r.saleStatus, "UNKNOWN");
    assert.equal(r.cumulativeCompletion, "NOT_EVALUATED");
    assert.equal(r.scan.coverageScope, "THIS_INVOCATION_ONLY");
    assert.equal(r.scan.scannedFromBlock, nextBlock === 103 ? 103 : null);
    assert.equal(r.scan.scannedThroughBlock, nextBlock === 103 ? 103 : null);
    assert.equal(r.scanStatus, nextBlock === 103 ? "SCANNED" : "NO_NEW_RANGE");
    assert.equal(r.scan.rangeComplete, undefined);
    assert.equal(r.saleComplete, undefined);
    assert.equal(r.orderComplete, undefined);
  }
  for (const nextBlock of [99, 105]) {
    unknown(
      await observe({ cursor: { ...first.nextCursor, nextBlock } }),
      "NFT_SALE_OBSERVER_CURSOR_INVALID",
    );
  }
});

test("empty bounded scan is UNKNOWN, even after reaching the window end or accepted publication", async () => {
  const h = harness();
  h.fills.length = 0;
  const r = await createListedOrderObserver(h.config)();
  unknown(r, "NFT_SALE_OBSERVER_NO_VERIFIED_FILL");
  assert.equal(r.scanStatus, "SCANNED");
  assert.equal(r.saleComplete, undefined);
  assert.equal(r.orderCancelled, undefined);
  unknown(
    await createListedOrderObserver(h.config)({ accepted: true }),
    "NFT_SALE_OBSERVER_INPUT_INVALID",
  );
});

test("unconfirmed heights remain unconsumed until sufficient head confirmations", async () => {
  const h = harness();
  h.state.head = 100;
  const observe = createListedOrderObserver(h.config),
    first = await observe();
  unknown(first);
  assert.equal(first.nextCursor.nextBlock, 100);
  assert.equal(
    h.calls.some((c) => c.method === "eth_getLogs"),
    false,
  );
  h.state.head = 102;
  const second = await observe({ cursor: first.nextCursor });
  assert.equal(second.fills[0].confirmations, 3);
  assert.equal(second.nextCursor.nextBlock, 101);
  assert.equal(second.scan.scannedThroughBlock, 100);
});

test("other nonindexed orderHash is ignored after real ABI decoding, without receipt lookup", async () => {
  const h = harness();
  editSale(h.f, (a) => (a[0] = hash("9")));
  const r = await createListedOrderObserver(h.config)();
  unknown(r, "NFT_SALE_OBSERVER_NO_VERIFIED_FILL");
  assert.equal(
    h.calls.some((c) => c.method === "eth_getTransactionReceipt"),
    false,
  );
});

for (const [name, mutate] of [
  ["seller topic", (l) => (l.topics[1] = ethers.zeroPadValue(buyer, 32))],
  ["orderHash incorrectly indexed", (l) => l.topics.push(hash("9"))],
  ["event signature", (l) => (l.topics[0] = hash("9"))],
  ["emitter", (l) => (l.address = nft)],
  ["removed", (l) => (l.removed = true)],
  ["out-of-range block", (l) => (l.blockNumber = "0x63")],
])
  test(`rejects wrong discovery ${name}`, async () => {
    const h = harness();
    h.state.transform = (req, r) => {
      if (req.method === "eth_getLogs" && r.length) mutate(r[0]);
      return r;
    };
    const r = await createListedOrderObserver(h.config)();
    unknown(r, "NFT_SALE_OBSERVER_LOG_FILTER_MISMATCH");
    assert.equal(r.nextCursor.nextBlock, 100);
  });

test("receipt must contain the exact discovered log", async () => {
  const h = harness();
  h.state.transform = (req, r) => {
    if (req.method === "eth_getLogs" && r.length)
      r[0].data = r[0].data.slice(0, -1) + "4";
    return r;
  };
  unknown(
    await createListedOrderObserver(h.config)(),
    "NFT_SALE_OBSERVER_DISCOVERY_RECEIPT_MISMATCH",
  );
});

for (const location of ["initial", "final", "transaction", "receipt", "log"])
  test(`rejects ${location} chain mismatch`, async () => {
    const h = harness();
    let chainCalls = 0;
    h.state.transform = (req, r) => {
      if (
        req.method === "eth_chainId" &&
        ++chainCalls === (location === "final" ? 2 : 1) &&
        ["initial", "final"].includes(location)
      )
        return "0x2105";
      if (
        req.method ===
        {
          transaction: "eth_getTransactionByHash",
          receipt: "eth_getTransactionReceipt",
        }[location]
      )
        r.chainId = "0x2105";
      if (location === "log" && req.method === "eth_getLogs" && r.length)
        r[0].chainId = "0x2105";
      return r;
    };
    unknown(
      await createListedOrderObserver(h.config)(),
      "NFT_SALE_OBSERVER_CHAIN_MISMATCH",
    );
  });

for (const method of [
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getLogs",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getCode",
])
  test(`${method} provider failure is atomic UNKNOWN without leaking provider detail`, async () => {
    const h = harness();
    h.state.transform = (req, r) => {
      if (req.method === method) throw Error("private-provider-detail");
      return r;
    };
    const r = await createListedOrderObserver(h.config)();
    unknown(r, "NFT_SALE_OBSERVER_PROVIDER_FAILURE");
    assert.equal(r.nextCursor.nextBlock, 100);
    assert.ok(!JSON.stringify(r).includes("private-provider-detail"));
  });

for (const target of ["execution-after", "page-end", "head"])
  test(`${target} reorg during reads prevents committing any fill/cursor`, async () => {
    const h = harness();
    let reads = 0;
    h.state.transform = (req, r) => {
      const tag = {
        "execution-after": "0x64",
        "page-end": "0x65",
        head: "0x69",
      }[target];
      if (
        req.method === "eth_getBlockByNumber" &&
        req.params[0] === tag &&
        ++reads >= (target === "head" ? 1 : 2)
      )
        return { ...r, hash: hash("9") };
      return r;
    };
    const r = await createListedOrderObserver(h.config)();
    unknown(
      r,
      target === "execution-after"
        ? "NFT_SALE_NOT_CANONICAL"
        : "NFT_SALE_OBSERVER_REORG",
    );
    assert.equal(r.nextCursor.nextBlock, 100);
  });

test("execution block runtime code must match the captured deployment pin", async () => {
  const h = harness();
  h.state.transform = (req, r) => (req.method === "eth_getCode" ? "0x6000" : r);
  unknown(
    await createListedOrderObserver(h.config)(),
    "NFT_SALE_DEPLOYMENT_UNTRUSTED",
  );
});

test("conflicting same-height fill/page-boundary anchors cannot overwrite canonical evidence", async () => {
  const h = harness();
  let reads = 0;
  h.config.scanPolicy.blocksPerPage = 1;
  h.state.transform = (req, r) => {
    if (req.method === "eth_getBlockByNumber" && req.params[0] === "0x64") {
      reads++;
      if (reads === 1 || reads >= 4) return { ...r, hash: hash("d") };
    }
    return r;
  };
  const r = await createListedOrderObserver(h.config)();
  unknown(r, "NFT_SALE_OBSERVER_REORG");
  assert.equal(r.nextCursor.nextBlock, 100);
});

test("conflicting same-height confirmation-head and fill anchors cannot be overwritten", async () => {
  const h = harness();
  h.state.head = 100;
  h.config.observationPolicy.minimumConfirmations = 1;
  h.state.transform = (req, r) =>
    req.method === "eth_getBlockByNumber" && req.params[0] === "latest"
      ? { ...r, hash: hash("d") }
      : r;
  unknown(
    await createListedOrderObserver(h.config)(),
    "NFT_SALE_OBSERVER_REORG",
  );
});

test("equivalent hex casing in discovery/receipt and duplicate logs is normalized", async () => {
  const h = harness();
  h.state.transform = (req, r) => {
    if (req.method === "eth_getLogs" && r.length) {
      const duplicate = structuredClone(r[0]);
      r[0].address = r[0].address.toLowerCase();
      for (const k of ["transactionHash", "blockHash", "data"])
        r[0][k] = "0x" + r[0][k].slice(2).toUpperCase();
      r[0].topics = r[0].topics.map((v) => "0x" + v.slice(2).toUpperCase());
      return [...r, duplicate];
    }
    return r;
  };
  const r = await createListedOrderObserver(h.config)();
  assert.equal(r.state, "CONFIRMED", JSON.stringify(r));
  assert.equal(r.fills.length, 1);
});

test("provider, order, policy and deployment mutations cannot replace constructor captures", async () => {
  const h = harness(),
    observe = createListedOrderObserver(h.config);
  h.config.readOnlyProvider.request = async () => {
    throw Error("replacement");
  };
  h.config.expectedOrder.seller = buyer;
  h.config.expectedOrder.binding.orderHash = hash("9");
  h.config.observationPolicy.minimumConfirmations = 99;
  h.config.allowedDeployments[0].runtimeCodeHash = hash("9");
  h.config.scanPolicy.throughBlock = 900000;
  h.config.now = () => {
    throw Error("replacement clock");
  };
  const r = await observe();
  assert.equal(r.state, "CONFIRMED", JSON.stringify(r));
  assert.equal(r.nextCursor.nextBlock, 104);
  for (const key of [
    "provider",
    "readOnlyProvider",
    "allowedDeployments",
    "expectedOrder",
    "observationPolicy",
  ])
    unknown(await observe({ [key]: {} }), "NFT_SALE_OBSERVER_INPUT_INVALID");
});

for (const method of ["eth_getTransactionByHash", "eth_getTransactionReceipt"])
  test(`missing ${method} response preserves cursor and unknown result`, async () => {
    const h = harness();
    h.state.transform = (req, r) => (req.method === method ? null : r);
    const r = await createListedOrderObserver(h.config)();
    unknown(r, "NFT_SALE_OBSERVER_EVIDENCE_UNAVAILABLE");
    assert.equal(r.scanStatus, "BLOCKED");
    assert.equal(r.nextCursor.nextBlock, 100);
  });

test("missing bounds/source or non-listing inputs cannot construct observer", () => {
  for (const mutate of [
    (c) => delete c.scanPolicy.maxPagesPerRun,
    (c) => (c.scanPolicy.blocksPerPage = Infinity),
    (c) => (c.scanPolicy.maxLogsPerPage = 0),
    (c) => (c.readOnlyProvider.sourceId = "other-source"),
    (c) => (c.expectedOrder.nativeAction = "accept"),
    (c) => delete c.now,
  ]) {
    const h = harness();
    mutate(h.config);
    assert.throws(
      () => createListedOrderObserver(h.config),
      /CONFIGURATION_INVALID/,
    );
    assert.equal(h.calls.length, 0);
  }
});

test("log and candidate bounds fail closed without consuming partial pages", async () => {
  const first = fixture({ standard: "erc1155" }),
    second = relocate(fixture({ standard: "erc1155" }), 102);
  for (const limit of ["logs", "candidates"]) {
    const h = harness(first, [first, second]);
    if (limit === "logs") {
      h.config.scanPolicy.maxLogsPerPage = 1;
      h.state.transform = (req, r) =>
        req.method === "eth_getLogs" ? [...r, ...r] : r;
    } else h.config.scanPolicy.maxCandidatesPerRun = 1;
    const r = await createListedOrderObserver(h.config)();
    unknown(
      r,
      `NFT_SALE_OBSERVER_${limit === "logs" ? "LOG" : "CANDIDATE"}_LIMIT`,
    );
    assert.equal(r.nextCursor.nextBlock, 100);
  }
});

test("two unique partial fills and repeated responses never assert cumulative completion", async () => {
  const make = () => {
    const f = fixture({
      standard: "erc1155",
      method: "fulfillAdvancedOrder",
      requested: "4",
      fill: "2",
    });
    const parsed = seaport.parseTransaction({
      data: f.evidence.transaction.data,
    });
    f.evidence.transaction.data = seaport.encodeFunctionData(
      "fulfillAdvancedOrder",
      [{ ...parsed.args[0].toObject(), numerator: "2" }, [], ZERO_HASH, buyer],
    );
    return f;
  };
  const a = make(),
    b = relocate(make(), 102),
    h = harness(a, [a, b]);
  h.state.transform = (req, r) =>
    req.method === "eth_getLogs" && req.params[0].fromBlock === "0x66"
      ? [...r, rawLog(a.evidence.receipt.logs[0])]
      : r;
  const r = await createListedOrderObserver(h.config)();
  assert.equal(r.state, "CONFIRMED", JSON.stringify(r));
  assert.equal(r.fills.length, 2);
  assert.deepEqual(
    r.fills.map((i) => i.quantity),
    ["2", "2"],
  );
  assert.deepEqual(
    r.fills.map((i) => i.sellerNet),
    ["450", "450"],
  );
  assert.ok(r.fills.every((i) => !i.saleComplete && !i.orderComplete));
  assert.equal(r.cumulativeCompletion, "NOT_EVALUATED");
  assert.equal(r.saleComplete, undefined);
});

test("router and batch routes remain unknown/unsupported without advancing", async () => {
  for (const route of ["router", "batch"]) {
    const h = harness();
    if (route === "router") h.f.evidence.transaction.to = nft;
    else
      h.f.evidence.transaction.data = seaport.encodeFunctionData(
        "fulfillAvailableOrders",
        [[], [], [], ZERO_HASH, 1],
      );
    const r = await createListedOrderObserver(h.config)();
    unknown(
      r,
      route === "router"
        ? "NFT_SALE_OBSERVER_ROUTE_UNSUPPORTED"
        : "NFT_SALE_FULFILLMENT_METHOD_UNSUPPORTED",
    );
    assert.equal(r.nextCursor.nextBlock, 100);
  }
});

test("missing transfer evidence remains UNKNOWN, never a successful observed fill", async () => {
  const h = harness();
  h.f.evidence.receipt.logs.pop();
  unknown(
    await createListedOrderObserver(h.config)(),
    "NFT_SALE_NFT_TRANSFER_MISMATCH",
  );
});

test("expired/revoked execution grant is irrelevant to historical read-only observation", async () => {
  const h = harness(),
    grant = { expiresAt: 1, state: "REVOKED" };
  assert.equal(grant.state, "REVOKED");
  h.config.now = () => 999999999;
  const r = await createListedOrderObserver(h.config)();
  assert.equal(r.state, "CONFIRMED", JSON.stringify(r));
  assert.equal(r.authorizationChanged, false);
  assert.equal(r.orderCancelled, undefined);
});

test("actual Stage 1 terms -> captured observer -> existing evaluator bind the same frozen order", async () => {
  const h = harness(),
    f = h.f,
    nowMs = 200000,
    adapterId = "synthetic-seaport";
  const policy = {
    schema: "8415-agent-task/1",
    taskId: "synthetic-observation",
    tenant: "test",
    origin: "https://example.test",
    chainId: "1",
    actor: seller,
    expiresAt: "2000",
    fees: { perOperationWei: "1", totalWei: "1" },
    intent: {
      kind: "nft-sale",
      direction: "sell",
      standard: "ERC-721",
      contract: nft,
      tokenId: "7",
      quantity: "1",
      marketAdapters: [adapterId],
    },
  };
  const frozenTask = {
    policy,
    digest: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(policy))),
  };
  const typedData = {
    primaryType: "OrderComponents",
    domain: {
      name: "Seaport",
      version: "1.6",
      chainId: 1,
      verifyingContract: protocol,
    },
    types: EIP_712_ORDER_TYPE,
    message: f.order.components,
  };
  const nativePlan = {
    id: "observer-plan",
    operationId: "observer-operation",
    sessionId: "synthetic-session",
    chainId: 1,
    request: {
      action: "list",
      collection: "synthetic",
      tokenId: "7",
      account: seller,
      quantity: "1",
      priceWei: "1000",
      expiresAt: 1000,
    },
    scope: {
      slug: "synthetic",
      chain: "ethereum",
      contract: nft,
      standard: "erc721",
      label: "Synthetic",
      charity: false,
    },
    expiresAt: nowMs + 60000,
    orderExpiresAt: 1000,
    kind: "signature",
    summary: "Synthetic only",
    orderHash: f.order.binding.orderHash,
    typedData,
    paymentToken: "ETH",
    orderTotalWei: "1000",
    fees: [
      { recipient: fee1, amountWei: "60" },
      { recipient: fee2, amountWei: "40" },
    ],
  };
  const reference = {
    taskDigest: frozenTask.digest,
    nativePlanId: nativePlan.id,
    nativeOperationId: nativePlan.operationId,
    reviewDigest: kernelRequestDigest(nativePlan),
    orderHash: nativePlan.orderHash,
    typedDataDigest: ethers.TypedDataEncoder.hash(
      typedData.domain,
      typedData.types,
      typedData.message,
    ),
  };
  const terms = createNftSaleTermsVerifier({
    ethers,
    validation,
    readNftRequest,
    frozenTask,
    nativePlan,
    adapterId,
  })(reference, nowMs);
  assert.ok(terms.order, JSON.stringify(terms));
  assert.equal(terms.reason, "USD_PRICE_EVIDENCE_REQUIRED");
  h.config.expectedOrder = terms.order;
  h.config.observationPolicy.taskDigest = frozenTask.digest;
  const r = await createListedOrderObserver(h.config)();
  assert.equal(r.state, "CONFIRMED", JSON.stringify(r));
  assert.equal(r.fills[0].orderDigest, kernelRequestDigest(terms.order));
  assert.equal(r.fills[0].usdProceeds, "NOT_EVALUATED");
});
