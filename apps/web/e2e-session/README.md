# Real wallet-session and sale-publication integration

This bounded TEST_ONLY suite runs an actual Chromium browser against the actual Next.js BFF,
Go API, and a disposable MySQL database. It does not mock authentication, approved-source catalog publication, or order HTTP.
It covers the existing wallet-login and native whole-artwork/fractional sale workflows in
Issue #110 and the client's three-section delivery, without adding a publication-signature gate.

The five cases cover:

1. Explicit wallet connection followed by signed login; public session metadata, HttpOnly
   cookies and reload restoration; no sale signature, publication or chain write from login.
2. Missing access cookie recovered with a rotated refresh cookie; explicit logout revokes
   both previously issued and current access/refresh credentials in the durable Go session store.
3. Publication rejects missing seller login, a login for another seller, and a missing sale signature.
4. Whole-artwork SaleIntent signed through the UI, explicit publication returning 201, identical
   UI retry returning 200, unauthenticated direct Go API reads, and linked-order reload.
5. The same fractional workflow at a 390px mobile viewport, including restoration of the
   seller's original authorization and remaining authorization read from the chain fixture.

## Running

Use Node 24+, the repository's pnpm version, Go from `apps/api/go.mod`, Chromium, and a fresh,
locally bound MySQL 8 instance. The test configuration defaults to the disposable
DSN `root:local-root-only@tcp(127.0.0.1:3306)/artfi?parseTime=true`;
`ARTFI_E2E_MYSQL_DSN` may select another freshly created local test database.
Create the database and apply every `apps/api/migrations/*.up.sql` file in lexical order before running.
The CI job owns database creation and teardown. Do not run against an existing or production database.

From `apps/web`:

```sh
pnpm exec playwright install chromium
pnpm test:e2e:session
```

The configuration starts Go on `127.0.0.1:8083` and Next.js on `127.0.0.1:3003` with fixed
TEST_ONLY internal credentials. Existing listeners are never reused. Go readiness uses the
SQL-backed `/v1/orders` endpoint, so a missing database cannot silently turn this into a mock test.
When needed, put the chosen Go binary on PATH; `ARTFI_E2E_CHROMIUM_PATH` selects an already
installed Chromium executable. No production RPC, Oracle, server credentials or real assets are used.

The runner generates an ephemeral P-256 source key in a Go test process, discards the private
key, and passes only its public trust root and two signed TEST_ONLY catalog envelopes to the
session environment. Test setup explicitly publishes these records through the ordinary authenticated
Next-to-Go publication API after sign-in; this is fixture setup, not automatic application behavior
on login. Whole and fractional records have distinct underlying token identities. The catalog HTTP
and its MySQL persistence remain real. Production defaults never trust these test sources.
`GO_BINARY` selects a Go binary when it is not on PATH. `ARTFI_E2E_PRODUCTION=1` uses an already
built production web output; otherwise the suite starts the development server.

## Boundaries and diagnostics

- Every test generates its ephemeral EOA key in Node. Only its public address and signing results
  reach the injected EIP-1193 wallet. No key is injected into browser code or saved to disk.
- `eth_accounts` starts empty. Only explicit connection grants origin permission; a visibly
  TEST_ONLY sessionStorage flag preserves that permission across reloads. Login is a separate click.
- The only mocked HTTP is a local read-only RPC fixture. All browser third-party requests are
  blocked, and service workers are disabled. Unknown contract selectors and RPC methods fail;
  the fixture includes ERC20/ERC721 reads and Multicall3 `getEthBalance` used by RainbowKit.
- Every wallet transaction attempt is rejected and counted. All five cases assert zero chain writes.
- Cookies stay in Node when testing rotation/revocation. Assertions report booleans and cookie
  metadata only; token values are never logged, snapshotted, placed in test names or attachments.
  Revocation probes use native Node fetch and never retain the API's response body.
- Traces, screenshots, videos and automatic failure-page ARIA snapshots are disabled; test output
  files are not preserved. Do not enable network debugging or attach browser storage state.
- The HTTP-only localhost deployment intentionally has `secure=false` cookies. The suite asserts
  HttpOnly, Strict SameSite, scoped paths and expiration; it does not claim production HTTPS evidence.

Collection, TypeScript, lint and the focused ABI fixture tests can be checked without a browser or
MySQL. Passing those checks alone does not establish that the five runtime scenarios pass.
A restricted local environment must report runtime checks as pending CI rather than bypassing
browser-launch or database restrictions. These tests establish application/session persistence,
not live contract settlement, mainnet readiness, or a real-asset business opening.
