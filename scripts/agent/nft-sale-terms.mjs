import { kernelRequestDigest } from "./agent-kernel.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const uint256 = (value, positive = false) => {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
    BigInt(value) >= 1n << 256n ||
    (positive && value === "0")
  )
    throw Error("NFT_SALE_INTEGER_INVALID");
  return BigInt(value);
};
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const hash = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const refuse = (condition, reason) => {
  if (!condition) throw Error(reason);
};
const failure = (state, reason) => freeze({ state, reason });
const decimals = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 36;

function usdEvaluation(minimum, policy, quote, order, now) {
  if (!minimum || !policy || !quote)
    return failure("EVIDENCE_REQUIRED", "USD_PRICE_EVIDENCE_REQUIRED");
  try {
    refuse(
      minimum.currency === "USD" &&
        minimum.minorUnit === 2 &&
        ["gt", "gte"].includes(minimum.comparison) &&
        ["gross", "net"].includes(minimum.basis),
      "USD_MINIMUM_POLICY_INVALID",
    );
    const threshold = uint256(minimum.amountMinor, true);
    // Source identity, pair, precision and time policy come from trusted
    // composition, never from a caller's proceedsMinor or quote reference.
    refuse(
      typeof policy.source === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(policy.source) &&
        quote.source === policy.source &&
        policy.base?.chainId === order.chainId &&
        same(policy.base?.token, order.payment.token) &&
        policy.base?.decimals === order.payment.decimals &&
        quote.base?.chainId === policy.base.chainId &&
        same(quote.base?.token, policy.base.token) &&
        quote.base?.decimals === policy.base.decimals &&
        policy.quote?.currency === "USD" &&
        policy.quote?.decimals === minimum.minorUnit &&
        quote.quote?.currency === policy.quote.currency &&
        quote.quote?.decimals === policy.quote.decimals &&
        decimals(policy.rateDecimals) &&
        quote.rateDecimals === policy.rateDecimals &&
        ["order-review", "settlement"].includes(policy.priceAt),
      "USD_QUOTE_POLICY_MISMATCH",
    );
    const validFrom = uint256(policy.validFrom),
      validUntil = uint256(policy.validUntil, true),
      maximumAge = uint256(policy.maxAgeSeconds, true),
      observedAt = uint256(quote.observedAt),
      expiresAt = uint256(quote.expiresAt, true),
      rate = uint256(quote.rate, true);
    refuse(
      validFrom <= now &&
        now < validUntil &&
        validFrom <= observedAt &&
        observedAt <= now &&
        now - observedAt <= maximumAge &&
        now < expiresAt &&
        observedAt < expiresAt &&
        expiresAt <= validUntil,
      "USD_QUOTE_STALE_OR_OUTSIDE_POLICY",
    );
    if (policy.priceAt === "settlement")
      return failure("EVIDENCE_REQUIRED", "FUTURE_USD_PRICE_NOT_GUARANTEED");
    const amount = BigInt(
        minimum.basis === "gross"
          ? order.amounts.gross
          : order.amounts.sellerNet,
      ),
      numerator = amount * rate * 10n ** BigInt(minimum.minorUnit),
      denominator =
        10n ** BigInt(order.payment.decimals) *
        10n ** BigInt(policy.rateDecimals),
      target = threshold * denominator,
      matches =
        minimum.comparison === "gt" ? numerator > target : numerator >= target;
    return freeze({
      state: matches ? "MATCHED" : "MISMATCH",
      reason: matches ? "USD_REVIEW_QUOTE_MATCHED" : "USD_MINIMUM_NOT_MET",
      priceAt: "order-review",
      basis: minimum.basis,
      source: quote.source,
      observedAt: quote.observedAt,
      expiresAt: quote.expiresAt,
      // Floor is presentation only. Compare the exact rational without rounding.
      amountMinorFloor: (numerator / denominator).toString(),
      numerator: numerator.toString(),
      denominator: denominator.toString(),
      futureSettlementUsd: "NOT_GUARANTEED",
    });
  } catch (error) {
    return failure("EVIDENCE_REQUIRED", error.message);
  }
}

/**
 * Pure proposal comparison, with dependencies and evidence supplied ONLY by the
 * trusted composition root. Use the original Stage 1 plan reader and Wallet's
 * already-normalized FrozenTask. A caller-provided `trusted: true` is no proof.
 *
 * `validation` must be the existing nft/validation.ts module (including its
 * explicit clock argument); `readNftRequest` is from nft/model.ts. This module
 * never implements a second Seaport parser or domain/schema validator.
 *
 * The task digest is Wallet's existing keccak256(JSON.stringify(policy)) format.
 * Its normalized field order is preserved, not replaced by ArtFi's SHA-256
 * kernelRequestDigest used for native reviewDigest.
 * The external valuation policy/quote are NOT in Wallet's frozen task digest.
 * Returned valuation digests identify review evidence only. A later task
 * authorization must explicitly bind the valuation policy digest and the
 * user's agreed price-at time; a trusted input is not that user agreement.
 * Never reinterpret a settlement-time USD minimum as an order-review minimum.
 *
 * No signer, network client, current counter/owner reader, wallet capability,
 * persistence or execution authority is supplied or returned. Matching is not
 * task authorization, listing publication, settlement or an execution decision.
 */
