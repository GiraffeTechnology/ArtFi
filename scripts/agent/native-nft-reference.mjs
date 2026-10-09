import { kernelRequestDigest } from "./agent-kernel.mjs";
import { uint } from "./stage1-action-plans.mjs";
const fail = (code) => {
  throw Error(code);
};
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const hash = (x) => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
// The plan is obtained by the fixed trusted Stage 1 plan reader, never copied
// from the caller's body. The official Stage 1 SDK remains responsible for
// validateComponents/validateTransaction and canonical venue order lookup.
// This adapter adds bounded-intent binding; it does not create wallet authority.
export function compileNativeNftReference(
  request,
  nativePlan,
  { ethers: e, chainId, mode },
) {
  const p = structuredClone(nativePlan),
    r = p?.request;
  if (
    !request.terms ||
    Object.keys(request.terms).join(",") !== "nativeOperationId" ||
    typeof request.terms.nativeOperationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(request.terms.nativeOperationId)
  )
    fail("NATIVE_NFT_REFERENCE_INVALID");
  if (!p) fail("NATIVE_NFT_EXECUTION_ADAPTER_REQUIRED");
  const expectedActions = {
    BUY: ["buy"],
    CREATE_ORDER: ["list", "offer"],
    CANCEL_ORDER: ["cancel"],
    ACCEPT_OFFER: ["accept"],
  };
  if (
    !expectedActions[request.action]?.includes(r?.action) ||
    p.operationId !== request.terms.nativeOperationId ||
    !p.id ||
    String(p.chainId) !== chainId ||
    !["1", "8453"].includes(chainId) ||
    { ethereum: 1, base: 8453 }[p.scope?.chain] !== p.chainId ||
    !same(p.scope?.contract, request.asset.contract) ||
    p.scope.slug !== r.collection ||
    r.tokenId !== request.asset.tokenId ||
    !same(r.account, request.wallet) ||
    !["erc721", "erc1155"].includes(p.scope.standard) ||
    !hash(p.orderHash) ||
    !Number.isSafeInteger(p.expiresAt) ||
    !Number.isSafeInteger(p.orderExpiresAt)
  )
    fail("NATIVE_NFT_PLAN_BINDING_REFUSED");
  const quantity = uint(r.quantity, true);
  if (quantity > 1000000n || (p.scope.standard === "erc721" && quantity !== 1n))
    fail("NATIVE_NFT_QUANTITY_REFUSED");
  if (p.kind === "approval") fail("NATIVE_NFT_APPROVAL_AUTHORITY_UNAVAILABLE");
  const creating = ["list", "offer"].includes(r.action),
    cancel = r.action === "cancel";
  const total = cancel ? 0n : uint(p.orderTotalWei, true);
  uint(r.priceWei);
  if (
    !Array.isArray(p.fees) ||
    p.fees.some(
      (fee) => !e.isAddress(fee.recipient) || typeof fee.amountWei !== "string",
    )
  )
    fail("NATIVE_NFT_FEES_UNVERIFIED");
  if (
    p.fees.reduce((sum, fee) => sum + uint(fee.amountWei), 0n) > total &&
    !cancel
  )
    fail("NATIVE_NFT_FEES_UNVERIFIED");
  if (creating) {
    if (
      p.kind !== "signature" ||
      p.typedData?.primaryType !== "OrderComponents" ||
      p.typedData.domain?.name !== "Seaport" ||
      String(p.typedData.domain.chainId) !== chainId ||
      !same(p.typedData.domain.verifyingContract, request.market) ||
      !same(p.typedData.message?.offerer, request.wallet)
    )
      fail("NATIVE_NFT_PLAN_BINDING_REFUSED");
  } else if (
    p.kind !== "transaction" ||
    !same(p.transaction?.to, request.market) ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(p.transaction.data ?? "") ||
    p.transaction.data.length > 131072 ||
    !same(r.orderHash, p.orderHash)
  )
    fail("NATIVE_NFT_PLAN_BINDING_REFUSED");
  if (!creating) uint(p.transaction.value);
  const reviewDigest = kernelRequestDigest(p);
  const dispatch = {
    kind: creating ? "NATIVE_NFT_SIGNATURE" : "NATIVE_NFT_TRANSACTION",
    method: r.action,
    args: {
      nativeOperationId: p.operationId,
      nativePlanId: p.id,
      reviewDigest,
    },
  };
  return {
    mode,
    chainId,
    wallet: request.wallet,
    market: request.market,
    marketKind: "NFT",
    asset: request.asset,
    paymentToken: request.paymentToken,
    action: request.action,
    name: creating ? "PUBLISH_NFT" : cancel ? "CANCEL_NFT" : "FILL_NFT",
    dispatch,
    callHash: creating
      ? kernelRequestDigest(dispatch)
      : e.keccak256(p.transaction.data),
    transactionValue: creating ? "0" : p.transaction.value,
    nativeReviewDigest: reviewDigest,
    nativePlanExpiresAt: p.expiresAt,
    nativeAction: r.action,
    unitPrice:
      total === 0n ? "0" : ((total + quantity - 1n) / quantity).toString(),
    quantity: cancel ? "0" : r.quantity,
    value: total.toString(),
    opensOrder: creating,
    exit: cancel,
    counterparty: request.wallet,
    orderKey: p.orderHash,
    dependsOn: null,
    expected: {
      name: creating
        ? "NativeNftOrderVisible"
        : cancel
          ? "OrderCancelled"
          : "OrderFulfilled",
      args: {
        orderHash: p.orderHash,
        ...(!creating && !cancel ? { recipient: request.wallet } : {}),
      },
      startsAt: "0",
      endsAt: String(p.orderExpiresAt),
    },
  };
}
