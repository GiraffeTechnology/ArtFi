import "server-only";
import { Interface, TypedDataEncoder } from "ethers";
import { SeaportABI } from "@opensea/seaport-js/lib/abi/Seaport";
import { EIP_712_ORDER_TYPE } from "@opensea/seaport-js/lib/constants";
import { getDefaultConduit, getSignedZone, Chain } from "@opensea/sdk";
import { isAddress, type Hex } from "viem";
import { SEAPORT, WETH, ZERO } from "./config";
import {
  NFT_CHAINS,
  equalAddress,
  fail,
  object,
  uint,
  type NftRequest,
  type NftScope,
  type NftTransaction,
  type NftTypedData,
} from "./model";

export type Item = {
  itemType: number;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
  recipient?: string;
};
export type Components = {
  offerer: string;
  zone: string;
  offer: Item[];
  consideration: Item[];
  orderType: number;
  startTime: string;
  endTime: string;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  counter: string;
};
const seaport = new Interface(SeaportABI);
const approvals = new Interface([
  "function approve(address spender,uint256 amount)",
  "function setApprovalForAll(address operator,bool approved)",
]);
const hex32 = /^0x[0-9a-fA-F]{64}$/;
export function sdkChain(scope: NftScope) {
  return scope.chain === "ethereum" ? Chain.Mainnet : Chain.Base;
}
export function item(value: unknown): Item {
  const raw = object(fromResult(value));
  const type = Number(raw.itemType);
  if (
    ![0, 1, 2, 3].includes(type) ||
    typeof raw.token !== "string" ||
    !isAddress(raw.token)
  )
    fail("Unsupported order asset or criteria.");
  const result: Item = {
    itemType: type,
    token: raw.token,
    identifierOrCriteria: uint(String(raw.identifierOrCriteria)),
    startAmount: uint(String(raw.startAmount), true),
    endAmount: uint(String(raw.endAmount), true),
  };
  if (result.startAmount !== result.endAmount)
    fail("Dynamic-price orders are unavailable in this workflow.");
  if (raw.recipient !== undefined) {
    if (
      typeof raw.recipient !== "string" ||
      !isAddress(raw.recipient) ||
      equalAddress(raw.recipient, ZERO)
    )
      fail("Invalid order recipient.");
    result.recipient = raw.recipient;
  }
  return result;
}
export function components(value: unknown): Components {
  const p = object(fromResult(value));
  if (
    !Array.isArray(p.offer) ||
    !Array.isArray(p.consideration) ||
    p.offer.length !== 1 ||
    p.consideration.length < 1 ||
    p.consideration.length > 20 ||
    typeof p.offerer !== "string" ||
    !isAddress(p.offerer) ||
    equalAddress(p.offerer, ZERO) ||
    typeof p.zone !== "string" ||
    !isAddress(p.zone) ||
    ![0, 1, 2, 3].includes(Number(p.orderType)) ||
    !hex32.test(String(p.zoneHash)) ||
    !hex32.test(String(p.conduitKey))
  )
    fail("Unsupported Seaport order.");
  return {
    offerer: p.offerer,
    zone: p.zone,
    offer: p.offer.map(item),
    consideration: p.consideration.map((value) => {
      const result = item(value);
      if (!result.recipient) fail("Missing consideration recipient.");
      return result;
    }),
    orderType: Number(p.orderType),
    startTime: uint(String(p.startTime)),
    endTime: uint(String(p.endTime)),
    zoneHash: String(p.zoneHash),
    salt: uint(
      /^0x[0-9a-fA-F]{1,64}$/.test(String(p.salt))
        ? BigInt(String(p.salt)).toString()
        : String(p.salt),
    ),
    conduitKey: String(p.conduitKey),
    counter: uint(String(p.counter)),
  };
}
export function orderHash(p: Components): Hex {
  return TypedDataEncoder.hashStruct(
    "OrderComponents",
    EIP_712_ORDER_TYPE,
    p,
  ) as Hex;
}
export function validateComponents(
  p: Components,
  request: NftRequest,
  scope: NftScope,
  creating: boolean,
  now = Date.now(),
) {
  const listing =
    request.action === "list" ||
    request.action === "buy" ||
    (request.action === "cancel" && p.offer[0].itemType >= 2);
  const nft = listing ? p.offer[0] : p.consideration[0];
  const payment = listing ? p.consideration : p.offer;
  if (
    nft.itemType !== (scope.standard === "erc721" ? 2 : 3) ||
    !equalAddress(nft.token, scope.contract) ||
    nft.identifierOrCriteria !== request.tokenId ||
    (scope.standard === "erc721" && nft.startAmount !== "1") ||
    BigInt(nft.startAmount) < BigInt(request.quantity) ||
    (creating && nft.startAmount !== request.quantity)
  )
    fail("The order does not match the selected NFT and quantity.");
  if (
    (!equalAddress(p.zone, ZERO) &&
      !equalAddress(p.zone, getSignedZone(sdkChain(scope)))) ||
    ![
      getDefaultConduit(sdkChain(scope)).key.toLowerCase(),
      "0x" + "0".repeat(64),
    ].includes(p.conduitKey.toLowerCase())
  )
    fail("Unsupported order zone or conduit.");
  if (
    creating &&
    (!equalAddress(p.offerer, request.account) ||
      Number(p.endTime) !== request.expiresAt)
  )
    fail("The signing request changed the maker or expiry.");
  if (request.action === "cancel" && !equalAddress(p.offerer, request.account))
    fail("Only the order maker can cancel this order.", 403);
  if (
    request.action !== "cancel" &&
    (BigInt(p.endTime) <= BigInt(Math.floor(now / 1000)) ||
      (!creating && BigInt(p.startTime) > BigInt(Math.floor(now / 1000))))
  )
    fail("This order is expired or has not started.", 409);
  if (!listing && !equalAddress(nft.recipient, p.offerer))
    fail("The offer NFT recipient is invalid.");
  const currency = listing ? ZERO : WETH[scope.chain];
  for (const value of payment)
    if (
      value.itemType !== (listing ? 0 : 1) ||
      !equalAddress(value.token, currency) ||
      value.identifierOrCriteria !== "0"
    )
      fail("This workflow supports ETH listings and WETH offers.");
  if (listing && !equalAddress(p.consideration[0].recipient, p.offerer))
    fail("The listing proceeds are not bound to the seller.");
  if (!listing)
    for (const fee of p.consideration.slice(1))
      if (
        fee.itemType !== 1 ||
        !equalAddress(fee.token, currency) ||
        fee.identifierOrCriteria !== "0"
      )
        fail("Unsupported offer fee.");
  const total = payment.reduce(
    (sum, value) => sum + BigInt(value.startAmount),
    0n,
  );
  const feeTotal = p.consideration
    .slice(1)
    .reduce((sum, value) => sum + BigInt(value.startAmount), 0n);
  if (feeTotal >= total) fail("Invalid venue fees.");
  const quantity = BigInt(request.quantity),
    size = BigInt(nft.startAmount);
  // Exact integral fills avoid hidden rounding in the customer's approved amount.
  if (
    request.action !== "cancel" &&
    [...p.offer, ...p.consideration].some(
      (value) => (BigInt(value.startAmount) * quantity) % size !== 0n,
    )
  )
    fail("This quantity cannot be filled without amount rounding.");
  if (request.action !== "cancel" && quantity < size && p.orderType % 2 === 0)
    fail("This order does not permit partial fills.");
  const fillTotal = (total * quantity) / size;
  if (
    request.action !== "cancel" &&
    (fillTotal > BigInt(request.priceWei) ||
      (!creating && fillTotal !== BigInt(request.priceWei)) ||
      (creating &&
        BigInt(request.priceWei) - fillTotal > BigInt(payment.length)))
  )
    fail("The venue price changed. Review the refreshed order.", 409);
  return {
    listing,
    nft,
    currency,
    total: fillTotal,
    fees: p.consideration.slice(1).map((value) => ({
      recipient: value.recipient!,
      amountWei: ((BigInt(value.startAmount) * quantity) / size).toString(),
    })),
  };
}
function sameTypedDataTypes(types: NftTypedData["types"]) {
  const expected = EIP_712_ORDER_TYPE as NftTypedData["types"];
  const names = Object.keys(expected);
  return (
    Object.keys(types).length === names.length &&
    names.every(
      (name) =>
        Array.isArray(types[name]) &&
        types[name].length === expected[name].length &&
        types[name].every(
          (field, index) =>
            Object.keys(field).length === 2 &&
            field.name === expected[name][index].name &&
            field.type === expected[name][index].type,
        ),
    )
  );
}

