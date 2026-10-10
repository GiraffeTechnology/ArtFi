# Internal native NFT seller task port

This is the bounded seller-listing increment under the native NFT workflow in
Issue #110 and the explicit 2026-10-10 implementation instruction. It does not
expand supported markets, task policy, payment tokens, or execution authority.

## Interface and identity

`createNativeNftTaskPort` in `apps/web/src/lib/nft/task-port.ts` requires fixed,
server-only composition and returns:

- `prepareListing(taskBinding, request)` -> immutable native reference
- `reviewListing(nativeReference)` -> the same reference and exact unsigned plan
- `publishListing(nativeReference, exactSignature)` -> publication state
- `readPublication(nativeReference)` -> existing state, safe reconciliation and a read-only recovery snapshot

A binding identifies the frozen task, executor, durable grant reference/version and
Wallet child operation. The reference additionally identifies the native operation,
plan, canonical SHA-256 review digest, Seaport order hash and EIP-712 digest. The
SHA-256 encoder is the existing `kernelRequestDigest`; the task digest remains the
Wallet's existing frozen-task format. Public binding fields are not credentials.

The injected authenticated verifier must establish `VerifiedNftTask` from the
server's actual task/grant authorization service. Every call verifies the binding;
prepare, review and publish with a plan also require that verifier to check the
existing NFT sale terms validator, the exact child, its grant-bound valuation policy,
quote evidence, explicit price-at rule and fee limits. An idempotent prepare that finds
a saved operation returns its exact existing reference; it does not refresh price
evidence or authorize another signature. Review and publish recheck full current terms. A pure `MATCHED` assessment is
not task authorization. A settlement-time USD guarantee cannot be replaced with an
order-review quote. No default validator, HTTP-loaded configuration, claimed
`authenticated` boolean, bearer bridge shortcut, user-session fabrication or stale
cookie is provided.

Only `list` is supported. Seller, chain, NFT standard/contract/token and quantity must
match the authenticated task. `request.quantity` equals `task.intent.quantity`, even
when the wallet holds more. A task plan contains `taskPrincipal`; it has no
`sessionId`. The existing web session wrapper and route interfaces are unchanged.

## Exact side-effect boundary and uncertainty

The composition must implement `withTaskAuthorization` using the same durable grant
snapshot/lock as revocation. The port consumes that capability once. Review records
`walletStarted` with CAS before returning its unsigned plan. The external Wallet
signer must independently perform its final authorization gate immediately before
signing; this port has no signer or key interface.

If the review response is lost after `walletStarted` was committed, the same verified
reference can still read `recoverySnapshot.unsignedPlan`, `walletStarted` and
`signingState`. The snapshot explicitly carries
`authority: "READ_ONLY_NOT_SIGNING_AUTHORIZATION"`. Its original unsigned plan keeps
the same review digest. It may be read after grant/review expiry or revocation with
independent read authorization. Reading does not reset `walletStarted`, authorize a
new child, or request another signature. Whether dispatch can recover must be proved
by the same Wallet child's durable signer/journal evidence; unknown outcomes stop.
That production recovery composition is not implemented or claimed here.

Publication verifies the exact signature through the existing EOA/EIP-1271 core,
rechecks current ownership, counter and existing approval, then enters the durable
grant gate. That gate remains held through the `submitted` CAS and official SDK
publication dispatch, including intervening awaits. After the submitted journal await, a final synchronous
check of the gate's fresh task, exact terms and review/order/task expiry runs immediately
before SDK dispatch. A new review claim or publication dispatch also requires the verifier's explicit
`sideEffectDeadlineAtMs` (milliseconds), the earliest applicable quote-age, quote-expiry
or valuation-policy deadline. The final guard checks that deadline again after CAS;
it never shortens the order/task expiry to approximate a quote window. Missing
or expired deadline fails closed. Expiry there retains `pending` uncertainty with zero
publication. Existing pending/submitted publication is reconciled without another
dispatch and does not consume a new side-effect deadline.
A check followed by an unlocked
async callback is not an implementation of this contract. Revocation that wins the
gate blocks publication; revocation ordered after dispatch does not cancel the order.

The existing journal transitions are reused. Signatures are only transient values
for verification and `postListing`; they are never added to an operation, reference,
plan, or publication response. `submitted` is committed before publication. Lost or
mismatched responses remain `pending`; reads reconcile the same order hash and never
repost. A concurrent or restarted attempt must respect journal CAS and immutable plan
identity. There is no in-memory-only operation identity or regenerated order on retry.

The task path refuses any approval or transaction plan with an explicit existing
approval-required/currently-unsupported error. It does not silently approve a token
or collection. ERC-721's already-existing token-specific approval is preserved through
the existing official SDK exact-approval recorder logic.

`accepted` means venue publication acceptance. Responses include `saleComplete: false`
and `settlement: "NOT_ASSESSED"`. Fill observation is the separate existing evidence
path. Read authorization may remain available after task/grant expiry or revocation,
so unknown publication can still be reconciled. It must still authenticate ownership;
revocation is never represented as on-chain order cancellation.

## Cross-service deployment state

The current Go `/v1/nft/operations` handler authenticates bridge transport and a valid
user access token. Neither is a task principal. This increment does not change that
handler, loosen login, invent a task credential, or wire a public task endpoint.

The injected journal contract must be backed by an authenticated **internal task
scope** carrying the verifier-established principal and applying the same durable
CAS, plan immutability, signature exclusion, operation ownership and uncertain-result
rules. The authenticated cross-service transport and production composition are
**NOT CONFIGURED** by this patch. A future adapter must add that real scope without
bypassing the existing session path. Tests supply an explicitly synthetic journal
model; they do not establish a production channel.

## Synthetic evidence and limits

Tests use the pinned official OpenSea SDK with a completely synthetic fetch/provider,
plus existing canonical parser and signature verifier. The task tests use only fake
EIP-1271 results, no key generation or actual signing. Global network use is denied in
the task fixture. Ethereum/Base identifiers represent supported protocol shapes only;
no API testnet listing support or real marketplace execution is asserted.

Local evidence: 25 task-port tests; 143 unchanged NFT-path tests; all 82 web test files
and 1,059 web tests; all 251 agent script tests; TypeScript, ESLint and secret scan.
Full production build, browser E2E, authenticated task-journal integration, deployment
and real-value operation were not run. The isolated patch does not modify a current
PR, an installation package, a live service, or production configuration.
