# Internal task listing runtime

This is the fixed internal ArtFi/8415 Wallet listing product artifact. It does not
publish a public SDK, configure an authenticated peer or signer, authorize a grant,
or enable production trading. Product authority is the inherited ArtFi #110 NFT
workflow and the bounded authenticated task listing integration.

## Build and installation contract

Use the repository's existing frozen pnpm installation and Node 24 or later. Run
`node scripts/install/build-task-listing-runtime.mjs --output /absolute/output`.
Add `--archive /absolute/artfi-task-listing-runtime-1.0.0.tgz` to produce the
closed npm file dependency. Packing disables install scripts, uses offline mode,
compares every extracted file to the manifest, and imports the extracted runtime.
The normal `scripts/install/build-bundle.mjs` also includes this artifact at
`runtime/task-listing`, with the separate authenticated `artfi-task-journal`
Go binary in `runtime/bin`. Packaging never starts or enables that listener.
The builder compiles the actual application TypeScript
with the already-locked TypeScript compiler and closes production dependencies
with the existing `bundleNodePackage` exporter. It never downloads dependencies. Standard npm lookup paths preserve conflicting
transitive versions without external symlinks. Optional peers are omitted in the
same way as ordinary npm bundled-dependency packing; required dependencies remain
closed. Only preinstall/install/postinstall/prepare declarations are removed from
packaged metadata. Code, dependency versions, exports, and notices stay intact;
the manifest records original and normalized package hashes and each omission.
Missing source modules, undeclared modules and missing installed dependencies
fail the build. No sibling checkout, source loader, fixture or test mock is used
by the installed entry.

The fixed package is `@artfi/task-listing-runtime@1.0.0`:

- `./server`: real native task port, authenticated task journal adapter, sale
  terms, listed-order observer and fixed production dependency composition.
- `./manifest`: `runtime-manifest.json`, schema `artfi-task-listing-runtime/1`.
- `./package.json`: exact package version and exports.
- Wallet interface: `8415-task-listing-runtime/1`.

Consumers pin the artifact and manifest checksum and verify the manifest's file
hashes and contained relative links before loading. The manifest identifies the
lock digest, source closure, every installed package path/version/lock integrity,
original and normalized package hashes, exact direct versions and the true `server-only`
marker copied unchanged from locked Next. It does not contain credentials,
operator configuration, private files, or deployment authority.

## Server-only boundary

The enabled Wallet runtime's supplied launcher/service configuration must start
its controlled Node process with `--conditions=react-server`. Disabled legacy
Wallet processes need not import this package or change their conditions.
`server-only` is the real Next-distributed marker package with its original
conditional exports, not an empty replacement. Importing without `react-server`
fails deliberately; importing with that condition resolves the actual modules.
Never alias the marker to a test stub or strip it from the packaged code.

The installed test uses a fresh process with no `NODE_PATH`, no source checkout,
no transpiler, no `.env`, and no `NODE_OPTIONS`. It must also refuse missing native
modules, journal adapter, and production dependency files.

## Fixed JSON configuration

`validateServerListingConfig(value)` is a pure strict JSON validator. It rejects
unknown fields, functions, getters, custom prototypes, module paths, injected
ABI/types, unsafe endpoints, missing code pins and unbounded scans.

Required root fields:

- `schema`: `artfi-server-listing-config/1`
- `chainId`: string `1` or `8453`
- `executionZone`: `sin`
- `tradingEnabled`: boolean; false always refuses a listing
- `collections`: one to 100 entries with exactly `slug`, `chain`, `contract`,
  `standard`, `label`, `charity`. Chains are `ethereum` or `base`; all entries
  must match `chainId`. Standards are `erc721` or `erc1155`.
- `rpc`: exactly `url`, `sourceId`, `timeoutMs`. The URL must use HTTPS or local
  loopback HTTP, without URL credentials, query or fragment. The source ID is
  an alphanumeric/underscore/hyphen ID of at most 128 characters. Timeout is
  100 through 12000 milliseconds.
- `sdkTimeoutMs`: exactly 12000, matching the existing bounded official venue
  transport. It is not an unrestricted caller-controlled transport timeout.
- `observation`: exactly `policyId`, `allowedDeployments`, `scanPolicy`.

Each allowed deployment has exactly `chainId`, `address`, `runtimeCodeHash`,
`proxyOrUpgradeAllowed: false`, and `reviewEvidenceSha256`; optional
`nativeConsiderationPolicy` must be `SEAPORT_SUCCESSFUL_NATIVE_CONSIDERATION_V1`.
It must match the configured chain and existing native Seaport address. Code and
review hashes must be supplied from reviewed deployment evidence; no live pin is
invented or defaulted. The actual observer checks runtime code against the pins.

Scan policy has exactly `fromBlock`, `throughBlock`, `blocksPerPage`,
`maxPagesPerRun`, `maxLogsPerPage`, `maxCandidatesPerRun`. Block bounds are positive
safe integers; page bounds are respectively 1–10000, 1–100, 1–10000, 1–1000.

`createServerListingDependencies(config, {journal, now})` returns
`nativeDependencies`, `observationDependencies`, and `canonicalReader`. Only the
trusted in-process journal and optional clock are function parameters. The fixed
factory supplies the official OpenSea SDK, ABI/types, existing read-only provider,
venue restrictions, and exact configured scope. Canonical and observer reads use
the same source-bound provider and allow only the observer's read RPC methods.

The enabled process requires `OPENSEA_API_KEY` in its secure environment. Missing
configuration fails explicitly before the factory returns and never produces a
connected state. This artifact does not provision, log or embed a key. There is
no fallback signer, quote, peer identity, authority verifier or session cookie.
Wallet must supply its authenticated grant gate and exact journal capability
transport; the factory cannot authorize or sign a transaction.

## Verification scope

Run the installed artifact test against the built package, plus the existing
native port, journal, terms and observer suites. Passing isolated package checks
proves package closure and the checked fail-closed behaviors, not real peer
credentials, a live marketplace listing, deployment or complete product acceptance.
