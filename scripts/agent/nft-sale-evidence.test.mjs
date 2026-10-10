import test from "node:test";
import assert from "node:assert/strict";
import {
  createRequire,
  registerHooks,
  stripTypeScriptTypes,
} from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createNftSaleEvidenceEvaluator,
  NFT_SALE_NATIVE_POLICY,
} from "./nft-sale-evidence.mjs";
import { kernelRequestDigest } from "./agent-kernel.mjs";
import { createNftSaleTermsVerifier } from "./nft-sale-terms.mjs";

// Entirely synthetic receipts and bytecode, encoded with the installed official
// ABI. No signer, RPC, venue credential, broadcast or real-chain write exists.
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const sourceRoot = new URL("../../apps/web/src/lib/nft/", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { url: "data:text/javascript,export{}", shortCircuit: true };
    try {
      return next(specifier, context);
    } catch (error) {
      if (
        context.parentURL?.startsWith(sourceRoot) &&
        specifier.startsWith(".")
      )
        return next(`${specifier}.ts`, context);
      if (specifier.startsWith("@opensea/"))
        return {
          url: pathToFileURL(require.resolve(specifier)).href,
          shortCircuit: true,
        };
      throw error;
    }
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith(".ts"))
      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), {
          mode: "transform",
        }),
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const validation = await import("../../apps/web/src/lib/nft/validation.ts");
const { readNftRequest } = await import("../../apps/web/src/lib/nft/model.ts");
const ethers = require("ethers");
const { SeaportABI } = require("@opensea/seaport-js/lib/abi/Seaport");
const { EIP_712_ORDER_TYPE } = require("@opensea/seaport-js/lib/constants");
const seaport = new ethers.Interface(SeaportABI);
const erc721 = new ethers.Interface([
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);
const erc1155 = new ethers.Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
]);
const erc20 = new ethers.Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const addr = (c) => `0x${c.repeat(40)}`;
const hash = (c) => `0x${c.repeat(64)}`;
const ZERO = addr("0"),
  ZERO_HASH = hash("0"),
  seller = addr("1"),
  buyer = addr("2"),
  nft = addr("3"),
  fee1 = addr("4"),
  fee2 = addr("5");
const protocol = "0x0000000000000068F116a894984e2DB1123eB395";
const WETH = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  8453: "0x4200000000000000000000000000000000000006",
};
const transactionHash = hash("a"),
  blockHash = hash("b");
const runtimeCode = "0x6000600055";
const item = (itemType, token, identifier, amount, recipient) => ({
  itemType,
  token,
  identifierOrCriteria: identifier,
  startAmount: amount,
  endAmount: amount,
  ...(recipient ? { recipient } : {}),
});

