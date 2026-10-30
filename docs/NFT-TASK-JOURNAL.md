# Authenticated internal NFT task journal

## Scope and baseline

This increment closes the task-principal journal code gap behind the existing
native NFT listing port. It preserves the unsigned native operation journal,
Wallet authority separation, exact-plan authorization and recovery requirements
of issue #110 and the later bounded seller-listing implementation instruction.
The source baseline is ArtFi PR #162, commit
`298aabb50da1354077bc406073891b421586c24a`, now merged as
`04b94465c8d9265ae1357133fa4e2c41ef3f0ad0`; both use tree
`c30aa7a3439fb6dfa5eeeb514924871c8bb2a474`.

This is implementation and isolated verification, not a deployment, live signing,
venue publication, chain execution, or genuine-device acceptance result.

## One repository, two verified principal paths

`nft_operation_store.go` owns the existing `nft_operations` table transaction,
`SELECT ... FOR UPDATE`, revision CAS, state transitions, permanent wallet-start
claim, immutable plan and transaction/order hash claims. The update query also
has an explicit expected-revision predicate. Both handlers use this repository.

- The existing `/v1/nft/operations` handler still requires its dedicated bridge
  credential and the verified user access token. Session refresh/recovery by the
  same authenticated wallet and chain is preserved.
- `/internal/v1/nft/operations` is a distinct authenticated task route. It is not
  registered by the public `NewHandler` or the ordinary API binary.
- Task identity is persisted in the existing immutable unsigned plan's
  `taskPrincipal`. It contains the task ID/digest, original executor digest,
  grant reference/version and Wallet operation ID. The plan also retains the
  native operation and plan IDs. No parallel journal or data migration is needed.
- Task operations cannot adopt a session row or another task's row. The session
  get/update path cannot adopt a task row. Task create idempotency requires both
  the request hash and the entire immutable plan to match.
- Signature-bearing fields, private keys, seed material, raw signed transactions,
  access tokens, API keys and capability values are excluded recursively. Key
  aliases such as `private_key`, `signatures` and `typedDataSignature` are rejected.
  Unsigned typed data and the plan value `kind: "signature"` remain supported.

The repository receives an internal typed verified principal. HTTP JSON cannot
construct that authority. No login session is fabricated for a task.

## Fixed transport and capability protocol

The task handler requires two independent facts:

1. The incoming Wallet workload has an authenticated TLS certificate whose
   verified client-certificate chain contains the exact configured URI SAN.
   Forwarded identity headers, unverified certificates, the existing bridge
   credential and body `taskPrincipal` claims do not authenticate this peer.
2. Wallet atomically consumes a short-lived, one-use capability in its held-grant
   registry. The capability is valid only while the existing grant gate remains
   held. Issuing it does not create, renew, broaden or replace a grant.

ArtFi's `NewNFTTaskHTTPVerifier` calls a fixed HTTPS endpoint with its own
separately installed mTLS client identity:

`POST /internal/v1/task-journal-capabilities/consume`

The JSON request fields are `capability`, `peerId`, `action`,
`nativeOperationId`, `planDigest` and `requestDigest`. `peerId` is the original
Wallet-to-ArtFi client URI SAN. It is **not** the identity of the ArtFi-to-Wallet
introspection connection. Wallet must independently authenticate the latter
against its configured ArtFi workload identity. No shared certificate is needed.

The response is a direct JSON object containing those scope fields, excluding
`capability`, plus `principal`, `wallet`, `chainId`, `issuedAtMs` and
`expiresAtMs`. No envelope or caller-provided verified flag is accepted.

The handler independently checks every returned binding, the exact principal
shape, wallet and chain, issuance time, expiry, and a maximum lifetime of 30
seconds. The database transaction context is bounded by capability expiry.
Transport and body errors fail closed. Redirects are not followed. Introspection
responses are limited to 16 KiB; operation requests/responses are limited to 64
KiB. Neither transport retries writes automatically or logs capability payloads.

### Canonical digest

`nftTaskJournalDigest` and Go's wire digest use the same version-1 encoding:
recursively lexically sorted ASCII object keys, safe-integer JSON numbers,
ordinary JSON arrays and values, and escaped `<`, `>`, `&`, U+2028 and U+2029.
String values may contain Unicode. Numeric object property names are sorted
lexically too. The digest is lowercase SHA-256 hex without a `0x` prefix.

