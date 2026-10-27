# Receipt and isolated-test operations handover

This supplements the existing [installation guide](INSTALLATION.md),
[UI deployment contract](UI_DEPLOYMENT_CONTRACT.md),
[Safe workflow](ADMIN_SAFE_WORKFLOW.md), [cluster operations](CLUSTER_OPERATIONS.md)
and [MySQL recovery](MYSQL_RECOVERY.md). It covers operating the whole-artwork
receipt, charity evidence and isolated Hoodi capabilities once their exact
source, runtime and interfaces have been independently accepted.

The document is an operator procedure. It supplies no deployment observation,
test result, signature, receipt or full-product acceptance. A source PR, built
artifact, healthy process and completed business operation are separate facts.
Unconfigured features retain their explicit unavailable states while unrelated
accepted functions continue.

## Roles and release identity

The initial developer supplies complete source and authored regression inputs.
The assigned independent reviewer owns ordinary tests, post-submission changes,
combined integration, required CI and qualified merge. The existing deployment
operator owns service changes and the approved chain executor owns real test
operations. The delivery controller reconciles these records into the final
handover. This document does not transfer those responsibilities or authorize
another writer on a submitted file.

Before using a candidate, bind these existing records to the same release:

| Record                 | Required observed identity                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Source                 | Full commit, tree, lockfile, source fingerprint and any preserved dirty inputs                                                     |
| Independent validation | Exact tested source, commands, UTC times, exits, applicable failures/skips and raw evidence hashes                                 |
| Package                | Actual archive bytes/SHA-256, per-file manifest, runtime/dependency versions and contract ABI/bytecode                             |
| Installation           | Actual current release/process identity, protected configuration reference, original complete public URL and served build revision |
| Persistence            | Existing primary/schema and migration ledger identity, source journals, operation records and verified recovery inputs             |
| Chain                  | Exact chain/genesis, collection/register/Safe identities, runtime code hashes and existing role assignments                        |
| Authority              | Actual existing authenticated session or bounded delegated capability, principal, scope, nonce, expiry and revocation state        |

Hashes establish byte identity, not publisher authenticity or permission. Verify
the release channel and configuration provenance independently. A merge that
changes the selected source needs its own package identity; do not relabel an
older artifact with a newer commit.

Reuse the existing public origin, bridge, runtime, database, storage and signing
references. Keep actual endpoints, private paths, account bindings, credentials
and raw logs in their controlled records. A missing reference is recovered from
its original holder; an example value is not a replacement allocation.

## Source tools and installed artifacts

In the source tree, installer and operations code resides under scripts/install
and scripts/operations. The generated native kit places its corresponding files
under tools/install and tools/operations and bundles runtime/bin/node. Consult
the selected artifact's own manifest and installation guide before invoking a
path. A source-root INSTALLATION.md link is not evidence of an installed kit;
the repository installation guide is docs/INSTALLATION.md.

Receipt source modules and engineering preparation/verifier CLIs are not
automatically part of a native kit merely because their PRs exist. The packaging
owner must establish their actual inclusion and dependency resolution in the
selected release. In particular, an engineering CLI that resolves dependencies
from apps/web/package.json needs its approved source layout or a separately
reviewed packaging adaptation. Do not copy an unreviewed source file into a
running service or install a new runtime to make a path appear.

The existing installer distinguishes these operations:

| Operation    | Effect and limit                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| check-bundle | Checks listed package bytes/links and rejects unlisted files; does not authenticate the release publisher                   |
| install      | Stages a verified version and reports activated:false                                                                       |
| migrate      | Applies forward schema through the existing migrator and ledger; it is a database mutation                                  |
| activate     | Checks schema status and switches the current release; managed services must already be stopped                             |
| start / stop | Manages only the process records owned by that installer                                                                    |
| verify       | Writes its installation report and makes bounded reads; it is not a business transaction test                               |
| upgrade      | Stages, checks migrations, stops, switches, starts and verifies; may attempt to restart the previous application on failure |
| rollback     | Restarts a recorded previous application release after checks; preserves the schema and business history                    |