function fixture({
  action = "list",
  standard = "erc721",
  chainId = "1",
  method = "fulfillOrder",
  size = standard === "erc721" ? "1" : "4",
  requested = size,
  fill = requested,
  batch = false,
} = {}) {
  const listing = action === "list",
    currency = listing ? ZERO : WETH[chainId];
  const asset = item(
    standard === "erc721" ? 2 : 3,
    nft,
    "7",
    size,
    listing ? undefined : buyer,
  );
  const fees = [
    item(listing ? 0 : 1, currency, "0", "60", fee1),
    item(listing ? 0 : 1, currency, "0", "40", fee2),
  ];
  const components = {
    offerer: listing ? seller : buyer,
    zone: ZERO,
    offer: listing ? [asset] : [item(1, currency, "0", "1000")],
    consideration: listing
      ? [item(0, ZERO, "0", "900", seller), ...fees]
      : [asset, ...fees],
    orderType: standard === "erc721" ? 0 : 1,
    startTime: "100",
    endTime: "1000",
    zoneHash: ZERO_HASH,
    salt: "9",
    conduitKey: ZERO_HASH,
    counter: "0",
  };
  const scaled = (n, q = requested) =>
    ((BigInt(n) * BigInt(q)) / BigInt(size)).toString();
  const order = {
    schema: "artfi-nft-sale-order/1",
    nativeAction: action,
    binding: {
      taskDigest: hash("f"),
      nativePlanId: "synthetic-plan",
      nativeOperationId: "synthetic-operation",
      reviewDigest: "e".repeat(64),
      orderHash: ethers.TypedDataEncoder.hashStruct(
        "OrderComponents",
        EIP_712_ORDER_TYPE,
        components,
      ),
      typedDataDigest: ethers.TypedDataEncoder.hash(
        {
          name: "Seaport",
          version: "1.6",
          chainId: Number(chainId),
          verifyingContract: protocol,
        },
        EIP_712_ORDER_TYPE,
        components,
      ),
    },
    chainId,
    protocol,
    seller,
    nft: { standard, contract: nft, tokenId: "7", quantity: requested },
    payment: {
      itemType: listing ? 0 : 1,
      token: currency,
      symbol: listing ? "ETH" : "WETH",
      decimals: 18,
    },
    components,
    amounts: {
      gross: scaled("1000"),
      fees: scaled("100"),
      sellerNet: scaled("900"),
    },
    feeRecipients: [
      { recipient: fee1, amount: scaled("60") },
      { recipient: fee2, amount: scaled("40") },
    ],
  };
  const parameters = {
    ...components,
    totalOriginalConsiderationItems: components.consideration.length,
  };
  let data;
  if (method === "fulfillAdvancedOrder") {
    data = seaport.encodeFunctionData(method, [
      {
        parameters,
        signature: "0x",
        numerator: requested,
        denominator: size,
        extraData: "0x",
      },
      [],
      ZERO_HASH,
      listing ? buyer : seller,
    ]);
  } else if (method.startsWith("fulfillBasicOrder")) {
    const first = components.consideration[0],
      offered = components.offer[0];
    data = seaport.encodeFunctionData(method, [
      {
        considerationToken: first.token,
        considerationIdentifier: first.identifierOrCriteria,
        considerationAmount: first.startAmount,
        offerer: components.offerer,
        zone: ZERO,
        offerToken: offered.token,
        offerIdentifier: offered.identifierOrCriteria,
        offerAmount: offered.startAmount,
        basicOrderType:
          (listing
            ? standard === "erc721"
              ? 0
              : 1
            : standard === "erc721"
              ? 4
              : 5) *
            4 +
          components.orderType,
        startTime: "100",
        endTime: "1000",
        zoneHash: ZERO_HASH,
        salt: "9",
        offererConduitKey: ZERO_HASH,
        fulfillerConduitKey: ZERO_HASH,
        totalOriginalAdditionalRecipients: fees.length,
        additionalRecipients: fees.map((i) => ({
          recipient: i.recipient,
          amount: i.startAmount,
        })),
        signature: "0x",
      },
    ]);
  } else
    data = seaport.encodeFunctionData(method, [
      { parameters, signature: "0x" },
      ZERO_HASH,
    ]);
  const transaction = {
    chainId,
    hash: transactionHash,
    blockHash,
    blockNumber: 100,
    from: listing ? buyer : seller,
    to: protocol,
    data,
    value: listing ? scaled("1000") : "0",
    nonce: 17,
  };
  const context = {
    chainId,
    transactionHash,
    blockHash,
    blockNumber: 100,
    removed: false,
  };
  let index = 0;
  const log = (iface, name, address, args) => ({
    ...context,
    ...iface.encodeEventLog(iface.getEvent(name), args),
    address,
    index: index++,
  });
  const toEventItem = (i, consideration) => [
    i.itemType,
    i.token,
    i.identifierOrCriteria,
    scaled(i.startAmount, fill),
    ...(consideration ? [i.recipient] : []),
  ];
  const sale = log(seaport, "OrderFulfilled", protocol, [
    order.binding.orderHash,
    components.offerer,
    ZERO,
    listing ? buyer : seller,
    components.offer.map((i) => toEventItem(i, false)),
    components.consideration.map((i) => toEventItem(i, true)),
  ]);
  const nftLog =
    standard === "erc721"
      ? log(erc721, "Transfer", nft, [seller, buyer, "7"])
      : batch
        ? log(erc1155, "TransferBatch", nft, [
            protocol,
            seller,
            buyer,
            ["7"],
            [fill],
          ])
        : log(erc1155, "TransferSingle", nft, [
            protocol,
            seller,
            buyer,
            "7",
            fill,
          ]);
  const logs = [sale, nftLog];
  if (!listing) {
    const basic = method.startsWith("fulfillBasicOrder");
    logs.push(
      log(erc20, "Transfer", currency, [
        buyer,
        seller,
        scaled(basic ? "900" : "1000", fill),
      ]),
    );
    fees.forEach((i) =>
      logs.push(
        log(erc20, "Transfer", currency, [
          basic ? buyer : seller,
          i.recipient,
          scaled(i.startAmount, fill),
        ]),
      ),
    );
  }
  const evidence = {
    observationPolicyId: "synthetic-policy",
    sourceId: "synthetic-reader",
    observedAt: 1234000,
    chainId,
    transaction,
    receipt: {
      transactionHash,
      chainId,
      from: transaction.from,
      to: protocol,
      blockHash,
      blockNumber: 100,
      status: 1,
      logs,
    },
    canonicalBlockBefore: {
      chainId,
      number: 100,
      hash: blockHash,
      timestamp: 200,
    },
    canonicalBlockAfter: {
      chainId,
      number: 100,
      hash: blockHash,
      timestamp: 200,
    },
    head: { chainId, number: 105, hash: hash("c") },
    deploymentEvidence: {
      chainId,
      address: protocol,
      blockNumber: 100,
      blockHash,
      runtimeCode,
    },
  };
  const reviewedTransaction = listing
    ? undefined
    : {
        chainId,
        from: seller,
        to: protocol,
        data,
        value: "0",
        nonce: 17,
        orderHash: order.binding.orderHash,
        nativePlanId: order.binding.nativePlanId,
        nativeOperationId: order.binding.nativeOperationId,
        reviewDigest: order.binding.reviewDigest,
      };
  const config = {
    ethers,
    orderTypes: EIP_712_ORDER_TYPE,
    seaportABI: SeaportABI,
    expectedOrder: order,
    ...(reviewedTransaction ? { reviewedTransaction } : {}),
    observationPolicy: {
      id: "synthetic-policy",
      taskDigest: order.binding.taskDigest,
      chainId,
      sourceId: "synthetic-reader",
      minimumConfirmations: 3,
    },
    allowedDeployments: [
      {
        chainId,
        address: protocol,
        runtimeCodeHash: ethers.keccak256(runtimeCode),
        proxyOrUpgradeAllowed: false,
        reviewEvidenceSha256: "1".repeat(64),
        nativeConsiderationPolicy: NFT_SALE_NATIVE_POLICY,
      },
    ],
  };
  return { config, input: { evidence }, order, evidence, log };
}
function assess(f) {
  return createNftSaleEvidenceEvaluator(f.config)(f.input);
}
function unknown(result, reason) {
  assert.equal(result.state, "UNKNOWN");
  assert.equal(result.verified, false);
  assert.equal(result.saleComplete, false);
  assert.equal(result.orderComplete, false);
  if (reason) assert.equal(result.reason, reason);
}
function replaceSale(f, edit) {
  const parsed = seaport.parseLog(f.evidence.receipt.logs[0]).args;
  const args = [
    parsed.orderHash,
    parsed.offerer,
    parsed.zone,
    parsed.recipient,
    parsed.offer.map((i) => [...i]),
    parsed.consideration.map((i) => [...i]),
  ];
  edit(args);
  Object.assign(
    f.evidence.receipt.logs[0],
    seaport.encodeEventLog(seaport.getEvent("OrderFulfilled"), args),
  );
}

