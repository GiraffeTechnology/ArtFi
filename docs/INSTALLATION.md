# Native installation, upgrade and recovery

This package delivers the existing ArtFi NFT, whole-artwork receipt and fractional/DAO
application as built Linux services. It does not deploy contracts, move assets, sign orders,
select a production chain, change host networking, or authorize business opening. The
requirements remain #110, incorporated #84, and the later three-section delivery instructions.

## Contents and requirements

- Built Next.js standalone web application, browser/static assets and runtime dependencies.
- Built Go API and MySQL migration utility. Go and a source checkout are not required onsite.
- A bundled Node 24 executable and its license, plus the compiled optional OpenSea mirror.
- All ordered MySQL forward and reverse migrations, including wallet sessions, NFT operations,
  approved-source catalog records and bounded runtime ledgers.
- The optional bounded agent runtime and read-only operations monitor, disabled until configured.
- MySQL recovery tools, fixed-pool proxy renderer and source-bound application contract artifacts.
- Artifact-first lifecycle acceptance tools and their runbook.
- Configuration generation/validation, integrity verification, service lifecycle commands,
  user-systemd service templates, and this runbook.
- A release manifest, source-file hash manifest and archive SHA-256 sidecar. A dirty source
  snapshot is identified explicitly; its base Git revision is not claimed to include its edits.

The generated artifact targets the builder's Linux CPU architecture. Use a matching glibc-based
Linux host with the system libraries required by the bundled Node executable (check `ldd
runtime/bin/node`), a writable installation directory, and an existing supported MySQL 8.4+
service for persistent workflows. TLS certificates, reverse proxy, DNS, database service and
optional Redis/object storage remain operator-supplied infrastructure. Docker is optional.
The installer performs no package downloads or onsite source compilation.

Generic package settings contain no private hosts, credentials or infrastructure bindings.
Listener addresses, ports, public origin and bridge URLs are operator inputs. Examples are
local development allocations, not restrictions or approved ports on another host. Preserve
existing service allocations and environment-specific SSH/TLS constraints when installing.

## Verify and configure

Obtain the archive and SHA-256 sidecar from the authorized release channel. Verify the sidecar
against that channel before extraction; a checksum obtained with a tampered archive does not
provide publisher authentication.

```sh
sha256sum -c artfi-RELEASE-linux-x64.tar.gz.sha256
tar -xzf artfi-RELEASE-linux-x64.tar.gz
cd artfi-RELEASE-linux-x64
./runtime/bin/node tools/install/artfi.mjs check-bundle
```

Create a private `settings.json` from `tools/install/config.example.json`, outside the source
checkout. Supply your assigned listener ports, the complete public URL, the actual upstream
API URL (including any bridge prefix), and the protected `MYSQL_DSN`. Keep its mode `0600`.
An existing database user and database must already exist. The migration account needs schema
DDL privileges; ordinary service access should use the approved least-privilege credentials.
Never put real credentials in command-line flags, repository files, public build arguments,
logs, tickets or screenshots. No wallet private keys or seed phrases belong in this configuration.

```sh
chmod 600 /secure/settings.json
./runtime/bin/node tools/install/artfi.mjs configure \
  --prefix "$HOME/.local/share/artfi" --input /secure/settings.json
./runtime/bin/node tools/install/artfi.mjs validate --prefix "$HOME/.local/share/artfi"
```

`configure` generates independent high-entropy service/session secrets on the operator's machine,
retains existing secrets when updating configuration, derives the exact web origin, and writes
`shared/config.json` with mode `0600`. It never prints secret values. Back up this file using
the deployment's secure secret-management procedure; changing session secrets invalidates sessions.

Public `NEXT_PUBLIC_*` deployment settings are selected from a fixed allowlist at request/runtime
and bootstrapped before browser modules execute. You can set API/RPC URLs, contract addresses,
asset route bindings and token IDs without rebuilding. No arbitrary environment export exists.
`NEXT_PUBLIC_*` values are public: a credential-bearing RPC URL must not be put there. Browser
fallbacks and unconfigured states remain intact when a value is empty. Restart services after
configuration changes. The same immutable release can be configured for another deployment.

