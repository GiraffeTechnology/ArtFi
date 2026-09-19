# Deterministic Agent integration slice

Status: IMPLEMENTED-NOT-VERIFIED. This is not a DELIVERY_CANDIDATE.

Authority: repository issue #84 §§9–18 and §§32–34. The slice implements a
minimum observation, signed-intent, deterministic-policy, execution, verification,
reconciliation and recovery path. It does not authorize unbounded spending,
custody, mainnet, real assets or stored user keys.

`runtime.mjs` composes durable SQL storage, kernel, service and scanning worker.
`agent-console.mjs` mounts the minimum browser view with injected authenticated
API and user-wallet adapters. No adapter is discovered from environment or guessed.
An absent adapter fails configuration; fixtures are never used as live fallback.
The modules do not start a listener or sign a transaction on import.

The kernel persists STARTED before execute and reconciles uncertain submission
instead of resending. Only exact confirmed canonical revocation proof terminates
PREPARED; STARTED remains eligible for historical reconciliation. New mint-authority
preflight is separate from historical recovery. Oracle supplies that interface;
this change does not replace its proof implementation or introduce named-source
requirements. The caller supplies trusted `mintAuthority`, `observe`, `authorize`,
`execute`, `verify` and `reconcile` dependencies; caller JSON is not authority.

The durable store renews its identity-bound lease before each bounded external
stage. Its minimum lease covers renewal persistence, one bounded adapter and the
following durable save. STARTED atomically reserves nonce, intent ID and a
conservative monotonic wallet exposure before executor dispatch; an UNKNOWN result
or expired process
lease never releases that authority. A timed-out pool acquisition is quarantined
and any late connection is destroyed, while later bounded recovery attempts remain
possible after a short backoff.

Source observation failure cannot erase owned durable identity or disable wallet
revocation. The view marks stale source data while preserving stored status;
creation/execution still require their independent fresh checks. STARTED stores
the newly authorized observation version, not a permanent equality to the creation
snapshot. This does not replace nonce/reservation enforcement or chain checks.

`durable-store.sql` is an unapplied schema template, not a numbered deployment
migration. A reviewed exclusive CTYun TEST schema and non-root TLS pool are still
required. Uint256 reservations use canonical decimal strings in MySQL-compatible
`VARCHAR(78)` columns and are range-checked before write and after read. The code
expects a mysql2-compatible pool, but installs no driver and
contains no connection information. No DB or source snapshot is included.

Run `pnpm agent:test` for kernel and durable-runtime contract tests. The existing
quality web job runs this command. The wiring suite uses an explicit SQL protocol
fake and a configuration-only crypto stub which throws if signature operations
are attempted; no sibling checkout or external test dependency is required.
These tests use a store fake and prove no live DB, real source or remote runtime.
`apps/web/e2e/agent-console.spec.ts` imports the actual console and intent modules
into desktop and mobile Chromium. It covers the TEST_ONLY create/query/revoke,
stale-source, terminal and remount-recovery states with explicit in-test adapters;
the harness is never presented as live data. Remaining gates include durable DB
restart, real proof adapter composition, authenticated HTTP/wallet binding, chain
executor integration, deployed browser runtime, dependency/CI/security review and
deployment acceptance.

Production composition treats the wallet+DAO operations agent as a required,
managed dependency. It must be injected through the reviewed opaque adapter
boundary; ArtFi must not read wallet material, place keys in IPC/environment/logs,
or silently fall back to an application-held signer. This repository slice does
not install or activate that production dependency.

`operations-dependency.contract.json` records the exact non-secret handoff that
is currently available. The client ruled that the wallet+DAO Operations Agent is
a production dependency; the fields below are implementation observations, not
new product requirements or acceptance gates. The current artifact's role is
limited to read-only operations health input:
it has no execute, reconcile, revoke, signing, RPC or broadcast capability. The
contract deliberately remains `productionReady: false`. Integrity, projection,
database, installation, rollback, alerting, recovery and soak fields describe
currently unverified implementation evidence only. They do not amend issue #84 or
independently block a bounded stage. This read-only artifact does not implement
the autonomous responsibilities described by issue #84 sections 30 and 36.