for (const chainId of ["1", "8453"])
  for (const standard of ["erc721", "erc1155"])
    for (const action of ["list", "accept"]) {
      test(`synthetic ${chainId} ${standard} ${action} verifies exact whole fill`, () => {
        const f = fixture({ chainId, standard, action }),
          before = kernelRequestDigest(f.input);
        const result = assess(f);
        assert.equal(result.state, "CONFIRMED", JSON.stringify(result));
        assert.equal(result.kind, "NFT_SALE_FILL");
        assert.equal(result.saleComplete, true);
        assert.equal(result.orderComplete, true);
        assert.equal(result.sellerNet, "900");
        assert.equal(result.fees, "100");
        assert.equal(result.transactionBalanceDeltaMeasured, false);
        assert.equal(result.finality, "NOT_EVALUATED");
        assert.equal(result.currentOwnership, "NOT_EVALUATED");
        assert.equal(result.authorizationChanged, false);
        assert.equal(result.budgetChanged, false);
        assert.equal(before, kernelRequestDigest(f.input));
        assert.ok(Object.isFrozen(result));
        assert.ok(Object.isFrozen(result.feeRecipients));
      });
    }
test("listing is fulfilled by a future buyer with an unrelated sender nonce", () => {
  const f = fixture();
  f.evidence.transaction.nonce = 982;
  assert.notEqual(f.evidence.transaction.from, seller);
  assert.equal(assess(f).saleComplete, true);
});
test("advanced listing distinguishes the external payer from its explicit gift recipient", () => {
  const f = fixture({ method: "fulfillAdvancedOrder" });
  f.evidence.transaction.from = fee2;
  f.evidence.receipt.from = fee2;
  const result = assess(f);
  assert.equal(result.saleComplete, true);
  assert.equal(result.buyer, fee2);
  assert.equal(result.nftRecipient, buyer);
});
test("P2 rejects fulfillOrder sender and event recipient contradiction", () => {
  const f = fixture();
  f.evidence.transaction.from = fee2;
  f.evidence.receipt.from = fee2;
  unknown(assess(f), "NFT_SALE_CALLDATA_RECIPIENT_MISMATCH");
});
test("P2 rejects calldata order salt and event orderHash contradiction", () => {
  const f = fixture();
  const parameters = {
    ...f.order.components,
    salt: "999999",
    totalOriginalConsiderationItems: f.order.components.consideration.length,
  };
  f.evidence.transaction.data = seaport.encodeFunctionData("fulfillOrder", [
    { parameters, signature: "0x" },
    ZERO_HASH,
  ]);
  unknown(assess(f), "NFT_SALE_CALLDATA_ORDER_MISMATCH");
});
function editCall(f, edit) {
  const call = seaport.parseTransaction({ data: f.evidence.transaction.data });
  const first = call.args[0].toObject();
  if (call.name === "fulfillBasicOrder") {
    first.additionalRecipients = call.args[0].additionalRecipients.map((i) =>
      i.toObject(),
    );
  } else {
    const p = call.args[0].parameters;
    first.parameters = {
      ...p.toObject(),
      offer: p.offer.map((i) => i.toObject()),
      consideration: p.consideration.map((i) => i.toObject()),
    };
  }
  const args =
    call.name === "fulfillAdvancedOrder"
      ? [first, [], call.args[2], call.args[3]]
      : call.name === "fulfillOrder"
        ? [first, call.args[1]]
        : [first];
  edit(args);
  f.evidence.transaction.data = seaport.encodeFunctionData(call.name, args);
}
for (const method of ["fulfillAdvancedOrder", "fulfillBasicOrder"]) {
  test(`decoded ${method} order salt must match the event`, () => {
    const f = fixture({ method });
    editCall(f, (args) => {
      (method === "fulfillAdvancedOrder" ? args[0].parameters : args[0]).salt =
        "999999";
    });
    unknown(assess(f), "NFT_SALE_CALLDATA_ORDER_MISMATCH");
  });
}
test("basic caller must match the event recipient", () => {
  const f = fixture({ method: "fulfillBasicOrder" });
  f.evidence.transaction.from = fee2;
  f.evidence.receipt.from = fee2;
  unknown(assess(f), "NFT_SALE_CALLDATA_RECIPIENT_MISMATCH");
});
test("advanced explicit recipient must match the event recipient", () => {
  const f = fixture({ method: "fulfillAdvancedOrder" });
  editCall(f, (a) => {
    a[3] = fee2;
  });
  unknown(assess(f), "NFT_SALE_CALLDATA_RECIPIENT_MISMATCH");
});
test("advanced zero recipient resolves to the transaction sender", () => {
  const f = fixture({ method: "fulfillAdvancedOrder" });
  editCall(f, (a) => {
    a[3] = ZERO;
  });
  assert.equal(assess(f).saleComplete, true);
  f.evidence.transaction.from = fee2;
  f.evidence.receipt.from = fee2;
  unknown(assess(f), "NFT_SALE_CALLDATA_RECIPIENT_MISMATCH");
});
test("standard original consideration count must match the order", () => {
  const f = fixture();
  editCall(f, (a) => {
    a[0].parameters.totalOriginalConsiderationItems = 2n;
  });
  unknown(assess(f), "NFT_SALE_CALLDATA_ORDER_MISMATCH");
});
test("basic original consideration count and route remain bound", () => {
  const f = fixture({ method: "fulfillBasicOrder" });
  editCall(f, (a) => {
    a[0].totalOriginalAdditionalRecipients = 1n;
  });
  unknown(assess(f), "NFT_SALE_CALLDATA_ORDER_MISMATCH");
  const g = fixture({ method: "fulfillBasicOrder" });
  editCall(g, (a) => {
    a[0].basicOrderType = 8n;
  });
  unknown(assess(g), "NFT_SALE_CALLDATA_ORDER_MISMATCH");
});
test("advanced receipt cannot exceed the decoded requested fraction", () => {
  const f = fixture({ method: "fulfillAdvancedOrder", standard: "erc1155" });
  editCall(f, (a) => {
    a[0].numerator = 1n;
    a[0].denominator = 2n;
  });
  unknown(assess(f), "NFT_SALE_FILL_QUANTITY_INVALID");
});
test("basic receipt cannot report a partial fill", () => {
  const f = fixture({
    method: "fulfillBasicOrder",
    standard: "erc1155",
    fill: "2",
  });
  unknown(assess(f), "NFT_SALE_FILL_QUANTITY_INVALID");
});
test("standard remaining partial fill remains supported", () => {
  const f = fixture({ standard: "erc1155", fill: "2" });
  const result = assess(f);
  assert.equal(result.verified, true);
  assert.equal(result.saleComplete, false);
  assert.equal(result.quantity, "2");
});
test("seller funding their own listing is not seller proceeds evidence", () => {
  const f = fixture();
  f.evidence.transaction.from = seller;
  f.evidence.receipt.from = seller;
  unknown(assess(f), "NFT_SALE_SELF_FUNDED_LISTING");
});
for (const method of ["fulfillBasicOrder", "fulfillAdvancedOrder"]) {
  test(`accept WETH exact payment allocation for ${method}`, () => {
    const result = assess(fixture({ action: "accept", method }));
    assert.equal(result.saleComplete, true, JSON.stringify(result));
  });
}
test("partial listing proves only this fill, without claiming full sale or order", () => {
  const f = fixture({
    standard: "erc1155",
    method: "fulfillAdvancedOrder",
    fill: "2",
  });
  const result = assess(f);
  assert.equal(result.verified, true);
  assert.equal(result.quantity, "2");
  assert.equal(result.sellerNet, "450");
  assert.equal(result.saleComplete, false);
  assert.equal(result.orderComplete, false);
  assert.equal(result.priorFills, "NOT_EVALUATED");
});
test("accepting an explicitly reviewed partial offer separates selection and whole order completion", () => {
  const result = assess(
    fixture({
      action: "accept",
      standard: "erc1155",
      requested: "2",
      method: "fulfillAdvancedOrder",
    }),
  );
  assert.equal(result.saleComplete, true);
  assert.equal(result.orderComplete, false);
  assert.equal(result.orderQuantity, "4");
  assert.equal(result.quantity, "2");
});
test("ERC1155 one-item TransferBatch is reconciled exactly", () =>
  assert.equal(
    assess(fixture({ standard: "erc1155", batch: true })).saleComplete,
    true,
  ));

