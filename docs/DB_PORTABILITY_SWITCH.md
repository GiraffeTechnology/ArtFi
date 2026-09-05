# MySQL portability and controlled switching

This independent candidate implements a prerequisite, not a hot switch. It maps to
PRD M6.2/M6.5 and the user's DB P0 ruling. No production switch, new DB installation,
customer-data copy, deletion, credential disclosure or blockchain action is authorized
by this document. Only the dedicated CTYun DB or an explicitly approved new DB host
may hold a database; abcdyi and Aivan are application/bridge hosts, not DB targets.

## Implemented boundary and evidence status

- Existing `MYSQL_DSN` remains an externally injected MySQL-driver connection
  specification. Endpoint, credentials and TLS parameters must come from a managed
  profile, never source code, logs or PR artifacts. The example leaves it empty.
- `persistencePoolOptionsFromEnv` externalizes bounded pool/health-probe settings.
  Unset options preserve the existing startup defaults; configuration errors expose
  only `DB_POOL_CONFIGURATION_REFUSED`. Open/ping/hydration logs now use fixed stage
  codes rather than raw driver errors.
- `persistence_options_test.go` contains three top-level default-preservation,
  application-to-pool and invalid-input tests, including sixteen negative subtests.
  Retrievable source evidence: exact PR #67 head
  `5d9b11aadd557cf3dd2520556e969e8b3f55a11c`,
  [quality run 33952268640](https://github.com/GiraffeTechnology/ArtFi/actions/runs/33952268640),
  [API job 101269156886](https://github.com/GiraffeTechnology/ArtFi/actions/runs/33952268640/job/101269156886):
  Go 1.26.5 Linux, gofmt/no-diff, `go vet ./...` and `go test -race ./...` succeeded.
  No retrievable standalone offline `go mod verify` log is attached to this PR;
  local offline observations are not counted as reviewable acceptance evidence.
  These CI results bind the cited source head only; any follow-up needs fresh CI.
  Approved CTYun DB integration, TLS, backup/restore and switching remain
  **NOT_VERIFIED**. No real DB was connected by the local source checks.
- TLS certificate/hostname policy enforcement, live pool replacement, write
  admission fencing, replication and rollback are **not implemented by this slice**.
  `MYSQL_DSN` changing in an environment or secret file does not reload an existing
  process or establish a hot-switch result. Do not call `attachPersistence` concurrently
  with requests: it is a startup function, not a reload API.

| Setting                       | Default | Accepted bound                                             |
| ----------------------------- | ------- | ---------------------------------------------------------- |
| `ARTFI_DB_POOL_MAX_OPEN`      | 10      | Integer 1–1000                                             |
| `ARTFI_DB_POOL_MAX_IDLE`      | 5       | Integer 0–max open; adjust both when reducing below 5      |
| `ARTFI_DB_POOL_MAX_LIFETIME`  | 5m      | 1s–24h                                                     |
| `ARTFI_DB_POOL_MAX_IDLE_TIME` | 0s      | 0 disables idle expiry; otherwise no greater than lifetime |
| `ARTFI_DB_CONNECT_TIMEOUT`    | 3s      | 10ms–1m; bounds startup ping/hydration context             |

The timeout is not a substitute for driver dial/read/write deadlines or a transaction
deadline. The `database/sql` setters do not guarantee that an active transaction is
aborted at max lifetime. Tests must establish draining explicitly.

## Compatibility contract, not arbitrary-database compatibility

The application is pinned to `go-sql-driver/mysql` 1.10.0, SQL migrations and MySQL
semantics. The acceptance suite specifies MySQL 8.4. A reported CTYun historical
handshake of 8.0.58 is inventory only, not proof that 8.4 acceptance, migration or
TLS behavior passes there. MariaDB, PostgreSQL and other engines are not asserted
to be drop-in compatible. No new driver/vendor dependency is added by this slice.

For each exact source and server pair, record sanitized version/architecture, SQL
mode, timezone, collation, case sensitivity, transaction isolation, storage engine,
JSON/constraint/index behavior, authentication plugin and TLS version/CA/hostname
verification result. Test migrations forward/down, integration/race/restart/replay/
conflict/reorg, logical dump and independent restore with matching schema, row counts,
constraints and canonical-event checkpoints. Pin compatible client/dump versions and
test GTID/replication options rather than assuming every server exposes them.

Configuration profiles may identify a secret by opaque reference. Their non-secret
control plane needs revision, logical target identity, TEST_ONLY/production label and
approved schema scope. DSN values, credentials, database dumps and private customer
rows must never be included in evidence. No profile is invented when it is absent.

## Routing choices

| Choice                                       | Benefit                                                    | Required controls still missing                                                                                                                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable managed endpoint/proxy/tunnel         | Future server address changes need no business-code change | Existing TCP sessions remain pinned to the old backend. Fence admission, drain all old pools and fence the old writer; verify new TLS/target identity and rebuild connections. Do not alter the protected current tunnel without a separate execution plan. |
| Explicit profile reload and pool replacement | Health-check a candidate pool before publishing it         | A synchronized admission/generation lease, per-generation in-flight accounting, complete staging of hydrated projections, atomic publication and rejection rollback. A plain assignment to `service.db` is insufficient.                                    |

Prefer the existing stable managed endpoint when its controlled switch/health/fencing
capabilities can be proven. Add explicit reload only if required by the measured
runtime. Both require the same data-plane protocol below. No new paid license or
business rewrite is a design goal, not a promise of zero infrastructure/traffic cost.

## TEST_ONLY switch protocol and rollback evidence

1. **Preconditions:** approved source/target DB identities and isolated schemas,
   least-privilege profiles, immutable source commit, baseline schema/data checkpoints,
   verified backup and isolated restore. Target starts non-writable to applications.
   Absent second target/replication authority is a named gate, not a simulated PASS.
2. **Catch-up:** seed the target with approved test data only, follow a supported
   replication/change stream, measure lag and compare schema, constraints, row hashes
   and canonical checkpoints. No concurrent unfenced application writers.
3. **Admission fence:** stop admitting new writes across every application replica.
   Return bounded unavailability; do not acknowledge an unexecuted write. Drain active
   source transactions under a finite deadline; cancellation is not proof of rollback.
4. **UNKNOWN outcomes:** if a connection drops around commit, retain the request's
   stable idempotency identity and mark reconciliation required. Inspect the authoritative
   outcome before any retry. Never replay an entire batch or infer rollback from a
   transport error. An unresolved outcome prevents completion of the switch checkpoint.
5. **Final synchronization/fencing:** record the source high-water mark after drain,
   fence the old writer at the DB/control plane, complete target catch-up and verify
   equality. Fence effectiveness must be tested from all old application identities.
6. **Candidate health:** build a new pool from the reviewed profile; verify target,
   TLS identity, version/schema and permitted read/write semantics in the test scope.
   Stage all hydrated maps from the target and validate them before exposing the pool.
   Failure must not publish a partially hydrated service or drop the old usable pool.
7. **Promotion:** change routing/pool generation and projections together under the
   admission barrier, then allow exactly one writer. Prove old connections cannot write,
   run API read/write and canonical-projection checks, and observe bounded errors.
8. **Rollback:** before any new target write, reverting routing is allowed only after
   verifying the old data remains current and re-fencing the target. After a new target
   write, **never** route back to a stale old database. Fence/drain the new writer,
   reconcile UNKNOWN outcomes, reverse-sync or restore its new committed data onto the
   old target, verify checkpoints, then exchange the writer fence. If correctness cannot
   be proven, remain unavailable and escalate; do not claim safe rollback.
9. **Measure:** report observed write-unavailable interval, failed/UNKNOWN requests,
   recovery time and lost acknowledged-write count/checkpoint delta (RTO/RPO), clocks and
   workload. Include reconnect/timeout/TLS rejection/lag/target-down/rollback-after-new-write
   cases. Publish measured bounds, never an untested zero-loss/zero-downtime promise.

The current service hydrates mutable maps at startup. Refresh/invalidation and atomic
replacement are mandatory future work; retaining stale maps after a new pool is not
compatibility. Server-side migrations, backups, restores and eventual approved switch
execution belong to the fullserver lane, which records sanitized validation/rollback
logs. This document does not authorize deletion of any source database or backup.