By default, browser catalog reads use the web origin. The built-in GET-only `/v1` relay forwards
only allowlisted public catalog/market/configuration reads to `ARTFI_API_URL`. It does not forward
cookies, authorization headers, portfolio/session data, operator/indexer routes or writes.
Protected workflows retain their existing `/api/*` gateways. A separate public API base URL is
still supported. The optional reverse proxy must preserve the actual public Host and Origin.

## Install and start

The exact release identifier is printed by `check-bundle` and stored in `manifest.json`.
Substitute that identifier for `RELEASE` below.

```sh
./runtime/bin/node tools/install/artfi.mjs install --prefix "$HOME/.local/share/artfi"
./runtime/bin/node tools/install/artfi.mjs migrate \
  --prefix "$HOME/.local/share/artfi" --release RELEASE
./runtime/bin/node tools/install/artfi.mjs activate \
  --prefix "$HOME/.local/share/artfi" --release RELEASE
./runtime/bin/node tools/install/artfi.mjs start --prefix "$HOME/.local/share/artfi"
./runtime/bin/node tools/install/artfi.mjs verify \
  --prefix "$HOME/.local/share/artfi" --require-database
```

`install` verifies all packaged files/links, copies a versioned release, and leaves activation
explicit. Database migrations run under a connection-scoped advisory lock with a checksum ledger.
Each migration is marked dirty before execution because MySQL DDL can commit independently.
Changed checksums or an incomplete migration fail closed instead of replaying unsafe DDL.
Existing populated databases without this installer's ledger require an operator-reviewed
baseline/restore procedure; the tool never guesses their version or overwrites their tables.
Empty databases are initialized by `migrate`. Repeated migrations are idempotent through the ledger.

`activate` atomically replaces the `current` link after checking the required schema. The preceding
release remains available. `start` launches API/web and only the explicitly enabled mirror as
unprivileged processes, with logs under `shared/logs`. The application binaries remain unchanged;
mutable web cache and mirror checkpoints live under `shared`. Protect the entire installation
from unrelated local users. No root privileges are needed for assigned unprivileged ports.

`verify` distinguishes PASSED, FAILED and NOT_RUN. It checks web/API health, section pages,
same-origin public routing, migration state and an actual database-backed orders read when
configured. Health alone does not prove persistence. `--require-database` fails if database
verification was not run. Optional unavailable external capabilities are recorded separately;
installation verification never performs a chain signature, order, cancellation or transaction.
Use `--web-url` and `--api-url` for read-only verification through the deployment's approved proxy.
The full report is saved to `shared/verification.json`.

A package can run without optional external configuration. Missing MySQL correctly leaves
persistent features unavailable; it is not an empty-account result. Missing OpenSea, wallet,
Oracle, object-store or chain configuration disables only the affected existing workflow.

## Optional external integrations

Add only operator-approved values to the private input file, rerun `configure`, then restart:

- `OPENSEA_API_KEY`: server-side official OpenSea access.
- `ARTFI_NFT_COLLECTIONS_JSON`: JSON string containing an array of
  `{slug, chain, contract, standard, label, charity}` records. Chain is `ethereum` or `base`;
  standard is `erc721` or `erc1155`. Empty `[]` is an honest unconfigured state.
- `ARTFI_NFT_TRADING_ENABLED`: explicit `true` to enable configured native NFT preparation.
- `ARTFI_NFT_RPC_1`, `ARTFI_NFT_RPC_8453`: server RPC connections for supported NFT chains.
- `ARTFI_USER_AUTH_CHAIN_IDS`: supported allowed session chains; default `560048`, with
  `1` and `8453` included only when that deployment enables them.
- `ARTFI_XIONGAN_WALLET_URL`: complete HTTPS wallet destination, optional port/path, no
  credentials, query or fragment. No default destination is inserted.
- Existing `ARTFI_RPC_URL`, contract bindings, Oracle read URL, private holder-object storage,
  indexer, operator, R2 and Giraffe translation settings retain their existing semantics.

For the passive market mirror, set `ARTFI_MIRROR_ENABLED=true`, `OPENSEA_COLLECTION_SLUGS`,
`OPENSEA_API_KEY` and the existing execution-zone setting. The mirror's existing SIN boundary
is preserved; it is not a package-wide host restriction. Its durable storage paths are assigned
under `shared/mirror` and persist across upgrades. Keep a single writer per checkpoint directory.
The installer never turns on public-chain access merely because a key or hostname exists.

