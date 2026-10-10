# Seller listing read-only observation

Requirement trace: #110's native NFT/OpenSea result tracking and read-only
projection boundary; the bounded seller-listing increment continues the existing
Stage 1 terms and settlement-evidence interfaces. It introduces no marketplace,
signing authority, transaction executor, grant or accounting ledger.

## Composition interface

`scripts/agent/listed-order-observer.mjs` exports `createListedOrderObserver`.
The trusted composition root supplies:

- `ethers`, official `orderTypes` and `seaportABI`.
- The frozen `expectedOrder` from `createNftSaleTermsVerifier`; only `list` is
  supported. A terms result is not publication or execution authorization.
- Explicit `observationPolicy`, including task digest, chain, source ID and
  minimum confirmations, and reviewed `allowedDeployments` with runtime hashes
  and native-consideration accounting policy. These use the existing evaluator
  contracts unchanged.
- `readOnlyProvider: { sourceId, request }`, an EIP-1193-style trusted reader.
  Composition owns its endpoint, authentication and request timeout. Source ID
  must match the observation policy. The request function is captured once.
- `scanPolicy: { fromBlock, throughBlock, blocksPerPage, maxPagesPerRun,
maxLogsPerPage, maxCandidatesPerRun }`. All bounds are required; maximums are
  respectively 10,000 blocks per page, 100 pages, 10,000 logs per page and 1,000
  candidate fills per invocation. The scan window never expands implicitly.
- `now`, a captured clock returning nonnegative integer milliseconds.

The factory returns `async observe({ cursor } = {})`. No other per-call input
is accepted. Callers cannot replace orders, pins, provider or policy. The factory
deep-copies and freezes input data; it does not mutate its dependencies.

Only `eth_chainId`, `eth_getBlockByNumber`, `eth_getLogs`,
`eth_getTransactionByHash`, `eth_getTransactionReceipt` and `eth_getCode` are
issued. There is no arbitrary RPC method input. Code reads use EIP-1898
`{ blockHash, requireCanonical: true }` at the execution block; an unsupported
provider returns `UNKNOWN` rather than falling back to current code.

## Evidence and scan semantics

Logs are filtered by Seaport address, `OrderFulfilled` topic and indexed seller.
`orderHash` is not indexed and is compared only after official ABI decoding.
Other orders from that seller are skipped. The exact selected discovery log must
occur in the retrieved receipt. Hexadecimal casing is normalized for this
comparison and duplicate detection.

The observer reads transaction, receipt, canonical execution block before and
after, confirmation head and execution-block runtime code. It passes the complete
envelope to `createNftSaleEvidenceEvaluator`. It implements no second event,
transfer or price validator. Every fill retains the evaluator's stable `fillId`,
quantity, gross, fees, seller net, transaction/block evidence and accounting
limitations. Direct supported single-order Seaport calls remain the only routes;
router and batch execution are unknown/unsupported, not evidence of no sale.

Every fill and page anchor, the resumed cursor checkpoint and the confirmation
head are checked after reads. Contradictory hashes at the same height fail closed
instead of overwriting one another. Confirmation depth is not absolute finality.

- `saleStatus` is `VERIFIED_FILLS` only when complete evidence exists for the
  returned fills; otherwise it is `UNKNOWN`.
- `scanStatus` is `SCANNED` for successful bounded page reads, `NO_NEW_RANGE`
  when no confirmed block in the supplied window remains for this invocation,
  or `BLOCKED` on a read, evidence, bound or consistency failure. Thus an empty
  page can advance normally while sale status remains unknown.
- `scan.scannedFromBlock` and `scan.scannedThroughBlock` describe only this
  invocation; both are null when nothing was committed. There is no global
  scan-completion, no-sale or order-cancellation assertion.
- A failure is atomic for the invocation: no fills are emitted and the original
  valid cursor is preserved. Unknown results never authorize retransmission.
- Each fill's `saleComplete` and `orderComplete` come unchanged from the evaluator
  and describe that individual fill. The observer never adds partial quantities
  together or declares cumulative completion.

## Consumer responsibilities and cursor trust

Persist/deduplicate verified fills in the existing consumer by stable
`chainId:transactionHash:logIndex` before adding quantity or proceeds. Repeating an
invocation can legitimately return the same fill IDs. Identical overlap within
one invocation, including across pages, emits only one copy; conflicting copies
make the invocation unknown. No additional ledger exists here.

The cursor binds the order, observation policy, deployment pins and scan policy,
and includes the next block and prior checkpoint hash. Its range and binding are
validated and its checkpoint is rechecked against the provider on every resume.
It is public data, not authenticated proof that earlier pages were scanned.
The existing durable consumer must save and recover its own trusted cursor; do
not accept arbitrary client checkpoints as completed observation history. Even
a forged in-range checkpoint cannot produce an aggregate completion or absence
claim. A reorg reports unknown with the cursor unchanged; reconciliation of
previously consumed fills and selection of a trusted rewind point belong to the
existing consumer, not a new observer ledger.

The reader remains a trust boundary: this module cannot authenticate fabricated
RPC responses or prove that a provider did not omit logs. Explicit bounded source
configuration and reviewed code pins are mandatory. Nothing here performs an
OpenSea request, checks publication acceptance, cancels an order or renews a grant.
Grant expiry/revocation does not prohibit historical read-only observation and
does not prove cancellation of an already-published order.

## Verification scope

Run the targeted suite with Node 24:

`node --test scripts/agent/listed-order-observer.test.mjs`

The fixture uses the installed official ABI, existing Stage 1 TypeScript terms
validation and unchanged evidence evaluator. It has no network client or signer.
Coverage includes both supported chains and NFT standards; exact/nonindexed
order matching; page limits and continuation; duplicate and partial fills;
cursor tampering and reorgs; same-height anchor conflicts; receipt/code/source
binding; provider failures; route restrictions; and the terms-to-observer-to-
evaluator boundary. These are synthetic tests, not genuine-chain or deployed
workflow acceptance. No real RPC, OpenSea call, key access, signature, broadcast,
listing publication, cancellation, PR/main change or package update is performed.
