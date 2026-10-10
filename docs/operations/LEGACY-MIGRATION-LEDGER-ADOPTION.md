# Explicit legacy migration-ledger adoption

This is a separate upgrade compatibility tool. The ordinary installer and `mysql-recovery.mjs` are unchanged and retain their refusal to infer an untracked database's migration history. In particular, the existing recovery backup refuses a database without `artfi_schema_migrations`; the separate backup command below is the compatibility path. Nothing here runs automatically during install, update, or backup.

## Narrow supported case

- An existing official MySQL 8 database has exactly the business schema produced by the unchanged official migration files 000001–000010.
- The legacy `artfi_deployment_migrations` contains exactly ten unique records with `version`, `source_sha`, `sql_sha256`, and `applied_at`.
- The ten distinct SQL SHA-256 values form an exact bijection to the pinned first ten canonical files. Legacy version values are retained verbatim, without guessing their syntax or order. The `source_sha` values are historical provenance, not a claim about the current source checkout.
- No final `artfi_schema_migrations` exists. Exact repeat of an already completed adoption is supported before later migrations run. Any empty, partial, dirty, differently shaped, or otherwise mismatched final ledger is refused.
- Only nonpartitioned InnoDB base tables are supported. Views, triggers, stored routines, events, cross-database foreign keys, and tables without primary keys are refused. Unknown tables, including orphan adoption staging tables, are refused.

The SQL files are byte-pinned. Never amend an old migration to make a checksum check pass. Reference construction uses the source database's character set and collation, and a separate disposable server with the same MySQL version and identifier-case setting. It does not assume server defaults.

Comparison includes database and table collation, engine, row format, declared table options, all columns and order, type, nullability, defaults, generated expressions, charset, collation, comments and spatial reference IDs; all index parts, expression/prefix/order, uniqueness, type and visibility; primary/unique/FK/CHECK declarations, FK actions, and CHECK enforcement. Mutable table statistics and the next AUTO_INCREMENT value are not schema identity. Actual declared FK, CHECK and uniqueness constraints are also checked against existing data. There is no invented assertion that a historical payload hash must equal today's serialization of its JSON.

## Operator prerequisites and authority

Use Node and official `mysql`/`mysqldump` clients. For production, use only the approved database endpoint and approved TLS settings in the protected connection file. Never copy the disposable fixture's passwordless/SSL-disabled configuration into an operational connection. Keep the source credentials in an absolute, owned 0600 defaults file. Never pass passwords or DSNs on the command line. Use a separate configuration for a genuinely disposable MySQL instance. The tool rejects reference/restore targets with the source server UUID; that check does not replace verifying the operator selected an isolated instance.

Reserve a private 0700 working directory. All generated evidence is 0600 and contains database metadata; backup files contain private data. Keep them in trusted operator-controlled storage. Do not upload them to GitHub, CI artifacts, logs, or public releases. SHA-256 proves integrity, not origin or independent authorization.

Before inspection and through adoption, arrange a maintenance window that excludes competing schema/ledger changes. Before apply, quiesce application/background writers and all external DDL; `--maintenance-confirmed` attests that the operator has done so. The common `artfi-schema:<database>` advisory lock excludes cooperating ArtFi installers and tools, not unrelated administrator SQL. Do not claim this lock universally freezes a database.

The source reads used for reference construction and inspection change no database objects or rows. Reference creation and restore verification write only to explicitly selected fresh databases on the isolated server. These commands never select or connect to production unless an authorized operator supplies that source configuration.

## Procedure without handwritten migration or backup SQL

Run from the delivered source/tool directory. Replace uppercase placeholders only with verified operator paths and names. Append `--mysql /path/to/mysql` and, where used, `--mysqldump /path/to/mysqldump` if clients are not on PATH.

