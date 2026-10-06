# Native OpenSea implementation

The product boundary is defined in PRD section 4.8. This document separates the current
implementation from the remaining work. A native discovery page or removal of redirects does
not complete listing, buying, offers, cancellation, or wallet integration.

## Current source

- `/nft` retains in-app edition discovery and rights/holder-access surfaces. External OpenSea
  navigation is footer-only; observed URLs remain non-navigating source evidence.
- `apps/market-mirror` supplies passive REST/Stream ingestion, replay, and reconciliation.
- `apps/api/internal/httpapi/market_orchestration.go` has a gated `fulfill-listing` increment,
  durable intent IDs, idempotency, bounded transaction-plan checks, and submission/result
  tracking. No current web component invokes that execution path.
- The increment does not implement listing creation, offers, offer acceptance, or cancellation.
  Its authentication, account binding, protocol allowlist, calldata semantics, current API
  response shape, fees, and receipt validation must be verified before exposing it to users.
- Portfolio balances and indexed records require the existing authenticated-session gate,
  including logout, expiry, account changes, aborted reads, and cache isolation. Verify that
  implementation separately from this navigation correction. Xiongan Wallet is a separate
  application whose asset-display authentication is not verified by ArtFi's navigation tests.

## Implementation sequence

1. Keep the three product sections and public wallet entry. Gate personal asset displays on
   a valid session bound to the current wallet and chain. Verify both request authorization
   and removal of already-rendered data when the session becomes invalid.
2. Add native NFT discovery/detail routes backed by the approved NFT collection scope. Keep
   digital NFTs separate from RWA receipts and fractions; generic mixed venue records are not
   proof of NFT classification. Show observed identity, source time, order state, and real
   missing-data or upstream-error states.
3. Reuse the existing intent/idempotency model for an authenticated buy flow. Revalidate the
   canonical order and actual official fulfillment response, explicit protocol/chain support,
   token quantity, payment/fees, expiry, account, and exact transaction before wallet approval.
   Record a broadcast as pending; verify receipts and reconcile venue/order state separately.
4. Add listing and offer preparation, reviewed terms, user-controlled typed-data signing,
   and submission through the official order API. Validate ownership, balances, bounded
   approvals, signatures, chain/domain, and account on both sides. A signature is not evidence
   that the venue accepted an order. Keep credentials and credential-bearing SDK calls on
   the server, and do not persist raw signed payloads in logs or browser recovery storage.
5. Add offer acceptance and eligible cancellation. Distinguish on-chain revocation from
   supported off-chain cancellation and its fulfillment-race limitations. Refresh resulting
   order and portfolio state; do not report cancellation from an optimistic UI update.
6. Cover all operations in desktop/mobile tests with explicit mocks or approved test assets:
   rejected signatures, unsupported chain, expired/stale order, upstream 401/429/5xx, duplicate
   clicks, close/back/reload, account/network changes, delayed responses, transaction replacement,
   reorg, and interrupted reconciliation. Keep live acceptance and deployment unclaimed until
   observed in the applicable environment.

## Runtime inputs

- Approved OpenSea API access is required for the relevant upstream calls; API keys stay
  server-side. Existing key configuration must be verified without exposing it.
- Use actually supported chains, contracts, payment tokens, protocol addresses, and collection
  scope. Do not silently switch isolated Hoodi tests to a production chain when unsupported.
- Reuse the configured ArtFi authentication service, durable storage, and wallet transport.
  The Xiongan tenant URL remains complete deployment-supplied configuration, without a
  hardcoded hostname, port, or invented cross-origin connection/signing handshake.
- Opening or testing a page grants no authority to execute a real-value trade, listing,
  offer, cancellation, or wallet signature. Users confirm their own wallet actions.

## Official references

Checked 2026-10-04. Confirm the current version and endpoint contract when implementing each
operation; the API/SDK does not imply complete feature parity with the OpenSea website.

- [NFT trading guide](https://docs.opensea.io/docs/buy-and-sell-nfts)
- [Server-side TypeScript SDK](https://docs.opensea.io/reference/opensea-sdk)
- [SDK API reference](https://github.com/ProjectOpenSea/opensea-sdk/blob/main/developerDocs/api-reference.md)
- [Cancellation behavior](https://github.com/ProjectOpenSea/opensea-sdk/blob/main/developerDocs/advanced-use-cases.md)
