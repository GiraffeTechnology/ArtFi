import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createRequire,
  registerHooks,
  stripTypeScriptTypes,
} from "node:module";
import { pathToFileURL } from "node:url";
import { createNftSaleTermsVerifier } from "./nft-sale-terms.mjs";
import { kernelRequestDigest } from "./agent-kernel.mjs";

// Run the actual application parser and hashes. Node 24 test-only hooks strip
// TypeScript and replace Next's server-only marker, without editing production.
const webRequire = createRequire(
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
          url: pathToFileURL(webRequire.resolve(specifier)).href,
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
const { SEAPORT, ZERO, WETH } =
  await import("../../apps/web/src/lib/nft/config.ts");
const ethers = webRequire("ethers");
const { EIP_712_ORDER_TYPE } = webRequire("@opensea/seaport-js/lib/constants");
const now = 1800000000000,
  seconds = Math.floor(now / 1000);
const address = (byte) => `0x${byte.repeat(40)}`;
const seller = address("1"),
  nft = address("2"),
  feeRecipient = address("3"),
  ZERO_HASH = `0x${"0".repeat(64)}`;
const adapterId = "artfi-seaport-1.6";
function freezeTask(policy) {
  return {
    policy,
    digest: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(policy))),
  };
}
function reference(plan, task) {
  return {
    taskDigest: task.digest,
    nativePlanId: plan.id,
    nativeOperationId: plan.operationId,
    reviewDigest: kernelRequestDigest(plan),
    orderHash: plan.orderHash,
    typedDataDigest: ethers.TypedDataEncoder.hash(
      plan.typedData.domain,
      plan.typedData.types,
      plan.typedData.message,
    ),
  };
}
function fixture(change = () => {}) {
  const policy = {
    schema: "8415-agent-task/1",
    taskId: "synthetic-sale",
    tenant: "test",
    origin: "https://example.test",
    chainId: "1",
    actor: seller,
    expiresAt: String(seconds + 7200),
    fees: { perOperationWei: "1", totalWei: "1" },
    intent: {
      kind: "nft-sale",
      direction: "sell",
      standard: "ERC-721",
      contract: nft,
      tokenId: "7",
      quantity: "1",
      minimumProceeds: {
        currency: "USD",
        amountMinor: "195000",
        minorUnit: 2,
        comparison: "gte",
        basis: "net",
      },
      marketAdapters: [adapterId],
    },
  };
  const message = {
    offerer: seller,
    zone: ZERO,
    offer: [
      {
        itemType: 2,
        token: nft,
        identifierOrCriteria: "7",
        startAmount: "1",
        endAmount: "1",
      },
    ],
    consideration: [
      {
        itemType: 0,
        token: ZERO,
        identifierOrCriteria: "0",
        startAmount: "975000000000000000",
        endAmount: "975000000000000000",
        recipient: seller,
      },
      {
        itemType: 0,
        token: ZERO,
        identifierOrCriteria: "0",
        startAmount: "25000000000000000",
        endAmount: "25000000000000000",
        recipient: feeRecipient,
      },
    ],
    orderType: 0,
    startTime: String(seconds - 30),
    endTime: String(seconds + 3600),
    zoneHash: ZERO_HASH,
    salt: "1",
    conduitKey: ZERO_HASH,
    counter: "7",
  };
  const plan = {
    id: "synthetic-plan",
    operationId: "synthetic-operation",
    sessionId: "test-only",
    chainId: 1,
    request: {
      action: "list",
      collection: "synthetic",
      tokenId: "7",
      account: seller,
      quantity: "1",
      priceWei: "1000000000000000000",
      expiresAt: seconds + 3600,
    },
    scope: {
      slug: "synthetic",
      chain: "ethereum",
      contract: nft,
      standard: "erc721",
      label: "TEST ONLY",
      charity: false,
    },
    expiresAt: now + 120000,
    kind: "signature",
    summary: "Synthetic unsigned listing",
    orderExpiresAt: seconds + 3600,
    orderTotalWei: "1000000000000000000",
    paymentToken: "ETH",
    typedData: {
      domain: {
        name: "Seaport",
        version: "1.6",
        chainId: 1,
        verifyingContract: SEAPORT,
      },
      types: structuredClone(EIP_712_ORDER_TYPE),
      primaryType: "OrderComponents",
      message,
    },
    fees: [{ recipient: feeRecipient, amountWei: "25000000000000000" }],
  };
  const valuationPolicy = {
    source: "synthetic-quote-source",
    base: { chainId: "1", token: ZERO, decimals: 18 },
    quote: { currency: "USD", decimals: 2 },
    rateDecimals: 8,
    maxAgeSeconds: "60",
    validFrom: String(seconds - 100),
    validUntil: String(seconds + 100),
    priceAt: "order-review",
  };
  const trustedQuote = {
    source: valuationPolicy.source,
    base: structuredClone(valuationPolicy.base),
    quote: structuredClone(valuationPolicy.quote),
    rateDecimals: 8,
    rate: "200000000000",
    observedAt: String(seconds - 10),
    expiresAt: String(seconds + 30),
  };
  const data = { policy, plan, valuationPolicy, trustedQuote };
  change(data);
  plan.orderHash ??= validation.orderHash(validation.components(message));
  const frozenTask = freezeTask(policy);
  return { ...data, frozenTask, reference: reference(plan, frozenTask) };
}
function verifier(f, overrides = {}) {
  return createNftSaleTermsVerifier({
    ethers,
    validation,
    readNftRequest,
    frozenTask: f.frozenTask,
    nativePlan: f.plan,
    adapterId,
    valuationPolicy: f.valuationPolicy,
    trustedQuote: f.trustedQuote,
    ...overrides,
  });
}
function check(f, state, reason) {
  const result = verifier(f)(f.reference, now);
  assert.equal(result.state, state, JSON.stringify(result));
  if (reason) assert.equal(result.reason, reason);
  return result;
}