The separately frozen `ArtFiLinkOps` r3 package is audit-only provenance, not
an executable dependency contract: archive
`E95AB4436F276C3831A35CAD498C903C061716B9F5E8D10EB36F04F6B487D000`,
manifest
`189326EE4C030A24CE9AD183F902499506A48F8775B4F89ADB759298E32CCEB0`,
integrity
`EB04584630464CDE28BF3FF6B5D5C4A91245C595C7AA34135BD90C73AED1C827`
and test results
`729F22E3B60BDDFE2DEC82CAAA142977F9AB4F77F41D3F7C6EA430EE7EADF825`.
The producer reported 23/23 local and 23/23 ABCDYI tests, but this repository
contains no durable run or artifact that independently reproduces those counts.
Treat them as unverified external provenance, not current delivery evidence. r3
is not imported into this machine contract and cannot enable execution.

Initial supported execution is one bounded TEST_ONLY NFT BUY, not every PRD action.
All other actions remain outstanding; this slice does not redefine final delivery.

## Conditional Oracle observation adapter

The optional `oracleAttestation` composition option wraps the existing `observe`
dependencies for both kernel and service. D1 `mintAuthority` and its
`EXCLUSIVE_AT_PINNED_BLOCK` contract remain unchanged. Projection history and
finality are distinct from attestation validity. Registration remains optional.

Trusted composition supplies `resolveRequiredAttestation(request, signal)` and
an application-facing verifier created with `createOracleApiVerifier`. The verifier
calls only Oracle's `POST /v1/rwa/attestations/verify` boundary. Its endpoint and
fetch implementation are injected by the composition root; no environment,
credential or fallback service is guessed. Only explicit `null` from that trusted
resolver selects a flow without an attestation requirement.
Otherwise it supplies `{ attestation, expectedSubject }` with the existing
flow's assetId/chainId/contract/tokenId/purpose binding. Caller JSON cannot select
an opt-out. No purpose, registration requirement or token convention is defined.

Valid evidence establishes current grounding without removing an existing
restriction or negative grounding result. NOT_CURRENT clears groundingCurrent;
REVOKED sets assetRestricted. Source failures clear available/current. The
existing deterministic policy refuses ineligible observations. Before STARTED,
the kernel persists bounded Oracle evidence separately from D1 mint authority;
a refusal preserves PREPARED and returns SAFE_DEGRADED. STARTED recovery skips
new observation checks. No proof/signature bytes are stored in that evidence.

The existing console shows the stored verdict as a historical check, not current
authority. Durable reads and independent wallet revocation remain available
through source outage. The wrapper never calls export, settlement, or custody.
Omitting the option preserves existing behavior, including existing errors.

Tests use explicit verifier/store/chain fakes and the existing policy tests;
they do not establish live Oracle, cryptographic, database or production proof.
Browser evidence uses the existing console with fixture API/wallet adapters.
No remote deployment or global PreMint gate is included.

Required-flow evidence includes bounded `attestationId` and the exact
`expectedSubject` assetId/chainId/contract/tokenId/purpose tuple. The adapter and
durable hydration bind chainId/contract/tokenId to the immutable request. Valid
verdicts without identity are refused. Source-resolution failures can remain
identity-free failure records. No raw proof or signature is persisted.

### Opt-in real SDK integration test

Run `node --test scripts/agent/oracle-sdk.integration.mjs` with
`ARTFI_ORACLE_TEST_CHECKOUT` set to an absolute path containing Oracle main
`f2ba4bc5fa6e88330a19c3f8684764e524917dd0`. The test verifies Git blob
identities for all five imported source files before importing the real SDK,
attestation service, revocation registry and resilient source adapter. It fails
if the path is missing or any source differs; it does not skip or substitute a
fake. Source files are external test dependencies, not copied into ArtFi.

Those five blobs are unchanged from the earlier `8350a65` handoff; the current
main pin preserves the merged projection/finality/conformance corrections through
Oracle PR #41. Direct SDK composition is retained only as a synthetic compatibility
test. Runtime ArtFi composition uses the Oracle application-facing API.

This test uses ephemeral in-memory Ed25519 keys and synthetic source transport.
It covers valid, exact expiry, revoked, subject mismatch, source timeout/circuit
open without verifier invocation, and recovery. It proves real-SDK compatibility,
not live deployment, source authority or production composition. The default
agent suite remains self-contained with its useful contract-fake coverage.
