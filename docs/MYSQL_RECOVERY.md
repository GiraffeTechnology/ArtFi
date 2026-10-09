# MySQL primary/replica and recovery

Requirement: PRD M6.2, the existing primary/replica, backup and restore scope.
This delivery provides reusable MySQL 8 tooling and source-neutral configuration
templates. Its automated evidence uses fresh loopback MySQL 8.4.11 servers and
synthetic TEST_ONLY records. It is not a production deployment, production
failover exercise or evidence of registry/chain authority.

## Delivered tools and prerequisites

- `tools/operations/mysql-recovery.mjs`: packaged, dependency-free Node CLI.
- `tools/operations/mysql-primary.cnf.example`: durable GTID primary template.
- `tools/operations/mysql-replica.cnf.example`: durable GTID, persistently
  read-only replica template.
- `tools/operations/mysql-client.cnf.example`: private operator connection-file
  template. The checked-in version contains placeholders, not credentials.
- The release's bundled `runtime/bin/node` runs the CLI; no source checkout,
  npm, Go compiler or onsite implementation is needed.
- Install the official MySQL 8 `mysql` and `mysqldump` client programs through the
  operator's normal approved software process. Use compatible clients/server
  versions. If they are not on PATH, specify `--mysql /absolute/path/mysql` and
  `--mysqldump /absolute/path/mysqldump` for backup.

In a source checkout, substitute `scripts/operations` for `tools/operations` and
the available Node 24+ runtime for `runtime/bin/node` in the examples below.

Connection files must be owned by the operating account, regular files, mode
0600 and selected with an absolute path. Keep them in private operator storage
outside source, release bundles, web roots, screenshots and CI artifacts. The CLI
does not accept credential arguments, print client stderr, or use `MYSQL_PWD`.
It explicitly ignores MySQL login-path credentials; the supplied configuration
file is the connection authority. Keep that file limited to the reviewed client
connection and TLS settings in the example; do not add init commands or options
that change dump/import semantics. Protect its parent directories as well.

Use an operator-provisioned backup account with SELECT over **the entire
application schema**, including the migration ledger, and metadata visibility
for the entire schema. A table-restricted account cannot attest to tables it
cannot see. The application schema is the installer-managed InnoDB table schema;
unexpected views, triggers, stored routines, events or non-InnoDB tables cause an
explicit failure rather than silent omission. Provision the restore account for
the isolated target only, with SELECT, CREATE, INSERT and applicable REFERENCES
privileges. Dumps do not need DROP, database creation, account administration,
replication administration or global GTID mutation. Have the operator verify
least privileges against the actual server; these tools never issue grants.

Real connections require the approved private endpoint and verified TLS. Use
`ssl-mode=VERIFY_IDENTITY` with the correct CA and matching server identity, as in
the client template. The tests' passwordless loopback root accounts and disabled
client TLS are disposable TEST_ONLY fixtures, never deployment examples.

## Create and verify a backup

```sh
runtime/bin/node tools/operations/mysql-recovery.mjs backup \
  --defaults-file /private/artfi/backup-client.cnf \
  --database artfi \
  --output /private/artfi-backups/2026-10-06T020000Z

runtime/bin/node tools/operations/mysql-recovery.mjs verify \
  --backup /private/artfi-backups/2026-10-06T020000Z
```

The parent of the new output directory must already exist in private storage.
The output directory must not already exist. The tool creates it as 0700 and
its files as 0600; it never overwrites or deletes an earlier backup. Never place
backups in public object storage or attach real dumps to delivery evidence.
Encrypted operator-controlled backup storage and off-host retention remain
operator storage configuration; this CLI neither uploads nor deletes backups.

A completed directory contains:

1. `database.sql`: all supported application table definitions and data,
   including `artfi_schema_migrations`, binary values and exact decimals.
2. `manifest.json`: completion marker, UTC time, source database, server version,
   byte size and SHA-256 of the SQL, table/column/index/constraint schema snapshot
   and its SHA-256, and ordered migration names/checksums/applied timestamps.

The CLI uses `mysqldump --single-transaction --quick` for a consistent InnoDB data
snapshot. No table locks, drop statements, GTID purging, database selection
statements or privileged account material are generated. It uses the same
connection-scoped `GET_LOCK(CONCAT('artfi-schema:', DATABASE()), timeout)` as the
precompiled installer migrator. The lock remains held while dumping and while
the schema and clean migration ledger are checked before and after the dump.
Schema metadata comparison excludes mutable table statistics and auto-increment
counters. The tool rechecks the held lock every second during a dump/import.
A lost lock connection aborts the client operation and cannot silently
reconnect. An interrupted/failed backup has no completed manifest and cannot be
restored by this tool.

