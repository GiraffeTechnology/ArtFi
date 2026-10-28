# Receipt content checks at held action and journal boundaries

This stage connects the application commitment producer/comparator to the existing
ArtFi receipt composition. It does not establish a grant, approved-source
authority, asset ownership or successful execution.

## Send composition

The fixed Wallet provider factory still constructs the wire and supplies its
original provider callback. Before entering the real Wallet authorization gate,
ArtFi validates the complete native business against the fixed policy and wire,
then recomputes both application content digests from the parsed policy's
tenant, canonical origin, task ID, actor, escrow and runtime code hash. Both
stored phase digests must also equal the claim. Legacy arbitrary nonzero hashes
are rejected even when claim, policy and scope repeat the same values.

Inside the actual held snapshot the same checks run again before exposing the
one-use lease or invoking the ArtFi action. Complete task principal/native
operation identity, exact request, deadline, one gate, one dispatch and draining
of an already started send remain required. Known-submission persistence and
unknown-outcome reconciliation retain their existing behavior.

The business matcher returns an immutable unsigned installation-binding
projection from its descriptor-safe parsed policy. It does not return calldata,
a signature or a Kit proof. The content comparator uses that projection rather
than reading mutable caller-selected binding fields.

## Preparation and recovery

The prepared-journal port recomputes the same commitments inside its existing
bound-plan check. Creation validates the selected content before a native
journal write. Every returned journal row, including idempotent create and
review/observation recovery, is checked against the actual held policy after
the journal await. A stale installation association or old opaque slot produces
`RECEIPT_JOURNAL_APPROVAL_COMMITMENT_REFUSED` and no successful row.

The returned `approvalCommitments` marker is now `CONTENT_MATCHED`. Its
`executionAuthorization` remains `NOT_ESTABLISHED`: equality is content
evidence only. Recovery may still read the original operation under the
runtime's review/observe policy after expiry or revocation; it does not renew
send authority. The full native plan, principal and canonical request digest
remain persisted and checked independently of the pregrant content digest.

## Verification and remaining integration

The two existing synthetic test fixtures now compute their slots with the actual
pregrant producer. New negative cases cover coherent legacy opaque slots,
tenant/origin/runtime-code-hash drift, pre-gate versus held-snapshot drift,
claim-versus-slot mismatch, and association changes during a journal await.
These are authored source regressions, not genuine Wallet, mTLS, database or
public-chain acceptance.

The Go receipt consumer's explicit refusal remains. Enabling that route still
requires its installed authoritative business/source/asset/segment/journal
composition and applicable independent acceptance. This stage changes no Wallet
source, deployment parameter, capability registry, HTTP route or store guard.
