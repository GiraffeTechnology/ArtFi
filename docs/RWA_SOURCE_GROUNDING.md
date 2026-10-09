# Approved-source RWA correspondence and catalog

Implementation trace: #110 with incorporated #84; `docs/PRD.md` §§1.2–1.3 and
`AGENTS.md` §1.1. This implements the existing Stage 1 correspondence requirement.
It does not introduce a new global product gate, independent Oracle/Kit milestone,
ArtFi authenticity authority, registry of record, custody service or source issuer.
Digital ERC-1155 charity editions remain independent.

## What is verified

An approved source signs a finite correspondence claim with its P-256 key. ArtFi
receives only the public key and signature. The claim identifies its source and
source asset record, canonical underlying asset/right, product model, exact
operation, source reference, document digest, rights, environment and validity.
For registry-backed sources it also includes a registry reference, source version
and observation time. A reference can be a stable record identifier or URL; ArtFi
does not fetch arbitrary evidence URLs. The source must authenticate the actual
asset/right before signing. An image or document hash alone is not that evidence.

The two application contexts are separate:

- Native fractional-underlying issuance: exact chain, source-verifying registry,
  request ID, recipient, metadata SHA-256 and metadata URI. This is the existing
  ArtFi ERC-721 underlying flow, not a substitute whole ERC-8415 receipt product.
- Catalog activation: every public metadata field and every token, underlying,
  vault, fraction-token and settlement-contract association. Whole ERC-8415 assets
  continue to be externally issued compatible receipts consumed through Oracle.
  The API does not issue, certify or silently replace those external receipts.

Source signatures assert correspondence, not a completed delivery. Chain
ownership, custody, registry holdership and lifecycle state retain their respective
authorities. The existing Oracle read/projection path supplies current registry
and receipt lifecycle observations independently of these source commitments.
An observation is shown with its source version/time; it is not described as a
live synchronization merely because a signed record exists.

## Public trust roots and isolated testing

Server runtime inputs:

- `ARTFI_RWA_APPROVED_SOURCES_JSON`: JSON array of `{id,name,kind,publicKeyX,
publicKeyY,mode,registryBacked,disabled}`. Kind is `registry`, `warehouse`,
  `custody`, `certificate` or `provenance`. Public coordinates are 32-byte,
  `0x`-prefixed P-256 values. Private keys and unknown fields are rejected.
- `ARTFI_RWA_EVIDENCE_MODE`: `LIVE` by default. `TEST_ONLY` is accepted only when
  `ARTFI_ENV=test`. The whole source configuration fails closed on malformed,
  duplicate, unsupported or mismatched roots. Empty roots disable source-dependent
  actions only; they do not disable independent digital NFT functions.

Trust roots are deployment configuration; no administrator, publisher or registrar
endpoint creates a root. A root change takes effect when the API process reloads
its configuration. Current trust, signature, time and durable revocation state are
rechecked for public catalog reads and before new issuance/activation.

`/v1/rwa/sources` exposes the public verification roots and mode. It does not
expose secrets or grant authority. Never generate a production source identity
inside ArtFi to make a fixture appear real.

`TestExportIsolatedRWACatalog` can generate a bounded test seed for the real
HTTP/MySQL session suite:

```sh
cd apps/api
ARTFI_EXPORT_RWA_FIXTURE=/absolute/isolated/workspace/rwa-public-fixture.json \
  go test ./internal/httpapi -run '^TestExportIsolatedRWACatalog$' -count=1
```

Its optional output is `{mode,sources,publications}`: public trust roots and two
pre-signed TEST_ONLY publication envelopes, valid for 24 hours. The source private
key exists only in test memory and is never emitted. Normal tests write no fixture
file. The whole and fractional records have distinct source and underlying NFT
identities. The test runner must enable the isolated mode explicitly, configure
those public roots, and publish through an authenticated ordinary-user endpoint.
There is no runtime fixture fallback or preloaded catalog asset.

## Source signing format, version 1

`rwaSourceEvidence` in `apps/api/internal/httpapi/rwa_grounding.go` and
`RWASourceEvidence` in `apps/web/src/lib/rwa-source-evidence.ts` define the public
envelope. Timestamps are Unix seconds; signatures are fixed-width 32-byte `r` and
`s`, with `0 < s <= P-256 order / 2`. No DER or Ethereum personal-message prefix is
used. The hash is SHA-256 over the following Solidity ABI encoding (each item is
one 32-byte word):

```text
sha256(abi.encode(
  sha256("ArtFi approved-source evidence v1"),
  sha256(sourceId), sha256(sourceAssetId), sha256(underlyingAssetId),
  evidenceId, claimHash, contextHash, validFrom, validUntil,
  sha256(mode), sha256(section)
))
```