1. Construct the exact reference on the isolated MySQL server. The target database must not already exist and its name must start with `artfi_adoption_`. The tool creates it using the inspected source defaults, then executes official migrations 1–10 there only.

   ```sh
   node scripts/operations/mysql-legacy-adoption.mjs reference \
     --defaults-file /PRIVATE/source.cnf --database SOURCE_DATABASE \
     --isolated-defaults-file /PRIVATE/disposable.cnf \
     --isolated-database artfi_adoption_reference --isolated-target \
     --migrations apps/api/migrations --output /PRIVATE/reference.json
   ```

2. Inspect the source read-only and compare against the complete reference.

   ```sh
   node scripts/operations/mysql-legacy-adoption.mjs inspect \
     --defaults-file /PRIVATE/source.cnf --database SOURCE_DATABASE \
     --migrations apps/api/migrations --reference /PRIVATE/reference.json \
     --output /PRIVATE/inspect.json
   ```

3. Back up the legacy database independently of the newer-ledger-only recovery tool. `NEW_BACKUP_DIRECTORY` must not exist.

   ```sh
   node scripts/operations/mysql-legacy-adoption.mjs backup \
     --defaults-file /PRIVATE/source.cnf --database SOURCE_DATABASE \
     --inspect /PRIVATE/inspect.json --output /PRIVATE/NEW_BACKUP_DIRECTORY
   ```

   This is a normal `mysqldump --single-transaction --quick` InnoDB backup, with hex binary values, deterministic primary-key order, single-row INSERTs, no GTID changes, and no drops. The schema lock is held and checked during the dump; schema/legacy identity must match before and after. Concurrent business DML may continue during this backup and is represented at its single consistent snapshot. The tool never compares a racing separate source-data read and calls it snapshot equivalence.

4. Restore this trusted backup into another fresh isolated database and verify it. No handwritten create/restore SQL is needed.

   ```sh
   node scripts/operations/mysql-legacy-adoption.mjs restore-check \
     --defaults-file /PRIVATE/disposable.cnf --database artfi_adoption_restore \
     --backup /PRIVATE/NEW_BACKUP_DIRECTORY --trusted-backup --isolated-target \
     --output /PRIVATE/restore.json
   ```

   It verifies checksum and consumes the same open SQL file, checks the restored full schema and original legacy rows, audits declared data constraints, and compares a deterministic re-dump's INSERT stream against the INSERT stream from the original consistent backup. This proves the isolated restore equals that backup snapshot. It does not claim later source data remains identical. The private `.data-check.sql` output is retained as evidence. A failed or partial restore remains isolated and must never be activated or reused.

5. Generate a reviewable plan bound to that inspection, source server UUID/database/version, complete schema, exact original legacy values, official source hashes, tool file hashes, backup bytes, and isolated restore evidence.

   ```sh
   node scripts/operations/mysql-legacy-adoption.mjs plan \
     --inspect /PRIVATE/inspect.json --backup /PRIVATE/NEW_BACKUP_DIRECTORY \
     --restore-evidence /PRIVATE/restore.json --output /PRIVATE/plan.json
   ```

   Review the private plan and obtain specific approval for its exact printed SHA-256, target database identity, and ledger-only action. Inspection, a successful backup, a CLI flag, or general deployment authority is not a substitute for that approval. Keep the approval record separately.

6. Only after that approval and quiesced-maintenance confirmation, apply the approved plan.

   ```sh
   node scripts/operations/mysql-legacy-adoption.mjs apply \
     --defaults-file /PRIVATE/source.cnf --database SOURCE_DATABASE \
     --migrations apps/api/migrations --plan /PRIVATE/plan.json \
     --plan-sha256 EXACT_SPECIFICALLY_APPROVED_SHA256 \
     --backup /PRIVATE/NEW_BACKUP_DIRECTORY \
     --approve-ledger-only --maintenance-confirmed
   ```

   The tool checks identity, source/tool hashes, backup bytes, schema and original rows again under the same advisory lock. It creates a random noncanonical staging table, inserts and commits all ten historical records (including original timestamps), validates its rows and schema, rechecks source evidence, then atomically renames it to `artfi_schema_migrations`. It never replays migrations 1–10, changes business data, modifies/drops the old ledger, or executes 11–14.

