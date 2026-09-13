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
is currently available. Its role is limited to read-only operations health input:
it has no execute, reconcile, revoke, signing, RPC or broadcast capability. The
contract deliberately remains `productionReady: false` while its independent
integrity object, complete health projection, managed database probe, installation,
injection, rollback, alerting, recovery and soak gates are absent. Treating the
handoff as a required production dependency does not promote an artifact-only,
non-callable input into a ready Operations Agent. Even after those health-input
gates pass, this role cannot self-promote: the complete Operations Agent requires
a separate exact capability contract covering the autonomous responsibilities in
issue #84 sections 30 and 36.

The separately frozen `ArtFiLinkOps` r3 package is audit-only provenance, not
an executable dependency contract: archive
`E95AB4436F276C3831A35CAD498C903C061716B9F5E8D10EB36F04F6B487D000`,
manifest
`189326EE4C030A24CE9AD183F902499506A48F8775B4F89ADB759298E32CCEB0`,
integrity
`EB04584630464CDE28BF3FF6B5D5C4A91245C595C7AA34135BD90C73AED1C827`
and test results
`729F22E3B60BDDFE2DEC82CAAA142977F9AB4F77F41D3F7C6EA430EE7EADF825`.
Producer-side tests passed 23/23 locally and 23/23 on ABCDYI. Independent
audit, protected execution authority, alert/repair helper acceptance, actual
installation/upgrade/rollback, recovery evidence and soak remain absent, so
r3 is not imported into this machine contract and cannot enable execution.

Initial supported execution is one bounded TEST_ONLY NFT BUY, not every PRD action.
All other actions remain outstanding; this slice does not redefine final delivery.