test("synthetic seller listing: real Seaport hashes, exact native economics, no authority", () => {
  const f = fixture(),
    result = check(f, "MATCHED", "USD_REVIEW_QUOTE_MATCHED");
  assert.deepEqual(result.order.amounts, {
    gross: "1000000000000000000",
    fees: "25000000000000000",
    sellerNet: "975000000000000000",
  });
  assert.equal(
    result.order.binding.orderHash,
    validation.orderHash(validation.components(f.plan.typedData.message)),
  );
  assert.notEqual(
    result.order.binding.orderHash,
    result.order.binding.typedDataDigest,
  );
  assert.equal(result.usd.amountMinorFloor, "195000");
  assert.equal(result.usd.futureSettlementUsd, "NOT_GUARANTEED");
  assert.ok(Object.isFrozen(result.order.components.consideration[0]));
  assert.deepEqual(result.evidenceLimits, [
    "SIGNATURE_NOT_CHECKED",
    "CURRENT_COUNTER_NOT_CHECKED",
    "OWNERSHIP_AND_APPROVAL_NOT_CHECKED",
    "SETTLEMENT_NOT_CHECKED",
  ]);
  for (const key of [
    "authorized",
    "executable",
    "executability",
    "signature",
    "dispatch",
  ])
    assert.equal(key in result, false);
});
test("explicit gt/gte and gross/net policies have no historical fixed minimum", () => {
  check(
    fixture(({ policy }) => {
      policy.intent.minimumProceeds.comparison = "gt";
    }),
    "MISMATCH",
    "USD_MINIMUM_NOT_MET",
  );
  check(
    fixture(({ policy }) => {
      policy.intent.minimumProceeds.amountMinor = "194999";
      policy.intent.minimumProceeds.comparison = "gt";
    }),
    "MATCHED",
  );
  check(
    fixture(({ policy }) => {
      policy.intent.minimumProceeds.amountMinor = "195001";
    }),
    "MISMATCH",
  );
  check(
    fixture(({ policy }) => {
      policy.intent.minimumProceeds.basis = "gross";
      policy.intent.minimumProceeds.amountMinor = "200000";
    }),
    "MATCHED",
  );
});
test("rational comparison does not round fractional minor units across the threshold", () => {
  const f = fixture(({ policy, trustedQuote }) => {
    policy.intent.minimumProceeds = {
      currency: "USD",
      amountMinor: "199999",
      minorUnit: 2,
      comparison: "gt",
      basis: "gross",
    };
    trustedQuote.rate = "199999999999";
  });
  assert.equal(check(f, "MATCHED").usd.amountMinorFloor, "199999");
  check(
    fixture(({ policy, trustedQuote }) => {
      policy.intent.minimumProceeds.basis = "gross";
      policy.intent.minimumProceeds.amountMinor = "200000";
      trustedQuote.rate = "199999999999";
    }),
    "MISMATCH",
  );
});
test("caller proceeds are ignored; absent evidence and future USD floor stay unknown", () => {
  const f = fixture(({ policy }) => {
    policy.intent.minimumProceeds.amountMinor = "999999999";
  });
  f.reference.proceedsMinor = "999999999999999999999999999999999";
  check(f, "MISMATCH", "USD_MINIMUM_NOT_MET");
  for (const missing of [{ valuationPolicy: null }, { trustedQuote: null }])
    assert.equal(
      verifier(f, missing)(f.reference, now).reason,
      "USD_PRICE_EVIDENCE_REQUIRED",
    );
  const future = fixture(({ valuationPolicy }) => {
    valuationPolicy.priceAt = "settlement";
  });
  assert.equal(
    check(future, "EVIDENCE_REQUIRED", "FUTURE_USD_PRICE_NOT_GUARANTEED").order
      .nativeAction,
    "list",
  );
});
test("all quote source, pair, precision, time and policy bindings are necessary", () => {
  const changes = [
    ({ trustedQuote: q }) => {
      q.source = "caller-source";
    },
    ({ trustedQuote: q }) => {
      q.base.token = nft;
    },
    ({ trustedQuote: q }) => {
      q.base.chainId = "8453";
    },
    ({ trustedQuote: q }) => {
      q.base.decimals = 6;
    },
    ({ trustedQuote: q }) => {
      q.quote.currency = "EUR";
    },
    ({ trustedQuote: q }) => {
      q.quote.decimals = 3;
    },
    ({ trustedQuote: q }) => {
      q.rateDecimals = 9;
    },
    ({ trustedQuote: q }) => {
      q.observedAt = String(seconds + 1);
    },
    ({ trustedQuote: q }) => {
      q.observedAt = String(seconds - 61);
    },
    ({ trustedQuote: q }) => {
      q.expiresAt = String(seconds);
    },
    ({ trustedQuote: q }) => {
      q.expiresAt = String(seconds + 101);
    },
    ({ trustedQuote: q }) => {
      q.rate = "1e8";
    },
    ({ trustedQuote: q }) => {
      q.rate = "0";
    },
    ({ valuationPolicy: p }) => {
      delete p.source;
    },
    ({ valuationPolicy: p }) => {
      delete p.priceAt;
    },
    ({ valuationPolicy: p }) => {
      delete p.maxAgeSeconds;
    },
    ({ valuationPolicy: p }) => {
      p.validUntil = String(seconds);
    },
    ({ valuationPolicy: p }) => {
      p.rateDecimals = 10000000;
    },
  ];
  for (const change of changes) check(fixture(change), "EVIDENCE_REQUIRED");
});
test("task, native IDs, review and both order digests are independently bound", () => {
  for (const key of [
    "taskDigest",
    "reviewDigest",
    "orderHash",
    "typedDataDigest",
    "nativePlanId",
    "nativeOperationId",
  ]) {
    const f = fixture();
    f.reference[key] = key.endsWith("Id")
      ? "another-id"
      : key === "reviewDigest"
        ? "e".repeat(64)
        : `0x${"e".repeat(64)}`;
    check(f, "MISMATCH");
  }
  const f = fixture();
  f.frozenTask.policy.actor = feeRecipient;
  check(f, "MISMATCH", "NFT_SALE_TASK_DIGEST_MISMATCH");
});
test("transfer, approval, buy and buy-side offer cannot masquerade as seller listing", () => {
  for (const action of [
    "buy",
    "offer",
    "accept",
    "cancel",
    "transfer",
    "approve",
  ])
    check(
      fixture(({ plan }) => {
        plan.request.action = action;
      }),
      "MISMATCH",
      "NFT_SALE_SELLER_LISTING_REQUIRED",
    );
  for (const kind of ["approval", "transaction"])
    check(
      fixture(({ plan }) => {
        plan.kind = kind;
      }),
      "MISMATCH",
      "NFT_SALE_SELLER_LISTING_REQUIRED",
    );
  check(
    fixture(({ plan }) => {
      plan.transaction = { to: nft, data: "0x", value: "0" };
    }),
    "MISMATCH",
  );
  check(
    fixture(({ policy }) => {
      policy.intent = {
        kind: "exact-operation",
        operation: { kind: "erc721-transfer" },
      };
    }),
    "MISMATCH",
  );
});
test("canonical validation rejects substituted seller, NFT, currency, domain, zone and conduit", () => {
  const changes = [
    ({ plan: p }) => {
      p.typedData.message.offerer = feeRecipient;
    },
    ({ plan: p }) => {
      p.typedData.message.offer[0].itemType = 1;
      p.typedData.message.offer[0].token = WETH.ethereum;
    },
    ({ plan: p }) => {
      p.typedData.message.consideration[0].recipient = feeRecipient;
    },
    ({ plan: p }) => {
      p.typedData.message.consideration[1].itemType = 1;
      p.typedData.message.consideration[1].token = WETH.ethereum;
    },
    ({ plan: p }) => {
      p.typedData.message.consideration[1].identifierOrCriteria = "1";
    },
    ({ plan: p }) => {
      p.fees = [];
    },
    ({ plan: p }) => {
      p.orderTotalWei = "999999999999999999999999";
    },
    ({ plan: p }) => {
      p.scope.contract = feeRecipient;
    },
    ({ plan: p }) => {
      p.request.account = feeRecipient;
    },
    ({ plan: p }) => {
      p.request.quantity = "2";
    },
    ({ policy: p }) => {
      p.intent.tokenId = "8";
    },
    ({ policy: p }) => {
      p.intent.marketAdapters = ["unrelated-adapter"];
    },
    ({ plan: p }) => {
      p.typedData.message.zone = feeRecipient;
    },
    ({ plan: p }) => {
      p.typedData.message.conduitKey = `0x${"f".repeat(64)}`;
    },
    ({ plan: p }) => {
      p.typedData.domain.version = "1.5";
    },
    ({ plan: p }) => {
      p.typedData.domain.chainId = 8453;
    },
    ({ plan: p }) => {
      p.typedData.domain.verifyingContract = feeRecipient;
    },
    ({ plan: p }) => {
      p.typedData.domain.salt = ZERO_HASH;
    },
  ];
  for (const change of changes) check(fixture(change), "MISMATCH");
});
test("every original consideration, counter, zone hash, salt and interval binds the review", () => {
  const changes = [
    (p) => {
      p.counter = "8";
    },
    (p) => {
      p.zoneHash = `0x${"a".repeat(64)}`;
    },
    (p) => {
      p.salt = "2";
    },
    (p) => {
      p.consideration[1].recipient = address("4");
    },
    (p) => {
      p.consideration[0].startAmount = p.consideration[0].endAmount =
        "950000000000000000";
      p.consideration[1].startAmount = p.consideration[1].endAmount =
        "50000000000000000";
    },
    (p) => {
      p.startTime = String(seconds - 20);
    },
    (p) => {
      p.endTime = String(seconds + 3500);
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f.plan.typedData.message);
    check(f, "MISMATCH", "NFT_SALE_NATIVE_REVIEW_MISMATCH");
    f.reference.reviewDigest = kernelRequestDigest(f.plan);
    assert.equal(verifier(f)(f.reference, now).state, "MISMATCH");
  }
});
test("task, order and review expiry include exact boundaries, future and inverted intervals", () => {
  for (const change of [
    ({ plan }) => {
      plan.expiresAt = now;
    },
    ({ policy }) => {
      policy.expiresAt = String(seconds);
    },
    ({ policy }) => {
      policy.expiresAt = String(seconds + 3500);
    },
    ({ plan }) => {
      plan.orderExpiresAt++;
    },
    ({ plan }) => {
      plan.typedData.message.startTime = String(seconds + 1);
    },
    ({ plan }) => {
      plan.typedData.message.startTime = plan.typedData.message.endTime;
    },
  ])
    check(fixture(change), "MISMATCH");
  const f = fixture();
  for (const t of [undefined, -1, NaN, now + 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(verifier(f)(f.reference, t).state, "MISMATCH");
});
test("ERC1155 whole quantity and all recipients retain integer net accounting", () => {
  const f = fixture(({ policy, plan }) => {
    policy.intent.standard = "ERC-1155";
    policy.intent.quantity = "10";
    plan.scope.standard = "erc1155";
    plan.request.quantity = "10";
    plan.typedData.message.offer[0].itemType = 3;
    plan.typedData.message.offer[0].startAmount =
      plan.typedData.message.offer[0].endAmount = "10";
    plan.typedData.message.orderType = 1;
    const extra = {
      ...plan.typedData.message.consideration[1],
      recipient: seller,
      startAmount: "1000000000000000",
      endAmount: "1000000000000000",
    };
    plan.typedData.message.consideration.push(extra);
    plan.fees.push({ recipient: seller, amountWei: extra.startAmount });
    plan.request.priceWei = plan.orderTotalWei = "1001000000000000000";
  });
  const r = check(f, "MATCHED");
  assert.deepEqual(r.order.amounts, {
    gross: "1001000000000000000",
    fees: "25000000000000000",
    sellerNet: "976000000000000000",
  });
  assert.equal(r.order.feeRecipients.length, 1);
  assert.equal(r.order.components.consideration.length, 3);
});
test("actual parser rejects criteria, dynamic amounts, malformed uint and incomplete consideration", () => {
  const f = fixture();
  for (const mutate of [
    (p) => {
      p.offer[0].itemType = 4;
    },
    (p) => {
      p.offer[0].endAmount = "2";
    },
    (p) => {
      p.counter = "-1";
    },
    (p) => {
      p.counter = (1n << 256n).toString();
    },
    (p) => {
      p.offer[0].identifierOrCriteria = "01";
    },
    (p) => {
      p.consideration = [];
    },
    (p) => {
      delete p.consideration[1].recipient;
    },
  ]) {
    const changed = structuredClone(f);
    mutate(changed.plan.typedData.message);
    changed.reference.reviewDigest = kernelRequestDigest(changed.plan);
    assert.equal(verifier(changed)(changed.reference, now).state, "MISMATCH");
  }
});
test("trusted evidence/functions are pinned, output immutable, no implicit clock", () => {
  const f = fixture(),
    injected = { ...validation },
    engine = verifier(f, { validation: injected });
  f.plan.typedData.message.counter = "99";
  f.trustedQuote.rate = "1";
  injected.validateTypedData = () => {
    throw Error("replaced");
  };
  const a = engine(f.reference, now),
    b = engine(f.reference, now);
  assert.equal(a.state, "MATCHED");
  assert.deepEqual(a, b);
  assert.throws(() => {
    a.order.amounts.gross = "1";
  }, TypeError);
  assert.equal(engine(f.reference, now + 120000).state, "MISMATCH");
  assert.equal(
    verifier(f, { nativePlan: null })(f.reference, now).state,
    "EVIDENCE_REQUIRED",
  );
});

test("Base is supported without silently changing the chain or valuation pair", () => {
  const f = fixture(({ policy, plan, valuationPolicy, trustedQuote }) => {
    policy.chainId = "8453";
    plan.chainId = plan.typedData.domain.chainId = 8453;
    plan.scope.chain = "base";
    valuationPolicy.base.chainId = trustedQuote.base.chainId = "8453";
  });
  assert.equal(check(f, "MATCHED").order.chainId, "8453");
  check(
    fixture(({ policy }) => {
      policy.chainId = "560048";
    }),
    "MISMATCH",
  );
});

test("canonical EIP712 type fields cannot be reordered, extended or replaced", () => {
  for (const change of [
    (d) => {
      d.primaryType = "Permit";
    },
    (d) => {
      d.types.OrderComponents.reverse();
    },
    (d) => {
      d.types.OrderComponents[0].type = "bytes32";
    },
    (d) => {
      d.types.OrderComponents[0].extra = "malicious";
    },
    (d) => {
      d.types.Unused = [{ name: "value", type: "uint256" }];
    },
  ]) {
    const f = fixture();
    change(f.plan.typedData);
    f.reference.reviewDigest = kernelRequestDigest(f.plan);
    check(f, "MISMATCH", "NFT_SALE_ORDER_INVALID");
  }
});

test("missing reference fields and unsupported numeric coercions fail closed", () => {
  for (const field of [
    "taskDigest",
    "reviewDigest",
    "orderHash",
    "typedDataDigest",
    "nativePlanId",
    "nativeOperationId",
  ]) {
    const f = fixture();
    delete f.reference[field];
    check(f, "MISMATCH");
  }
  const f = fixture();
  for (const bad of [undefined, null, 0, [], {}])
    assert.equal(verifier(f)(bad, now).state, "MISMATCH");
  check(
    fixture(({ policy }) => {
      policy.intent.quantity = 1;
    }),
    "MISMATCH",
  );
  check(
    fixture(({ plan }) => {
      plan.expiresAt = String(now + 120000);
    }),
    "MISMATCH",
  );
});

test("normalized and original typed data must encode the same exact digest", () => {
  const f = fixture();
  f.plan.typedData.message.consideration[0].itemType = false;
  f.plan.orderHash = validation.orderHash(
    validation.components(f.plan.typedData.message),
  );
  f.reference.orderHash = f.plan.orderHash;
  f.reference.reviewDigest = kernelRequestDigest(f.plan);
  f.reference.typedDataDigest = ethers.TypedDataEncoder.hash(
    f.plan.typedData.domain,
    f.plan.typedData.types,
    validation.components(f.plan.typedData.message),
  );
  check(f, "MISMATCH", "NFT_SALE_ORDER_INVALID");
});

test("valuation and quote evidence have separate digests outside the frozen Wallet task", () => {
  const f = fixture(),
    initial = check(f, "MATCHED");
  assert.equal(initial.assessmentScope, "ORDER_REVIEW_ONLY");
  assert.equal(initial.valuationBinding, "EXTERNAL_TO_FROZEN_TASK");
  assert.equal(
    initial.order.binding.valuationPolicyDigest,
    kernelRequestDigest(f.valuationPolicy),
  );
  assert.equal(
    initial.order.binding.quoteEvidenceDigest,
    kernelRequestDigest(f.trustedQuote),
  );
  for (const change of [
    ({ valuationPolicy: p }) => {
      p.priceAt = "settlement";
    },
    ({ valuationPolicy: p, trustedQuote: q }) => {
      p.source = q.source = "other-reviewed-source";
    },
    ({ valuationPolicy: p }) => {
      p.validUntil = String(seconds + 120);
    },
    ({ valuationPolicy: p }) => {
      p.maxAgeSeconds = "45";
    },
  ]) {
    const changed = fixture(change);
    const r = verifier(changed)(changed.reference, now);
    assert.equal(r.order.binding.taskDigest, initial.order.binding.taskDigest);
    assert.equal(
      r.order.binding.reviewDigest,
      initial.order.binding.reviewDigest,
    );
    assert.notEqual(
      r.order.binding.valuationPolicyDigest,
      initial.order.binding.valuationPolicyDigest,
    );
    assert.equal(r.valuationBinding, "EXTERNAL_TO_FROZEN_TASK");
  }
  const changedQuote = fixture(({ trustedQuote: q }) => {
    q.rate = "210000000000";
  });
  const changedResult = check(changedQuote, "MATCHED");
  assert.equal(
    changedResult.order.binding.valuationPolicyDigest,
    initial.order.binding.valuationPolicyDigest,
  );
  assert.notEqual(
    changedResult.order.binding.quoteEvidenceDigest,
    initial.order.binding.quoteEvidenceDigest,
  );
  const missing = verifier(f, { valuationPolicy: null, trustedQuote: null })(
    f.reference,
    now,
  );
  assert.equal(missing.state, "EVIDENCE_REQUIRED");
  assert.equal(missing.order.binding.valuationPolicyDigest, null);
  assert.equal(missing.order.binding.quoteEvidenceDigest, null);
});
