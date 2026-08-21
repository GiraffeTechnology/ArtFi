# UI acceptance evidence

## Approved design and brand boundary

- Design source: [ArtCCH:ArtFi approved Figma file](https://www.figma.com/design/O9etbeZZD0VrsU8ch9PaZZ?node-id=11-2).
- The global identity uses the approved `apps/web/public/brand/artcch-logo-master.svg` VI asset directly. The implementation does not redraw, trace, or synthesize the ArtCCH logo.
- Asset provenance is byte-for-byte verified: SHA-256
  `6e4f29d3de0026dcbac0cd763b039cc2832bb0e64296d322794fe33ced90104b` matches the
  controlled abcdyi `artcch/brand/vi/artcch-logo-master.svg` and the current ArtCCH site asset.
  The VI manual names that exact file as the approved primary wall-red vector master.
- The asset is used at its native `4:1` ratio and approved screen colour `#93272C`. Its rendered
  width is `152px` on desktop and `104px` on mobile, both above the VI manual's recommended `96px`
  digital minimum, with the SVG's built-in clear space preserved.
- `ArtCCH:ArtFi` is the product identity. `Giraffe ArtFi Corp.` appears only in the technical-support footer attribution. Bazaar is a composition reference only and is not presented as a product or partner.
- Overview, market mirror, NFT control, wallet, and DAO follow the approved visual shell while the original PRD routes remain available.

## Product and compliance boundary

- The market surface is an external-market mirror. It cannot create, sign, match, custody, or settle an order; execution remains at the approved external venue.
- Wallet connection stays external and does not request a signature merely to display public Sepolia state.
- DAO membership, vote and classified proposal controls are present but fail closed until the reviewed Sepolia deployment is configured. The browser never receives a signing key; automated debit, forced closeout and real buyout settlement remain disabled.
- Projects, fractional previews, valuations, treasury, and governance examples remain labelled fixtures. The RWA market route renders only attributed runtime marketplace records, including source and observation time; it shows an explicit empty/error state instead of falling back to fixtures.

## Local automated evidence — 2026-08-20

- TypeScript, ESLint, and four Vitest unit tests pass.
- Playwright passes 28 checks across desktop Chromium and Pixel 7 profiles: 20 route/render/accessibility checks plus wallet, VI attribution, Sepolia gate, and operating-mode checks in both projects.
- Axe reports no serious or critical accessibility violations across the ten tested routes.
- Manual browser inspection additionally confirmed the 1440px and 390px responsive layouts, no horizontal overflow, and no browser-console errors.
- Next.js production compilation, TypeScript validation, and static generation of all 24 routes pass. The final local standalone-directory copy is blocked only by Windows symlink permission (`EPERM`); no source compile or route-generation failure occurred.

## abcdyi Linux pre-chain revalidation - 2026-08-20

- The approved UI source was synchronized to the main `GiraffeTechnology/ArtFi` working tree without
  generated output, dependency directories, test artwork masters, or local agent files.
- Prettier, ESLint, TypeScript, and all four Vitest assertions passed in the repository-pinned Node
  `24.18.0` / pnpm `11.22.0` environment.
- The production build compiled and generated all 24 routes, including `/dao` and `/api/health`.
- Playwright and Axe passed all 28 desktop/mobile checks, including the approved VI attribution,
  wallet non-transaction boundary, Sepolia gate, read-only operating mode, and ten representative
  routes. This Linux result removes the Windows standalone-copy environment limitation from the
  pre-chain acceptance result.

This evidence is local and does not replace the deferred one-time CI, signed release evidence,
Sepolia deployment, real NFT mint, or OpenSea discovery validation.

## Eight-language replacement evidence - 2026-08-21

- The compact global order is `EN / 简 / 繁 / FR / ES / DE / 한 / 日`; every option exposes its
  complete language name to assistive technology without widening the existing header control.
- The UI locale `zht` maps to the established `zh-Hant` translation target and migrates the prior
  `zh-Hant` local-storage value without discarding the user's preference.
- French, Spanish, German, Korean and Japanese reject non-English source copy instead of translating
  from Chinese or another generated language. Primary-generation failures restore the authoritative
  English text; typed Qwen proofread-only failures retain the valid CTranslate2 primary translation.
- Linux TypeScript, ESLint, 9 Vitest assertions and the repository secrets/plaintext-server-IP gate
  pass. The Next.js 16.3.1 production build compiles and generates all 25 routes.
- Playwright and Axe pass 30 desktop/mobile checks. The added deterministic browser journey verifies
  language persistence, `html lang`, dynamic accessible attributes, translated page titles and
  mobile-menu redraw behavior.
- A separate AIVAN canary reports CTranslate2 as the primary provider and returns warning-free
  English-to-Simplified-Chinese, Traditional-Chinese, French, Spanish, German, Korean and Japanese
  translations while preserving `NFT`, `OpenSea` and `0.01 ETH`.

These are pre-production local/canary results. Public portal routing, Qwen proofread-only sampling on
the four added targets, managed-tunnel restart evidence and the deferred one-time GitHub CI remain
required before production acceptance.

## ERC-721 / ERC-1155 control and wallet-to-DAO evidence - 2026-08-21

- `/create/rwa` is a single administrator control surface with an accessible ERC-721 / ERC-1155
  selector and the original four-step record, wallet, confirmation and routing structure.
- ERC-721 retains the server-held operator credential boundary, live registrar-role recheck,
  request/recipient-bound receipt decoding and immutable collection lookup.
- ERC-1155 accepts commitments and a no-preview metadata URI only. It does not upload an artwork
  master. Before enabling a wallet call it checks the configured Sepolia contract, creator role,
  pause state, exact 100-unit supply constant and recorded `0.01 ETH` policy. Success additionally
  requires an exact `SeriesCreated` event plus post-mint total-supply and recipient-balance checks.
- Confirmed assets expose the standard, contract, Token ID and quantity for external-wallet import.
  Import changes wallet display only and does not transfer, approve or grant DAO rights.
- The control page includes a canonical ERC-721/ERC-1155 mint catalog projected from indexed
  Sepolia events. It does not wait for OpenSea discovery and does not substitute fixture assets.
- The portfolio provides a wallet-to-DAO module. DAO access still requires the holder-wallet nonce
  signature, continuing ERC-721 Vault custody and a positive RWA share-token balance. Indexed
  positions and transaction history replace the prior fixture artwork cards.
- The DAO page preserves the original four-step setup purpose with deterministic Vault creation,
  exact-token approval, deposit/custody readback and fixed-supply issuance. It never asks for
  collection-wide `setApprovalForAll`.
- The market mirror now provides real search, listing-state filter, stable sort and bounded page
  controls over attributed runtime records.
- TypeScript, ESLint and 9 Vitest assertions pass. Playwright and Axe pass 36 desktop/mobile checks,
  including both NFT-standard gates, safe DAO setup and wallet-to-DAO routing. Manual 390px
  inspection found no horizontal overflow or browser-console warning/error. The abcdyi Linux
  production build compiled, typechecked and generated all 28 pages.