Use the deployment's existing service manager. A utility-managed process record
does not control an independently managed system service. Do not mix lifecycle
managers on the same listeners. Optional agent and monitor enablement changes
the managed process set; no new supervisor, timer or notification destination
is enabled by this handover.

Reusing protected configuration must retain its existing identities. Generic
configuration generation can create missing service secrets; do not use it as a
shortcut for recovering an existing deployment. A required new credential,
security setting, resource or role transfer needs its own applicable authority.

## Installation verification and migrations

Follow the reviewed release procedure using the existing approved allocations.
Inspect the selected forward migration inventory against the actual primary's
ledger. Confirm additive schema prerequisites and checksums before a dependent
migration. A document's old numbered migration list is not the current ledger.
Do not mark a dirty or legacy schema clean or infer applied migrations from
file presence.

The primary remains authoritative for mutations and session reads. A reachable
replica or healthy replication thread does not prove the required state is
caught up. Use the existing database recovery procedure for the exact required
GTID/application records. Do not promote a replica or reroute writers from a
readiness failure.

Check the served build revision and an actual database-backed read in addition
to process health. Missing persistence is unavailable, not an empty account.
The installer verify report explicitly leaves external chain/venue transactions
NOT_RUN. An installation verification success therefore cannot satisfy real
wallet, registration, marketplace, charity, Vault or DAO acceptance.

Keep optional source, venue, object-store and chain availability separate.
Restore or repair the affected approved binding; do not weaken origin, TLS,
authentication, journal or feature checks to make a health report green.

## Whole-artwork receipt operation

For a specific operation, retain its full immutable native plan, complete
principal, exact sale/correspondence fields, segment/domain identity, phase,
nonce and actual transaction identity. Preserve pregrant business and
association commitments separately from grant-derived/native journal binding.
Their encoding and authority must come from the agreed installed interfaces.

The business comparison, Wallet held context, source observation, Kit proof
and native journal each have a different job:

| Surface              | What must actually be established                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Business comparison  | Exact native plan, frozen policy and phase wire correspond; opaque producer commitments are not newly recomputed                    |
| Wallet context       | The real installed held authorization and its one-use lease govern the exact action/send, with peer/principal/TTL/revocation checks |
| Source admission     | The approved original-document format/profile and fixed authenticated source verify the full signed intent and mint policy          |
| Source observation   | A complete expected token/source/register/authority/policy/entry/five-word binding matches one historical snapshot                  |
| Native journal / Kit | Authoritative source, asset, segment, version, proof and durable one-consumption state bind the real operation                      |
| Chain evidence       | The exact transaction, canonical block, events and state satisfy the applicable confirmation/finality rules                         |
| Product outcome      | The installed UI and original product's funds/ownership/holdership semantics agree with the reconciled operation                    |

A passing earlier row does not establish a later row. A fixed TLS peer or an
authenticated transport flag alone is not original-document verification.
An absent approved institution profile affects that admission path; a synthetic
JSON test format must not be substituted as its production parser.

The optional source API exposes receipt/current and receipt/version/{version}.
The ArtFi historical reader uses the exact requested version and an expectation
from the authenticated immutable application context. It must retain:

- token ID, chain, contract, register ID and source authority;
- immutable mint policy hash;
- entry version, record/previous commitments, registry reference, holder and
  original effectiveAt;
- schemaId, mintPolicyHash, segmentDigest, requestHash and receiptDocumentHash;
- observed block number/hash and any later supersededAt interval.

All-zero legacy bindings are unavailable; partial or mismatched bindings are
refused. Preserve exact decimal strings, including values beyond JavaScript's
safe integer range. Do not substitute NFT owner for register holder, infer
physical title from either, reset a historical deadline or treat a later
current entry as the old version.

