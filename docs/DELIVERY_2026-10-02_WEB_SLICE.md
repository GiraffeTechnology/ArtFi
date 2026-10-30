# Three-product web delivery slice — 2026-10-02

## Authority and scope

This bounded implementation follows the client's explicit 2026-10-02 clarification and delivery request for `https://io.artcch.com`:

1. NFT has no real-world asset backing; its principal relationship is with CCHS (`cchsc.ca`), and trading is primarily on OpenSea. Existing independent Charity functionality is retained.
2. Whole-artwork RWA is a commercial ERC-8415 product. Its token represents a pickup voucher or warehouse receipt.
3. Fractional trading and DAO are inherited original PRD/MVP scope, not an added phase or optional feature.

The corresponding documentation alignment was merged in [PR #130](https://github.com/GiraffeTechnology/ArtFi/pull/130). This slice preserves existing implementation, adds no product requirement or acceptance gate, and does not claim that all three business workflows or their live deployment are complete.

Upstream base: `e628b8d2c6189042f9804539b18d22e8b51a2b7e`, tree `e92ab8df934f973836bf81ef2daa2d948a1f801f`. The initial complete 438-file snapshot was verified against every Git blob, binary content, executable mode and full tree; the three documentation files from merged PR #130 were then refreshed and the new upstream tree verified. Publication uses the actual upstream commit as parent.

## What changes

- Three explicit product entries on the homepage, desktop navigation and mobile navigation: `/nft`, `/rwa`, `/market/fractionals`.
- Product entries reach the existing Charity, whole-artwork signature settlement, fractional settlement, Vault and DAO screens. Existing marketplace mirror, history, creation, wallet, projects and operations routes remain available.
- `/create/rwa?standard=erc1155` opens the existing independent Charity creation flow. Unknown values preserve the existing ERC-721 default.
- Whole-artwork buyers approve exactly the signed ERC-20 payment before settlement. The page identifies the token and smallest-unit amount. It does not request unlimited allowance.
- Approval, settlement and withdrawal are recorded as complete only after a successful receipt. Reverts and changed/cancelled transactions do not produce a success claim.
- An operation captures its wallet/chain/asset context; leaving that context prevents another wallet request after approval. A context-level in-flight lock prevents another mounted instance from duplicating an unanswered wallet request.
- Unresolved broadcast hashes are stored per browser session, wallet and asset. A refresh or route change retains them. `Check transaction` reconciles them before another submission, including partial-fraction fills.
- Authorization display and single-intent withdrawal stay bound to their signer and asset. Wrong-chain controls are disabled, and pasted orders for another asset or buyer are refused before payment approval.
- The existing Docker build now accepts all public settings actually consumed by the web app. `/api/health` reports a validated `buildRevision`, or `null` when no exact revision was supplied.

The sample catalogue remains explicitly labelled fixture data. Product entry pages and working code are not evidence of a configured registry, a live order book, a real-asset sale, or physical delivery.

## Build and configuration handoff

Use the existing authorized ArtFi deployment task and existing hosting path. This PR creates no new hosting account, credential, production network or deployment system. The client has identified an older `artcch.com` build to reuse; the removable environment binding and exact user-supplied server labels are recorded in `docs/DEPLOYMENT_ENVIRONMENT.md`. First establish whether that old build serves ArtFi or a separate site, reuse compatible dependencies/configuration, and preserve any independent site. No server files or running processes have yet been inspected from this implementation environment.

- Node: repository requirement 24 or later. CI is pinned to Node 24.18.0 and pnpm 11.22.0.
- Install: `pnpm install --frozen-lockfile`.
- Web build: `pnpm --filter @giraffetechnology/artfi-web build`.
- Existing image definition: `apps/web/Dockerfile`; runtime port 3000; health `/api/health`.
- Current client-specified placement: the UI and public-chain execution stay in the existing SIN zone; backend, data and non-chain services stay on the existing backend/database hosts. Reuse the existing bridge and 24/7 operations, with removable named bindings only in `docs/DEPLOYMENT_ENVIRONMENT.md`.
- Use the existing operations model integration and reuse server-side environment/secret references where they are already configured. No credential was configured or tested in this slice. Do not introduce another operations stack or new persistent credentials. The existing `<LLM_PROVIDER_A>` binding remains removable; model output is advisory and never transaction authority.
- Build the exact reviewed Git commit. Pass `--build-arg ARTFI_BUILD_SHA=<full-40-character-commit>`; the runtime health response and image revision label must match that commit.
- `NEXT_PUBLIC_*` values below must be supplied at **build time**. Setting them only on an already-built running container does not change the browser bundle.

Public build inputs, already supported by the existing implementation:

| Purpose                   | Inputs                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API and public RPC        | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_HOODI_RPC_URL`, `NEXT_PUBLIC_ETHEREUM_RPC_URL`                                                                                                         |
| NFT / independent Charity | `NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS`                                                                                                                                               |
| Whole-artwork settlement  | `NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_MARKET_ADDRESS`, `NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS`, `NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID`, `NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG` |
| Fraction settlement       | `NEXT_PUBLIC_ARTFI_FRACTION_MARKET_ADDRESS`, `NEXT_PUBLIC_ARTFI_FRACTION_TOKEN_ADDRESS`, `NEXT_PUBLIC_ARTFI_FRACTION_SLUG`                                                                 |
| DAO / Vault               | `NEXT_PUBLIC_ARTFI_GOVERNOR_ADDRESS`, `NEXT_PUBLIC_ARTFI_GOVERNANCE_TOKEN_ADDRESS`, `NEXT_PUBLIC_ARTFI_DAO_ACTIONS_ADDRESS`, `NEXT_PUBLIC_ARTFI_RWA_VAULT_ADDRESS`                         |

Use verified Hoodi deployment addresses and the route representing that same asset. Do not assign one real token to unrelated fixture artwork pages. Blank settings remain explicitly unavailable; no address is fabricated. The current write-test chain remains Hoodi `560048`. Ethereum remains the existing read-only mirror source; no mainnet operation is authorized by this slice.

Server-only API authentication, holder-access storage settings and session secrets remain server-side and outside the public build inputs. Do not copy secret values into the PR, build arguments, evidence or health endpoint. Retain the existing API/reverse-proxy mapping: the SIN UI's same-origin `/v1/*` route reaches the backend through the existing bridge. Do not assume the backend is localhost or port 8080 on the UI host. The original `artfi` deployment task must resolve the actual upstream from its existing configuration.

After the existing authorized deployment task publishes the reviewed candidate, verify:

1. `/api/health` returns chain `560048` and the exact candidate `buildRevision`.
2. Homepage, `/nft`, `/rwa`, `/market/fractionals`, `/dao`, and the retained workflows load at `https://io.artcch.com`.
3. Verified configured assets appear only on their bound routes; absent dependencies remain accurately disclosed.
4. Run the corresponding existing TEST_ONLY user flows and record actual receipts where authorized. A health check or build alone does not establish them.

## Verification and limits

Local verification uses Node 24.19.0 and the available pnpm 11.19.0 with the frozen lockfile. No dependency versions or lockfile were changed.

- Web unit tests: 203 passing, including receipt, interruption, pending-journal, deployment-input and product-routing regressions.
- Full monorepo unit tests: API-client, market mirror, wallet-extension and web tasks all passed against the final implementation, including the receipt/journal additions. Candidate CI reruns all suites.
- Agent tests: 36 passing.
- Web lint and TypeScript: passed.
- HTTP-only Playwright checks: 14 passing, covering product routes, inherited workflow routes, mint selection, health/brand assets and unauthorized holder-download behavior.
- Next web build: passed against the final implementation. Remote CI must still be checked against the exact published head.
- Browser-interaction Playwright: **not locally executed successfully**. The official browser download returned an invalid archive; the installed Chromium could not create required Unix sockets in this execution environment, including an approved retry. The cloud browser also refused localhost. These are environment limitations, not passing UI evidence.
- The CI browser job explicitly runs both the existing desktop/mobile suite and `playwright.market.config.ts`. The latter uses isolated injected-wallet/RPC fixtures for approval/receipt ordering, revert handling and pending-fill refresh recovery. It makes no real-chain transaction.
- Solidity, Go and MySQL integration tests were not run locally: the required Foundry, Go compiler and container runtime are absent. Existing candidate CI remains the execution path for those suites.
- No merge, server upload, deployment, real wallet signature, mainnet transaction or real-money transaction was performed by this implementation slice.

## Existing work that remains open

These are current implementation/runtime gaps, not new requirements or blockers for the changes above:

- Complete the existing registry/Oracle consumer path and selectively integrate compatible work from PR #113 and the #117–#122 stack; do not import obsolete control-document gates or replace PR #127 fixes.
- Persist and reconcile ordinary signed orders through the existing API. The current screens still disclose browser-local/manual authorization handoff.
- Configure the verified deployed addresses and complete corresponding TEST_ONLY wallet user flows in the existing authorized deployment task.
- Finish current Charity holder-wallet access and evidence reconciliation; retain historical receipt evidence without relabelling it as this candidate's acceptance.
- Demonstrate the existing fraction/Vault/DAO lifecycle and record current-candidate outcomes.

Delivery of the full three-product request continues beyond this first web slice. Documentation, automated tests, deployed UI and actual runtime evidence must identify the same candidate before any corresponding completion claim.
