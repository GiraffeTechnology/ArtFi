# Whole-receipt asynchronous settlement boundary

## Status

This is an isolated implementation checkpoint, **not a deployment input or completed
whole-artwork workflow**. The existing atomic `WholeArtworkMarket` remains unchanged.
The receipt UI still reports its execution paths as unavailable. No deployment script,
runtime configuration, credential, privilege, production database or public entry is changed.

## Implemented funding and payout

`packages/contracts/src/WholeReceiptEscrow.sol` is a bounded settlement extension, not
a second exchange or Oracle. It reuses `WholeArtworkMarket.SaleIntent` and the existing
market's token/collection allowlists, pause and seller epoch. A seller must explicitly
sign the separate `ArtFi Whole Artwork Receipt Settlement` domain and
`ReceiptAuthorization` type. An old atomic-fill signature is intentionally invalid.
The named buyer funds its own segment. The contract checks exact buyer debit and escrow
credit, then transfers the artwork directly from seller to buyer. It never holds the NFT.

The authorization binds all sale terms, settlement ID hash, asset record hash, Oracle
source ID hash, registration request hash, authenticated journal execution-reference
hash, predecessor segment, prior certificate hash and warehouse receipt hash. Hashes
must come from authenticated records, not invented identifiers or user-entered claims.
Chain and contract are bound by EIP-712. The current implementation is restricted to
isolated local EVM and Hoodi; this is not authority to deploy or broadcast there.

Each segment retains its own immutable buyer, seller, currency and amount. A verified
registration confirmation is persisted separately from payment. Any relayer may call
the release, but cannot change the recipient or amount. Exact outbound debit/credit
checks reject fee-on-transfer or other non-exact payment behavior; failed payment rolls
back only that payment and preserves the registered/unpaid state for an exact retry.

Registration and payment do not use the latest token holder or global finality as a veto.
An authenticated B-to-C historical confirmation may release that segment while the token
has already moved to D. An exact confirmation replay is a no-op. A changed replay is
rejected, and an unavailable later proof cannot undo an already settled prefix.

## Existing Oracle correspondence, not a new trust source

`whole-receipt-correspondence.ts` matches the existing Oracle SettlementCoordinator
snapshot algorithm at `014cf716b6ef9125e1fe8245065665900bec8ab2`. It recomputes the
snapshot using authenticated journal participants and execution reference omitted from
the public projection, and checks the exact historical certificate correspondence.
It uses the existing certificate schema. A later SUPERSEDED certificate remains valid
historical evidence; a current-holder observation is not substituted for that record.
The matcher itself does not authenticate the transport or authorize any financial act.

`IWholeReceiptRegistrationVerifier` is the required adapter boundary, not an implemented
Oracle backend. A real adapter must authenticate the existing functional Oracle source,
validate the full segment digest and corresponding request/certificate/snapshot, enforce
source and record policy, and return the authenticated registration-record commitment.
Code-hash pinning is an additional integrity check, **not** a substitute for authenticating
the record, proxy implementation, source policy, or external dependencies. No production
adapter currently satisfies this boundary in this checkpoint.

The `TestOnlyReceiptOracle` fixture is deliberately synthetic and unsuitable for
deployment. Passing its tests proves escrow mechanics only. It does not prove Oracle,
registry, signer, real custody, legal-title or production correctness.

## Still unavailable

- Live composition and acceptance of the authenticated task journal and canonical
  chain-receipt association. `whole-receipt-journal.ts` now deliberately reuses the
  existing capability-bound endpoint and CAS repository through its shared unsigned
  envelope, with strict domain validation. It records no signature or raw transaction.
  Repeated create recovers the existing lifecycle; an unknown write response is not
  retried. Every reconciliation rechecks chain proof even for a confirmed journal row.
  Synthetic transport and shared repository tests do not prove actual mTLS, grant
  consumption, MySQL restart durability or a deployed execution composition.
- Actual registration submission and a reviewed, existing-source-backed Oracle adapter.
- Approved isolated whole-artwork identity and its exact journal/Oracle correspondence
  for genuine end-to-end verification.
- Authorized NFT rollback, failure treatment after registration but before payment,
  and document handover/burn sequence. There is no administrative refund or forced-transfer
  fallback. Unknown outcomes are not permission to retry a financial action.
- Production UI execution, deployment, live-chain receipts and complete acceptance.

Do not deposit live funds or enable this path while those dependencies are incomplete.
The contract intentionally has no sweep, administrative withdrawal, forced NFT transfer,
burn or speculative refund function. Its current absence of an accepted recovery route
is a deployment blocker, not a claim of safe indefinite custody.

## Verification scope

Tests exercise buyer isolation, A-to-B-to-C-to-D independent payout, historical replay,
wrong buyer/source/request/segment proof, pause and revocation, exact inbound/outbound
balances, callback forwarding refusal and custody conservation. The real invariant handler
is targeted through `targetContracts`, with nonzero campaign calls checked after execution.
`whole-receipt-authorization` reuses the browser sale terms and supplies only typed data;
it neither invokes a wallet nor configures an execution route. A fixed digest vector is
checked independently in Solidity and TypeScript.

Every result remains bound to its recorded source pins. Synthetic fixture results,
read-only UI, unavailable-state rendering and green tests cannot certify full settlement.
