# Fractional price-time matching and amendment

Authority: inherited #110/#84, coordinated in `PRD.md` §4.2. This implementation uses the existing
`ArtFiMarket` signed-sale contract and introduces no custody, seller privilege, fee change,
unsigned settlement authority, or real-value execution.

## Delivered workflow

1. A seller signs an EIP-712 limit sale with a maximum cumulative quantity. Publication keeps the
   original signature, terms and server-assigned publication timestamp immutable. Exact retries
   retain priority.
2. `GET /v1/orders/fraction-book` returns an explicitly scoped fraction/payment pair at an observed
   chain timestamp, ordered by numeric uint256 unit price, precise publication time, then intent
   hash. There is no seller-role field or preferred-seller branch. Unknown/duplicate query fields
   are rejected. One database read captures the candidate log; responses carry a SHA-256 log ID.
3. The native fractional screen offers market execution with a maximum total payment, or immediate
   limit execution with both a unit-price ceiling and a maximum total payment. A preview reads one
   mined block, validates each applicable original EOA/EIP-1271 signature, seller epoch, cumulative
   fill, seller balance/allowance, pair permissions, pause state, and buyer balance/pilot headroom.
   Multiple intents from the same seller share their observed token and allowance capacity.
4. The reviewed plan names each original intent, amount and payment. Each fill uses the existing
   wallet-signed transaction and seller authorization. Signatures and current authority are checked
   again before approval and after approval, before requesting settlement. Each exact payment
   approval is bounded. The existing journal prevents duplicate wallet requests and retains
   unresolved broadcasts across reloads.
5. Multi-order execution is sequential. Each fill is atomic; the entire multi-order plan is not.
   Rejection, pending receipt, changed terms/account/session, navigation or an unavailable order
   stops execution. Already confirmed fills remain completed. The screen asks for a fresh preview
   rather than silently increasing quantities, substituting terms, or replaying confirmed fills.
6. A seller can load a published order after reload and withdraw it, or choose **Amend this order**.
   Amendment validates proposed replacement fields, retires the original on chain, verifies that
   its authority is exhausted or its epoch superseded, then requests a new signature with a fresh
   cryptographic salt. Publication of the replacement is explicit and gets a new timestamp.
   Earlier fills remain unchanged. A rejected/interrupted replacement signature cannot revive the
   original; retry checks chain retirement before requesting another revocation.

## Deliberate boundaries

- The matching input is the exact immutable candidate response plus the explicit chain block and
  request. Save those inputs when independently replaying a plan; the current book may contain new
  orders. The pure planner is deterministic and does not read a clock, seller role or mutable UI state.
- The book snapshot is bounded to 500 candidates whose signed time windows are open at the supplied
  chain timestamp. A larger candidate set returns 422 without a truncated or preferential match.
- Market and limit execution can leave an unfilled remainder. This change does not create a resting
  buy-intent contract or imply a new bid-side signature format.
- A preview reserves no assets. Chain settlement remains authoritative for races and reorgs. A
  revocation counter at the maximum is displayed as no remaining authorization, not as proof all
  tokens were sold.
- The UI, API and local tests target the existing Hoodi 560048 fractional deployment binding.
  No production chain, real wallet action or deployment is authorized by this document.

## Verification

- `fraction_book_test.go`: scope validation, numeric price/time/hash priority, actual MySQL
  snapshot filters, exact log replay, immutable retry priority and fail-closed snapshot bounds.
- `fraction-matching.test.ts`: deterministic replay, precise microsecond order, seller neutrality,
  partial/revoked/superseded/invalid authority, same-seller balance consumption, budget/cap/price
  boundaries, uint256 precision, block pinning, RPC failure and reorg rejection.
- `fraction-amendment.test.ts`: revoke-before-replace, durable-chain retry, still-live authority,
  unresolved receipt, owner/chain/session checks and fresh bounded salts.
- `fraction-match-execution.test.ts`: sequential original-term execution, partial completion and
  interruption without replay.
- `fraction-book-route.test.ts`: exact public scope, no credentials, bounded errors and no truncated
  matches.

These are isolated unit and database integration tests. They do not establish browser interaction,
real wallet confirmation, production deployment, or mainnet settlement evidence.