7. Under the applicable separate deployment authority, the unchanged standard migrator can now report four pending migrations and apply 11–14. Once later migrations exist, this adoption plan is no longer an idempotent operation and refuses rather than rewriting history.

## Interrupted or failed apply

A failure before the atomic rename can leave an empty, partial, or fully populated `artfi_adopt_<random>` staging table, but never an empty canonical ledger. The standard installer remains fail-closed. The tool deliberately does not auto-drop staging tables or infer whether a previous uncertain operation completed.

Inspect the private server logs and compare the identified staging table with the approved plan under a reviewed recovery action. Do not delete unknown tables, edit a final ledger, replay old DDL, or reuse a partial restore. Have the authorized database operator resolve the specific orphan and repeat evidence/review as necessary. If a connection is lost at rename, first inspect the final ledger: an exact completed result can be checked by idempotent apply with the same plan; any mismatch is refused.

## Reproducible isolated tests

The integration test needs official local MySQL binaries and the unchanged precompiled migrator. It starts two fresh, owned, loopback-only servers with `--socket=` and `--mysqlx=0`; no existing database or real credentials are used. Set `ARTFI_MYSQL_BASE`, `ARTFI_MYSQL_MIGRATOR`, `ARTFI_LEGACY_TEST_CACHE` (private), and any required `LD_LIBRARY_PATH`, then run:

```sh
node --test scripts/operations/mysql-legacy-adoption.test.mjs \
  scripts/operations/mysql-legacy-adoption.integration.test.mjs \
  scripts/operations/mysql-recovery.test.mjs
```

The test covers official 1–10 and opaque version mapping, nondefault collation, reference isolation, read-only inspection, checksum/schema/index/CHECK drift, unsupported objects, lock contention, consistent backup and actual isolated restore, plan binding, missing approval, source drift, real privilege failures after staging CREATE and before RENAME, exact idempotence, dirty/mismatched final-ledger refusal, business/legacy preservation, and unchanged standard migration of 11–14. These are synthetic local results, not production acceptance.

## Minimal separate delivery route

Review these five new files as an independent compatibility patch against the merged application source. Do not amend PR159's frozen source or rebuild/relabel its existing installation archive for this tool. The two runtime modules, `mysql-legacy-adoption.mjs` and `mysql-legacy-client.mjs`, can be delivered together as a separately checksummed sidecar and run with the Node runtime already supplied by the current package plus approved official MySQL clients. Supply the existing package's exact official migration directory through `--migrations`; there is no application recompilation or production connection embedded in this sidecar. Keep the runbook and synthetic verification summary with the separate delivery. Publication and operational adoption remain separately authorized actions.

## Dedicated CI coverage

The existing `operations-recovery` job retains its previous checks and adds `bash scripts/operations/mysql-legacy-ci-test.sh`. No job or workflow permission is added. This dedicated wrapper uses official `mysql:8.4.11` (or its approved immutable digest), the existing Node 24/Go setup, a compiled unchanged migrator, read-only source mounting, a non-root container user, and `--network none`. It supports the official image's actual `mysqld` location via `ARTFI_MYSQL_SERVER_BIN`.

The wrapper requires all 22 tests to pass with zero skips and all 15 real integration subtests recorded as passed. Missing fixture configuration, a missing integration report, or a skipped integration suite fails this step. The generic web unit-test collection can still skip the opt-in integration fixture; it does not replace the dedicated MySQL check. Only a filtered synthetic `public-summary.json` and the official image digest are selected for CI upload. Raw TAP/container logs, connection files, dumps, plans and datadirs are excluded.

The local validation used the official MySQL 8.4.11 binaries, not Docker. Docker wrapper execution and the new hosted workflow remain pending until the separately authorized PR runs in CI.