`claimHash` is the SHA-256 of this ordered compact JSON object, with UTF-8 and Go
JSON escaping of `<`, `>`, `&`, U+2028 and U+2029:

```text
{"sourceReference":...,"evidenceSha256":...lowercase...,"rights":...,"section":...,
 "registryRecord":{"reference":...,"version":...,"observedAt":...}}
```

Omit `registryRecord` when absent. The source-approved `registryBacked` policy
requires the record when applicable and rejects an unapproved registry assertion.
The browser and Go implementation share this encoding; OpenZeppelin P256 verifies
the same signature on native issuance.

Mint `contextHash` is:

```text
sha256(abi.encode(chainId, registryAddress, requestId, recipient,
                  metadataSha256, sha256(metadataUri)))
```

Catalog `contextHash` is SHA-256 of the ordered compact Go encoding of
`{"domain":"ArtFi public RWA catalog v1","asset":<RWACatalogRecord>}`. The
review endpoint returns the canonical record and hash so a source can verify
exactly what it is signing. The public record's field order is declared by the
Go struct, including an empty `imageUrl` when absent; optional empty binding fields
are omitted. Address/Oracle-asset-ID case is preserved in the signed document.
Database uniqueness keys canonicalize EVM address case separately.

A source must compare the public record and applicable evidence before signing a
context hash. A bare hash submitted by an ArtFi role is not an authenticity claim.

## Native issuance and bypass closure

1. The registrar-authenticated upload flow validates the image bytes and digest.
2. `POST /v1/rwa/metadata-preparations` returns an immutable metadata commitment
   with `executable:false` and `awaiting-approved-source-evidence`. It returns no
   mint function or contract arguments. Repeating the same unsigned request and
   idempotency key yields the same source context.
3. The approved source returns a signed `fractional` envelope for that context.
4. `POST /v1/rwa/intents` requires that envelope as `evidence`. The API verifies
   current trust, exact context/model, signature, validity and revocation before
   committing the mint intent, source identity uniqueness and audit atomically.
5. The ERC-721 form validates imported fields locally before transmission, verifies
   the returned source/contract tuple, simulates the guarded method, then requests
   the existing wallet confirmation. Its recovery path retains upload/intent/key
   binding, uncertain transaction recovery and independent submission logging.
   Changing metadata requires a new source-approved context.
6. `RWARegistry.createAssetWithEvidence` independently verifies the signature,
   chain/registry/request/recipient/metadata/URI binding, source approval, model,
   environment, expiry, revocation and unique source/underlying identity. The old
   `createAsset` function unconditionally reverts, including for registrars.
7. `ArtFiRWA.bindMintRegistry` irreversibly seals minting to the guarded registry
   during deployment. Minting is disabled before the seal; later ArtFi
   `MINTER_ROLE` grants cannot bypass the sealed registry. Issuance pause and
   registrar permission continue to apply.

The deployment script takes the independent public `ARTFI_SOURCE_AUTHORITY` address
and explicit `ARTFI_RWA_TEST_ONLY` boolean. The immutable source authority cannot
be the initial ArtFi administrator or registrar. Only it can configure approved
source public keys on this guarded deployment. ArtFi's AccessControl hierarchy
cannot grant itself this authority. The installer never supplies a source private
key. No real deployment, signature, transaction or source activation was performed
as part of implementation tests.

Already-deployed metadata-only contracts do **not** acquire this behavior from a
web/API update. They must not be represented as guarded issuance. A configured
legacy address fails the guarded wallet simulation. The new contract artifacts,
independent source authority and approved public roots must be used for guarded
native issuance; actual deployment is a separate authorized operation.

## Catalog publication, renewal and public reads

- Any ordinary authenticated wallet can use `/rwa/activate`, backed by
  `POST /v1/user/rwa/catalog-drafts` and `PUT /v1/user/rwa/assets/{slug}`.
  `/v1/admin/rwa/...` is optional convenience with identical source verification.
  There is no discretionary ArtFi-admin approval step for a valid source claim.
- Publication body is `{revision,asset,evidence}`; new records use revision 0.
  A publisher role identifies who submitted public content, not who authenticated
  the underlying property/right. Every source/underlying/collection/token/model
  association is immutable. Source-approved metadata, validity and venue changes
  use the current revision and a fresh source evidence ID.
- Whole and fractional catalog records are independently model-bound. Each source
  asset/model, canonical underlying/model and NFT/model binding is unique. A
  fraction token cannot be assigned to two records. Fraction/vault associations
  are included in the source-signed context; an admin cannot append one afterward.
- `GET /v1/rwa/assets` supports section, search, stable title/updated sort,
  pagination and exact chain/collection/token or fraction-token lookup.
  `GET /v1/rwa/assets/{slug}` returns the raw asset DTO.