export function validateTypedData(
  data: NftTypedData,
  request: NftRequest,
  scope: NftScope,
  now = Date.now(),
) {
  if (
    data.primaryType !== "OrderComponents" ||
    data.domain.name !== "Seaport" ||
    data.domain.version !== "1.6" ||
    data.domain.chainId !== NFT_CHAINS[scope.chain] ||
    !equalAddress(data.domain.verifyingContract, SEAPORT) ||
    !sameTypedDataTypes(data.types)
  )
    fail("Unexpected Seaport signing domain or schema.");
  const p = components(data.message);
  validateComponents(p, request, scope, true, now);
  return p;
}
function fromResult(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "toObject" in value &&
    typeof value.toObject === "function"
  )
    return value.toObject(false);
  return value;
}
function assertSameOrder(
  value: unknown,
  expected: Components,
  requireOriginalCount = false,
) {
  const raw = object(fromResult(value));
  if (
    requireOriginalCount &&
    String(raw.totalOriginalConsiderationItems) !==
      String(expected.consideration.length)
  )
    fail("The fulfillment changed the signed consideration count.");
  const candidate = components({
    ...raw,
    counter: expected.counter,
  });
  if (orderHash(candidate) !== orderHash(expected))
    fail("The fulfillment changed the selected order.");
}
export function validateTransaction(
  tx: NftTransaction,
  request: NftRequest,
  scope: NftScope,
  expected?: Components,
) {
  uint(tx.value);
  if (!/^0x[0-9a-fA-F]+$/.test(tx.data) || tx.data.length > 131074)
    fail("Invalid transaction calldata.");
  const conduit = getDefaultConduit(sdkChain(scope)).address;
  if (!equalAddress(tx.to, SEAPORT)) {
    if (tx.value !== "0") fail("An approval cannot send native currency.");
    const decoded = approvals.parseTransaction({ data: tx.data });
    if (
      !decoded ||
      ![conduit, SEAPORT].some((value) => equalAddress(decoded.args[0], value))
    )
      fail("Unexpected approval spender.");
    if (
      equalAddress(tx.to, scope.contract) &&
      ["list", "accept"].includes(request.action)
    ) {
      if (scope.standard === "erc721") {
        // Replace collection-wide permission with the selected token approval.
        return {
          ...tx,
          data: approvals.encodeFunctionData("approve", [
            decoded.args[0],
            request.tokenId,
          ]) as Hex,
        };
      }
      if (decoded.name !== "setApprovalForAll" || decoded.args[1] !== true)
        fail("Invalid NFT approval.");
      return tx;
    }
    if (
      equalAddress(tx.to, WETH[scope.chain]) &&
      request.action === "offer" &&
      decoded.name === "approve"
    )
      return {
        ...tx,
        data: approvals.encodeFunctionData("approve", [
          decoded.args[0],
          request.priceWei,
        ]) as Hex,
      };
    fail("The approval is unrelated to this NFT action.");
  }
  if (!expected) fail("The transaction has no canonical order binding.");
  const decoded = seaport.parseTransaction({ data: tx.data, value: tx.value });
  if (!decoded) fail("Unknown Seaport transaction.");
  const terms = validateComponents(expected, request, scope, false);
  if (request.action === "cancel") {
    if (
      decoded.name !== "cancel" ||
      decoded.args[0].length !== 1 ||
      tx.value !== "0"
    )
      fail("Invalid cancellation transaction.");
    assertSameOrder(decoded.args[0][0], expected);
    return tx;
  }
  if (BigInt(tx.value) !== (terms.listing ? terms.total : 0n))
    fail("The fulfillment changed the approved native amount.");
  if (decoded.name === "fulfillOrder") {
    assertSameOrder(decoded.args[0].parameters, expected, true);
    if (
      ![getDefaultConduit(sdkChain(scope)).key, "0x" + "0".repeat(64)].includes(
        String(decoded.args[1]),
      )
    )
      fail("Unexpected fulfiller conduit.");
    if (request.quantity !== terms.nft.startAmount)
      fail("This transaction cannot partially fill the order.");
  } else if (decoded.name === "fulfillAdvancedOrder") {
    const advanced = decoded.args[0];
    assertSameOrder(advanced.parameters, expected, true);
    if (
      ![getDefaultConduit(sdkChain(scope)).key, "0x" + "0".repeat(64)].includes(
        String(decoded.args[2]),
      )
    )
      fail("Unexpected fulfiller conduit.");
    if (
      BigInt(advanced.numerator) <= 0n ||
      BigInt(advanced.denominator) <= 0n ||
      BigInt(advanced.numerator) > BigInt(advanced.denominator) ||
      decoded.args[1].length !== 0 ||
      (!equalAddress(decoded.args[3], request.account) &&
        !equalAddress(decoded.args[3], ZERO)) ||
      BigInt(advanced.numerator) * BigInt(terms.nft.startAmount) !==
        BigInt(advanced.denominator) * BigInt(request.quantity)
    )
      fail("Invalid partial-fill quantity or recipient.");
  } else if (
    decoded.name === "fulfillBasicOrder" ||
    decoded.name === "fulfillBasicOrder_efficient_6GL6yc"
  ) {
    const p = decoded.args[0];
    const primary = expected.consideration[0];
    if (
      ![getDefaultConduit(sdkChain(scope)).key, "0x" + "0".repeat(64)].includes(
        String(p.fulfillerConduitKey),
      )
    )
      fail("Unexpected fulfiller conduit.");
    if (
      !equalAddress(p.offerer, expected.offerer) ||
      !equalAddress(p.zone, expected.zone) ||
      !equalAddress(p.offerToken, expected.offer[0].token) ||
      String(p.offerIdentifier) !== expected.offer[0].identifierOrCriteria ||
      String(p.offerAmount) !== expected.offer[0].startAmount ||
      !equalAddress(p.considerationToken, primary.token) ||
      String(p.considerationIdentifier) !== primary.identifierOrCriteria ||
      String(p.considerationAmount) !== primary.startAmount ||
      String(p.startTime) !== expected.startTime ||
      String(p.endTime) !== expected.endTime ||
      String(p.salt) !== expected.salt ||
      p.zoneHash !== expected.zoneHash ||
      p.offererConduitKey !== expected.conduitKey ||
      p.additionalRecipients.length !== expected.consideration.length - 1 ||
      String(p.totalOriginalAdditionalRecipients) !==
        String(expected.consideration.length - 1) ||
      request.quantity !== terms.nft.startAmount
    )
      fail("The basic fulfillment changed the selected terms.");
    p.additionalRecipients.forEach(
      (fee: { recipient: string; amount: bigint }, index: number) => {
        const want = expected.consideration[index + 1];
        if (
          !equalAddress(fee.recipient, want.recipient) ||
          String(fee.amount) !== want.startAmount
        )
          fail("The fulfillment changed the fee recipients.");
      },
    );
    const route = terms.listing
      ? scope.standard === "erc721"
        ? 0
        : 1
      : scope.standard === "erc721"
        ? 4
        : 5;
    if (Number(p.basicOrderType) !== route * 4 + expected.orderType)
      fail("Unexpected settlement route.");
  } else fail("This Seaport settlement method is unavailable.");
  return tx;
}
