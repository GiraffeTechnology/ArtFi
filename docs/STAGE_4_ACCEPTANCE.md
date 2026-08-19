# Stage 4 acceptance evidence

Stage 4 implements an approved-source external marketplace mirror, governance, and
event-reconciliation boundaries while preserving the existing user interface for debugging.
It does not operate an ArtFi exchange.

## Delivered

- Versioned `MarketplaceAdapter` boundary with OpenSea as the first approved implementation.
- A stable normalized event schema and source allowlist reserve the integration seam for another
  reviewed marketplace adapter without adding order creation, signing, custody, or settlement.
- OpenSea real-time Stream ingestion plus REST backfill for gaps; event versions are scoped by
  source entity/family so out-of-order delivery converges without comparing incompatible counters.
- Sale events converge orders to a terminal `fulfilled` state; delayed listing/cancellation events
  remain auditable but cannot reactivate a fulfilled order.
- Durable external event/order projections with original payload, source attribution, idempotency,
  stale-version rejection, and HTTPS deep links back to the executing marketplace.
- Public read-only activity API. The adapter capability contract hard-codes order creation,
  fulfillment, custody, signing, matching, and settlement as unavailable.
- `FractionalToken` EIP-712 delegation and historical vote checkpoints.
- OpenZeppelin-based Governor with proposal threshold, quorum, voting window, mandatory Timelock
  queue/execution, and atomic bootstrap that leaves no bootstrap administrator.
- Search, status filtering, deterministic pagination, public portfolio read models, and regenerated
  OpenAPI TypeScript types.
- Credential-gated Sepolia event ingestion with canonical identity, payload-conflict rejection,
  replay updates, confirmation tracking, removal handling, and reorg replacement.
- Transactional ERC-20 transfer projection into an append-only delta ledger; portfolio balances are
  rebuilt with arbitrary-precision integers from canonical, non-removed events.
- MySQL 8.4 schemas for external market events/orders, portfolio deltas, transactions,
  notifications, proposals, and votes, with a complete Stage 4 rollback.

## Verified development evidence

- The future `ArtFiMarket` candidate remains in security regression tests but is excluded from the
  Stage 4 deployment script and current release manifest.
- Adapter tests cover normalization, stable idempotency fingerprints, malformed source events,
  and capability boundaries.
- Governance tests prove Timelock self-administration, Governor-only proposer/canceller roles, and
  removal of the bootstrap administrator.
- MySQL integration tests cover indexer authentication, identical replay, payload conflict,
  transfer projection, event removal, reorg replacement, and restart persistence.
- MySQL migration sequence: Stage 1–4 `14` tables; Stage 4 rollback `7`; Stage 3 rollback `5`;
  Stage 2 rollback `2`; full rollback `0`.
- The legacy UI is intentionally retained; contract action binding and visual iteration are part of
  the final integrated debugging pass requested for this delivery.

## External exit gates still required

- Deploy and verify only the reviewed governance bytecode on Sepolia using approved role addresses
  and signers; do not deploy `ArtFiMarket`.
- Reconcile real Sepolia receipts through an approved RPC/indexer and exercise reorg recovery.
- Independently review governance parameters, Timelock delay, external-source terms, attribution,
  availability, and data-retention assumptions.
- Complete licensed-asset, jurisdiction, investor eligibility, and payment-token approvals before
  any real asset or value is accepted.

OpenSea Stream is used only for approved mainnet marketplace activity because the current SDK does
not support testnets. Sepolia asset discovery is a separate NFT metadata/API validation track; it
must not be represented as Stream coverage.

No ArtFi exchange, mainnet, real asset, real-money, or unreviewed marketplace source is enabled by
this stage.
