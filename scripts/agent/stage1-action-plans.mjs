import {
  TEST_MODE,
  validRuntimeMode,
  validChainId,
} from "./runtime-profile.mjs";
import { compileNativeNftReference } from "./native-nft-reference.mjs";
import { kernelRequestDigest } from "./agent-kernel.mjs";
export const ACTION_BITS = Object.freeze({
  BUY: 1n,
  CREATE_ORDER: 2n,
  AMEND_ORDER: 4n,
  CANCEL_ORDER: 8n,
  BID: 16n,
  REBID: 32n,
  ACCEPT_OFFER: 64n,
  PARTIAL_FILL: 128n,
  SETTLE: 256n,
  CLAIM: 512n,
  REFUND: 1024n,
});
const fail = (code) => {
  throw Error(code);
};
export const uint = (value, positive = false) => {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) >= 2n ** 256n ||
    (positive && value === "0")
  )
    fail("ACTION_UINT_INVALID");
  return BigInt(value);
};
const exact = (value, keys) =>
  value &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const address = (value) =>
  typeof value === "string" &&
  /^0x[0-9a-fA-F]{40}$/.test(value) &&
  !/^0x0{40}$/i.test(value);
const hash = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const fields = (pairs) => pairs.map(([name, type]) => ({ name, type }));
// Exact existing Stage 1 schemas: ArtFiMarket.SaleIntent and WholeArtworkMarket.SaleIntent.
export const FRACTION_SALE_TYPES = {
  SaleIntent: fields([
    ["seller", "address"],
    ["assetToken", "address"],
    ["paymentToken", "address"],
    ["maxAmount", "uint256"],
    ["unitPrice", "uint256"],
    ["buyer", "address"],
    ["salt", "uint256"],
    ["startsAt", "uint48"],
    ["endsAt", "uint48"],
    ["epoch", "uint256"],
  ]),
};
export const WHOLE_SALE_TYPES = {
  SaleIntent: fields([
    ["seller", "address"],
    ["collection", "address"],
    ["tokenId", "uint256"],
    ["paymentToken", "address"],
    ["price", "uint256"],
    ["buyer", "address"],
    ["salt", "uint256"],
    ["startsAt", "uint48"],
    ["endsAt", "uint48"],
    ["epoch", "uint256"],
  ]),
};
export const STAGE1_ABI = Object.freeze({
  FRACTION: [
    "function fillIntent((address seller,address assetToken,address paymentToken,uint256 maxAmount,uint256 unitPrice,address buyer,uint256 salt,uint48 startsAt,uint48 endsAt,uint256 epoch),bytes,uint256)",
    "function revokeIntent((address seller,address assetToken,address paymentToken,uint256 maxAmount,uint256 unitPrice,address buyer,uint256 salt,uint48 startsAt,uint48 endsAt,uint256 epoch))",
  ],
  WHOLE: [
    "function fillIntent((address seller,address collection,uint256 tokenId,address paymentToken,uint256 price,address buyer,uint256 salt,uint48 startsAt,uint48 endsAt,uint256 epoch),bytes)",
    "function revokeIntent((address seller,address collection,uint256 tokenId,address paymentToken,uint256 price,address buyer,uint256 salt,uint48 startsAt,uint48 endsAt,uint256 epoch))",
  ],
  AUCTION: [
    "function createAuctionListing(bytes32 requestId,address assetToken,address paymentToken,uint256 amount,uint256 openingBid,uint48 startsAt,uint48 endsAt,uint256 reservePrice,uint256 minimumBidIncrement,uint48 extensionWindow,uint48 extensionDuration) returns(uint256)",
    "function placeBid(uint256 listingId,uint256 bidAmount)",
    "function cancelListing(uint256 listingId)",
    "function settleAuction(uint256 listingId)",
    "function withdrawCredit(address token)",
  ],
  OFFERING: [
    "function claimOffering(uint256 offeringId)",
    "function refundOffering(uint256 offeringId)",
  ],
});
function sale(request, terms, e, chainId) {
  const kind = request.marketKind,
    types = kind === "FRACTION" ? FRACTION_SALE_TYPES : WHOLE_SALE_TYPES;
  if (
    !exact(
      terms.intent,
      types.SaleIntent.map((x) => x.name),
    ) ||
    !/^0x[0-9a-fA-F]{130}$/.test(terms.signature ?? "")
  )
    fail("NATIVE_ORDER_SHAPE_INVALID");
  for (const field of types.SaleIntent) {
    const value = terms.intent[field.name];
    if (field.type.startsWith("uint")) {
      const n = uint(value);
      if (field.type === "uint48" && n >= 2n ** 48n)
        fail("NATIVE_ORDER_SHAPE_INVALID");
    } else if (!e.isAddress(value)) fail("NATIVE_ORDER_SHAPE_INVALID");
  }
  const intent = terms.intent,
    domain = {
      name:
        kind === "FRACTION"
          ? "ArtFi Fractions Market"
          : "ArtFi Whole Artwork Market",
      version: "1",
      chainId: Number(chainId),
      verifyingContract: request.market,
    };
  if (
    !same(
      e.verifyTypedData(domain, types, intent, terms.signature),
      intent.seller,
    ) ||
    !same(intent.paymentToken, request.paymentToken) ||
    !same(
      kind === "FRACTION" ? intent.assetToken : intent.collection,
      request.asset.contract,
    ) ||
    (kind === "WHOLE" && intent.tokenId !== request.asset.tokenId) ||
    (kind === "FRACTION" && request.asset.tokenId !== "0") ||
    !address(intent.seller) ||
    uint(intent.startsAt) >= uint(intent.endsAt)
  )
    fail("NATIVE_ORDER_BINDING_REFUSED");
  const price = kind === "FRACTION" ? intent.unitPrice : intent.price;
  uint(price, true);
  return {
    intent,
    signature: terms.signature,
    orderHash: e.TypedDataEncoder.hash(domain, types, intent),
    unitPrice: price,
    quantity: kind === "FRACTION" ? intent.maxAmount : "1",
  };
}
// Compiles closed, typed operations. No arbitrary calldata, arbitrary methods or
// privileged contract settings can be introduced by a model or HTTP request.
export function compileStage1Action(
  input,
  { ethers: e, chainId = "560048", nativePlan = null, mode = TEST_MODE },
) {
  const request = structuredClone(input);
  if (
    !exact(request, [
      "operationId",
      "action",
      "marketKind",
      "market",
      "wallet",
      "asset",
      "paymentToken",
      "terms",
    ]) ||
    !id(request.operationId) ||
    !Object.hasOwn(ACTION_BITS, request.action) ||
    !["FRACTION", "WHOLE", "AUCTION", "OFFERING", "NFT"].includes(
      request.marketKind,
    ) ||
    !address(request.market) ||
    !address(request.wallet) ||
    !address(request.paymentToken) ||
    !exact(request.asset, ["contract", "tokenId"]) ||
    !address(request.asset.contract)
  )
    fail("ACTION_REQUEST_INVALID");
  uint(request.asset.tokenId);
  const { action, marketKind: kind, terms: t } = request;
  if (!validRuntimeMode(mode) || !validChainId(chainId))
    fail("ACTION_PROFILE_INVALID");
  const common = {
    mode,
    chainId,
    wallet: request.wallet,
    market: request.market,
    marketKind: kind,
    asset: request.asset,
    paymentToken: request.paymentToken,
    action,
  };
  function leg(
    name,
    method,
    args,
    {
      price = "0",
      quantity = "0",
      value = "0",
      opensOrder = false,
      exit = false,
      counterparty = request.wallet,
      expected = {},
      orderKey = null,
      dependsOn = null,
    } = {},
  ) {
    uint(price);
    uint(quantity);
    uint(value);
    const dispatch = { kind: "CONTRACT_CALL", method, args };
    const abi = STAGE1_ABI[kind];
    if (!abi) fail("NATIVE_NFT_EXECUTION_ADAPTER_REQUIRED");
    const callData = new e.Interface(abi).encodeFunctionData(method, args);
    return {
      ...common,
      name,
      dispatch,
      callHash: e.keccak256(callData),
      transactionValue: "0",
      unitPrice: price,
      quantity,
      value,
      opensOrder,
      exit,
      counterparty,
      expected,
      orderKey,
      dependsOn,
    };
  }
  function orderLeg(s, name = "PUBLISH", dependsOn = null) {
    if (!same(s.intent.seller, request.wallet)) fail("ORDER_SELLER_MISMATCH");
    const value = (uint(s.unitPrice) * uint(s.quantity, true)).toString();
    uint(value, true);
    const dispatch = {
      kind: "SIGNED_ORDER_PUBLICATION",
      method: "publishSignedOrder",
      args: {
        kind,
        chainId,
        market: request.market,
        intent: s.intent,
        signature: s.signature,
        intentHash: s.orderHash,
      },
    };
    return {
      ...common,
      name,
      dispatch,
      callHash: kernelRequestDigest(dispatch),
      unitPrice: s.unitPrice,
      quantity: s.quantity,
      value,
      opensOrder: true,
      exit: false,
      counterparty:
        s.intent.buyer === e.ZeroAddress ? request.wallet : s.intent.buyer,
      orderKey: s.orderHash,
      dependsOn,
      expected: {
        name: "SignedOrderPublished",
        args: { intentHash: s.orderHash, seller: request.wallet },
        startsAt: s.intent.startsAt,
        endsAt: s.intent.endsAt,
      },
    };
  }
  let legs;
  if (["FRACTION", "WHOLE"].includes(kind)) {
    if (["BUY", "PARTIAL_FILL"].includes(action)) {
      if (!exact(t, ["intent", "signature", "quantity"]))
        fail("ACTION_TERMS_INVALID");
      const s = sale(request, t, e, chainId);
      const qty = uint(t.quantity, true);
      if (
        (kind === "WHOLE" && (qty !== 1n || action === "PARTIAL_FILL")) ||
        (kind === "FRACTION" && qty > uint(s.quantity)) ||
        same(s.intent.seller, request.wallet) ||
        (!same(s.intent.buyer, e.ZeroAddress) &&
          !same(s.intent.buyer, request.wallet))
      )
        fail("ORDER_FILL_SCOPE_REFUSED");
      const value = (qty * uint(s.unitPrice)).toString();
      uint(value, true);
      legs = [
        leg(
          "FILL",
          "fillIntent",
          kind === "FRACTION"
            ? [s.intent, s.signature, t.quantity]
            : [s.intent, s.signature],
          {
            price: s.unitPrice,
            quantity: t.quantity,
            value,
            counterparty: s.intent.seller,
            orderKey: s.orderHash,
            expected: {
              name: kind === "FRACTION" ? "IntentFilled" : "SaleSettled",
              args:
                kind === "FRACTION"
                  ? {
                      intentHash: s.orderHash,
                      seller: s.intent.seller,
                      buyer: request.wallet,
                      amount: t.quantity,
                      payment: value,
                    }
                  : {
                      intentHash: s.orderHash,
                      seller: s.intent.seller,
                      buyer: request.wallet,
                      collection: request.asset.contract,
                      tokenId: request.asset.tokenId,
                      paymentToken: request.paymentToken,
                      price: value,
                    },
              startsAt: s.intent.startsAt,
              endsAt: s.intent.endsAt,
              maxAmount: s.quantity,
            },
          },
        ),
      ];
    } else if (action === "CREATE_ORDER") {
      if (!exact(t, ["intent", "signature"])) fail("ACTION_TERMS_INVALID");
      legs = [orderLeg(sale(request, t, e, chainId))];
    } else if (action === "CANCEL_ORDER") {
      if (!exact(t, ["intent", "signature"])) fail("ACTION_TERMS_INVALID");
      const s = sale(request, t, e, chainId);
      if (!same(s.intent.seller, request.wallet)) fail("ORDER_SELLER_MISMATCH");
      legs = [
        leg("REVOKE", "revokeIntent", [s.intent], {
          exit: true,
          orderKey: s.orderHash,
          expected: {
            name: kind === "FRACTION" ? "IntentRevoked" : "SaleIntentRevoked",
            args: { intentHash: s.orderHash, seller: request.wallet },
          },
        }),
      ];
    } else if (action === "AMEND_ORDER") {
      if (!exact(t, ["original", "replacement"])) fail("ACTION_TERMS_INVALID");
      const original = sale(request, t.original, e, chainId),
        replacement = sale(request, t.replacement, e, chainId);
      if (
        !same(original.intent.seller, request.wallet) ||
        original.orderHash === replacement.orderHash ||
        original.intent.salt === replacement.intent.salt
      )
        fail("AMENDMENT_BINDING_REFUSED");
      legs = [
        leg("RETIRE", "revokeIntent", [original.intent], {
          exit: true,
          orderKey: original.orderHash,
          expected: {
            name: kind === "FRACTION" ? "IntentRevoked" : "SaleIntentRevoked",
            args: { intentHash: original.orderHash, seller: request.wallet },
          },
        }),
        orderLeg(replacement, "REPLACE", "RETIRE"),
      ];
    } else fail("ACTION_MARKET_UNSUPPORTED");
  } else if (kind === "AUCTION") {
    if (action === "CREATE_ORDER") {
      const keys = [
        "requestId",
        "amount",
        "openingBid",
        "startsAt",
        "endsAt",
        "reservePrice",
        "minimumBidIncrement",
        "extensionWindow",
        "extensionDuration",
      ];
      if (!exact(t, keys) || !hash(t.requestId)) fail("ACTION_TERMS_INVALID");
      for (const key of keys.slice(1))
        uint(t[key], !["reservePrice", "startsAt"].includes(key));
      if (
        ["startsAt", "endsAt", "extensionWindow", "extensionDuration"].some(
          (key) => uint(t[key]) >= 2n ** 48n,
        ) ||
        uint(t.startsAt) >= uint(t.endsAt)
      )
        fail("AUCTION_WINDOW_INVALID");
      legs = [
        leg(
          "CREATE",
          "createAuctionListing",
          [
            t.requestId,
            request.asset.contract,
            request.paymentToken,
            ...keys.slice(1).map((key) => t[key]),
          ],
          {
            price: (
              (uint(t.openingBid) + uint(t.amount) - 1n) /
              uint(t.amount)
            ).toString(),
            quantity: t.amount,
            value: t.openingBid,
            opensOrder: true,
            orderKey: t.requestId,
            expected: {
              name: "ListingCreated",
              args: { requestId: t.requestId, seller: request.wallet },
              startsAt: t.startsAt,
              endsAt: t.endsAt,
            },
          },
        ),
      ];
    } else if (["BID", "REBID"].includes(action)) {
      if (!exact(t, ["listingId", "bidAmount", "seller"]))
        fail("ACTION_TERMS_INVALID");
      uint(t.listingId, true);
      uint(t.bidAmount, true);
      if (!address(t.seller) || same(t.seller, request.wallet))
        fail("BID_SELLER_REFUSED");
      legs = [
        leg("BID", "placeBid", [t.listingId, t.bidAmount], {
          price: t.bidAmount,
          quantity: "1",
          value: t.bidAmount,
          counterparty: t.seller,
          orderKey: t.listingId,
          expected: {
            name: "BidPlaced",
            args: {
              listingId: t.listingId,
              bidder: request.wallet,
              amount: t.bidAmount,
            },
          },
        }),
      ];
    } else if (action === "CANCEL_ORDER") {
      if (!exact(t, ["listingId"])) fail("ACTION_TERMS_INVALID");
      uint(t.listingId, true);
      legs = [
        leg("CANCEL", "cancelListing", [t.listingId], {
          exit: true,
          orderKey: t.listingId,
          expected: {
            name: "ListingCancelled",
            args: { listingId: t.listingId },
          },
        }),
      ];
    } else if (action === "SETTLE") {
      if (!exact(t, ["listingId", "buyer", "payment"]))
        fail("ACTION_TERMS_INVALID");
      uint(t.listingId, true);
      uint(t.payment);
      if (!e.isAddress(t.buyer)) fail("ACTION_TERMS_INVALID");
      legs = [
        leg("SETTLE", "settleAuction", [t.listingId], {
          exit: true,
          orderKey: t.listingId,
          expected: {
            name: "ListingSettled",
            args: {
              listingId: t.listingId,
              buyer: t.buyer,
              payment: t.payment,
            },
          },
        }),
      ];
    } else if (action === "REFUND") {
      if (!exact(t, ["amount"])) fail("ACTION_TERMS_INVALID");
      uint(t.amount, true);
      legs = [
        leg("WITHDRAW_CREDIT", "withdrawCredit", [request.paymentToken], {
          exit: true,
          expected: {
            name: "CreditWithdrawn",
            args: {
              account: request.wallet,
              token: request.paymentToken,
              amount: t.amount,
            },
          },
        }),
      ];
    } else fail("ACTION_MARKET_UNSUPPORTED");
  } else if (kind === "OFFERING") {
    if (
      !["CLAIM", "REFUND"].includes(action) ||
      !exact(t, ["offeringId", "amount"])
    )
      fail("ACTION_MARKET_UNSUPPORTED");
    uint(t.offeringId, true);
    uint(t.amount, true);
    legs = [
      leg(
        action,
        action === "CLAIM" ? "claimOffering" : "refundOffering",
        [t.offeringId],
        {
          exit: true,
          orderKey: t.offeringId,
          expected: {
            name: action === "CLAIM" ? "OfferingClaimed" : "OfferingRefunded",
            args: {
              offeringId: t.offeringId,
              account: request.wallet,
              amount: t.amount,
            },
          },
        },
      ),
    ];
  } else {
    // Existing native OpenSea workflow is list/offer/buy/accept/cancel and has its
    // own SDK, chain and receipt verifier. No ABI or delegated signer is invented.
    legs = [
      compileNativeNftReference(request, nativePlan, {
        ethers: e,
        chainId,
        mode,
      }),
    ];
  }
  const plan = { ...common, operationId: request.operationId, request, legs };
  return Object.freeze({ ...plan, digest: kernelRequestDigest(plan) });
}
