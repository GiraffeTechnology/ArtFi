# ArtFi bounded agent runtime

This package supplies the application-side durable execution/recovery service. It does **not** make the current Wallet product a NO-HIL wallet. The current Wallet interface requires owner confirmation per operation and does not provide delegated session keys, autonomous broadcasting, standing signing permission or an HTTP agent-write endpoint. The existing ArtFi wallet-reviewed NFT, whole-artwork, fractional and auction paths remain the supported execution path.

The `/agent` application page authenticates the current wallet, reads only that wallet's operations/history, identifies synthetic evidence, and links to the existing owner-confirmed market screens. A submitted request is never displayed as settlement without matching evidence. Private records are excluded from the translation-service boundary.

## What is executable

- Pinned `mysql2@3.24.4` and `ethers@6.17.0`, no executable configuration or application-held user keys.
- Real bounded HTTP listener, existing ArtFi wallet-session validation, owner-scoped reads, request limits, no-store responses, and sanitized errors.
- Atomic shared intent/nonces, execution limits, exposure reservations, rate windows, open-order slots, leases and append-only audit events in migration `000014_agent_runtime`.
- Native typed action plans and individual receipt rules for whole/fraction fills, partial fills, signed-order publication, retire-then-replace amendment, revocation, auction creation/bidding/rebidding/cancellation/settlement, offering claims/refunds and credit withdrawal.
- Native NFT references retain the existing Stage 1 `NftPlan` shape and list/offer/buy/accept/cancel semantics. A trusted reader must supply the reviewed plan; caller calldata or a caller's claimed review never substitutes for it. Approval-only plans are refused rather than silently extending wallet permissions.
- Restart discovery and reconciliation of `STARTED`/unknown operations, with no automatic resend and no budget release from timeout or lease expiry.
- Deterministic planning fallback and model-only candidate ranking; bounded outcome learning cannot edit signed authority, source trust or protocol settings.

Financial reservations currently implement a conservative gross-authorized-value envelope per wallet/executor/chain/settlement-policy bucket. They are monotonic, including after successful execution. A canonically proved cancellation releases its open-order slot; it does not silently release financial exposure. This is not general mark-to-market portfolio accounting or cross-currency netting.

## Safe configuration

The installer owns enabling/stopping the optional service. `ARTFI_AGENT_CONFIG_FILE` points to a private JSON file outside the immutable application artifact. `config.example.json` is a local example, not an approved deployment allocation. In particular, it does not allocate a CTYun port; TCP 443 remains reserved for SSH there.

Configuration contains no JavaScript or import/module path. Available adapter kinds are:

- `unavailable`: starts a truthful `SAFE_DEGRADED` service. With a configured database, owned historical records remain readable. No autonomous action is enabled.
- `artfi-isolated-test-v1`: fixed packaged client for the explicitly isolated, loopback-only integration-test protocol. It is allowed only with `TEST_ONLY_NO_REAL_VALUE`. The fixture implementation lives under `test/`, not the production source directory.

Environment/profile modes:

- `TEST_ONLY_NO_REAL_VALUE` is the safe default and preserves the original first BUY slice.
- `BOUNDED_SIGNED_AUTHORITY` parameterizes the reusable action core and stored record labels for a future supported binding. It cannot select the isolated test adapter and currently has **no executable external authority adapter**. This mode does not claim production readiness, pick a production chain, supply signing permission, or turn the current Wallet's owner-confirmed interface into NO-HIL.

The reusable action compiler/policy/store use the configured chain/domain and preserve the stored profile identity. A stored test authority cannot be promoted by changing the configuration label. Native OpenSea reference shapes are limited to the existing Ethereum/Base support. Offline fixtures for those shapes perform no chain access or transaction.

Required existing private credentials are supplied by the installer/environment:

- `ARTFI_AGENT_BRIDGE_TOKEN`: private BFF-to-runtime credential
- `ARTFI_USER_AUTH_BRIDGE_TOKEN`: existing ArtFi session-verification bridge credential

