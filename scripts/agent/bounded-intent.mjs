// TEST_ONLY first-slice authorization boundary. No signing, custody or execution here.
export const INTENT_FIELDS = Object.freeze(
  [
    ["intentId", "bytes32"],
    ["principal", "address"],
    ["wallet", "address"],
    ["assetScope", "bytes32"],
    ["actionScope", "uint256"],
    ["maxUnitPrice", "uint256"],
    ["minUnitPrice", "uint256"],
    ["maxTransactionValue", "uint256"],
    ["maxAggregateExposure", "uint256"],
    ["maxExecutions", "uint256"],
    ["maxOpenOrders", "uint256"],
    ["validFrom", "uint256"],
    ["validUntil", "uint256"],
    ["allowedCounterpartyPolicy", "bytes32"],
    ["allowedVenuePolicy", "bytes32"],
    ["jurisdictionPolicy", "bytes32"],
    ["slippageLimit", "uint256"],
    ["settlementPolicy", "bytes32"],
    ["nonce", "uint256"],
    ["revocationRef", "bytes32"],
  ].map(([name, type]) => Object.freeze({ name, type })),
);
export const INTENT_TYPES = Object.freeze({ BoundedIntent: INTENT_FIELDS });
const reject = (code) => {
  throw new Error(code);
};
const uint = (value) => {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) >= 2n ** 256n
  )
    reject("UINT_INVALID");
  return BigInt(value);
};