const invalidEvidence = [
  [
    "missing receipt",
    (f) => {
      f.evidence.receipt = null;
    },
  ],
  [
    "approval alone",
    (f) => {
      f.evidence.receipt.logs = [f.evidence.receipt.logs[1]];
    },
  ],
  [
    "signature alone",
    (f) => {
      f.input.evidence = { state: "SIGNED" };
    },
  ],
  [
    "OpenSea accepted alone",
    (f) => {
      f.input.evidence = {
        state: "ORDER_VISIBLE",
        orderHash: f.order.binding.orderHash,
      };
    },
  ],
  [
    "reverted receipt",
    (f) => {
      f.evidence.receipt.status = 0;
    },
  ],
  [
    "unknown status",
    (f) => {
      f.evidence.receipt.status = null;
    },
  ],
  [
    "wrong chain",
    (f) => {
      f.evidence.chainId = "8453";
    },
  ],
  [
    "wrong transaction chain",
    (f) => {
      f.evidence.transaction.chainId = "8453";
    },
  ],
  [
    "wrong receipt chain",
    (f) => {
      f.evidence.receipt.chainId = "8453";
    },
  ],
  [
    "wrong policy identity",
    (f) => {
      f.evidence.observationPolicyId = "other-policy";
    },
  ],
  [
    "wrong reader identity",
    (f) => {
      f.evidence.sourceId = "other-reader";
    },
  ],
  [
    "wrong receipt transaction",
    (f) => {
      f.evidence.receipt.transactionHash = hash("d");
    },
  ],
  [
    "transaction in other block",
    (f) => {
      f.evidence.transaction.blockHash = hash("d");
    },
  ],
  [
    "transaction in other height",
    (f) => {
      f.evidence.transaction.blockNumber = 99;
    },
  ],
  [
    "wrong receipt from",
    (f) => {
      f.evidence.receipt.from = seller;
    },
  ],
  [
    "wrong transaction destination",
    (f) => {
      f.evidence.transaction.to = nft;
    },
  ],
  [
    "wrong receipt destination",
    (f) => {
      f.evidence.receipt.to = nft;
    },
  ],
  [
    "wrong canonical before",
    (f) => {
      f.evidence.canonicalBlockBefore.hash = hash("d");
    },
  ],
  [
    "reorg observed after receipt",
    (f) => {
      f.evidence.canonicalBlockAfter.hash = hash("d");
    },
  ],
  [
    "wrong canonical chain",
    (f) => {
      f.evidence.canonicalBlockAfter.chainId = "8453";
    },
  ],
  [
    "shallow depth",
    (f) => {
      f.evidence.head.number = 101;
    },
  ],
  [
    "head before receipt",
    (f) => {
      f.evidence.head.number = 99;
    },
  ],
  [
    "wrong head chain",
    (f) => {
      f.evidence.head.chainId = "8453";
    },
  ],
  [
    "execution before start",
    (f) => {
      f.evidence.canonicalBlockBefore.timestamp =
        f.evidence.canonicalBlockAfter.timestamp = 99;
    },
  ],
  [
    "execution at expiry",
    (f) => {
      f.evidence.canonicalBlockBefore.timestamp =
        f.evidence.canonicalBlockAfter.timestamp = 1000;
    },
  ],
  [
    "code hash not pinned",
    (f) => {
      f.evidence.deploymentEvidence.runtimeCode = "0x6000";
    },
  ],
  [
    "deployment missing",
    (f) => {
      delete f.evidence.deploymentEvidence;
    },
  ],
  [
    "deployment at different block",
    (f) => {
      f.evidence.deploymentEvidence.blockHash = hash("d");
    },
  ],
  [
    "deployment on wrong chain",
    (f) => {
      f.evidence.deploymentEvidence.chainId = "8453";
    },
  ],
  [
    "untrusted verified boolean",
    (f) => {
      f.evidence.deploymentEvidence = { verified: true };
    },
  ],
  [
    "removed log",
    (f) => {
      f.evidence.receipt.logs[0].removed = true;
    },
  ],
  [
    "log from other transaction",
    (f) => {
      f.evidence.receipt.logs[0].transactionHash = hash("d");
    },
  ],
  [
    "log from other block",
    (f) => {
      f.evidence.receipt.logs[0].blockHash = hash("d");
    },
  ],
  [
    "log from other height",
    (f) => {
      f.evidence.receipt.logs[0].blockNumber = 99;
    },
  ],
  [
    "log on other chain",
    (f) => {
      f.evidence.receipt.logs[0].chainId = "8453";
    },
  ],
  [
    "duplicate index",
    (f) => {
      f.evidence.receipt.logs[1].index = 0;
    },
  ],
  [
    "duplicate OrderFulfilled",
    (f) => {
      f.evidence.receipt.logs.push({
        ...f.evidence.receipt.logs[0],
        index: 88,
      });
    },
  ],
  [
    "wrong event emitter",
    (f) => {
      f.evidence.receipt.logs[0].address = nft;
    },
  ],
  [
    "malformed event",
    (f) => {
      f.evidence.receipt.logs[0].data = "0x1234";
    },
  ],
  [
    "wrong orderHash",
    (f) =>
      replaceSale(f, (a) => {
        a[0] = hash("d");
      }),
  ],
  [
    "wrong offerer",
    (f) =>
      replaceSale(f, (a) => {
        a[1] = buyer;
      }),
  ],
  [
    "wrong zone",
    (f) =>
      replaceSale(f, (a) => {
        a[2] = fee1;
      }),
  ],
  [
    "recipient missing",
    (f) =>
      replaceSale(f, (a) => {
        a[3] = ZERO;
      }),
  ],
  [
    "seller self-fill",
    (f) =>
      replaceSale(f, (a) => {
        a[3] = seller;
      }),
  ],
  [
    "wrong NFT",
    (f) =>
      replaceSale(f, (a) => {
        a[4][0][1] = fee1;
      }),
  ],
  [
    "wrong token ID",
    (f) =>
      replaceSale(f, (a) => {
        a[4][0][2] = "8";
      }),
  ],
  [
    "wrong quantity",
    (f) =>
      replaceSale(f, (a) => {
        a[4][0][3] = "2";
      }),
  ],
  [
    "wrong currency",
    (f) =>
      replaceSale(f, (a) => {
        a[5][0][1] = WETH["1"];
      }),
  ],
  [
    "wrong seller net",
    (f) =>
      replaceSale(f, (a) => {
        a[5][0][3] = "899";
      }),
  ],
  [
    "wrong fee recipient",
    (f) =>
      replaceSale(f, (a) => {
        a[5][1][4] = buyer;
      }),
  ],
  [
    "same total wrong fee split",
    (f) =>
      replaceSale(f, (a) => {
        a[5][1][3] = "59";
        a[5][2][3] = "41";
      }),
  ],
  [
    "missing fee item",
    (f) =>
      replaceSale(f, (a) => {
        a[5].pop();
      }),
  ],
  [
    "extra unreviewed tip",
    (f) =>
      replaceSale(f, (a) => {
        a[5].push([...a[5][1]]);
      }),
  ],
  [
    "missing NFT Transfer",
    (f) => {
      f.evidence.receipt.logs.pop();
    },
  ],
  [
    "NFT Transfer wrong emitter",
    (f) => {
      f.evidence.receipt.logs[1].address = fee1;
    },
  ],
  [
    "NFT round trip",
    (f) => {
      f.evidence.receipt.logs.push(
        f.log(erc721, "Transfer", nft, [buyer, seller, "7"]),
      );
    },
  ],
  [
    "insufficient native value",
    (f) => {
      f.evidence.transaction.value = "999";
    },
  ],
  [
    "cancel calldata",
    (f) => {
      f.evidence.transaction.data = seaport.encodeFunctionData("cancel", [
        [f.order.components],
      ]);
    },
  ],
];
for (const [name, mutate] of invalidEvidence)
  test(`fails closed: ${name}`, () => {
    const f = fixture();
    mutate(f);
    unknown(assess(f));
  });

