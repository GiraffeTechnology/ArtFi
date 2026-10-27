# Native receipt journal content and installed authority

This stage connects receipt-specific ownership checks to the existing Go task
journal and SQL state machine. The dedicated environment constructor still
installs no receipt authority. Its default response for consumed receipt claims
remains unavailable; there is no new public route or automatic execution enable.

## Explicit installation boundary

`NFTTaskJournalConfig.ReceiptAuthority` is a server-composition interface.
After the actual mTLS peer and one-use capability are verified, the handler may
call its `ResolveReceipt(ctx, consumedClaims)`. The resolver must independently
verify the real approved business/source/asset/segment/journal mapping and the
applicable canonical source record. Its input is the consumed full principal
and four receipt claims, not a browser assertion. Its output is the existing
six-field application association domain: tenant, canonical origin, task ID,
actor, escrow and runtime code hash.

A static metadata object, a successful fixture, matching content digests or
source HTTP text cannot implement this authority. Installation must supply the
actual approved source/deployment context, verify its source/asset/segment
correspondence, current applicable grant scope and source record, and preserve
the complete source-authenticated product classification. No signing key,
credential, new endpoint or environment fallback is provided by this stage.

The handler bounds resolution by the consumed capability's existing expiry and
checks cancellation and expiry before and after resolution. The resolver must
honor that context, perform no journal mutation, and never reacquire the
already-held Wallet grant lock. A failed or late resolution returns only the
existing unavailable response. It does not retry a consumed capability or
reveal a private source diagnostic.

## Content contract

`CompareNFTReceiptApprovalContent` is a pure content comparison, not an
authenticator. It preserves the complete unsigned native plan, exact principal
and derived native operation ID. It independently retains the full native
canonical digest and compares the two pregrant namespaces already defined by
the application:

- `artfi-whole-receipt-business-plan/1`, containing the normalized business.
- `artfi-whole-receipt-journal-binding/1`, containing the installation
  association and that business digest.

It reuses `nftTaskWireDigest` and its sorted ASCII-key canonical SHA256 rules.
Decimal amounts remain canonical strings; only bounded safe numeric chain,
schema and uint48 time values are accepted. Addresses and hashes in pregrant
content are lowercase, while the complete original native bytes remain
separate. Complete native principal facts and the native operation ID are
checked even when the pregrant business is unchanged.

The strict object decoder rejects duplicate or aliased keys, unknown fields,
nulls, incomplete principal/receipt groups, signed payload additions and
trailing JSON. The receipt operation envelope also has exact case-sensitive
names; recovery uses the ID-only request defined by the capability registry.
The full native digest must equal the stored operation's request hash.

This content decoder does not independently recompute an EIP-712 segment or
establish checksum/source/workflow authority. The existing application business
validator and installed receipt authority must establish those semantics.
Likewise, the installation origin must be the independently validated canonical
origin from the actual frozen policy; a client-provided origin creates no trust.
No receipt field is stripped to reuse a listing grant.

## Store and recovery

Only a receipt context built after explicit installed resolution can inspect a
receipt row. Both incoming and existing rows pass content, full principal,
derived native identity, wallet, chain and canonical request-digest checks.
These checks run before get and idempotent-create returns under the existing
row lock. Missing receipt context cannot adopt a receipt row; receipt context
cannot adopt a listing row.

The existing SQL table, immutable full plan, revision predicate, wallet-start
marker, known transaction preservation and only-forward/reorg state transitions
remain unchanged. Source resolution happens before SQL ownership/mutation and
does not hold a database row lock while performing external reads. Neither
session nor ordinary listing authorization acquires receipt permission.

A journal acknowledgement or row is not evidence of a completed registration,
fund release or physical delivery. Registry-backed operation authority must
preserve the original wallet reservation and atomic holder/receipt settlement
boundary. This implementation does not turn the compatibility phase labels
funded/registered/paid into a fresh-payment workflow, nor does it enable the
legacy direct-payment market for a classified registry-backed receipt.
Unsupported actual composition remains unavailable.

## Verification

The shared vector file is explicitly synthetic: reserved example tenant/origin,
repeated synthetic addresses/hashes, and no real wallet/source/custody material.
Its three phase vectors use independent standard SHA256 fixture arithmetic
under the existing canonical contract. They do not represent executed product,
institutional or on-chain evidence.

Authored coverage includes Go content/transport refusal, complete principal and
native identity, every sale/correspondence family, phase/proof separation,
normalization without native rewriting, row recovery, idempotency, CAS,
wallet-start/known-hash/reorg preservation, actual-peer-before-source ordering,
one-use replay and late/failed source resolution. A new isolated MySQL case
covers create/update/CAS and a reconstructed handler using synthetic
peer/capability/source authority. Handler reconstruction is not a database or
process restart proof.

The web parity test runs the existing application producer/comparator against
the same independent vectors. Ordinary QA must run both language suites,
formatting, TypeScript and appropriate isolated MySQL verification on the exact
candidate. All new test source is currently NOT_RUN. Actual source resolution,
mTLS deployment, original-wallet and chain integration plus final archive
readback remain required for delivery.