// readState is a trusted composition-root dependency, not a caller-provided state object.
// Executor must atomically reserve the returned stateVersion and consume on chain; this
// validator alone is not replay-safe execution and is never reported as D1 E2E.
export function createIntentAuthorizer({ ethers, policy, readState, clock }) {
  const fixed = structuredClone(policy);
  const sameAddress = (a, b) => ethers.getAddress(a) === ethers.getAddress(b);
  const validAddress = (value) => {
    try {
      return ethers.isAddress(value) && !sameAddress(value, ethers.ZeroAddress);
    } catch {
      return false;
    }
  };
  if (
    !ethers ||
    typeof ethers.isAddress !== "function" ||
    typeof ethers.getAddress !== "function" ||
    typeof ethers.verifyTypedData !== "function" ||
    typeof ethers.AbiCoder?.defaultAbiCoder !== "function" ||
    typeof ethers.keccak256 !== "function" ||
    typeof ethers.TypedDataEncoder?.hash !== "function" ||
    !fixed ||
    fixed?.mode !== "TEST_ONLY_NO_REAL_VALUE" ||
    String(fixed.chainId) !== "560048" ||
    !validAddress(fixed.executor) ||
    !validAddress(fixed.venue) ||
    !Array.isArray(fixed.counterparties) ||
    fixed.counterparties.length === 0 ||
    fixed.counterparties.some((value) => !validAddress(value)) ||
    [
      "allowedCounterpartyPolicy",
      "allowedVenuePolicy",
      "jurisdictionPolicy",
      "settlementPolicy",
    ].some(
      (key) =>
        typeof fixed[key] !== "string" ||
        !/^0x[0-9a-f]{64}$/.test(fixed[key]) ||
        fixed[key] === ethers.ZeroHash,
    ) ||
    typeof readState !== "function" ||
    typeof clock !== "function"
  )
    reject("CONFIGURATION_INVALID");
  const domain = Object.freeze({
    name: "ArtFi Bounded Intent",
    version: "1",
    chainId: String(fixed.chainId),
    verifyingContract: fixed.executor,
  });
  return function authorize(input) {
    const cloned = structuredClone(input);
    if (!cloned || typeof cloned !== "object" || Array.isArray(cloned))
      reject("INTENT_SHAPE_INVALID");
    const { intent: p, signature, proposal: q } = cloned;
    if (
      !p ||
      Object.keys(p).length !== INTENT_FIELDS.length ||
      INTENT_FIELDS.some((f) => !Object.hasOwn(p, f.name))
    )
      reject("INTENT_SHAPE_INVALID");
    for (const { name, type } of INTENT_FIELDS) {
      const value = p[name];
      if (type === "uint256") uint(value);
      if (
        type === "bytes32" &&
        (typeof value !== "string" ||
          !/^0x[0-9a-f]{64}$/.test(value) ||
          value === ethers.ZeroHash)
      )
        reject("HASH_INVALID");
      if (
        type === "address" &&
        (!ethers.isAddress(value) || sameAddress(value, ethers.ZeroAddress))
      )
        reject("ADDRESS_INVALID");
    }
    // First scope is BUY only. Other #84 actions remain unimplemented, not silently granted.
    if (
      p.actionScope !== "1" ||
      p.maxExecutions !== "1" ||
      p.maxOpenOrders !== "0" ||
      p.slippageLimit !== "0" ||
      q?.action !== "BUY" ||
      q.opensOrder !== false
    )
      reject("ACTION_UNSUPPORTED");
    if (!sameAddress(p.principal, p.wallet))
      reject("PRINCIPAL_DELEGATION_UNSUPPORTED");
    if (
      typeof signature !== "string" ||
      !/^0x[0-9a-fA-F]{130}$/.test(signature)
    )
      reject("SIGNATURE_INVALID");
    let signer;
    try {
      signer = ethers.verifyTypedData(domain, INTENT_TYPES, p, signature);
    } catch {
      reject("SIGNATURE_INVALID");
    }
    if (!sameAddress(signer, p.wallet)) reject("SIGNATURE_INVALID");
    const now = clock();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      BigInt(now) < uint(p.validFrom) ||
      BigInt(now) >= uint(p.validUntil) ||
      uint(p.validUntil) <= uint(p.validFrom)
    )
      reject("INTENT_NOT_CURRENT");
    for (const field of [
      "allowedCounterpartyPolicy",
      "allowedVenuePolicy",
      "jurisdictionPolicy",
      "settlementPolicy",
    ]) {
      if (p[field] !== fixed[field]) reject("POLICY_UNSUPPORTED");
    }
    if (
      !fixed.counterparties.some((a) => sameAddress(a, q.counterparty)) ||
      !sameAddress(q.venue, fixed.venue)
    )
      reject("VENUE_OR_COUNTERPARTY_REFUSED");
    const asset = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "address", "uint256"],
        [fixed.chainId, q.contract, uint(q.tokenId)],
      ),
    );
    if (asset !== p.assetScope) reject("ASSET_SCOPE_REFUSED");
    const price = uint(q.unitPrice),
      quantity = uint(q.quantity),
      value = uint(q.value),
      quoted = uint(q.quotedUnitPrice);
    if (
      quantity === 0n ||
      quoted === 0n ||
      price * quantity !== value ||
      value >= 2n ** 256n
    )
      reject("VALUE_INVALID");
    if (
      uint(p.minUnitPrice) > uint(p.maxUnitPrice) ||
      price < uint(p.minUnitPrice) ||
      price > uint(p.maxUnitPrice) ||
      value > uint(p.maxTransactionValue)
    )
      reject("FINANCIAL_BOUND_EXCEEDED");
    if (quantity !== 1n) reject("QUANTITY_UNSUPPORTED");
    const slip = uint(p.slippageLimit);
    if (
      slip > 10000n ||
      (price > quoted && (price - quoted) * 10000n > quoted * slip)
    )
      reject("SLIPPAGE_EXCEEDED");
    const state = structuredClone(
      readState(
        Object.freeze({
          principal: p.principal,
          nonce: p.nonce,
          intentId: p.intentId,
          revocationRef: p.revocationRef,
          assetScope: asset,
        }),
      ),
    );
    if (
      state?.available !== true ||
      state.current !== true ||
      state.revoked !== false ||
      state.groundingCurrent !== true ||
      state.assetRestricted !== false
    )
      reject("STATE_NOT_ELIGIBLE");
    if (
      typeof state.version !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(state.version)
    )
      reject("STATE_VERSION_INVALID");
    if (uint(state.executions) >= uint(p.maxExecutions))
      reject("AUTHORITY_CONSUMED");
    if (
      uint(state.aggregateExposure) + value > uint(p.maxAggregateExposure) ||
      uint(state.openOrders) > uint(p.maxOpenOrders)
    )
      reject("EXPOSURE_EXCEEDED");
    return Object.freeze({
      state: "AUTHORIZED_NOT_EXECUTED",
      intentDigest: ethers.TypedDataEncoder.hash(domain, INTENT_TYPES, p),
      stateVersion: state.version,
      assetScope: asset,
      value: value.toString(),
      executionRequired: "ATOMIC_RESERVATION_AND_CHAIN_ENFORCEMENT",
      testOnly: true,
    });
  };
}