The HTTP result is a source observation. Authorization, finality and
original-document verification remain NOT_ESTABLISHED by that reader. Native
chain/Kit/journal checks must prove their own boundaries. No source read,
registration receipt or market mirror result grants a fresh payment or release.

Use the exact installed producer/consumer capability contract. An unsupported
claim, missing agreed commitment encoding, missing real peer binding or an
unaccepted combined runtime stays unavailable. Do not drop fields, disable the
journal, construct a new digest or substitute a fixture to enable execution.

## Charity evidence and atomic creation

Preserve the original source-bound series identity and immutable 100 editions.
Creator and donation-recorder roles are separate. A zero distributor balance is
only a necessary sellout condition; it does not prove the required independent
purchases or CCHS acceptance evidence. Recording evidence does not issue a
charitable receipt, establish physical ownership or settle a sale.

For Safe-mediated actions, inspect the actual Safe, target, method, zero ETH
call value, request ID, immutable calldata and owner confirmations. The chain
timelock and current roles govern execution. Reaching the confirmation threshold
is not execution. Preserve the original target token/series binding when
another owner executes or when a receipt is recovered.

The atomic creation primitive accepts 1–37 SeriesInput values per call and
still permits later distinct calls. It is a source capability for a separately
reviewed runtime. Existing deployed single-series bytecode does not acquire
the selector from a source change.

An actual atomic-batch UI needs an integrated decoder/allowlist, complete review,
simulation and original Safe/Wallet recovery. The existence of a recorder UI
or single-series creation form does not prove that batch integration is
installed. Assign its shared-file integration to the current single writer;
do not add a parallel generic Safe executor.

For accepted atomic evidence, bind the complete input order to one actual
execution transaction and every expected event/state value. Separate successful
transactions are not one atomic batch. Frozen historical mints and their hashes
must never be rewritten, replayed, migrated or relabelled to satisfy this check.

## Isolated Hoodi inputs and evidence

Use the separate AI test namespace and the current approved Hoodi chain, 560048. Every asset's metadata, deployment/series description, relevant screen
and top-level batch manifest must display TESTNET, NO REAL-WORLD VALUE and
NO LEGAL EFFECT. Keep the payload out of the frozen charity directory and any
production/mainnet manifest. It carries no real artist, donation, valuation,
physical-title or holder-benefit claim.

The offline preparation profile consumes private PNGs and exact metadata bytes.
It checks bounded files, SHA-256, path/symlink identity, PNG signature/IHDR bounds,
distinct content and no-preview metadata. It does not decode all pixels, prove
AI generation, verify a live deployment or generate a per-holder derivative.
Retain actual generation events/prompts, source bytes and independent visual
and decoder results as separate evidence.

An absent collection, Safe, runtime, publication, producer-ID or recipient
binding stays absent. Recover approved values from actual existing records.
Preparation must not invent them or select a new artwork-ID digest. Even a
descriptor with all supplied bindings remains PREPARATION_ONLY, execution
disabled, and authorization/runtime observations unestablished.

A narrow finalized-receipt verifier can check the selected Safe execution,
collection/Safe runtime hashes, exact stored action/calldata, complete per-series
mint/URI/creation events, fixed supply and canonical/finalized block identities.
It needs the actual supported provider and reviewed runtime. Failure on an
unsupported historical block read does not authorize a latest-state fallback.

Neither fixture success nor a narrow receipt result accepts AI provenance,
metadata publication, UI markers, real holder delivery, Vault/fractional/DAO/
marketplace behavior or the complete product. Record each applicable real path
at its own required level. Keep public charity metadata without artwork
previews and the master private; holder delivery needs the actual distinct,
holder-specific watermarked file and authorization.

## Uncertain results, revocation and reorgs

Start with the original operation and transaction identity. Route navigation,
process restart, lease expiry, a new package or a missing browser record does
not cancel an already dispatched operation.

