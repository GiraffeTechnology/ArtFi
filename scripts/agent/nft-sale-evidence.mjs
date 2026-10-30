import { kernelRequestDigest } from "./agent-kernel.mjs";

export const NFT_SALE_EVENT =
  "event OrderFulfilled(bytes32 orderHash,address indexed offerer,address indexed zone,address recipient,(uint8 itemType,address token,uint256 identifier,uint256 amount)[] offer,(uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)[] consideration)";
export const NFT_SALE_NATIVE_POLICY =
  "SEAPORT_SUCCESSFUL_NATIVE_CONSIDERATION_V1";
const ZERO = "0x0000000000000000000000000000000000000000";
const WETH = Object.freeze({
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  8453: "0x4200000000000000000000000000000000000006",
});
const fail = (code) => {
  throw new Error(code);
};
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const hash = (x) =>
  typeof x === "string" && /^0x[0-9a-f]{64}$/i.test(x) && !/^0x0{64}$/i.test(x);
const count = (x) => Number.isSafeInteger(x) && x >= 0;
const bytes = (x) => typeof x === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(x);
const uint = (x, positive = false) => {
  if (typeof x !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(x))
    fail("NFT_SALE_AMOUNT_INVALID");
  const n = BigInt(x);
  if (n >= 1n << 256n || (positive && n === 0n))
    fail("NFT_SALE_AMOUNT_INVALID");
  return n;
};
const freeze = (x) => {
  if (x && typeof x === "object") {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};

// Pure evidence assessment, not a broadcaster, authorization, budget mutation or
// replacement marketplace. The composition root supplies the official SDK's
// EIP_712_ORDER_TYPE and reviewed deployment pins. Neither comes from a request.
// The order is the snapshot normalized by nft-sale-terms / Stage 1
// validation.ts. Accept-offer snapshots must also have passed validateTransaction.
// Like action-evidence.mjs this checks public evidence from a trusted reader;
// it cannot authenticate an arbitrary RPC response or establish provider trust.
export function createNftSaleEvidenceEvaluator({
  ethers: e,
  orderTypes,
  seaportABI,
  allowedDeployments,
  expectedOrder: expectedOrderInput,
  reviewedTransaction: reviewedTransactionInput,
  observationPolicy,
}) {
  const policy = freeze(structuredClone(observationPolicy ?? null));
  if (
    !e?.Interface ||
    !e?.TypedDataEncoder?.hashStruct ||
    !e?.TypedDataEncoder?.hash ||
    !e?.keccak256 ||
    !e?.isAddress ||
    !orderTypes?.OrderComponents ||
    !Array.isArray(seaportABI) ||
    !Array.isArray(allowedDeployments) ||
    allowedDeployments.length > 32 ||
    !policy ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(policy.id ?? "") ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(policy.sourceId ?? "") ||
    !hash(policy.taskDigest) ||
    !Object.hasOwn(WETH, policy.chainId) ||
    !count(policy.minimumConfirmations) ||
    policy.minimumConfirmations < 1
  )
    fail("NFT_SALE_VERIFIER_CONFIGURATION_INVALID");
  const pinnedOrder = freeze(structuredClone(expectedOrderInput));
  const pinnedReview = freeze(
    structuredClone(reviewedTransactionInput ?? null),
  );
  if (
    pinnedOrder?.binding?.taskDigest !== policy.taskDigest ||
    pinnedOrder?.chainId !== policy.chainId
  )
    fail("NFT_SALE_POLICY_BINDING_INVALID");
  const pinnedOrderDigest = kernelRequestDigest(pinnedOrder);
  const isAddress = e.isAddress,
    keccak256 = e.keccak256,
    orderHash = e.TypedDataEncoder.hashStruct.bind(e.TypedDataEncoder),
    typedHash = e.TypedDataEncoder.hash.bind(e.TypedDataEncoder);
  const types = freeze(structuredClone(orderTypes));
  const deployments = freeze(structuredClone(allowedDeployments));
  for (const d of deployments) {
    if (
      !Object.hasOwn(WETH, d.chainId) ||
      !isAddress(d.address) ||
      same(d.address, ZERO) ||
      !hash(d.runtimeCodeHash) ||
      d.proxyOrUpgradeAllowed !== false ||
      !/^[0-9a-f]{64}$/i.test(d.reviewEvidenceSha256 ?? "") ||
      (d.nativeConsiderationPolicy !== undefined &&
        d.nativeConsiderationPolicy !== NFT_SALE_NATIVE_POLICY)
    )
      fail("NFT_SALE_DEPLOYMENT_CONFIGURATION_INVALID");
  }
  const seaport = new e.Interface(structuredClone(seaportABI));
  const nft721 = new e.Interface([
    "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
  ]);
  const nft1155 = new e.Interface([
    "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
    "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
  ]);
  const erc20 = new e.Interface([
    "event Transfer(address indexed from,address indexed to,uint256 value)",
  ]);
  const topic = (iface, name) => iface.getEvent(name).topicHash;
  const saleTopic = topic(seaport, "OrderFulfilled");
  const transferTopic = topic(nft721, "Transfer");
  const singleTopic = topic(nft1155, "TransferSingle");
  const batchTopic = topic(nft1155, "TransferBatch");
  const address = (x) => isAddress(x) && !same(x, ZERO);

  function expectedOrder(o) {
    const p = o?.components;
    const listing = o?.nativeAction === "list";
    if (
      o?.schema !== "artfi-nft-sale-order/1" ||
      !["list", "accept"].includes(o.nativeAction) ||
      !Object.hasOwn(WETH, o.chainId) ||
      !address(o.protocol) ||
      !address(o.seller) ||
      !["erc721", "erc1155"].includes(o.nft?.standard) ||
      !address(o.nft.contract) ||
      !hash(o.binding?.orderHash) ||
      !hash(o.binding?.typedDataDigest) ||
      !p ||
      !address(p.offerer) ||
      !isAddress(p.zone) ||
      ![0, 1, 2, 3].includes(p.orderType) ||
      !Array.isArray(p.offer) ||
      p.offer.length !== 1 ||
      !Array.isArray(p.consideration) ||
      p.consideration.length < 1 ||
      p.consideration.length > 20
    )
      fail("NFT_SALE_ORDER_INVALID");
    uint(o.nft.tokenId);
    const requested = uint(o.nft.quantity, true);
    const nft = listing ? p.offer[0] : p.consideration[0];
    const size = uint(nft.startAmount, true);
    if (
      requested > size ||
      requested > 1000000n ||
      (o.nft.standard === "erc721" && (requested !== 1n || size !== 1n)) ||
      nft.itemType !== (o.nft.standard === "erc721" ? 2 : 3) ||
      !same(nft.token, o.nft.contract) ||
      nft.identifierOrCriteria !== o.nft.tokenId ||
      (listing
        ? !same(p.offerer, o.seller)
        : same(p.offerer, o.seller) || !same(nft.recipient, p.offerer))
    )
      fail("NFT_SALE_NFT_BINDING_INVALID");
    const currency = listing ? ZERO : WETH[o.chainId];
    if (
      o.payment?.itemType !== (listing ? 0 : 1) ||
      !same(o.payment.token, currency) ||
      o.payment.symbol !== (listing ? "ETH" : "WETH") ||
      o.payment.decimals !== 18
    )
      fail("NFT_SALE_CURRENCY_INVALID");
    for (const i of [...p.offer, ...p.consideration]) {
      if (
        !isAddress(i.token) ||
        ![0, 1, 2, 3].includes(i.itemType) ||
        uint(i.startAmount, true) !== uint(i.endAmount, true)
      )
        fail("NFT_SALE_DYNAMIC_OR_UNSUPPORTED_ORDER");
      uint(i.identifierOrCriteria);
    }
    if (p.consideration.some((i) => !address(i.recipient)))
      fail("NFT_SALE_RECIPIENT_INVALID");
    const monetary = listing
      ? p.consideration
      : [p.offer[0], ...p.consideration.slice(1)];
    if (
      monetary.some(
        (i) =>
          i.itemType !== (listing ? 0 : 1) ||
          !same(i.token, currency) ||
          i.identifierOrCriteria !== "0",
      )
    )
      fail("NFT_SALE_CURRENCY_INVALID");
    if (listing && !same(p.consideration[0].recipient, o.seller))
      fail("NFT_SALE_SELLER_PROCEEDS_INVALID");
    const start = uint(p.startTime),
      end = uint(p.endTime, true);
    if (
      start >= end ||
      !same(orderHash("OrderComponents", types, p), o.binding.orderHash)
    )
      fail("NFT_SALE_ORDER_HASH_INVALID");
    if (
      !same(
        typedHash(
          {
            name: "Seaport",
            version: "1.6",
            chainId: Number(o.chainId),
            verifyingContract: o.protocol,
          },
          types,
          p,
        ),
        o.binding.typedDataDigest,
      )
    )
      fail("NFT_SALE_TYPED_DATA_DIGEST_INVALID");
    if (requested < size && p.orderType % 2 === 0)
      fail("NFT_SALE_PARTIAL_NOT_ALLOWED");
    const amounts = (quantity) => {
      const scaled = (i) => {
        const n = uint(i.startAmount, true) * quantity;
        if (n % size !== 0n) fail("NFT_SALE_FILL_ROUNDING");
        return n / size;
      };
      const gross = listing
        ? p.consideration.reduce((n, i) => n + scaled(i), 0n)
        : scaled(p.offer[0]);
      const fees = p.consideration
        .slice(listing ? 0 : 1)
        .filter((i) => !same(i.recipient, o.seller))
        .map((i) => ({ recipient: i.recipient, amount: scaled(i).toString() }));
      const feeTotal = fees.reduce((n, i) => n + BigInt(i.amount), 0n);
      if (feeTotal >= gross) fail("NFT_SALE_SELLER_PROCEEDS_INVALID");
      return {
        gross: gross.toString(),
        fees: feeTotal.toString(),
        sellerNet: (gross - feeTotal).toString(),
        feeRecipients: fees,
        scaled,
      };
    };
    const reviewedAmounts = amounts(requested);
    if (
      ["gross", "fees", "sellerNet"].some(
        (k) => o.amounts?.[k] !== reviewedAmounts[k],
      ) ||
      !Array.isArray(o.feeRecipients) ||
      kernelRequestDigest(
        o.feeRecipients.map((i) => ({
          recipient: i.recipient.toLowerCase(),
          amount: i.amount,
        })),
      ) !==
        kernelRequestDigest(
          reviewedAmounts.feeRecipients.map((i) => ({
            ...i,
            recipient: i.recipient.toLowerCase(),
          })),
        )
    )
      fail("NFT_SALE_REVIEW_AMOUNTS_MISMATCH");
    return { p, listing, size, requested, currency, start, end, amounts };
  }

  return (input) => {
    try {
      const x = structuredClone(input),
        o = pinnedOrder,
        v = x.evidence;
      if (
        x.order !== undefined &&
        kernelRequestDigest(x.order) !== pinnedOrderDigest
      )
        fail("NFT_SALE_ORDER_SNAPSHOT_MISMATCH");
      if (
        x.reviewedTransaction !== undefined &&
        kernelRequestDigest(x.reviewedTransaction) !==
          kernelRequestDigest(pinnedReview)
      )
        fail("NFT_SALE_REVIEW_SNAPSHOT_MISMATCH");
      const expected = expectedOrder(o);
      const { p, listing, size, requested, currency, start, end, amounts } =
        expected;
      if (
        !v ||
        v.chainId !== o.chainId ||
        v.sourceId !== policy.sourceId ||
        v.observationPolicyId !== policy.id ||
        !count(v.observedAt)
      )
        fail("NFT_SALE_SOURCE_BINDING_INVALID");
      const t = v.transaction,
        r = v.receipt;
      if (
        !t ||
        !r ||
        !hash(t.hash) ||
        !same(r.transactionHash, t.hash) ||
        t.chainId !== o.chainId ||
        r.chainId !== o.chainId ||
        !hash(r.blockHash) ||
        !count(r.blockNumber) ||
        r.blockNumber < 1 ||
        !same(t.blockHash, r.blockHash) ||
        t.blockNumber !== r.blockNumber ||
        !address(t.from) ||
        !same(r.from, t.from) ||
        !same(t.to, o.protocol) ||
        !same(r.to, o.protocol) ||
        !bytes(t.data) ||
        t.data.length < 10 ||
        t.data.length > 131074 ||
        !count(t.nonce) ||
        !Array.isArray(r.logs) ||
        r.logs.length > 512
      )
        fail("NFT_SALE_RECEIPT_BINDING_INVALID");
      uint(t.value);
      if (listing && same(t.from, o.seller))
        fail("NFT_SALE_SELF_FUNDED_LISTING");
      if (r.status !== 1)
        fail(
          r.status === 0
            ? "NFT_SALE_TRANSACTION_REVERTED"
            : "NFT_SALE_RECEIPT_STATUS_UNKNOWN",
        );
      const before = v.canonicalBlockBefore,
        after = v.canonicalBlockAfter,
        head = v.head;
      if (
        [before, after].some(
          (b) =>
            !b ||
            b.chainId !== o.chainId ||
            b.number !== r.blockNumber ||
            !same(b.hash, r.blockHash) ||
            !count(b.timestamp),
        ) ||
        before.timestamp !== after.timestamp ||
        !head ||
        head.chainId !== o.chainId ||
        !hash(head.hash) ||
        !count(head.number) ||
        head.number < r.blockNumber
      )
        fail("NFT_SALE_NOT_CANONICAL");
      const confirmations = head.number - r.blockNumber + 1;
      if (confirmations < policy.minimumConfirmations)
        fail("NFT_SALE_CONFIRMATIONS_SHALLOW");
      if (BigInt(before.timestamp) < start || BigInt(before.timestamp) >= end)
        fail("NFT_SALE_EXECUTION_OUTSIDE_ORDER_WINDOW");
      const d = v.deploymentEvidence;
      const matches = deployments.filter(
        (a) => a.chainId === o.chainId && same(a.address, o.protocol),
      );
      if (
        !d ||
        d.chainId !== o.chainId ||
        !same(d.address, o.protocol) ||
        d.blockNumber !== r.blockNumber ||
        !same(d.blockHash, r.blockHash) ||
        !bytes(d.runtimeCode) ||
        d.runtimeCode === "0x" ||
        d.runtimeCode.length > 131074
      )
        fail("NFT_SALE_DEPLOYMENT_EVIDENCE_INVALID");
      const pin = matches.find((a) =>
        same(keccak256(d.runtimeCode), a.runtimeCodeHash),
      );
      if (!pin) fail("NFT_SALE_DEPLOYMENT_UNTRUSTED");
      if (listing && pin.nativeConsiderationPolicy !== NFT_SALE_NATIVE_POLICY)
        fail("NFT_SALE_NATIVE_ACCOUNTING_UNREVIEWED");
      const call = seaport.parseTransaction({ data: t.data, value: t.value });
      if (
        !call ||
        ![
          "fulfillOrder",
          "fulfillAdvancedOrder",
          "fulfillBasicOrder",
          "fulfillBasicOrder_efficient_6GL6yc",
        ].includes(call.name)
      )
        fail("NFT_SALE_FULFILLMENT_METHOD_UNSUPPORTED");
      // Bind decoded calldata to the same canonical order used for event
      // reconciliation. Counter is not in fulfillment calldata; the pinned
      // components and emitted orderHash bind it. Basic and standard calls
      // receive offer items at msg.sender; only advanced calls can name a gift
      // recipient (zero means msg.sender). Do not accept contradictory inputs
      // merely because each individual evidence envelope has valid formatting.
      let callOrder,
        callRecipient = t.from,
        callQuantity = size;
      const basicCall = [
        "fulfillBasicOrder",
        "fulfillBasicOrder_efficient_6GL6yc",
      ].includes(call.name);
      if (basicCall) {
        const b = call.args[0];
        const route = listing
          ? o.nft.standard === "erc721"
            ? 0
            : 1
          : o.nft.standard === "erc721"
            ? 4
            : 5;
        if (
          Number(b.basicOrderType) !== route * 4 + p.orderType ||
          b.totalOriginalAdditionalRecipients !==
            BigInt(p.consideration.length - 1) ||
          b.additionalRecipients.length !== p.consideration.length - 1
        )
          fail("NFT_SALE_CALLDATA_ORDER_MISMATCH");
        const item = (
          itemType,
          token,
          identifierOrCriteria,
          amount,
          recipient,
        ) => ({
          itemType,
          token,
          identifierOrCriteria,
          startAmount: amount,
          endAmount: amount,
          ...(recipient ? { recipient } : {}),
        });
        callOrder = {
          offerer: b.offerer,
          zone: b.zone,
          offer: [
            item(
              p.offer[0].itemType,
              b.offerToken,
              b.offerIdentifier,
              b.offerAmount,
            ),
          ],
          consideration: [
            item(
              p.consideration[0].itemType,
              b.considerationToken,
              b.considerationIdentifier,
              b.considerationAmount,
              b.offerer,
            ),
            ...b.additionalRecipients.map((i) =>
              item(
                listing ? 0 : 1,
                listing ? b.considerationToken : b.offerToken,
                0n,
                i.amount,
                i.recipient,
              ),
            ),
          ],
          orderType: Number(b.basicOrderType) % 4,
          startTime: b.startTime,
          endTime: b.endTime,
          zoneHash: b.zoneHash,
          salt: b.salt,
          conduitKey: b.offererConduitKey,
          counter: p.counter,
        };
      } else {
        const order = call.args[0];
        const parameters = order.parameters;
        if (
          parameters.totalOriginalConsiderationItems !==
          BigInt(p.consideration.length)
        )
          fail("NFT_SALE_CALLDATA_ORDER_MISMATCH");
        callOrder = { ...parameters.toObject(), counter: p.counter };
        if (call.name === "fulfillAdvancedOrder") {
          if (
            call.args[1].length !== 0 ||
            order.numerator <= 0n ||
            order.denominator <= 0n ||
            order.numerator > order.denominator ||
            (size * order.numerator) % order.denominator !== 0n
          )
            fail("NFT_SALE_CALLDATA_QUANTITY_MISMATCH");
          callQuantity = (size * order.numerator) / order.denominator;
          callRecipient = same(call.args[3], ZERO) ? t.from : call.args[3];
        }
      }
      if (
        !same(
          orderHash("OrderComponents", types, callOrder),
          o.binding.orderHash,
        )
      )
        fail("NFT_SALE_CALLDATA_ORDER_MISMATCH");
      if (callQuantity > requested || (!listing && callQuantity !== requested))
        fail("NFT_SALE_CALLDATA_QUANTITY_MISMATCH");
      // Listing maker is not the future fulfiller. Never bind the buyer's nonce
      // or sender to the seller. Accept-offer is the seller's reviewed transaction.
      if (!listing) {
        const reviewed = pinnedReview;
        if (
          !reviewed ||
          reviewed.chainId !== o.chainId ||
          !same(reviewed.from, o.seller) ||
          !same(t.from, o.seller) ||
          !same(reviewed.to, t.to) ||
          !same(reviewed.data, t.data) ||
          reviewed.value !== t.value ||
          reviewed.value !== "0" ||
          !count(reviewed.nonce) ||
          reviewed.nonce !== t.nonce ||
          !same(reviewed.orderHash, o.binding.orderHash) ||
          ["nativePlanId", "nativeOperationId", "reviewDigest"].some(
            (k) =>
              typeof reviewed[k] !== "string" ||
              !reviewed[k] ||
              reviewed[k] !== o.binding[k],
          )
        )
          fail("NFT_SALE_ACCEPT_TRANSACTION_MISMATCH");
      }
      const indices = new Set(),
        filled = [],
        nftTransfers = [],
        payTransfers = [];
      for (const log of r.logs) {
        if (
          log.removed !== false ||
          !count(log.index) ||
          indices.has(log.index) ||
          !same(log.transactionHash, t.hash) ||
          !same(log.blockHash, r.blockHash) ||
          log.blockNumber !== r.blockNumber ||
          log.chainId !== o.chainId ||
          !isAddress(log.address) ||
          !Array.isArray(log.topics) ||
          log.topics.length > 4 ||
          log.topics.some((q) => !/^0x[0-9a-f]{64}$/i.test(q)) ||
          !bytes(log.data) ||
          log.data.length > 131074
        )
          fail("NFT_SALE_LOG_CONTEXT_INVALID");
        indices.add(log.index);
        if (same(log.address, o.protocol) && same(log.topics[0], saleTopic)) {
          const event = seaport.parseLog(log);
          filled.push({ args: event.args, index: log.index });
        }
        if (same(log.address, o.nft.contract)) {
          if (
            o.nft.standard === "erc721" &&
            same(log.topics[0], transferTopic)
          ) {
            const a = nft721.parseLog(log).args;
            nftTransfers.push({
              from: a.from,
              to: a.to,
              id: a.tokenId.toString(),
              quantity: "1",
            });
          } else if (
            o.nft.standard === "erc1155" &&
            same(log.topics[0], singleTopic)
          ) {
            const a = nft1155.parseLog(log).args;
            nftTransfers.push({
              from: a.from,
              to: a.to,
              id: a.id.toString(),
              quantity: a.value.toString(),
            });
          } else if (
            o.nft.standard === "erc1155" &&
            same(log.topics[0], batchTopic)
          ) {
            const a = nft1155.parseLog(log).args;
            if (a.ids.length !== a[4].length || a.ids.length > 256)
              fail("NFT_SALE_NFT_TRANSFER_INVALID");
            a.ids.forEach((id, i) =>
              nftTransfers.push({
                from: a.from,
                to: a.to,
                id: id.toString(),
                quantity: a[4][i].toString(),
              }),
            );
          }
        }
        if (
          !listing &&
          same(log.address, currency) &&
          same(log.topics[0], transferTopic)
        ) {
          const a = erc20.parseLog(log).args;
          payTransfers.push({
            from: a.from,
            to: a.to,
            amount: a.value.toString(),
          });
        }
      }
      // One-order scope: other fulfillment events make attribution ambiguous.
      // This also rejects a duplicate event even with a fresh log index.
      if (filled.length !== 1) fail("NFT_SALE_FULFILLMENT_SET_INVALID");
      const event = filled[0].args;
      if (!same(event.recipient, callRecipient))
        fail("NFT_SALE_CALLDATA_RECIPIENT_MISMATCH");
      if (
        !same(event.orderHash, o.binding.orderHash) ||
        !same(event.offerer, p.offerer) ||
        !same(event.zone, p.zone) ||
        !address(event.recipient) ||
        (listing
          ? same(event.recipient, o.seller)
          : !same(event.recipient, o.seller)) ||
        event.offer.length !== p.offer.length ||
        event.consideration.length !== p.consideration.length
      )
        fail("NFT_SALE_FULFILLMENT_MISMATCH");
      const nftItem = listing ? event.offer[0] : event.consideration[0];
      const quantity = uint(nftItem.amount.toString(), true);
      if (
        quantity > requested ||
        quantity > size ||
        quantity > callQuantity ||
        (basicCall && quantity !== size) ||
        (quantity < size && p.orderType % 2 === 0)
      )
        fail("NFT_SALE_FILL_QUANTITY_INVALID");
      const account = amounts(quantity);
      const itemsMatch = (actual, wanted, consideration) =>
        actual.every((a, index) => {
          const b = wanted[index];
          return (
            Number(a.itemType) === b.itemType &&
            same(a.token, b.token) &&
            a.identifier.toString() === b.identifierOrCriteria &&
            a.amount.toString() === account.scaled(b).toString() &&
            (!consideration || same(a.recipient, b.recipient))
          );
        });
      if (
        !itemsMatch(event.offer, p.offer, false) ||
        !itemsMatch(event.consideration, p.consideration, true)
      )
        fail("NFT_SALE_ITEM_OR_AMOUNT_MISMATCH");
      const buyer = listing ? event.recipient : p.offerer;
      const selectedTransfers = nftTransfers.filter(
        (n) => n.id === o.nft.tokenId,
      );
      if (
        selectedTransfers.length !== 1 ||
        !same(selectedTransfers[0].from, o.seller) ||
        !same(selectedTransfers[0].to, buyer) ||
        selectedTransfers[0].quantity !== quantity.toString()
      )
        fail("NFT_SALE_NFT_TRANSFER_MISMATCH");
      let accountingBasis;
      if (listing) {
        // ETH has no ERC20 Transfer event. Successful execution by pinned,
        // reviewed Seaport code proves the exact native consideration items;
        // it does not measure transaction balance deltas or current balances.
        if (BigInt(t.value) < BigInt(account.gross))
          fail("NFT_SALE_NATIVE_VALUE_INSUFFICIENT");
        accountingBasis = "PINNED_SEAPORT_NATIVE_CONSIDERATION";
      } else {
        const feeItems = p.consideration.slice(1).map((i) => ({
          to: i.recipient,
          amount: account.scaled(i).toString(),
        }));
        const allFeeTotal = feeItems.reduce((n, i) => n + BigInt(i.amount), 0n);
        if (allFeeTotal >= BigInt(account.gross))
          fail("NFT_SALE_SELLER_PROCEEDS_INVALID");
        const standard = [
          { from: buyer, to: o.seller, amount: account.gross },
          ...feeItems.map((i) => ({ from: o.seller, ...i })),
        ];
        const basic = [
          {
            from: buyer,
            to: o.seller,
            amount: (BigInt(account.gross) - allFeeTotal).toString(),
          },
          ...feeItems.map((i) => ({ from: buyer, ...i })),
        ];
        const key = (v) =>
          `${v.from.toLowerCase()}:${v.to.toLowerCase()}:${v.amount}`;
        const exact = (expectedTransfers) =>
          JSON.stringify(payTransfers.map(key).sort()) ===
          JSON.stringify(expectedTransfers.map(key).sort());
        if (!exact(basicCall ? basic : standard))
          fail("NFT_SALE_PAYMENT_TRANSFER_MISMATCH");
        accountingBasis = "SEAPORT_ITEMS_AND_EXACT_ERC20_TRANSFER_LOGS";
      }
      const { scaled: _scaled, ...accounting } = account;
      return freeze({
        state: "CONFIRMED",
        verified: true,
        kind: "NFT_SALE_FILL",
        canonical: true,
        saleComplete: quantity === requested,
        orderComplete: quantity === size,
        chainId: o.chainId,
        sourceId: v.sourceId,
        observedAt: v.observedAt,
        observationPolicyId: policy.id,
        finality: "NOT_EVALUATED",
        confirmations,
        transactionHash: t.hash,
        blockHash: r.blockHash,
        blockNumber: r.blockNumber,
        fillId: `${o.chainId}:${t.hash.toLowerCase()}:${filled[0].index}`,
        orderHash: o.binding.orderHash,
        orderDigest: kernelRequestDigest(o),
        evidenceDigest: kernelRequestDigest(v),
        seller: o.seller,
        buyer: listing ? t.from : p.offerer,
        fulfiller: t.from,
        nftRecipient: buyer,
        nft: o.nft.contract,
        tokenId: o.nft.tokenId,
        quantity: quantity.toString(),
        requestedQuantity: requested.toString(),
        orderQuantity: size.toString(),
        paymentToken: currency,
        ...accounting,
        accountingBasis,
        sellerNetBasis: "TOKEN_PROCEEDS_EXCLUDING_GAS",
        usdProceeds: "NOT_EVALUATED",
        transactionBalanceDeltaMeasured: false,
        currentOwnership: "NOT_EVALUATED",
        currentBalances: "NOT_EVALUATED",
        priorFills: "NOT_EVALUATED",
        authorizationChanged: false,
        budgetChanged: false,
      });
    } catch (error) {
      return freeze({
        state: "UNKNOWN",
        verified: false,
        kind: "NFT_SALE_FILL",
        canonical: false,
        saleComplete: false,
        orderComplete: false,
        reason: /^NFT_SALE_[A-Z0-9_]+$/.test(error?.message ?? "")
          ? error.message
          : "NFT_SALE_EVIDENCE_INVALID",
      });
    }
  };
}
