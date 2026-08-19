# Stage 4 acceptance evidence

Stage 4 implements the Sepolia market, participation, governance, and event-reconciliation
boundaries while preserving the existing user interface for integrated debugging.

## Delivered

- `ArtFiMarket` with allowlisted ERC-20 assets/payment tokens, escrowed fixed-price partial fills,
  expiry-bound auctions, pull-based outbid refunds and seller proceeds, cancellation rules, and
  settlement that remains callable while paused.
- Capped token offerings with minimum raise, hard cap, deterministic allocations, success claims,
  failure refunds, and unsold-token recovery.
- `FractionalToken` EIP-712 delegation and historical vote checkpoints.
- OpenZeppelin-based Governor with proposal threshold, quorum, voting window, mandatory Timelock
  queue/execution, and atomic bootstrap that leaves no bootstrap administrator.
- Search, status filtering, deterministic pagination, public portfolio read models, and regenerated
  OpenAPI TypeScript types.
- Credential-gated Sepolia event ingestion with canonical identity, payload-conflict rejection,
  replay updates, confirmation tracking, removal handling, and reorg replacement.
- Transactional ERC-20 transfer projection into an append-only delta ledger; portfolio balances are
  rebuilt with arbitrary-precision integers from canonical, non-removed events.
- MySQL 8.4 schemas for market, offers, portfolio deltas, transactions, notifications, proposals,
  and votes, with a complete Stage 4 rollback.

## Verified development evidence

- Foundry Stage 4: 6/6 tests covering fixed fills, auction refund/expiry/settlement, request replay
  conflict, offering claim/refund, and proposal-vote-queue-timelock-execute lifecycle.
- Governance tests prove Timelock self-administration, Governor-only proposer/canceller roles, and
  removal of the bootstrap administrator.
- MySQL integration tests cover indexer authentication, identical replay, payload conflict,
  transfer projection, event removal, reorg replacement, and restart persistence.
- MySQL migration sequence: Stage 1–4 `14` tables; Stage 4 rollback `7`; Stage 3 rollback `5`;
  Stage 2 rollback `2`; full rollback `0`.
- The legacy UI is intentionally retained; contract action binding and visual iteration are part of
  the final integrated debugging pass requested for this delivery.

## External exit gates still required

- Deploy and verify reviewed Stage 4 bytecode on Sepolia using approved role addresses and signers.
- Reconcile real Sepolia receipts through an approved RPC/indexer and exercise reorg recovery.
- Independently review governance parameters, Timelock delay, token allowlists, and market economic
  assumptions.
- Complete licensed-asset, jurisdiction, investor eligibility, and payment-token approvals before
  any real asset or value is accepted.

No mainnet, real asset, real-money, or unreviewed payment token is enabled by this stage.