## Upgrade and rollback

Take the database/configuration/object-store backup required by the deployment's existing
operations procedure, record the current release and check that the new forward schema is
compatible with the intended application rollback. Inspect the new manifest and migrations.

For processes started by this utility, run the command from the verified new extracted bundle:

```sh
./runtime/bin/node tools/install/artfi.mjs upgrade \
  --prefix "$HOME/.local/share/artfi" --apply-migrations
```

This stages the release, stops managed processes, applies needed forward migrations, atomically
activates, restarts and verifies. If post-activation verification fails, it attempts to restore
the previous application release and preserves the new schema. Inspect its result and rerun
`verify`; the attempt is not proof of successful recovery. A migration failure leaves the dirty
ledger for recovery and does not blindly retry partial DDL.

To restore the preceding application release:

```sh
./runtime/bin/node tools/install/artfi.mjs rollback --prefix "$HOME/.local/share/artfi"
```

Rollback never applies `*.down.sql`, drops a table, rewinds the blockchain or discards orders,
sessions, NFT operations or mirror checkpoints. Schema rollback/data restoration is a separate
operator-controlled recovery using verified backups and the packaged reverse scripts where
appropriate. Do not apply reverse scripts to live data as an application rollback shortcut.
Preserve failed-release logs and artifact hashes before diagnosis.

## Service manager alternative

For persistent host operation, generate and review user-systemd units:

```sh
./runtime/bin/node tools/install/artfi.mjs service-units \
  --prefix "$HOME/.local/share/artfi" --output "$HOME/.config/systemd/user"
systemctl --user daemon-reload
systemctl --user enable --now artfi-api.service artfi-web.service
```

Enable `artfi-mirror.service` only after configuring the mirror. Host login/linger and system
service ownership are the operator's existing policy; the installer does not alter them.
Do not mix systemd-managed and utility-managed processes on the same ports. Under systemd,
perform upgrades with `systemctl --user stop` for enabled ArtFi services, then the explicit
`install`, `migrate`, `activate` commands, then `systemctl --user start` and `verify`. The
utility's combined `upgrade`, `rollback`, `start` and `stop` commands manage only processes it
started itself. For systemd rollback, stop services, activate the previous recorded release,
start them and verify. Configuration secrets stay in the protected JSON file, not unit contents.

## Build a release in the engineering environment

Use an approved stable source snapshot with installed workspace dependencies, Node 24, Go
matching `apps/api/go.mod`, Foundry and Solidity 0.8.30. Local `.env` files are refused. Server and public deployment variables
are removed from the build environment. The builder refuses source changes during packaging.

```sh
node scripts/install/build-bundle.mjs --output /delivery/artfi \
  --node-binary /approved/node/bin/node --node-license /approved/node/LICENSE
```

Run repository tests, installer tests (`node --test scripts/install/*.test.mjs`), migration and
browser checks against that exact source. The build itself is not a test-suite pass. After
packaging, install into an isolated prefix and disposable MySQL database and verify start,
configuration changes, upgrade and rollback. Keep the resulting evidence with the archive digest.
Original deployment templates and preserved legacy sources are not removed by this installer.
No publication, production deployment or real-value activity is performed by the bundle builder.

## Application administration

Set `ARTFI_ADMIN_WALLETS` to the comma-separated wallet addresses assigned the
application moderation role. Empty leaves the admin console disabled. Existing
MySQL and wallet-session configuration is required. The installer applies migration
000012 with the other migrations. This grants only content reports, appeals,
service notices and audit access; it grants no seller, custody or chain authority.
See [Application moderation](ADMIN_MODERATION.md) for the workflow and privacy
boundaries.