Ordinary application DML can continue during backup. Every DDL operator must
honor the shared schema lock or schedule DDL outside the backup. The advisory
lock does not stop arbitrary administrative DDL, nor the replica SQL applier;
for a replica backup, avoid overlapping upstream migrations. Before/after schema
and ledger comparisons detect changes and refuse a successful backup, but do not
replace the coordinated DDL requirement. A replica's consistent snapshot can
still be older than the primary. Check replication freshness first.

Use `--lock-timeout 0..300` (default 30 seconds) and `--timeout-seconds 10..86400`
(default 3600 seconds) when necessary. Operation timeouts fail the operation;
they do not authorize a lock override or force an import to continue.

### Integrity is not authenticity

SHA-256 and byte count detect corruption or an incomplete copy. They **do not
authenticate** a backup: someone who can replace both SQL and manifest can
recompute the hashes. Treat a SQL backup as executable input. Verify its origin
through trusted operator-controlled storage, access controls and any independent
signature/integrity system your deployment uses. Never restore a user upload or
an untrusted archive merely because its self-supplied checksum matches. The
required `--trusted-backup` flag acknowledges this boundary; it does not perform
authentication or bypass permissions. `verify` reports
`authenticityVerified: false` explicitly.

## Restore without dropping or activating a database

First provision a **separate, empty application database** through the authorized
database operator. Match its character set/collation to the manifest. Keep all
applications, background jobs and other writers disconnected from this target
until restore and operator verification finish. Do not point the CLI at an
active application's database. The tool never creates a database, empties a
database, drops schema, changes accounts, promotes a replica or changes an
application connection.

```sh
runtime/bin/node tools/operations/mysql-recovery.mjs restore \
  --defaults-file /private/artfi/isolated-restore-client.cnf \
  --database artfi_recovered \
  --backup /private/artfi-backups/2026-10-06T020000Z \
  --trusted-backup
```

Before import, restore checks private storage permissions, the complete manifest,
the SQL's actual SHA-256 and length, and schema manifest integrity. It then
acquires the shared migration lock on the target and refuses any existing table,
view, routine, trigger or event, or a character-set/collation mismatch. The import
reads the same open file descriptor that was checksummed. Protect backup storage
from concurrent mutation throughout verification and restore.

After import, restore verifies the complete schema snapshot and migration ledger
against the backup manifest and returns `activated: false`. It never starts the
application. Run the packaged installer's migration-status/verification workflow
against the recovered target, check expected application records and source
reconciliation, and retain that evidence before an authorized configuration
cutover. The synthetic suite additionally compares extended checksums for every
source/restored table and checks binary, Unicode, JSON, NULL and decimal values.

MySQL DDL is not transactionally reversible. If import fails or is interrupted,
the target may be partially populated. Keep it isolated; the next restore
refuses it as nonempty. Provision another empty target, diagnose the failure
privately and retry from the verified backup. Do not delete tables automatically
or replay migrations over an unidentified partial schema. A dirty migration
ledger is a recovery condition, not a signal to silently mark it clean.

Restoring ArtFi's database recreates its application records and projections.
It neither changes nor proves chain state, registry holdership, artwork
authenticity, wallet authority or physical delivery.

## Primary/replica operating model

The templates are provider-neutral MySQL 8.4 inputs with explicit placeholders,
not ready-to-apply production configuration. The authorized operator supplies
private service addresses, allocated ports, data/log paths, distinct nonzero
server IDs and verified TLS files. Keep deployment bindings separate from the
generic product package. No template guesses a public port or changes a host's
network/security settings. In particular, this tooling does not touch SSH or
the CTYun TCP 443 reservation.

Both sides use GTID, enforced GTID consistency, row-based binary logging,
replica-update logging, synchronous binlog flushing and transaction-log flushing
at commit. The replica additionally uses relay-log recovery, `read_only=ON` and
`super_read_only=ON`, persisted in its startup configuration. Binary-log
retention is an operator capacity/RPO choice; the example is seven days. Keep
enough history for the worst expected replica outage and backup process.

Initialize replication only through an authorized operator procedure: provision
a dedicated least-privilege replication account and verified TLS, seed the
replica using a method with a matching GTID history, then configure its source
and automatic GTID positioning. The recovery CLI deliberately does **not** seed
replication positions (`--set-gtid-purged=OFF`), create replication users, grant
privileges, or execute `CHANGE REPLICATION SOURCE`. A generic logical app restore
is not by itself a correctly positioned replica seed. Never infer a starting
GTID position from the backup timestamp.