for (const field of [
  "from",
  "to",
  "data",
  "value",
  "nonce",
  "chainId",
  "orderHash",
  "nativePlanId",
  "nativeOperationId",
  "reviewDigest",
]) {
  test(`accept requires frozen reviewed ${field}`, () => {
    const f = fixture({ action: "accept" });
    f.config.reviewedTransaction[field] =
      field === "nonce"
        ? 18
        : field === "value"
          ? "1"
          : field === "data"
            ? "0x1234"
            : "mismatch";
    unknown(assess(f), "NFT_SALE_ACCEPT_TRANSACTION_MISMATCH");
  });
}
test("accept missing reviewed transaction fails closed", () => {
  const f = fixture({ action: "accept" });
  delete f.config.reviewedTransaction;
  unknown(assess(f), "NFT_SALE_ACCEPT_TRANSACTION_MISMATCH");
});
test("accept actual sender must be seller even if receipt agrees", () => {
  const f = fixture({ action: "accept" });
  f.evidence.transaction.from = buyer;
  f.evidence.receipt.from = buyer;
  unknown(assess(f), "NFT_SALE_ACCEPT_TRANSACTION_MISMATCH");
});
for (const [name, mutate] of [
  ["missing payment", (f) => f.evidence.receipt.logs.pop()],
  [
    "wrong payment emitter",
    (f) => {
      f.evidence.receipt.logs[2].address = fee1;
    },
  ],
  [
    "wrong payment recipient",
    (f) => {
      Object.assign(
        f.evidence.receipt.logs[2],
        erc20.encodeEventLog(erc20.getEvent("Transfer"), [buyer, fee1, "1000"]),
      );
    },
  ],
  [
    "wrong seller proceeds",
    (f) => {
      Object.assign(
        f.evidence.receipt.logs[2],
        erc20.encodeEventLog(erc20.getEvent("Transfer"), [
          buyer,
          seller,
          "999",
        ]),
      );
    },
  ],
  [
    "extra debit",
    (f) =>
      f.evidence.receipt.logs.push(
        f.log(erc20, "Transfer", WETH["1"], [seller, fee1, "1"]),
      ),
  ],
  [
    "duplicate payment",
    (f) =>
      f.evidence.receipt.logs.push({
        ...f.evidence.receipt.logs[2],
        index: 99,
      }),
  ],
  [
    "basic routing on standard call",
    (f) => {
      Object.assign(
        f.evidence.receipt.logs[2],
        erc20.encodeEventLog(erc20.getEvent("Transfer"), [
          buyer,
          seller,
          "900",
        ]),
      );
      for (let i = 3; i < 5; i++) {
        const a = erc20.parseLog(f.evidence.receipt.logs[i]).args;
        Object.assign(
          f.evidence.receipt.logs[i],
          erc20.encodeEventLog(erc20.getEvent("Transfer"), [
            buyer,
            a.to,
            a.value,
          ]),
        );
      }
    },
  ],
])
  test(`accept rejects ${name}`, () => {
    const f = fixture({ action: "accept" });
    mutate(f);
    unknown(assess(f), "NFT_SALE_PAYMENT_TRANSFER_MISMATCH");
  });