Generated systemd command lines use the documented `:` execution prefix to keep
literal dollar characters in installation paths instead of expanding environment
variables. Percent specifiers are escaped separately. See the upstream
[systemd service command syntax](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml).
`WorkingDirectory` uses a path value rather than command-line quoting. Its separate
renderer preserves spaces and literal percent characters. Unit generation rejects
quote/backslash characters that systemd does not permit in its executable path;
the native CLI lifecycle remains available for those filesystem paths. Unit tests
invoke the real user-mode parser with a private runtime directory, without
installing units. See the [upstream working-directory parser](https://github.com/systemd/systemd/blob/v257/src/core/load-fragment.c#L2383-L2438).

Optional existing multisig operator deployments use `ARTFI_ADMIN_SAFE_ADDRESS`
on the server and `NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS` in the public runtime
configuration. Set both to the same deployed nonzero Safe address. Leave both
empty for the existing direct-operator flow. Configuration does not grant a role:
normal chain checks still verify the Safe's target roles and connected ownership.
See [the operator workflow](ADMIN_SAFE_WORKFLOW.md) for its review and recovery steps.

## Rebuilding the generic artifact

The repository's `quality` workflow builds the native Linux artifact and retains
its archive/checksum under the exact workflow source SHA. Workflow artifacts need
a GitHub login and expire after their retention period; they are validation outputs,
not a permanent published release. Publish the verified archive and checksum to the
approved GitHub release only after the corresponding source passes required CI.
No production configuration is collected by this build job.

For an equivalent local build, install the pinned repository toolchain and frozen
package dependencies, then run `node scripts/install/build-bundle.mjs` from a
stable source checkout. Application contracts are rebuilt with the pinned Solidity compiler;
custom tool paths can use `--forge` and `--solc`. The tool locates the Node license beside the official
Node installation; custom locations can use `--node-binary` and `--node-license`.
It refuses source drift during the build and supplies a complete per-file source
fingerprint. This source-build step belongs on the build machine, never onsite as
part of installing the delivered precompiled package.

## Optional operations and bounded-agent services

The same artifact includes the existing Stage 2 application runtime and M6
operations tools. They are disabled by default. Enabling them is a configuration
step, not permission for a live transaction or production deployment.

For the bounded runtime, provide private absolute `ARTFI_AGENT_CONFIG_FILE`, the
explicit `ARTFI_AGENT_API_URL`, and `ARTFI_AGENT_ENABLED=true`. Re-running
`configure` preserves existing secrets and generates the dedicated bridge token
if absent. The shipped runtime descriptor example uses an unavailable adapter;
actual unsupported signing/execution capabilities remain unavailable. A connected
wallet alone is not delegated authority. See the runtime's own scope and evidence
before selecting an approved integration. Read the [runtime guide](../apps/agent-runtime/README.md)
and [A1–A10/A0–A6 scope map](../scripts/agent/STAGE2_SCOPE.md); real delegated
execution remains an incomplete integration capability.

For read-only monitoring, provide private absolute `ARTFI_MONITOR_CONFIG_FILE`
and `ARTFI_MONITOR_ENABLED=true`. Optional descriptors must be regular files with
no group/world permission and must stay outside the immutable artifact. The
installer starts/stops these services with the rest of its managed process set
and generates optional `artfi-agent.service` and `artfi-monitor.service` templates.
Old configurations with these services disabled remain upgrade-compatible.

Cluster configuration rendering, primary/replica templates, integrity-checked
backup and empty-database restore are under `tools/operations`. The MySQL client
and `mysqldump` are database-operations prerequisites; Node and application code
are bundled. No onsite compilation or code assembly is required. Read
[Cluster operations](CLUSTER_OPERATIONS.md) and [MySQL recovery](MYSQL_RECOVERY.md).

The `contracts` directory contains the exact release's precompiled application ABI
and bytecode, with a constructor/library-linking inventory. It excludes test
contracts and all deployment bindings. Providing these artifacts does not select
a chain or authorize any deployment or real-value action; the authorized operator
can consume them without compiling Solidity onsite.

For a repeatable fresh-host lifecycle test, the same package contains
`tools/acceptance/installable-acceptance.mjs` and its browser checker. Run it with
the bundled Node and explicit artifact, checksum, MySQL and private evidence
paths. See [Installable acceptance](INSTALLABLE_ACCEPTANCE.md). The controller
requires no source checkout or build tools; optional full browser validation
uses an explicitly supplied preinstalled Playwright/Chromium toolchain.