The web BFF uses `ARTFI_AGENT_API_URL`, preserving any configured bridge prefix. It never sends either bridge credential to the browser. The runtime revalidates the access token through the existing `POST /v1/user/auth/session` API on each private request; connecting an address is not login.

`authentication.allowedChainIds` defaults to `[560048]` and may select only chain IDs already supported by the current ArtFi session implementation. A chain choice is configuration, not deployment authorization.

For a configured database, supply `host`, `port`, `database`, non-root `user`, `passwordFile`, and `tls`. Remote MySQL requires a CA file and verified TLS/server identity. `tls: null` is accepted only for loopback. Startup does not create users, provision infrastructure or apply migrations. Apply the assigned migration through the existing installer workflow. The database role needs ordinary SELECT/INSERT/UPDATE on the agent tables; schema privileges are unnecessary at runtime.

## Endpoints

- `GET /healthz`: non-secret health/status only
- `GET /v1/agent/status`: authenticated capability state; unavailable remains unavailable
- `POST /v1/agent/intents/prepare`, `POST /v1/agent/intents`: original bounded BUY compatibility
- `GET /v1/agent/intents/:id`, `GET /v1/agent/intents/:id/history`
- `POST /v1/agent/intents/:id/revocations`: verify an already-submitted revocation receipt, never sign one
- `POST /v1/agent/actions/prepare`, `POST /v1/agent/actions`: review/queue a typed workflow under an already signed bounded authority
- `GET /v1/agent/actions/:id`, `GET /v1/agent/actions/:id/history`

There is no signing, raw-transaction, arbitrary RPC, trust-registry replacement, protocol upgrade or constitutional mutation endpoint. A missing external dependency never falls back to an application signer or bundled fixture.

## Verification

From the repository root after a frozen install:

```sh
node --test scripts/agent/*.test.mjs apps/agent-runtime/test/*.test.mjs
bash scripts/agent/test-mysql-docker.sh
```

The hosted-CI harness starts only its own uniquely named test project using the official pinned `mysql:8.4.11` image, applies **all** current migrations to a fresh `artfi_stage2_isolated_test` database, gives the runtime a non-root role, and runs real restart/concurrency/replay tests. It does not restart an existing application's MySQL service. The Docker harness is prepared for CI; this cloud executor has not run Docker.

An existing official local MySQL installation can run the same campaign without Docker:

```sh
ARTFI_TEST_MYSQL_BASE=/path/to/official/mysql \
  bash scripts/agent/test-mysql.sh
```

A local run starts its database, services and tests in one process/network namespace. It preserves configs/logs and a compressed, decompressed-file-SHA256-verified archive of stopped synthetic data.

For the real application browser chain, build the web first and supply the existing Go toolchain:

```sh
ARTFI_AGENT_RUN_BROWSER=1 \
ARTFI_TEST_MYSQL_BASE=/path/to/official/mysql \
GO_BINARY=/path/to/go \
ARTFI_E2E_CHROMIUM_PATH=/path/to/chromium \
  bash scripts/agent/test-mysql.sh
```

The browser runner uses the actual Go session store, actual Next authentication/BFF routes, actual agent HTTP service and actual MySQL. Only the external venue/chain/executor payloads are synthetic. It covers signed sign-in, duplicate queueing, lost-acknowledgement recovery without resend, private history, owner-confirmed handoff, and persisted logout. Test keys remain in Node test closures; none enter application storage.

Set `ARTFI_AGENT_TEST_BUNDLE=/absolute/path/to/verified/bundle` to run the same fixture against the precompiled package's Node, API, web and agent entry points. This runner does not mutate the package or activate production services.

See `scripts/agent/STAGE2_SCOPE.md` for the exact requirement/remaining-code boundary. No production NO-HIL, approved-source proof integration, independent review, continuous gray operation or acceptance soak is inferred from these tests.
