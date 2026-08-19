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
- Overview, market mirror, wallet, and DAO follow the approved visual shell while the original PRD routes remain available.

## Product and compliance boundary

- The market surface is an external-market mirror. It cannot create, sign, match, custody, or settle an order; execution remains at the approved external venue.
- Wallet connection stays external and does not request a signature merely to display public Sepolia state.
- DAO is read-only in this UI pass. Vote submission and proposal execution interfaces remain reserved.
- All catalog, valuation, treasury, and governance values shown by the local UI are labelled representative or illustrative fixtures. They are not live deployment evidence or offers.

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
