import { kernelRequestDigest } from "./agent-kernel.mjs";
import { createNftSaleEvidenceEvaluator } from "./nft-sale-evidence.mjs";

const fail = (reason) => {
  throw Error(reason);
};
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const hash = (v) =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v) && !/^0x0{64}$/i.test(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const freeze = (v) => {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const quantity = (v) => {
  if (typeof v !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v))
    fail("NFT_SALE_OBSERVER_RPC_QUANTITY_INVALID");
  const n = BigInt(v);
  if (n >= 1n << 256n) fail("NFT_SALE_OBSERVER_RPC_QUANTITY_INVALID");
  return n;
};
const number = (v) => {
  const n = quantity(v);
  if (n > BigInt(Number.MAX_SAFE_INTEGER))
    fail("NFT_SALE_OBSERVER_RPC_QUANTITY_INVALID");
  return Number(n);
};
const hex = (v) => `0x${v.toString(16)}`;
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : v);
const READ_METHODS = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getLogs",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getCode",
]);
const CURSOR = "artfi-listed-order-cursor/1";

/**
 * Bounded, read-only discovery for an already-published seller listing.
 * Composition supplies the frozen terms output, reviewed code pins, source and
 * observation policy, and one trusted EIP-1193-style reader. Only its request
 * function is captured; no signer, generic caller RPC, wallet grant, venue API,
 * publish/cancel/retry authority, or persistence is exposed.
 *
 * CONFIRMED means the returned fills have complete evaluator evidence. Neither
 * an empty result nor scanStatus proves absence, cancellation or expiry.
 * Each fill retains the evaluator's per-fill completion semantics. Cumulative
 * quantities/completion and persistent fillId deduplication belong to the
 * existing consumer; this module never creates a second ledger.
 * Cursors are public checkpoints, not authenticated proof of prior coverage.
 * A durable consumer must store/recover its own trusted cursor. Reported scan
 * bounds cover this invocation only; even an in-range forged cursor cannot
 * establish aggregate completion or absence of earlier fills.
 */