| Observation                                 | Required continuation                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Wallet request dispatched, no hash returned | Reconcile that original wallet/provider operation; do not issue another write                             |
| Hash known, RPC timed out                   | Query the same transaction and durable operation; preserve the known hash                                 |
| Candidate recovery hash does not match      | Refuse it and retain the unresolved original operation                                                    |
| Canonical failure proven                    | Apply the installed product's explicit failure/retry semantics; never silently replay the original intent |
| Source/journal observation changed revision | Reject stale work and reconcile the exact current revision                                                |
| Source, principal or grant revoked/expired  | Block new authority and reconcile any already dispatched result                                           |
| Prior block/event removed or reorged        | Preserve old evidence, remove its current acceptance and reconcile canonical state before continuing      |
| Unknown commit or archive write outcome     | Read the exact original identity/key before another mutation                                              |

Oracle source-ingress journal states and ArtFi native-operation states are
different component contracts. Use the installed component's enum and revision/
CAS rules. In Oracle ingestion, a claimed SUBMITTING/SUBMITTED/UNKNOWN intent
must not be resubmitted; only its existing lookup/reconciliation path applies.
Do not transpose those column names into the ArtFi database or edit journal,
nonce, revision or lock rows manually.

Preserve the existing once-only funding/payout and only-forward recovery
semantics. A recovered authoritative registration, application rollback or new
receipt observation does not create another funds action.

## Recovery and service continuity

Use the existing narrow containment control within its current authority.
Keep admitted/in-flight journals, chain identities, evidence and protected
configuration available for reconciliation. Do not delete a pending record,
regenerate a key, rotate a credential, clear a lock or restore an older nonce
to make an operation appear new.

Application rollback preserves the schema, credentials, source journals,
orders/sessions and chain history. The installer's attempt to restart an older
application after an error is an attempt, not proof of recovery. Inspect its
actual result and schema compatibility before restoring traffic or new writes.

Database recovery is a separately authorized operator procedure using an
authenticated backup and an isolated target. Its byte/hash verification does
not authenticate the source backup or reconcile chain state. A logical restore
must not erase knowledge of dispatched operations and then replay them.
Reconcile the recovered application state with the preserved external
transaction/source records before admitting new work.

Immutable contract recovery follows the existing reviewed forward procedure;
application binaries cannot upgrade an old contract in place. Preserve source
authority and original asset/segment bindings. No new account, service,
listener, migration, replica promotion or security-policy change follows from
this document.

## Final evidence and archive

The controller's final record must describe the actual combined source,
artifact, configuration and run. For each applicable requirement, retain the
independent evidence that proves that requirement's scope. Preserve missing,
failed, skipped, simulated, NOT_RUN and UNKNOWN results explicitly. Authored
tests, a report, a transfer, a single green suite and a component PASS cannot
stand in for complete product acceptance.

Archive accepted deliverables through the existing project-specific provider
and namespace. Record exact commit/tree, inventory, per-file byte count/SHA-256,
commands, UTC times, exits and object identities. Reconcile an existing object:
reuse identical bytes only after full verification, and do not overwrite a
different object. An unknown upload result needs exact-key reconciliation.

After immutable upload, independently read every object's complete bytes and
match size/hash and the manifest. Preserve a usable recovery path and the
operator's actual readback result. Dispatch, upload exit zero, metadata stat or
an empty directory listing alone does not establish recovery verification.
Treat archive integrity and source authenticity as separate checks.

Release only explicitly eligible inactive local material after recovery
verification under the existing retention policy. Preserve production, active
acceptance inputs, usable rollback versions, credentials, database/mail,
journals, locks, shared services and original evidence. Partial source archival
or an archived test input is not the final product delivery.

This handover neither creates a periodic inspection/reporting schedule nor
changes existing communications. Product verification and final archival follow
their assigned owners and the user's current instructions.