export function createNftSaleTermsVerifier({
  ethers: e,
  validation,
  readNftRequest,
  frozenTask,
  nativePlan,
  adapterId,
  valuationPolicy = null,
  trustedQuote = null,
}) {
  refuse(
    typeof e?.keccak256 === "function" &&
      typeof e?.toUtf8Bytes === "function" &&
      typeof e?.TypedDataEncoder?.hash === "function" &&
      typeof readNftRequest === "function",
    "NFT_SALE_VALIDATOR_CONFIGURATION_INVALID",
  );
  // Pin these functions as well as the data; later adapter mutation cannot
  // replace the canonical validation/hash implementation during a comparison.
  const validateTypedData = validation?.validateTypedData,
    validateComponents = validation?.validateComponents,
    orderHash = validation?.orderHash,
    typedHash = e.TypedDataEncoder.hash.bind(e.TypedDataEncoder),
    keccak256 = e.keccak256,
    utf8 = e.toUtf8Bytes;
  refuse(
    [validateTypedData, validateComponents, orderHash].every(
      (value) => typeof value === "function",
    ),
    "NFT_SALE_VALIDATOR_CONFIGURATION_INVALID",
  );
  const trusted = freeze(
    structuredClone({
      frozenTask,
      nativePlan,
      adapterId,
      valuationPolicy,
      trustedQuote,
    }),
  );
  return (reference, nowMs) => {
    try {
      refuse(
        Number.isSafeInteger(nowMs) && nowMs >= 0,
        "NFT_SALE_REVIEW_TIME_INVALID",
      );
      const task = trusted.frozenTask,
        plan = trusted.nativePlan;
      if (!task || !plan)
        return failure("EVIDENCE_REQUIRED", "NFT_SALE_TRUSTED_INPUT_REQUIRED");
      const policy = task.policy,
        intent = policy?.intent,
        now = BigInt(Math.floor(nowMs / 1000));
      refuse(
        hash(task.digest) &&
          same(keccak256(utf8(JSON.stringify(policy))), task.digest) &&
          hash(reference?.taskDigest) &&
          same(reference.taskDigest, task.digest),
        "NFT_SALE_TASK_DIGEST_MISMATCH",
      );
      refuse(
        policy.schema === "8415-agent-task/1" &&
          intent?.kind === "nft-sale" &&
          intent.direction === "sell" &&
          ["ERC-721", "ERC-1155"].includes(intent.standard) &&
          Array.isArray(intent.marketAdapters) &&
          intent.marketAdapters.includes(trusted.adapterId),
        "NFT_SALE_TASK_SCOPE_MISMATCH",
      );
      refuse(
        id(plan.id) &&
          id(plan.operationId) &&
          reference.nativePlanId === plan.id &&
          reference.nativeOperationId === plan.operationId &&
          /^[0-9a-f]{64}$/i.test(reference.reviewDigest ?? "") &&
          same(reference.reviewDigest, kernelRequestDigest(plan)),
        "NFT_SALE_NATIVE_REVIEW_MISMATCH",
      );
      refuse(
        plan.kind === "signature" &&
          plan.request?.action === "list" &&
          plan.typedData &&
          plan.transaction === undefined,
        "NFT_SALE_SELLER_LISTING_REQUIRED",
      );
      const request = readNftRequest(plan.request, nowMs),
        scope = plan.scope;
      refuse(
        ["1", "8453"].includes(policy.chainId) &&
          String(plan.chainId) === policy.chainId &&
          { ethereum: 1, base: 8453 }[scope?.chain] === plan.chainId &&
          request.collection === scope.slug &&
          scope.standard ===
            { "ERC-721": "erc721", "ERC-1155": "erc1155" }[intent.standard] &&
          same(scope.contract, intent.contract) &&
          request.tokenId === intent.tokenId &&
          request.quantity === intent.quantity &&
          same(request.account, policy.actor) &&
          plan.paymentToken === "ETH",
        "NFT_SALE_ASSET_OR_ACTOR_MISMATCH",
      );
      const taskExpiry = uint256(policy.expiresAt, true);
      refuse(
        Number.isSafeInteger(plan.expiresAt) &&
          plan.expiresAt > nowMs &&
          now < taskExpiry &&
          Number.isSafeInteger(plan.orderExpiresAt) &&
          plan.orderExpiresAt === request.expiresAt &&
          BigInt(request.expiresAt) <= taskExpiry,
        "NFT_SALE_VALIDITY_MISMATCH",
      );
      // Existing code validates exact Seaport 1.6 types, domain, supported zone,
      // conduit, static amounts, NFT, seller, payment, recipients and quantity.
      const components = validateTypedData(
          plan.typedData,
          request,
          scope,
          nowMs,
        ),
        terms = validateComponents(components, request, scope, true, nowMs);
      refuse(
        Object.keys(plan.typedData.domain).sort().join(",") ===
          "chainId,name,verifyingContract,version" &&
          terms.listing === true &&
          same(components.offerer, policy.actor) &&
          same(terms.currency, ZERO) &&
          BigInt(components.startTime) <= now &&
          BigInt(components.startTime) < BigInt(components.endTime),
        "NFT_SALE_ORDER_TERMS_MISMATCH",
      );
      const canonicalHash = orderHash(components),
        typedDataDigest = typedHash(
          plan.typedData.domain,
          plan.typedData.types,
          components,
        );
      refuse(
        [plan.orderHash, reference.orderHash, reference.typedDataDigest].every(
          hash,
        ) &&
          same(canonicalHash, plan.orderHash) &&
          same(canonicalHash, reference.orderHash) &&
          same(typedDataDigest, reference.typedDataDigest) &&
          same(
            typedDataDigest,
            typedHash(
              plan.typedData.domain,
              plan.typedData.types,
              plan.typedData.message,
            ),
          ),
        "NFT_SALE_ORDER_DIGEST_MISMATCH",
      );
      refuse(
        plan.orderTotalWei === terms.total.toString() &&
          kernelRequestDigest(plan.fees) === kernelRequestDigest(terms.fees),
        "NFT_SALE_REVIEW_AMOUNTS_MISMATCH",
      );
      // Never consume reference.proceedsMinor. Account for every consideration
      // item; fees paid back to the seller remain seller proceeds economically.
      const gross = components.consideration.reduce(
          (sum, item) => sum + BigInt(item.startAmount),
          0n,
        ),
        sellerNet = components.consideration.reduce(
          (sum, item) =>
            sum +
            (same(item.recipient, components.offerer)
              ? BigInt(item.startAmount)
              : 0n),
          0n,
        );
      uint256(gross.toString(), true);
      refuse(
        gross === terms.total && sellerNet > 0n,
        "NFT_SALE_AMOUNT_MISMATCH",
      );
      const order = freeze({
        schema: "artfi-nft-sale-order/1",
        nativeAction: "list",
        binding: {
          taskDigest: task.digest,
          nativePlanId: plan.id,
          nativeOperationId: plan.operationId,
          reviewDigest: kernelRequestDigest(plan),
          orderHash: canonicalHash,
          typedDataDigest,
          valuationPolicyDigest:
            trusted.valuationPolicy === null
              ? null
              : kernelRequestDigest(trusted.valuationPolicy),
          quoteEvidenceDigest:
            trusted.trustedQuote === null
              ? null
              : kernelRequestDigest(trusted.trustedQuote),
        },
        chainId: policy.chainId,
        protocol: plan.typedData.domain.verifyingContract,
        seller: components.offerer,
        nft: {
          standard: scope.standard,
          contract: scope.contract,
          tokenId: request.tokenId,
          quantity: request.quantity,
        },
        payment: {
          itemType: 0,
          token: terms.currency,
          symbol: "ETH",
          decimals: 18,
        },
        components,
        accountingBasis: "ORDER_CONSIDERATION_EXCLUDING_GAS",
        amounts: {
          gross: gross.toString(),
          fees: (gross - sellerNet).toString(),
          sellerNet: sellerNet.toString(),
        },
        feeRecipients: components.consideration
          .filter((item) => !same(item.recipient, components.offerer))
          .map((item) => ({
            recipient: item.recipient,
            amount: item.startAmount,
          })),
      });
      const usd = usdEvaluation(
        intent.minimumProceeds,
        trusted.valuationPolicy,
        trusted.trustedQuote,
        order,
        now,
      );
      return freeze({
        state: usd.state,
        reason: usd.reason,
        assessmentScope: "ORDER_REVIEW_ONLY",
        valuationBinding: "EXTERNAL_TO_FROZEN_TASK",
        order,
        usd,
        evidenceLimits: [
          "SIGNATURE_NOT_CHECKED",
          "CURRENT_COUNTER_NOT_CHECKED",
          "OWNERSHIP_AND_APPROVAL_NOT_CHECKED",
          "SETTLEMENT_NOT_CHECKED",
        ],
      });
    } catch (error) {
      return failure(
        "MISMATCH",
        /^NFT_SALE_[A-Z_]+$/.test(error?.message ?? "")
          ? error.message
          : "NFT_SALE_ORDER_INVALID",
      );
    }
  };
}
