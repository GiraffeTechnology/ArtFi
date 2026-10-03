# Xiongan Wallet entry

## Bounded requirement and implementation

The client's 2026-10-03 instruction asks for a discoverable path from ArtFi at
`https://io.artcch.com` to Xiongan Wallet, with login omitted from this navigation
test. This is an application-side integration under AGENTS.md section 1.3.

The client's later 2026-10-03 correction requires the deployment to supply the
complete wallet URL without a hardcoded address or port. This correction replaces
the initial fixed-destination implementation below; it does not authorize deployment.

The overview tools, desktop Tools menu, mobile Menu, portfolio page and existing
RainbowKit connection modal all consume one shared runtime configuration. The
server-only `ARTFI_XIONGAN_WALLET_URL` is read for each request to the same-origin,
read-only `GET /api/wallet-config` route. The route is force-dynamic and no-store.
This is not a `NEXT_PUBLIC_*` build-time value. The same built application can be
started with different deployment URLs without editing source or rebuilding it.

The deployment supplies a complete absolute HTTPS URL: hostname, any allocated
port, and path. No hostname, destination, port, or path is supplied by the code.
The value is preserved exactly, including any explicit port; no port is selected,
joined or substituted. Syntax, HTTPS, credentials and query/fragment payloads are
validated on both sides. Invalid values are never echoed in API errors. Only the
validated public URL is returned; no environment object, secret, account or token
is exposed. The API does not contact the destination or proxy arbitrary requests.

`Open Xiongan Wallet` opens that URL in a new tab with `rel="noopener noreferrer"`.
Missing, invalid, loading, failed or refreshing configuration produces no clickable
wallet destination. A visible status and retry action allow recovery. Old successful
URLs are hidden while refreshing or after an API failure, rather than used as a
fallback. All entry points share the result and refresh together.

The existing `/portfolio` entry, Browser Wallet provider and authentication remain.
The portfolio and modal explain that opening the separate DApp does not connect a
wallet to ArtFi. Each app uses its own browser-wallet connection. No fabricated
wallet connector, signing authority, chain policy or contract address is introduced.

## Verified protocol boundary

Reviewed source revisions:

- ArtFi `main`: `13f9b6b774fd7ba6010cd7a500574074d1ac37d3`.
- 8415Wallet `main`: `18499967348a6db572e699bc37700d98376755dc`.
- 8415Wallet `deploy/xiongan-sin`: `1ccafcdd769e9c41e3531876ace1b9714fdc932b`.

The wallet's `web/app.mjs` and `web/external-assets.mjs` have identical blob SHAs
in the two reviewed wallet revisions. Their connection handlers consume
`globalThis.ethereum`, request accounts from that external provider and check
the chain. They do not expose a provider to another origin. Agent requests use
explicit public-file review; they are not an ArtFi connection handshake.

No cross-origin provider, WalletConnect session endpoint or ArtFi deep-link
handshake is implemented in those reviewed browser entry points. Therefore this
change does not fabricate a Xiongan wagmi connector or claim shared sessions,
signing authority or a completed transaction. A future protocol integration
would need a real supported interface and separate scoped verification.

## Earlier navigation increment evidence (historical)

- Local format, lint, typecheck, workspace unit tests and production build pass.
  The Web suite has 521 tests; market-mirror has 49 and wallet-extension has 6.
  The API-client test command also passes. Agent tests pass 36 cases and the
  repository secret-pattern check passes.
- The new Playwright cases cover desktop/mobile entry visibility, the then-fixed URL,
  opener isolation, retained portfolio navigation, Back/Forward, repeated modal
  opening, Close/Escape, reload, accessibility and absence of account-permission,
  signing or transaction requests. Request evidence is retained in the test
  process across navigation. The destination is explicitly a navigation fixture.
- Local browser execution is **blocked**, not passed: browser download returned
  an incomplete archive; installed Chromium could not create its local socket;
  the cloud browser denied the local development URL. GitHub browser jobs must
  execute these cases for the exact PR head before merge.
- Go vet/race tests could not run locally because this workspace has no usable Go
  toolchain. API, contract, database and deployed-runtime results are separate CI
  or delivery evidence. This UI change does not modify those implementations.
- Login, signatures, live on-chain transactions and full chain/contract workflow
  acceptance were deliberately not exercised. Skipping login in a navigation
  test does not remove production authentication.

## Runtime configuration correction verification

The correction starts from ArtFi main
`ba2444988bcf53ac90e4cb4913c843f3af44f8b9`. Unit tests cover two distinct deployment
hosts, ports and paths; explicit standard ports are also accepted when supplied by
deployment. No deployment port blacklist is added. Validation tests include missing,
invalid and unsafe URLs, embedded credentials and payload-bearing query/fragment
values. Route tests change the server environment between requests and verify
no-store responses, demonstrating request-time rather than module/build-time reads.
Client tests cover malformed responses, API outage, stale destination suppression
while refreshing/paused and recovery to a changed URL.

Desktop/mobile browser cases cover all entry points, changed configuration after
reload, missing/invalid/unsafe/credential-bearing configuration, API outage/retry,
repeated wallet modal opening, Close/Escape, isolated new tabs, retained portfolio,
Back/Forward and unchanged Browser Wallet availability. Destinations are explicit
TEST_ONLY browser fixtures. They do not prove deployed wallet availability.
Exact-head CI evidence is recorded on the PR; no production/transaction pass is
inferred from these isolated tests.

## Deployment handoff

After the release owner merges an exact CI-green revision, publish the ArtFi Web
image using the existing procedure and full `ARTFI_BUILD_SHA`. Retain all existing
API/bridge/authentication/chain settings and the previous rollback digest.

The deployment owner must set `ARTFI_XIONGAN_WALLET_URL` in the running Web
process/container environment to the approved complete public wallet URL, using
the actual allocated host, port and path. It is public non-secret configuration.
Do not put credentials, accounts, tokens, query strings or fragments in it. The
example environment deliberately leaves it empty. The application has no default;
if the allocated public destination is not yet known, leave it unset and the UI
will report that configuration is missing. Do not guess a port or keep using a
previous hardcoded destination. Changing runtime environment requires the normal
process/container restart, but not a new application build.

Verify `/api/wallet-config` returns that exact approved URL and `Cache-Control:
no-store`; `/api/health` must report the deployed revision. On desktop and mobile,
check overview, navigation, portfolio and wallet-modal links, then close/reopen,
reload and retry. Verify no login, signature or claimed ArtFi connection occurs
just from opening the DApp. Separately verify the approved endpoint is reachable
and its redirects preserve the owner's assigned destination. An external redirect
or unavailable wallet service is deployment evidence, not repaired by source alone.

Existing CTYun and SIN TCP 443 bridge/listener allocations must be preserved. Do
not add a new binding or disrupt/rebind a service there; CTYun's SSH reservation
also remains in force. Reuse only the deployment owner's confirmed allocation.
These are current deployment constraints, not a general URL-port blacklist for
future hosts. This source change makes no SSH, firewall, listener, proxy, TLS,
credential, production deployment, real-chain or real-asset changes.