- The source state is recomputed, no-store: `verified`, `expired`, `revoked`,
  `not-yet-valid` or `source-unavailable`. Invalid source state does not erase the
  historical public record or pretend the token disappeared. Database failure is
  503, not an empty catalog and not sample artwork.
- An image URL is optional. No public image or artwork-preview prerequisite was
  added. Exact rights, source provenance and token/underlying identity remain
  required for meaningful RWA correspondence.
- The same source-authenticated underlying is required before API vault setup.
  A newly guarded native mint can be matched through its confirmed, nonremoved
  indexed AssetCreated record. An external underlying can be source-activated
  through its catalog record. Ordinary ERC-721 ownership alone is insufficient.
  The DAO issuance step re-reads `/v1/rwa/underlying-status` immediately before
  `fractionalize`, through a bounded no-store BFF accepting only the exact chain,
  collection and token. Retired wallet/form operations cannot continue after
  that read. Owner recovery, approval cancellation and other exits are unchanged.

Mutation receipts are actor-scoped, payload-bound, durable and atomic with the
revision change and security audit. Evidence identity and revocation share a
transaction lock, including revocation-before-publication. New claims cannot reuse
an evidence ID for a changed context. Replaying publication cannot bypass current
expiry/revocation checks. Browser retries retain the same public payload and key;
wallet/chain/session changes retire the private workspace. Imported schemas reject
unknown/private-key/token fields locally and in the BFF before forwarding. Draft
and source-import workspaces are excluded from translation-service extraction.

## Revocation and explicit external boundaries

`POST /v1/rwa/source-revocations` accepts only a source-signed revocation:

```text
sha256(abi.encode(
  sha256("ArtFi approved-source revocation v1"), sha256(sourceId), evidenceId,
  revokedAt, sha256(reason), sha256(mode)
))
```

Revocation is permanent and idempotent, audited and available before the claim is
published. The source can submit it without acquiring an ArtFi admin/operator
role. A disabled source may still revoke its prior claims while its public root
remains configured. Withdrawing the root also makes its claims unavailable.

The native contract exposes `revokeSourceEvidence` for the same signed revocation.
A signed API receipt is **not** an on-chain transaction: source revocation must
also reach the native verifier for direct-contract revocation enforcement.
The API stops new actions from its durable revocation immediately, and the
contract rejects evidence after its own recorded revocation or signed expiry.
There is no hidden server signer or automatic real-chain relay. Source operators
must deliver revocations to each relevant verifier; tests exercise both paths.

Application catalog activation does not retrofit external receipt contracts or
previously deployed market contracts. A market's token allowlist alone is not
source authenticity. ArtFi's current catalog/trading entry points check source
status and exact bindings; independent direct raw calls to external/legacy
contracts remain governed by those contracts. Do not claim this application
verifier can freeze or rewrite third-party assets. Owner revocation, withdrawal,
recovery and token-transfer exits are not blocked by source expiry.

## Local verification of this implementation

- Full Foundry suite: 145 passed across 10 suites, with configured 512-run fuzzing
  and 256 × 64 invariant campaigns. The source tests use ephemeral P-256 keys.
- Full web unit suite: 954 passed across 73 files, including the new source proof,
  publication/import, BFF and current-underlying checks.
- Full Go/MySQL 8.4 race-enabled suite passed with migration 000013 applied,
  including multi-process mint replay, signed-source revocation, source/token/model
  uniqueness, ordinary-user publication, revision conflicts and restart recovery.
- Web typecheck, focused ESLint, public API type generation, installer source
  configuration tests, deployment-tooling guard tests, chain-consistency check,
  secret-pattern scan and whitespace check passed.

These are local isolated checks. They are not a real-source activation, public-chain
operation, production deployment, independent external audit, browser aggregate or
final installable acceptance claim. The delivery owner runs the final browser and
installer checks on the frozen combined source.

### Prepared-request evidence renewal

If approved-source evidence expires before mint confirmation, import a fresh
source-signed envelope for the same source-review commitment. The registrar BFF
uses `POST /v1/rwa/intents/{intentID}/evidence`; the original intent, request ID,
recipient, metadata, source identity, underlying asset, model and rights remain
unchanged. The update is transactional, current trust and revocation are checked,
and the audit retains both public evidence versions. A reused evidence ID cannot
be assigned a different claim. No asset reservation is released by renewal.

A definitively reverted wallet attempt retains its original intent and
idempotency key. Its failed transaction hash remains in recovery information;
retrying does not allocate another issuance. An uncertain wallet result must be
resolved first. Neither renewal nor retry silently signs or submits a transaction.