The isolated tests configure only a fresh empty TEST_ONLY primary and replica,
start GTID replication before applying migrations, and verify actual writes and
replay. They do not require or exercise production replication grants.

```sh
runtime/bin/node tools/operations/mysql-recovery.mjs status \
  --defaults-file /private/artfi/replica-status-client.cnf \
  --database artfi
```

`status` queries server mode and Performance Schema replication connection,
applier and worker state without returning credentials, source hostnames, SQL or
replica error messages. The status account needs SELECT on the applicable
Performance Schema replication status tables. Exit codes:

- 0: operation succeeded; for status, no observed replication-thread error.
- 1: connectivity, configuration, integrity or operation failure.
- 2: status is `DEGRADED`, including a stopped/connecting/errored replica thread
  or a read-only server with no configured replication channel.

Healthy threads alone do not prove freshness. For a specific recovery/read
requirement, record the primary's committed GTID set and use the replica's
`WAIT_FOR_EXECUTED_GTID_SET(required_set, bounded_timeout)`; a zero result proves
that set was applied. Validate the corresponding application records. Never
interpret a timeout or a stale replica's available SQL connection as catch-up.

On primary outage the CLI reports failure/degraded state. The replica remains
read-only. There is **no automatic promotion** or application routing change.
Asynchronous replication can lag and can lose the primary's latest transactions
if they never reached a surviving replica. Replication is not a backup: logical
mistakes/deletions can replicate too. Restore and a separately authorized,
split-brain-safe failover/cutover procedure serve different purposes.

## Reproduce the nonproduction evidence

Unit checks need only Node. Integration checks need installed MySQL binaries,
the precompiled `artfi-migrate` executable and a private writable cache directory.
They instantiate the checked-in templates with TEST_ONLY loopback/TLS settings,
create two fresh datadirs, use loopback-only ports (34860/34861 by default),
apply **all checked-in forward migrations**, and stop both servers on exit.
No existing database is used. Each run retains its own private logs, summary,
source/migration hashes and synthetic backup artifacts; no real dump is included
in published delivery evidence. Reserve sufficient disk space before running.

```sh
node --test scripts/operations/mysql-recovery.test.mjs

ARTFI_MYSQL_BASE=/approved/mysql \
ARTFI_MYSQL_TEST_CACHE=/private/test-cache \
ARTFI_MYSQL_MIGRATOR=/release/runtime/bin/artfi-migrate \
ARTFI_MYSQL_TEST_PORT=34860 \
node --test scripts/operations/mysql-integration.test.mjs
```

`ARTFI_MYSQL_BASE` contains `bin/mysql`, `bin/mysqldump` and `bin/mysqld`. The test
sets its own library path to that installation's standard/private library
directories. Both DB servers and test clients remain in the same test process
environment. Without the three required environment inputs the integration
suite reports **skipped**, never a fabricated pass.

On a non-root Linux CI runner with Docker, Node 24+ and Go 1.26.5, run:

```sh
bash scripts/operations/mysql-ci-test.sh
```

This wrapper uses the official `mysql:8.4` image, records its resolved image
digest, compiles the existing migrator, and mounts source and Node read-only.
Both DB servers and clients run inside one disposable `--network none`
container; no service port is published. Set `ARTFI_MYSQL_CI_IMAGE` to an approved
immutable `mysql@sha256:...` image reference for digest-pinned CI. The Node binary
must be Linux-compatible with that image. The suite discovers the image's server
binary using `ARTFI_MYSQL_SERVER_BIN`; the normal binary-installation route needs
no such override. `ARTFI_MYSQL_CI_CACHE` can select a private artifact directory.

The container wrapper is syntax-checked in this delivery environment. Docker is
not installed here, so **hosted/container CI execution is pending**, and is not
counted as a passed run. The actual lifecycle results come from installed
MySQL 8.4.11 and the precompiled migrator in the isolated native environment.
Only publish synthetic test summaries/logs and the image digest. Do not upload
connection files, server datadirs, generated TLS keys or database dumps.

Coverage includes complete schema/ledger migration and table-data roundtrip;
primary and replica backups; checksum/size/schema corruption; nonempty and
collation-mismatched target refusal; dirty/nontransactional/unsupported schema
refusal; shared-lock contention and lost-lock abort; failed dump with no completion manifest;
partial-import refusal on retry;
concurrent transactional snapshot consistency; replica write rejection;
replica restart/catch-up; and primary outage/restart with truthful degraded
status and no promotion. Delivery evidence must name the exact source hashes
and actual run results rather than carrying these claims to an untested edit.