test("no implicit observation depth policy", () => {
  const f = fixture();
  delete f.config.observationPolicy;
  assert.throws(() => assess(f), /CONFIGURATION/);
});
test("policy binds the exact task", () => {
  const f = fixture();
  f.config.observationPolicy.taskDigest = hash("d");
  assert.throws(() => assess(f), /POLICY_BINDING/);
});
test("pinned order cannot be substituted with a separately valid order", () => {
  const f = fixture(),
    evaluate = createNftSaleEvidenceEvaluator(f.config),
    another = structuredClone(f.order);
  another.components.salt = "11";
  another.binding.orderHash = ethers.TypedDataEncoder.hashStruct(
    "OrderComponents",
    EIP_712_ORDER_TYPE,
    another.components,
  );
  unknown(
    evaluate({ ...f.input, order: another }),
    "NFT_SALE_ORDER_SNAPSHOT_MISMATCH",
  );
});
test("factory freezes order, deployment and reviewed snapshot independently of later caller mutation", () => {
  const f = fixture({ action: "accept" }),
    evaluate = createNftSaleEvidenceEvaluator(f.config);
  f.config.expectedOrder.seller = buyer;
  f.config.allowedDeployments[0].runtimeCodeHash = hash("9");
  f.config.reviewedTransaction.nonce = 99;
  assert.equal(evaluate(f.input).saleComplete, true);
});
test("input review cannot replace the frozen review", () => {
  const f = fixture({ action: "accept" });
  f.input.reviewedTransaction = { ...f.config.reviewedTransaction, nonce: 99 };
  unknown(assess(f), "NFT_SALE_REVIEW_SNAPSHOT_MISMATCH");
});
test("arbitrary code cannot become trusted by assigning its own hash", () => {
  const f = fixture(),
    evaluate = createNftSaleEvidenceEvaluator(f.config);
  f.evidence.deploymentEvidence.runtimeCode = "0x6000";
  f.evidence.deploymentEvidence.runtimeCodeHash = ethers.keccak256("0x6000");
  f.evidence.deploymentEvidence.verified = true;
  unknown(evaluate(f.input), "NFT_SALE_DEPLOYMENT_UNTRUSTED");
});
test("native accounting needs explicit reviewed deployment policy", () => {
  const f = fixture();
  delete f.config.allowedDeployments[0].nativeConsiderationPolicy;
  unknown(assess(f), "NFT_SALE_NATIVE_ACCOUNTING_UNREVIEWED");
});
test("expired today can still prove a canonical fill inside its original validity window", () => {
  const f = fixture();
  f.evidence.observedAt = 999999999;
  assert.equal(assess(f).saleComplete, true);
});
test("grant revocation is unrelated to historical sale or published-order cancellation", () => {
  const f = fixture();
  f.input.walletGrant = { state: "REVOKED" };
  const result = assess(f);
  assert.equal(result.saleComplete, true);
  assert.equal(result.authorizationChanged, false);
  assert.equal(result.orderCancelled, undefined);
});
test("order component hash and frozen normalized accounting are independently checked", () => {
  const f = fixture();
  f.order.components.salt = "15";
  unknown(assess(f), "NFT_SALE_ORDER_HASH_INVALID");
  const g = fixture();
  g.order.amounts.sellerNet = "901";
  unknown(assess(g), "NFT_SALE_REVIEW_AMOUNTS_MISMATCH");
});
test("actual Stage 1 terms output binds across the pure receipt boundary", () => {
  const f = fixture(),
    nowMs = 200000,
    adapterId = "synthetic-seaport";
  const policy = {
    schema: "8415-agent-task/1",
    taskId: "synthetic-cross-module",
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
    id: "cross-plan",
    operationId: "cross-operation",
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
    summary: "Synthetic listing only",
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
  assert.equal(terms.state, "EVIDENCE_REQUIRED", JSON.stringify(terms));
  assert.equal(terms.reason, "USD_PRICE_EVIDENCE_REQUIRED");
  assert.ok(terms.order, JSON.stringify(terms));
  f.config.expectedOrder = terms.order;
  f.config.observationPolicy.taskDigest = frozenTask.digest;
  const evaluate = createNftSaleEvidenceEvaluator(f.config),
    result = evaluate({ ...f.input, order: terms.order });
  assert.equal(result.saleComplete, true, JSON.stringify(result));
  assert.equal(result.orderDigest, kernelRequestDigest(terms.order));
  assert.equal(result.usdProceeds, "NOT_EVALUATED");
  const substituted = structuredClone(terms.order);
  substituted.binding.reviewDigest = "c".repeat(64);
  unknown(
    evaluate({ ...f.input, order: substituted }),
    "NFT_SALE_ORDER_SNAPSHOT_MISMATCH",
  );
  const wrongTyped = structuredClone(terms.order);
  wrongTyped.binding.typedDataDigest = hash("d");
  f.config.expectedOrder = wrongTyped;
  unknown(assess(f), "NFT_SALE_TYPED_DATA_DIGEST_INVALID");
});
test("actual Stage 1 accept validates the same reviewed transaction before evidence evaluation", () => {
  const f = fixture({ action: "accept" }),
    scope = {
      slug: "synthetic",
      chain: "ethereum",
      contract: nft,
      standard: "erc721",
      label: "Synthetic",
      charity: false,
    };
  // validateTransaction currently uses its own wall clock. Keep this canonical
  // fixture live for this preflight only, then use the same receipt snapshot.
  const now = Math.floor(Date.now() / 1000);
  f.order.components.startTime = String(now - 30);
  f.order.components.endTime = String(now + 3600);
  f.order.binding.orderHash = validation.orderHash(f.order.components);
  f.order.binding.typedDataDigest = ethers.TypedDataEncoder.hash(
    {
      name: "Seaport",
      version: "1.6",
      chainId: 1,
      verifyingContract: protocol,
    },
    EIP_712_ORDER_TYPE,
    f.order.components,
  );
  const data = seaport.encodeFunctionData("fulfillOrder", [
    {
      parameters: {
        ...f.order.components,
        totalOriginalConsiderationItems:
          f.order.components.consideration.length,
      },
      signature: "0x",
    },
    ZERO_HASH,
  ]);
  f.evidence.transaction.data = data;
  f.config.reviewedTransaction.data = data;
  f.config.reviewedTransaction.orderHash = f.order.binding.orderHash;
  f.evidence.canonicalBlockBefore.timestamp =
    f.evidence.canonicalBlockAfter.timestamp = now;
  replaceSale(f, (a) => {
    a[0] = f.order.binding.orderHash;
  });
  const request = {
    action: "accept",
    collection: "synthetic",
    tokenId: "7",
    account: seller,
    quantity: "1",
    priceWei: "1000",
    expiresAt: 0,
    orderHash: f.order.binding.orderHash,
  };
  const reviewed = validation.validateTransaction(
    { to: protocol, data, value: "0" },
    request,
    scope,
    validation.components(f.order.components),
  );
  assert.equal(reviewed.data, data);
  assert.equal(assess(f).saleComplete, true);
});
