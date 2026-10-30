# Installable artifact lifecycle acceptance

This reusable test harness checks the precompiled Linux package described in
[Installation](INSTALLATION.md). It consumes an existing archive and checksum;
it does not build application code, download dependencies, deploy contracts,
connect to production, or exercise real-value signing or transactions. The
requirement scope remains #110, incorporated #84, and the later three-section
delivery instructions. These tests add no business-opening condition.

## Prerequisites

On an isolated Linux test host, provide:

- GNU tar and `systemd-analyze` to parse generated unit files without installing
  them. The packaged Node 24 executable can run the packaged harness; no separate
  Node installation or source checkout is needed for that route
- The completed ArtFi archive and its SHA-256 sidecar from the authorized build
- Official MySQL 8.4+ server and client binaries already installed or extracted
  for the host architecture; an unprivileged user must be able to run `mysqld`
- Sufficient disk space for an extracted artifact, two installed releases, a
  clearly labeled synthetic upgrade bundle, disposable MySQL data and logs
- For browser acceptance, an already installed Playwright module and compatible
  Chromium/headless-shell executable. Browser tooling belongs to the test host,
  not the installed application

Obtain MySQL through the [official MySQL Community downloads](https://dev.mysql.com/downloads/mysql/).
Record and validate its distribution provenance using the test environment's
normal process. The harness records the actual MySQL version and binary hashes;
a path or version string alone is not publisher authentication.

No Docker is needed. This harness uses the official extracted-server route; it
does not claim a Docker or CI-container run. The application itself always runs
the Node and Go executables inside the tested artifact. Browser tooling is an
independent test-host prerequisite. The packaged harness can run without a source
tree; the repository also contains the same reusable acceptance tooling.

## Run against an immutable archive

Use absolute paths appropriate to the test host. The following paths are
illustrative; none is an assigned infrastructure address or port.

Prefer the harness shipped in the same verified release. Verify the archive
sidecar before extracting a bootstrap copy, then use that copy's bundled Node:

```sh
cd /delivery
sha256sum -c artfi-RELEASE-linux-x64.tar.gz.sha256
tar -xzf artfi-RELEASE-linux-x64.tar.gz
./artfi-RELEASE-linux-x64/runtime/bin/node \
  ./artfi-RELEASE-linux-x64/tools/acceptance/installable-acceptance.mjs \
  --artifact /delivery/artfi-RELEASE-linux-x64.tar.gz \
  --checksum /delivery/artfi-RELEASE-linux-x64.tar.gz.sha256 \
  --mysql-basedir /opt/mysql-8.4 \
  --mysql-client /opt/mysql-8.4/bin/mysql \
  --evidence-dir /private/artfi-installable-acceptance-UNIQUE \
  --expected-migrations 14 \
  --playwright-module /test-tools/node_modules/@playwright/test/index.mjs \
  --chromium-executable /test-tools/chrome-headless-shell \
  --require-browser
```

The runner independently verifies and extracts the original archive again into
its fresh private test directory. It installs from that fresh extraction, not
from mutable source or a previously installed release. `harness-hashes.json`
records the exact shipped runner and browser helper used for the test.

For engineering use, Node 24+ can instead invoke the repository copy at
`scripts/test/installable-acceptance.mjs` with the same arguments. Record that
choice and the actual harness hashes with the test result. This alternative also
consumes the precompiled archive and performs no onsite source build.

If the official MySQL distribution needs a runtime library directory, add
`--mysql-library-path /opt/mysql-8.4/lib/private`. It can contain a colon-separated
library search path for that distribution. The harness does not guess a local
database installation or reuse the caller's database environment. Add
`--systemd-analyze /usr/bin/systemd-analyze` if needed.

The evidence directory's parent must exist. The evidence directory itself must
not exist, must be outside this source checkout, and is created with private
permissions. Its fresh installation prefix and empty MySQL data directory are
owned by this test run. Loopback ports are selected at runtime. MySQL starts with
its Unix socket and X Protocol disabled and listens only on loopback. No existing
database is selected, modified or deleted. Test inputs contain generated local
service secrets only; do not supply production credentials to this harness.

Run the complete command in one execution session/network namespace. Do not start
MySQL in one isolated command session and attempt application/browser checks in
another. The harness owns startup, checks and cleanup in the same process tree.
Do not run it concurrently with a resource-intensive application build on a
constrained host.

Omitting Playwright runs the non-browser lifecycle checks but records all three
browser phases as `NOT_RUN`. Use `--require-browser` for full lifecycle acceptance;
it rejects missing browser inputs instead of describing unrun coverage as passed.
An assertion failure stops dependent phases, preserves private evidence, and
returns a nonzero status. `report.json` always distinguishes `PASSED`, `FAILED`
and `NOT_RUN` for phases reached by the runner. Preflight argument/path failures
occur before a run exists and are printed without creating misleading evidence.

## Checks performed

1. Check the archive's exact filename and SHA-256 against its sidecar. Extract it
   into a fresh directory, run the bundled integrity checker, retain the release
   and source-file manifests, and check bundled Node, API, web, mirror, Stage 2
   runtime, operations tools, migration pairs and compiled contract inventory.
2. Initialize a new empty MySQL database. Install and explicitly activate the
   package without persistence configured. Require a truthful `NOT_RUN` database
   result and failure when database verification is requested as mandatory.
3. Configure the disposable database, apply the exact packaged forward migration
   count, repeat migration and compare its ledger result. Start the bundled API
   and web and require health, primary readiness and a database-backed orders read.
4. Check default public runtime settings, set API/RPC/wallet configuration and
   reset it. Restart the same immutable package each time. Check server bootstrap,
   the no-store wallet-config route, and preservation of generated service secrets.
   With browser tooling, repeat the read-only checks at desktop and mobile sizes,
   retain screenshots, and verify that the browser uses the changed API base.
   Browser requests outside the installed web origin are blocked; the activity
   response is an explicitly labeled TEST_ONLY unavailable-upstream fixture.
   Record elapsed monotonic time from each navigation's start through its existing
   visible/readiness assertions for `/market/activity` and `/nft`, with exact
   viewport, configuration phase and navigation order. Each viewport/phase gets a
   fresh browser context; Playwright request routing disables its HTTP cache.
   The application is already started and health-verified, while server/filesystem
   caches are not cleared or independently measured. These observed local timings
   do not change pass criteria, measure a real wallet-provider connection, or
   establish production page-load acceptance.
5. Enable the packaged agent with its unavailable adapter and no agent database;
   require `TEST_ONLY_NO_REAL_VALUE`, `SAFE_DEGRADED` and `productionReady: false`.
   Enable the read-only monitor for installed loopback API/web probes, capture its
   actual status/alerts, then stop and restart both optional services. This proves
   optional service lifecycle and honest unavailable behavior, not live execution
   readiness or the separate full Stage 2 acceptance suite.
6. Make a separately labeled synthetic copy containing one additive test migration.
   Check that upgrade without migration opt-in is refused without switching the
   active release. Upgrade with explicit opt-in, roll the application back, and
   require the added table, sentinel row and migration ledger to remain. The
   synthetic copy is not represented as another product release. No database down
   migration is executed.
7. Generate all five user-systemd templates, check their concrete service commands,
   then parse them with `systemd-analyze --user verify` and a fresh private
   `XDG_RUNTIME_DIR` inside the test run. No daemon reload, service-manager
   installation, enablement or host configuration change is performed.
8. Change a migration checksum in a disposable copy and temporarily mark a test
   ledger row dirty. Require the migration utility to reject each state, and
   restore the disposable ledger flag. Verify that the original archive and its
   extracted/installed immutable files are still intact.
9. Reverify the restored application release, stop the managed services, check
   their listeners and PID records are gone, and stop the disposable MySQL server.

## Private evidence and honest reporting

The reusable files under `scripts/test/installable-*` and this document contain
no deployment bindings or machine-specific run evidence. Keep the generated
directory private and outside Git, public documentation and release archives.
It contains test configuration, generated fixture secrets, database files and
process logs. Do not publish or attach that entire directory as a report.

`report.json` records the tested archive hash, byte size, release, source revision,
source fingerprint, exact phase results, timestamps, actual optional-service
observations and cleanup. The evidence also includes:

- `archive.sha256`, `tested-manifest.json` and `tested-source-manifest.json`
- `harness-hashes.json`, binding the runner and browser helper to the evidence
- Per-command logs and installed services' private logs
- Desktop/mobile screenshots for default, changed and reset runtime configuration
- The explicitly synthetic manifest and optional-service observations

A scoped overall `PASSED` is not a claim that optional `NOT_RUN` checks ran. No
full product, production, Docker, CI, live integration, real-chain or sustained
availability pass may be inferred from this lifecycle harness. Other suites must
be reported against their own exact artifact/source and evidence. Share only a
reviewed summary and appropriate non-sensitive screenshots with the final
artifact digest; retain private evidence separately.

The harness's own lightweight tests can run before an artifact exists:

```sh
node --check scripts/test/installable-acceptance.mjs
node --check scripts/test/installable-browser-check.mjs
node --test scripts/test/installable-acceptance.test.mjs
```

Those are tooling checks, not an installed lifecycle pass. Do not write a release
acceptance claim until the complete artifact run has finished successfully.
