import { INTENT_TYPES } from "./bounded-intent.mjs";
export const SALE_TYPES = Object.freeze({
  FixedNFTSale: Object.freeze(
    [
      ["seller", "address"],
      ["buyer", "address"],
      ["recipient", "address"],
      ["nft", "address"],
      ["tokenId", "uint256"],
      ["paymentToken", "address"],
      ["price", "uint256"],
      ["validFrom", "uint256"],
      ["validUntil", "uint256"],
      ["nonce", "uint256"],
    ].map(([name, type]) => Object.freeze({ name, type })),
  ),
});
export const BUY_EVENT =
  "event BoundedBuySettled(bytes32 indexed intentDigest,bytes32 indexed saleDigest,address indexed buyer,address seller,address nft,uint256 tokenId,address paymentToken,uint256 price)";
const fail = (code) => {
  throw new Error(code);
};
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const hash = (value) =>
  typeof value === "string" &&
  /^0x[0-9a-f]{64}$/i.test(value) &&
  !/^0x0{64}$/i.test(value);
const number = (value) => Number.isSafeInteger(value) && value >= 0;

// Trusted composition-root config and normalized client only. No broadcasting.
// Scope is the exact reviewed bilateral TEST_ONLY ERC721/payment settlement.
export function createBuyReceiptVerifier({
  ethers: e,
  client,
  market,
  runtimeCodeHash,
  marketABI,
  deploymentTrust,
  timeoutMs = 5000,
}) {
  if (
    !e.isAddress(market) ||
    !hash(runtimeCodeHash) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  )
    fail("BUY_VERIFIER_CONFIGURATION_INVALID");
  const marketInterface = new e.Interface(marketABI),
    settled = new e.Interface([BUY_EVENT]);
  const nftInterface = new e.Interface([
    "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
  ]);
  const payInterface = new e.Interface([
    "event Transfer(address indexed from,address indexed to,uint256 value)",
  ]);
  // This envelope is supplied by reviewed deployment intake, NEVER by the
  // transaction request or by hashing whatever code an untrusted RPC returns.
  // Loading/authenticating a production manifest is a separate unmet gate.
  const trust = structuredClone(deploymentTrust ?? null);
  // Pin method references so a later caller cannot replace an adapter mid-check.
  const methods = {};
  for (const key of [
    "getNetwork",
    "getTransactionReceipt",
    "getTransaction",
    "getBlock",
    "getCode",
    "readExecutorBindings",
  ]) {
    if (typeof client?.[key] !== "function") fail("BUY_CLIENT_INVALID");
    methods[key] = client[key].bind(client);
  }
  return async (input) => {
    const x = structuredClone(input),
      started = performance.now();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("BUY_EVIDENCE_TIMEOUT")),
        timeoutMs,
      );
    });
    const read = async (key, ...args) => {
      if (performance.now() - started >= timeoutMs)
        fail("BUY_EVIDENCE_TIMEOUT");
      const result = await Promise.race([methods[key](...args), deadline]);
      if (performance.now() - started >= timeoutMs)
        fail("BUY_EVIDENCE_TIMEOUT");
      return structuredClone(result);
    };
    try {
      if (
        !trust ||
        trust.mode !== "TEST_ONLY_NO_REAL_VALUE" ||
        trust.accountingPolicy !==
          "TEST_ONLY_ARTFI_RWA_BUY_TOKEN_POSTCONDITIONS_V1" ||
        !/^[0-9a-f]{64}$/i.test(trust.reviewEvidenceSha256 ?? "") ||
        trust.executorSourceSha256 !==
          "8716AC88F23FB734F21A3FF69F4C404743CCA0A4A9C7B4DAA525C3BEE8A71D80" ||
        trust.proxyOrUpgradeAllowed !== false ||
        !same(trust.executor?.address, market) ||
        !same(trust.executor?.runtimeCodeHash, runtimeCodeHash) ||
        ["nft", "payment", "grounding"].some(
          (k) =>
            !e.isAddress(trust[k]?.address) || !hash(trust[k]?.runtimeCodeHash),
        )
      )
        fail("BUY_DEPLOYMENT_TRUST_UNAVAILABLE");
      if (!hash(x.transactionHash) || !x.intent || !x.sale)
        fail("BUY_EXPECTED_INVALID");
      const s = x.sale,
        domain = {
          name: "ArtFi Bounded Intent",
          version: "1",
          chainId: 560048,
          verifyingContract: market,
        };
      if (
        !same(s.nft, trust.nft.address) ||
        !same(s.paymentToken, trust.payment.address)
      )
        fail("BUY_UNSUPPORTED_TOKEN");
      const intentDigest = e.TypedDataEncoder.hash(
          domain,
          INTENT_TYPES,
          x.intent,
        ),
        saleDigest = e.TypedDataEncoder.hash(domain, SALE_TYPES, s);
      if (
        !same(
          e.verifyTypedData(domain, INTENT_TYPES, x.intent, x.buyerSignature),
          s.buyer,
        ) ||
        !same(
          e.verifyTypedData(domain, SALE_TYPES, s, x.sellerSignature),
          s.seller,
        ) ||
        !same(x.intent.wallet, s.buyer) ||
        !same(s.recipient, s.buyer)
      )
        fail("BUY_SIGNATURE_BINDING_INVALID");
      if (String((await read("getNetwork")).chainId) !== "560048")
        fail("BUY_CHAIN_MISMATCH");
      const r = await read("getTransactionReceipt", x.transactionHash);
      if (
        !r ||
        r.status !== 1 ||
        !same(r.hash, x.transactionHash) ||
        !same(r.to, market) ||
        !hash(r.blockHash) ||
        !number(r.blockNumber) ||
        r.blockNumber < 1 ||
        !Array.isArray(r.logs)
      )
        fail("BUY_RECEIPT_INVALID");
      const before = await read("getBlock", r.blockNumber),
        finalized = await read("getBlock", "finalized");
      if (
        !before ||
        before.number !== r.blockNumber ||
        !same(before.hash, r.blockHash) ||
        !finalized ||
        !number(finalized.number) ||
        !hash(finalized.hash) ||
        finalized.number < r.blockNumber
      )
        fail("BUY_NOT_FINALIZED_CANONICAL");
      const code = await read("getCode", market, r.blockNumber);
      if (!same(e.keccak256(code), runtimeCodeHash))
        fail("BUY_EXECUTOR_CODE_MISMATCH");
      for (const name of ["nft", "payment", "grounding"]) {
        const dependencyCode = await read(
          "getCode",
          trust[name].address,
          r.blockNumber,
        );
        if (!same(e.keccak256(dependencyCode), trust[name].runtimeCodeHash))
          fail("BUY_DEPENDENCY_CODE_MISMATCH");
      }
      const bindings = await read(
        "readExecutorBindings",
        market,
        r.blockNumber,
      );
      if (
        !same(bindings?.collection, s.nft) ||
        !same(bindings?.payment, s.paymentToken) ||
        !same(bindings?.grounding, trust.grounding.address)
      )
        fail("BUY_IMMUTABLE_BINDING_MISMATCH");
      const t = await read("getTransaction", x.transactionHash);
      const expectedData = marketInterface.encodeFunctionData("buy", [
        x.intent,
        x.buyerSignature,
        s,
        x.sellerSignature,
      ]);
      if (
        !t ||
        !same(t.hash, r.hash) ||
        !same(t.to, market) ||
        !same(t.from, r.from) ||
        !same(t.blockHash, r.blockHash) ||
        t.blockNumber !== r.blockNumber ||
        String(t.chainId) !== "560048" ||
        String(t.value) !== "0" ||
        !same(t.data, expectedData)
      )
        fail("BUY_CALLDATA_MISMATCH");
      const found = { settlement: [], nft: [], payment: [] },
        indices = new Set();
      for (const log of r.logs) {
        if (
          log.removed !== false ||
          !same(log.transactionHash, r.hash) ||
          !same(log.blockHash, r.blockHash) ||
          log.blockNumber !== r.blockNumber ||
          !number(log.index) ||
          indices.has(log.index)
        )
          fail("BUY_LOG_CONTEXT_INVALID");
        indices.add(log.index);
        let parsed;
        if (same(log.address, market)) {
          parsed = settled.parseLog(log);
          if (parsed)
            found.settlement.push({ args: parsed.args, index: log.index });
        } else if (same(log.address, s.nft)) {
          parsed = nftInterface.parseLog(log);
          if (parsed) found.nft.push({ args: parsed.args, index: log.index });
        } else if (same(log.address, s.paymentToken)) {
          parsed = payInterface.parseLog(log);
          if (parsed)
            found.payment.push({ args: parsed.args, index: log.index });
        }
      }
      if (Object.values(found).some((v) => v.length !== 1))
        fail("BUY_EVENT_SET_INVALID");
      const b = found.settlement[0].args,
        n = found.nft[0].args,
        p = found.payment[0].args;
      if (
        !same(b.intentDigest, intentDigest) ||
        !same(b.saleDigest, saleDigest) ||
        !same(b.buyer, s.buyer) ||
        !same(b.seller, s.seller) ||
        !same(b.nft, s.nft) ||
        b.tokenId.toString() !== s.tokenId ||
        !same(b.paymentToken, s.paymentToken) ||
        b.price.toString() !== s.price
      )
        fail("BUY_SETTLEMENT_EVENT_MISMATCH");
      if (
        !same(n.from, s.seller) ||
        !same(n.to, s.recipient) ||
        n.tokenId.toString() !== s.tokenId ||
        !same(p.from, s.buyer) ||
        !same(p.to, s.seller) ||
        p.value.toString() !== s.price ||
        !(
          found.payment[0].index < found.nft[0].index &&
          found.nft[0].index < found.settlement[0].index
        )
      )
        fail("BUY_TRANSFER_EVENT_MISMATCH");
      // A reviewed exact executor emits settlement only after same-call exact
      // payment +/-price, owner postcondition and nonce consumption. Block-end
      // snapshots are NOT transaction deltas: later legitimate transfers can
      // change all balances/owner in this same block. Current holdings belong
      // to a separate timestamped observation/new-action eligibility boundary.
      const after = await read("getBlock", r.blockNumber);
      if (
        !after ||
        after.number !== r.blockNumber ||
        !same(after.hash, before.hash)
      )
        fail("BUY_REORG_OBSERVED");
      return Object.freeze({
        state: "CONFIRMED",
        canonical: true,
        accountingMatches: true,
        accountingBasis: "REVIEWED_EXECUTOR_POSTCONDITIONS",
        transactionBalanceDeltaMeasured: false,
        currentOwnership: "NOT_EVALUATED",
        currentBalances: "NOT_EVALUATED",
        binding: Object.freeze({
          transactionHash: r.hash,
          blockHash: r.blockHash,
          blockNumber: r.blockNumber,
          intentDigest,
          saleDigest,
          nft: s.nft,
          tokenId: s.tokenId,
          buyer: s.buyer,
          seller: s.seller,
          paymentToken: s.paymentToken,
          price: s.price,
        }),
      });
    } catch (error) {
      return Object.freeze({
        state: "UNKNOWN",
        canonical: false,
        accountingMatches: false,
        reason: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message ?? "")
          ? error.message
          : "BUY_EVIDENCE_UNAVAILABLE",
      });
    } finally {
      clearTimeout(timer);
    }
  };
}