`requestDigest` covers the complete JSON `{ action, operation }` after omission
of undefined optional properties. `planDigest` covers the complete unsigned
plan for create/update. Initial get uses an empty `planDigest`, but still binds
the exact action, native operation, body and task. The stored row must match the
verified task, wallet and chain before it can be returned. Read authority cannot
be converted to create/update authority.

### Avoid grant-gate deadlock

The TypeScript factory's fixed `withCapability(scope, callback)` dependency
holds the same previously verified Wallet grant gate across the entire journal
HTTP await. Its separate consume registry must not call back into the locked
grant store. The registry consumes once and rejects replay, expiry, revocation
or closure of the held authorization context. This dependency is provided by
the concrete Wallet runtime composition, never by an HTTP request.

A response can be lost after a committed CAS. The adapter does not resend a
create/update. Recovery first reads the durable operation using a new read
capability. Any later authorized write needs a fresh one-use capability and the
current expected revision. Do not turn response uncertainty into a second wallet
start, signature or publication.

## Concrete startup and package wiring

`apps/api/cmd/task-journal` is the opt-in internal-service entrypoint.
`NewNFTTaskJournalServerFromEnvironment` performs all fixed startup wiring:
existing MySQL table/pool, verified client CA, exact peer URI SAN, server TLS
identity, separate introspection client identity and pinned authority endpoint.
The listener requires TLS 1.3 and verified client certificates.

Startup requires all of these explicit installation settings:

- `ARTFI_TASK_JOURNAL_ENABLED=true`
- `ARTFI_TASK_JOURNAL_ADDR`
- `ARTFI_TASK_JOURNAL_MYSQL_DSN`
- `ARTFI_TASK_JOURNAL_TLS_CERT_FILE`
- `ARTFI_TASK_JOURNAL_TLS_KEY_FILE`
- `ARTFI_TASK_JOURNAL_CLIENT_CA_FILE`
- `ARTFI_TASK_JOURNAL_PEER_URI`
- `ARTFI_TASK_JOURNAL_CAPABILITY_URL`
- `ARTFI_TASK_JOURNAL_AUTHORITY_CA_FILE`
- `ARTFI_TASK_JOURNAL_AUTHORITY_CERT_FILE`
- `ARTFI_TASK_JOURNAL_AUTHORITY_KEY_FILE`

The ordinary database pool tuning settings are reused. Configuration values and
credential contents are not logged. Missing/invalid startup configuration does
not start the service. A task handler or TS adapter constructed without required
fixed dependencies returns an explicit 503 unavailable result. The public API
continues to return 404 for the internal route.

The independently packaged `@artfi/task-listing-runtime/server` entry exports
`createNftTaskJournal`, `nftTaskJournalDigest` and its versioned interface for
Wallet's fixed server composition. There is no request-selected module, URL,
signer, verifier or journal implementation, and no session/bridge fallback.
The bundle includes the separate `artfi-task-journal` binary without enabling
or installing a real workload identity automatically.

Installation still supplies the already approved workload authentication,
destination, existing database and secure credential paths. This increment does
not generate, provision or grant real persistent access, or select a custody
provider. Configuration is not a substitute for authorized deployment evidence.

## Verification

The isolated checks exercise:

- The actual shared SQL repository and the old session MySQL/CAS/history path.
- Concurrent task claims, task/session/foreign-task separation, immutable plans,
  permanent wallet-start and hash claims, and one-use/expired/changed capability
  rejection before persistence.
- Actual ephemeral test-only mTLS client/server handshakes, verified URI SANs,
  fixed introspection routing, replay response mapping and redirect refusal.
- A stopped and restarted MySQL server plus a new Go test process recovering the
  same durable task operation, revision and immutable plan.
- TS adapter canonicalization, exact response validation, gate-held transport,
  private/signature payload rejection, no session fabrication and no write retry.
- Existing native task-port tests, full web type checking and focused lint.

The MySQL runner uses a disposable database bound only to loopback, applies the
existing migrations, and stops both initial and restarted test servers. Test
certificates are ephemeral and in memory. No live signer, venue or chain is used.
