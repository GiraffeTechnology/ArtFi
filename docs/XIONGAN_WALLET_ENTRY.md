# Xiongan Wallet entry

## Bounded requirement and implementation

The client's 2026-10-03 instruction asks for a discoverable path from ArtFi at
`https://io.artcch.com` to Xiongan Wallet, with login omitted from this navigation
test. This is an application-side integration under AGENTS.md section 1.3.

The overview tools, desktop Tools menu, mobile Menu, portfolio page and existing
RainbowKit connection modal expose **Open Xiongan Wallet**. All use the fixed
public URL `https://xiongan.8415wallet.com/web/index.html`, open a new tab and set
`rel="noopener noreferrer"`. No account, token, request, credential or return URL
is included. The existing `/portfolio` entry and Browser Wallet connector remain.

The portfolio and modal explicitly explain that opening the separate DApp does
not connect a wallet to ArtFi. Each app uses its own browser-wallet connection.
No login/authentication code, wallet connector, chain policy, contract address or
server configuration changes are included.

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

## Checks and evidence limits

- Local format, lint, typecheck, workspace unit tests and production build pass.
  The Web suite has 521 tests; market-mirror has 49 and wallet-extension has 6.
  The API-client test command also passes. Agent tests pass 36 cases and the
  repository secret-pattern check passes.
- The new Playwright cases cover desktop/mobile entry visibility, canonical URL,
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

## Deployment handoff

After the release owner merges an exact CI-green revision, rebuild and publish
the ArtFi Web image using the existing deployment procedure and full
`ARTFI_BUILD_SHA`. Retain all existing API/bridge/authentication/chain settings and
the previous rollback digest. This link needs no new secret or environment key.

On desktop and mobile, visit the overview and portfolio, open the wallet modal,
and verify **Open Xiongan Wallet** opens
`https://xiongan.8415wallet.com/web/index.html` in a separate tab without a login,
signature or claimed ArtFi connection. Close the tab/modal and verify portfolio
navigation still works. Check `/api/health` for the deployed revision.

The root-domain redirect to port `9444`, reported during the separate deployed
browser check, is an infrastructure issue for the existing SIN deployment owner;
it is not repaired or bypassed by a new frontend protocol. Keep public redirects
on the canonical HTTPS origin. No production server was changed by this PR.
CTYun TCP port `443` remains reserved for SSH and must not be rebound for web/TLS.