export function createListedOrderObserver({
  ethers,
  orderTypes,
  seaportABI,
  allowedDeployments,
  expectedOrder,
  observationPolicy,
  readOnlyProvider,
  scanPolicy,
  now,
}) {
  const pinned = freeze(
    structuredClone({
      expectedOrder,
      observationPolicy,
      allowedDeployments,
      scanPolicy,
    }),
  );
  const order = pinned.expectedOrder,
    policy = pinned.observationPolicy,
    scan = pinned.scanPolicy;
  if (
    order?.nativeAction !== "list" ||
    typeof readOnlyProvider?.request !== "function" ||
    readOnlyProvider.sourceId !== policy?.sourceId ||
    typeof now !== "function" ||
    !scan ||
    !count(scan.fromBlock) ||
    scan.fromBlock < 1 ||
    !count(scan.throughBlock) ||
    scan.throughBlock < scan.fromBlock ||
    scan.throughBlock >= Number.MAX_SAFE_INTEGER ||
    ![
      [scan.blocksPerPage, 10000],
      [scan.maxPagesPerRun, 100],
      [scan.maxLogsPerPage, 10000],
      [scan.maxCandidatesPerRun, 1000],
    ].every(([v, max]) => count(v) && v >= 1 && v <= max)
  )
    fail("NFT_SALE_OBSERVER_CONFIGURATION_INVALID");
  const evaluate = createNftSaleEvidenceEvaluator({
    ethers,
    orderTypes,
    seaportABI,
    ...pinned,
  });
  const request = readOnlyProvider.request.bind(readOnlyProvider),
    clock = now,
    iface = new ethers.Interface(structuredClone(seaportABI)),
    topic = iface.getEvent("OrderFulfilled").topicHash.toLowerCase(),
    sellerTopic = `0x${order.seller.slice(2).toLowerCase().padStart(64, "0")}`,
    bindingDigest = kernelRequestDigest(pinned);
  const initialCursor = freeze({
    schema: CURSOR,
    bindingDigest,
    nextBlock: scan.fromBlock,
    checkpoint: null,
  });
  const rpc = async (method, params = []) => {
    if (!READ_METHODS.has(method)) fail("NFT_SALE_OBSERVER_WRITE_FORBIDDEN");
    try {
      // Detached data avoids provider mutation after a promise resolves.
      return structuredClone(await request({ method, params }));
    } catch {
      fail("NFT_SALE_OBSERVER_PROVIDER_FAILURE");
    }
  };
  const assertChain = async () => {
    if (quantity(await rpc("eth_chainId")).toString() !== order.chainId)
      fail("NFT_SALE_OBSERVER_CHAIN_MISMATCH");
  };
  const chainContext = (v) => {
    if (
      v?.chainId !== undefined &&
      quantity(v.chainId).toString() !== order.chainId
    )
      fail("NFT_SALE_OBSERVER_CHAIN_MISMATCH");
  };
  const readBlock = async (tag) => {
    const b = await rpc("eth_getBlockByNumber", [tag, false]);
    if (!b || !hash(b.hash)) fail("NFT_SALE_OBSERVER_BLOCK_UNAVAILABLE");
    chainContext(b);
    const result = {
      chainId: order.chainId,
      number: number(b.number),
      hash: b.hash,
      timestamp: number(b.timestamp),
    };
    if (tag !== "latest" && result.number !== number(tag))
      fail("NFT_SALE_OBSERVER_BLOCK_MISMATCH");
    return result;
  };
  const logContext = (l) => {
    chainContext(l);
    if (!l || !hash(l.transactionHash) || !hash(l.blockHash))
      fail("NFT_SALE_OBSERVER_LOG_INVALID");
    return {
      chainId: order.chainId,
      address: lower(l.address),
      topics: Array.isArray(l.topics) ? l.topics.map(lower) : l.topics,
      data: lower(l.data),
      removed: l.removed,
      transactionHash: lower(l.transactionHash),
      blockHash: lower(l.blockHash),
      blockNumber: number(l.blockNumber),
      index: number(l.logIndex),
    };
  };
  const cursorValid = (c) =>
    c?.schema === CURSOR &&
    c.bindingDigest === bindingDigest &&
    count(c.nextBlock) &&
    c.nextBlock >= scan.fromBlock &&
    c.nextBlock <= scan.throughBlock + 1 &&
    (c.nextBlock === scan.fromBlock
      ? c.checkpoint === null
      : c.checkpoint?.number === c.nextBlock - 1 && hash(c.checkpoint.hash));
  const result = (fills, cursor, progress, reason, scanStatus = "BLOCKED") =>
    freeze({
      kind: "NFT_LISTED_ORDER_OBSERVATION",
      state: fills.length ? "CONFIRMED" : "UNKNOWN",
      verified: fills.length > 0,
      saleStatus: fills.length ? "VERIFIED_FILLS" : "UNKNOWN",
      scanStatus,
      reason,
      chainId: order.chainId,
      sourceId: policy.sourceId,
      orderHash: order.binding.orderHash,
      orderDigest: kernelRequestDigest(order),
      observationPolicyId: policy.id,
      fills,
      nextCursor: cursor,
      scan: progress,
      cumulativeCompletion: "NOT_EVALUATED",
      onchainOrderStatus: "NOT_EVALUATED",
      priorFills: "NOT_EVALUATED",
      authorizationChanged: false,
      budgetChanged: false,
      resendAuthorized: false,
    });

  return async (input = {}) => {
    let cursor = initialCursor;
    const emptyProgress = {
      fromBlock: scan.fromBlock,
      throughBlock: scan.throughBlock,
      pages: 0,
      coverageScope: "THIS_INVOCATION_ONLY",
      scannedFromBlock: null,
      scannedThroughBlock: null,
    };
    try {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== "cursor")
      )
        fail("NFT_SALE_OBSERVER_INPUT_INVALID");
      cursor = freeze(structuredClone(input.cursor ?? initialCursor));
      if (!cursorValid(cursor)) {
        cursor = initialCursor;
        fail("NFT_SALE_OBSERVER_CURSOR_INVALID");
      }
      await assertChain();
      if (cursor.checkpoint) {
        const checkpoint = await readBlock(hex(cursor.checkpoint.number));
        if (!same(checkpoint.hash, cursor.checkpoint.hash))
          fail("NFT_SALE_OBSERVER_CURSOR_REORG");
      }
      const head = await readBlock("latest"),
        through = Math.min(
          scan.throughBlock,
          head.number - policy.minimumConfirmations + 1,
        ),
        fills = [],
        seen = new Map(),
        anchors = new Map();
      const addAnchor = (n, h) => {
        if (anchors.has(n) && !same(anchors.get(n), h))
          fail("NFT_SALE_OBSERVER_REORG");
        anchors.set(n, h);
      };
      if (cursor.checkpoint)
        addAnchor(cursor.checkpoint.number, cursor.checkpoint.hash);
      addAnchor(head.number, head.hash);
      let next = cursor,
        pages = 0,
        candidates = 0;
      while (next.nextBlock <= through && pages < scan.maxPagesPerRun) {
        const start = next.nextBlock,
          end = Math.min(start + scan.blocksPerPage - 1, through),
          boundary = await readBlock(hex(end));
        const logs = await rpc("eth_getLogs", [
          {
            address: order.protocol,
            fromBlock: hex(start),
            toBlock: hex(end),
            // orderHash is NOT indexed. Only offerer and zone are indexed.
            topics: [topic, sellerTopic],
          },
        ]);
        if (!Array.isArray(logs) || logs.length > scan.maxLogsPerPage)
          fail("NFT_SALE_OBSERVER_LOG_LIMIT");
        for (const raw of logs) {
          const l = logContext(raw),
            id = `${order.chainId}:${l.transactionHash.toLowerCase()}:${l.index}`,
            fingerprint = kernelRequestDigest(l);
          if (seen.has(id)) {
            if (seen.get(id) !== fingerprint)
              fail("NFT_SALE_OBSERVER_CONFLICTING_DUPLICATE");
            // Identical provider overlap is harmless, including across pages.
            continue;
          }
          if (
            l.blockNumber < start ||
            l.blockNumber > end ||
            l.removed !== false ||
            !same(l.address, order.protocol) ||
            !Array.isArray(l.topics) ||
            l.topics.length !== 3 ||
            l.topics.some((v) => !/^0x[0-9a-f]{64}$/i.test(v)) ||
            typeof l.data !== "string" ||
            !/^0x(?:[0-9a-f]{2})*$/i.test(l.data) ||
            l.data.length > 131074 ||
            !same(l.topics[0], topic) ||
            !same(l.topics[1], sellerTopic)
          )
            fail("NFT_SALE_OBSERVER_LOG_FILTER_MISMATCH");
          let decoded;
          try {
            decoded = iface.parseLog(l);
          } catch {
            fail("NFT_SALE_OBSERVER_LOG_DECODE_INVALID");
          }
          if (!decoded || !same(decoded.args.offerer, order.seller))
            fail("NFT_SALE_OBSERVER_LOG_FILTER_MISMATCH");
          seen.set(id, fingerprint);
          if (!same(decoded.args.orderHash, order.binding.orderHash)) continue;
          if (++candidates > scan.maxCandidatesPerRun)
            fail("NFT_SALE_OBSERVER_CANDIDATE_LIMIT");

          const before = await readBlock(hex(l.blockNumber)),
            rawTransaction = await rpc("eth_getTransactionByHash", [
              l.transactionHash,
            ]),
            rawReceipt = await rpc("eth_getTransactionReceipt", [
              l.transactionHash,
            ]);
          if (!rawTransaction || !rawReceipt)
            fail("NFT_SALE_OBSERVER_EVIDENCE_UNAVAILABLE");
          chainContext(rawTransaction);
          chainContext(rawReceipt);
          if (!same(rawTransaction.to, order.protocol))
            fail("NFT_SALE_OBSERVER_ROUTE_UNSUPPORTED");
          const transaction = {
            chainId: order.chainId,
            hash: rawTransaction.hash,
            blockHash: rawTransaction.blockHash,
            blockNumber: number(rawTransaction.blockNumber),
            from: rawTransaction.from,
            to: rawTransaction.to,
            data: rawTransaction.input,
            value: quantity(rawTransaction.value).toString(),
            nonce: number(rawTransaction.nonce),
          };
          if (!Array.isArray(rawReceipt.logs) || rawReceipt.logs.length > 512)
            fail("NFT_SALE_OBSERVER_RECEIPT_LOG_LIMIT");
          const receipt = {
            chainId: order.chainId,
            transactionHash: rawReceipt.transactionHash,
            blockHash: rawReceipt.blockHash,
            blockNumber: number(rawReceipt.blockNumber),
            from: rawReceipt.from,
            to: rawReceipt.to,
            status: number(rawReceipt.status),
            logs: rawReceipt.logs.map(logContext),
          };
          if (
            !same(transaction.hash, l.transactionHash) ||
            !same(receipt.blockHash, l.blockHash) ||
            receipt.blockNumber !== l.blockNumber ||
            !receipt.logs.some((r) => kernelRequestDigest(r) === fingerprint)
          )
            fail("NFT_SALE_OBSERVER_DISCOVERY_RECEIPT_MISMATCH");
          const runtimeCode = await rpc("eth_getCode", [
            order.protocol,
            { blockHash: receipt.blockHash, requireCanonical: true },
          ]);
          const after = await readBlock(hex(l.blockNumber)),
            observedAt = clock();
          if (!count(observedAt)) fail("NFT_SALE_OBSERVER_CLOCK_INVALID");
          const assessment = evaluate({
            evidence: {
              chainId: order.chainId,
              sourceId: policy.sourceId,
              observationPolicyId: policy.id,
              observedAt,
              transaction,
              receipt,
              canonicalBlockBefore: before,
              canonicalBlockAfter: after,
              head,
              deploymentEvidence: {
                chainId: order.chainId,
                address: order.protocol,
                blockNumber: receipt.blockNumber,
                blockHash: receipt.blockHash,
                runtimeCode,
              },
            },
          });
          if (!assessment.verified) fail(assessment.reason);
          if (assessment.fillId !== id)
            fail("NFT_SALE_OBSERVER_DISCOVERY_RECEIPT_MISMATCH");
          fills.push(assessment);
          addAnchor(after.number, after.hash);
        }
        addAnchor(end, boundary.hash);
        next = freeze({
          schema: CURSOR,
          bindingDigest,
          nextBlock: end + 1,
          checkpoint: { number: end, hash: boundary.hash },
        });
        pages++;
      }
      // Recheck every observed fill/page anchor after all reads, including a
      // resumed cursor, and the confirmation head. Reorgs never commit progress.
      for (const [n, h] of anchors) {
        if (!same((await readBlock(hex(n))).hash, h))
          fail("NFT_SALE_OBSERVER_REORG");
      }
      await assertChain();
      fills.sort(
        (a, b) =>
          a.blockNumber - b.blockNumber || a.fillId.localeCompare(b.fillId),
      );
      return result(
        fills,
        next,
        {
          ...emptyProgress,
          pages,
          scannedFromBlock: pages ? cursor.nextBlock : null,
          scannedThroughBlock: pages ? next.nextBlock - 1 : null,
          confirmedThroughBlock: through,
          head,
        },
        fills.length
          ? "NFT_SALE_OBSERVER_VERIFIED_FILLS"
          : "NFT_SALE_OBSERVER_NO_VERIFIED_FILL",
        pages ? "SCANNED" : "NO_NEW_RANGE",
      );
    } catch (error) {
      // Atomic per invocation: a failure emits no fills and does not advance
      // even past earlier good pages. A retry returns stable fillIds; consumers
      // must deduplicate before accounting. There is no transaction resubmission.
      return result(
        [],
        cursor,
        emptyProgress,
        /^NFT_SALE_[A-Z0-9_]+$/.test(error?.message ?? "")
          ? error.message
          : "NFT_SALE_OBSERVER_EVIDENCE_INVALID",
      );
    }
  };
}
