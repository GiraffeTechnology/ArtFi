# Indexed portfolio performance and notifications

## Requirement and boundary

This implements the inherited personal-center holdings/P&L and notifications in
`docs/PRD.md` section 4.3 under #110/#84. It adds a read-only calculation and
wallet-event notices to the existing authenticated Hoodi portfolio. It does not
change settlement, custody, registry authority, or the meaning of any asset.

`GET /v1/portfolio/{address}` requires a live wallet JWT matching the address and
Hoodi chain. The web BFF forwards its authenticated session token. Both routes
return `Cache-Control: no-store`. The client unmounts private content on logout,
expiry, wallet change, or chain change and aborts departed requests. An explicit
refresh reloads positions, performance and notices together.

## Calculation

- Use only canonical, confirmed indexed `IntentFilled` records joined to a
  persisted fractional authorization by chain, market address, and intent hash.
- Verify the seller, asset/payment currencies, positive integer quantities, and
  exact `amount × unitPrice = payment`. Reconcile the aggregate asset quantity
  with `Transfer` records from the same seller to buyer, transaction and block
  hash. Multiple partial fills are aggregated without counting a transfer twice.
- Process buys and sells in block/log order. Ethereum log index orders logs
  across the block. Consume acquisition lots FIFO with arbitrary-precision
  integer arithmetic; no floating point, decimal guess, or fiat price is used.
- Return remaining cost basis and realized P&L in payment-token base units.
  Quantities are asset-token base units. Gas and other unindexed costs are
  excluded. There is no current market mark or unrealized P&L estimate.
- An unmatched inbound/outbound transfer, missing acquisition lot, pending
  evidence, mismatched fill/transfer, currency change, invalid amount or missing
  sale terms makes the affected basis and P&L unknown (`null`), never false zero.
  Self-transfers and zero transfers do not create acquisitions/dispositions.
- Unsupported whole-artwork/NFT fills and missing mappings are counted as
  unmapped. A known fractional item does not establish complete wallet history,
  a tax basis, fiat value, or physical ownership. Untouched asset classes and
  balances absent from the index are not guessed.
- Calculations are bounded to 20,000 wallet-relevant evidence records. Exceeding
  that limit returns unknown with an explanation and no partial totals.

The response is read from one repeatable-read SQL snapshot. Performance is
reconstructed rather than maintaining a second mutable ledger. Replayed events
retain their identity. Removed evidence is excluded; reinstated canonical
records are recalculated. The existing raw positions include pending transfers,
which is disclosed separately from the confirmed performance quantities.

## Notifications

Notices are derived from the latest 100 persisted wallet-participant events by
indexed update time, including pending, confirmed and removed states. The ID is
`chain:transaction:log`; status changes update the existing notice. A removal
explicitly supersedes prior confirmation. A reorg update to an older block can
therefore appear at the top of the notices even when it is outside the latest
100 chain-ordered history entries.

The participant fields include transfer addresses, seller, buyer, bidder,
highest bidder, contributor, account, proposer and voter. The same set controls
cache invalidation. An event containing only an opaque listing/order identifier
without an indexed wallet participant is not claimed as a personal notice.
There is no email/SMS subscription, external delivery, or invented read state.

## Verification

- Pure Go projection tests cover exact large integers, positive and negative
  realized returns, partial FIFO sales, unknown/missing evidence, currency
  changes, pending transfers, unsupported terms, self/zero transfers, aggregate
  fills, deterministic order, and reorg removal/reinstatement.
- Actual-MySQL tests exercise authenticated API reads, persistence/restart,
  duplicate delivery, buyer/seller history, bidder pending/confirmed/removed
  notices, cache invalidation and deterministic P&L after reorg.
- Web unit tests exercise exact rendering, explicit unknown states, removed
  notices, authenticated gating, late-request cancellation, and data validation.
- The existing desktop/mobile portfolio browser scenario includes P&L, notice
  refresh/removal, and hiding both on wallet change. Browser execution is part
  of the final integration owner's suite; do not infer a pass from test presence.
