# Principal funds observation journal

This ArtFi module persists observations of the original buyer principal
reservation separately from NFT transaction journals, grant reservations and
Agent exposure counters. It never freezes a balance, signs, broadcasts, requests
a fresh buyer payment or calls a financial release/refund endpoint.

## Trusted composition and identity

`NewPrincipalFundsJournal` requires an existing `*sql.DB` and a fixed
`PrincipalFundsJournalAuthority`. Missing or typed-nil authority refuses startup.
No environment-selected module, URL, default signer or public HTTP route is
introduced. The normal task-journal executable does not install this authority.

The installer implements `AuthorizeJournal` for the current authenticated
peer/caller and the exact `prepare`, `read`, `history` or `observe` operation. It
must retain the complete original task principal and actual grant, revocation,
TTL and one-use boundaries. The adapter must honor cancellation and must not
reacquire an already-held Wallet grant. A new read authorization can inspect an
original operation without rewriting the original operation's stored principal.

`ReadPrincipalObservation` is a read of the actual original Wallet reservation
and operation result, with the approved source/asset/segment/journal association.
Where registration or rollback is involved it must verify the exact canonical
source facts and applicable finality. It must not authenticate evidence by
echoing an ArtFi row, a caller flag, a content hash, grant capacity, a fixture or
whatever code happens to be returned by an untrusted RPC.

The binding preserves the original operation, full task principal, chain,
buyer/seller, token, exact base-unit amount/currency, existing plan and journal
commitments, segment, asset record, approved source, independently pinned Oracle
code/source identity, mint policy and mint-defined registration deadline. These
are immutable, canonical application fields. Existing producer digest contracts
are preserved; this journal derives no new financial approval digest. Addresses
are lower-case canonical hex and amounts are bounded exact decimal strings.

These Go interfaces are an application-local normalization boundary. They do not
claim that the current Wallet exposes an equivalent wire API. The actual Wallet
principal API, its persistent result semantics and standard bootstrap still need
their original owner's implementation and exact adapter agreement. The existing
native NFT journal remains separate and its complete native IDs/principal must
still be checked by that adapter's original association contract.

## Recorded states and recovery

`Prepare` records only `prepared` metadata. An allocated reservation reference can
appear in `freeze-pending` or `unknown` before a freeze is known to have succeeded;
it is never itself a frozen-balance proof. Once known, the original reservation
and freeze/release/refund operation references cannot be replaced or dropped.
The namespace `PRINCIPAL_FUNDS` explicitly excludes grant reservation metadata,
but the actual adapter must still establish its real financial provenance.

Observations distinguish the principal phase from the outcome of the exact
external operation: `PENDING`, `APPLIED`, `NOT_APPLIED` or `UNKNOWN`, with the
corresponding `freeze`, `release` or `refund` action. An unchanged frozen balance
is not proof that a pending release was not applied. `UNKNOWN` can leave only
through reconciliation of that original pending action, never through a new
pending attempt or an automatic release-to-refund fallback. A failed source read
leaves the durable previous record unchanged; it is not a new business outcome.

Release requires the same reservation and the exact segment registration entry:
the holder is this segment's buyer, the version is beyond the initial entry, and
its effective time is no later than the immutable mint deadline. A later worker
processing time does not invalidate a registration that was effective in time.
The historical entry is used even when a later valid holder or token owner has
changed; token owner equality is not substituted for source registration.

Refund observations require the exact unresolved-segment rollback reference and
restoration of token owner to the current valid holder. The actual source adapter
must establish the bounded unresolved suffix and preservation of every settled
prefix. A completed registration and a rollback proof cannot coexist in this
operation. `released`, `refunded` and `refused` outcomes are not reopened. A new
permitted trade after rollback uses its own approved operation identity and does
not erase or reuse the old operation's history.

A restarted observer can first see a fully verified completed result. It does
not invent a pending event or dispatch the action again to reconstruct history.
All cumulative source and original reservation proofs still remain the actual
adapter's responsibility.

## Durable CAS and history

Migration `000017` adds `whole_receipt_principal_observations` and its separate
append-only event table. Exact server JSON is stored as `LONGTEXT` with
`JSON_VALID`, preserving bytes for strict reconstruction. Unknown fields,
duplicates, aliases, alternate representations and SQL key/revision disagreement
are refused. Records have the explicit `artfi-principal-observation/1` schema.

`Refresh` accepts no caller-supplied status, reservation or proof. The trusted
source read happens before the SQL row lock. Under `FOR UPDATE`, the entire
previous record and revision must still match, and the source validity/context
must remain current. The row CAS and one new event commit in the same transaction.
An identical observation creates no extra revision/event. A commit error returns
`PRINCIPAL_JOURNAL_COMMIT_OUTCOME_UNKNOWN`; the caller must read the original
operation and history before retrying metadata capture or making any external
decision. It must not infer that the database rejected the commit.

`History` bounds a page to 1–100 records and pins its high-water revision from the
current row. It rejects gaps, foreign bindings, revision aliases and a final event
that disagrees with the current row. Later concurrent commits are excluded from
that page. Internal Go revisions are uint64; a future HTTP contract must preserve
them exactly rather than using lossy JavaScript numbers.

Production code has no observation/event deletion path. The down migration
deliberately signals SQLSTATE `45000` instead of dropping financial recovery
history. Apply a reviewed forward repair; do not purge UNKNOWN or completed
records to make a rollback succeed.

## Validation boundaries

The authored Go checks cover original reservation identity, allocation versus
freeze, registration deadline/holder/segment, source-record completeness,
UNKNOWN reconciliation, release-result ambiguity, settled-prefix protection,
catch-up, strict storage JSON and missing authority. The isolated MySQL checks
cover two-instance CAS, fresh-object reconstruction, source outage/expiry,
append-only event pagination, full-principal isolation, corrupted rows and the
deliberate forward-only refusal.

Run the affected API checks on the existing approved Linux runtime and isolated
MySQL schema after applying migrations through `000017`. Set
`ARTFI_PRINCIPAL_JOURNAL_MYSQL_REQUIRED=1` for that required SQL run; a missing
migration must fail it. A legacy test run without that migration reports an
explicit UNVERIFIED skip and cannot be used as principal-journal acceptance.

```sh
cd apps/api
ARTFI_PRINCIPAL_JOURNAL_MYSQL_REQUIRED=1 go test -race ./internal/httpapi -run 'TestPrincipalFunds|TestMySQLPrincipalFunds'
```

At authoring, formatting, compilation, unit and MySQL execution are unverified.
Fresh Go objects are not a real database-server restart. Actual restart,
lost-commit-ack fault injection, real Wallet/source adapters and bootstrap,
same-version UI/chain integration and independent full-product acceptance remain
open. Do not deploy this draft as a completed principal settlement service.
