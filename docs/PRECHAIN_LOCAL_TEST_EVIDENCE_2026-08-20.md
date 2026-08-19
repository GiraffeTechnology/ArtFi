# ArtCCH:ArtFi pre-chain local test evidence - 2026-08-20

## Scope and decision

This evidence covers the `GiraffeTechnology/ArtFi` working tree on
`agent/stages-2-7-completion`, based on commit
`d754c6b64bfc12841148dba12c66c0e249be8d22` plus the reviewed, uncommitted pre-chain
change set.

The code, approved UI, fixed charity-edition contract, package gates, API persistence, and optional
Sepolia tooling pass the applicable local gates. This is not chain or production evidence. No ETH
was transferred, no transaction was broadcast, no contract or series was deployed, no artwork or
metadata was uploaded, and no OpenSea listing was created.

## Repository and Web gates

- Runtime: Node `24.18.0`, pnpm `11.22.0`.
- Full repository `format:check`, `lint`, `typecheck`, `test`, and `build`: passed serially.
- Approved Web source direct gates: Prettier, ESLint, TypeScript, and four Vitest assertions passed.
- Next.js `16.3.1` production build compiled and generated 24 routes, including `/dao`,
  `/create/rwa`, and `/api/health`.
- Playwright and Axe: 28/28 passed across desktop Chromium and Pixel 7 profiles, covering ten
  representative routes, the official VI asset, wallet non-transaction boundary, Sepolia gate, and
  read-only external-market mode.
- The approved ArtCCH primary wall-red vector is used directly. Its SHA-256 is
  `6e4f29d3de0026dcbac0cd763b039cc2832bb0e64296d322794fe33ced90104b`, matching the controlled
  abcdyi `artcch/brand/vi` and current ArtCCH site copies. It is not redrawn.

## Contract and deployment-tooling gates

- Foundry `1.5.1`, Solidity `0.8.30`.
- `forge fmt --check`, `forge build src --sizes`, and high-severity lint: passed.
- `forge test --force -vvv`: 35 passed, 0 failed, 0 skipped.
- Charity edition suite: 9 passed, including 512 fixed-supply fuzz runs.
- Two existing invariant suites: 256 runs and 16,384 calls each, zero reverts.
- `ArtFiCharityEditions` runtime size: 9,264 bytes, leaving 15,312 bytes below EIP-170.
- No-broadcast local deployment simulation with Sepolia chain ID `11155111`: passed; observed gas
  was `2,014,600`.
- Optional charity deployment, preflight, standard-probe shell syntax, and Sepolia tooling verifier:
  passed.
- ArtFi exchange deployment and operation remain disabled.

## API, MySQL, and Redis gates

- Go `1.26.5` container: `go vet ./...` and `go test -race ./...` passed.
- MySQL `8.4`: five up migrations produced exactly 22 tables.
- Real integration tests passed for service-restart persistence, chain-event dedupe/conflict/reorg,
  and external-market mirror dedupe/ordering.
- Redis `8`: real store/read, namespace invalidation, and failure-bypass tests passed against an
  isolated database.
- Five down migrations produced exactly 0 tables. The unique test database was dropped, the
  isolated Redis database was cleared, and the Redis service started for this test was stopped.
- Dependency download used a recorded, temporary SSH SOCKS PID through the approved Singapore
  exit `8.219.77.22`. The exact process was terminated, port `11082` was confirmed closed, and all
  task-specific dependency caches and bridge artifacts were removed.

## Charity-edition and artwork gates

- The duplicated `UNIT-A16-000.png` input was deduplicated, leaving 13 unique works and 1,300 fixed
  edition units.
- Each series is one ERC-1155 token ID with exactly 100 units created once and a recorded primary
  unit price of `0.01 ETH`.
- Public metadata has no artwork preview. The unwatermarked master cannot be a website download;
  the only holder asset is a distinct high-resolution watermarked file behind ownership checking.
- Schema-only validation and full positive/negative charity-package regression tests passed.
- The package rejects changed supply, public preview, unwatermarked download, master/holder hash
  reuse, less than 100% CCHS proceeds, transfer-date or non-`ETH/CAD` receipt valuation, missing
  rate evidence, ArtFi receipt-amount control, physical title transfer, or stale listing approval.
- Product policy records the CCHS receipt amount using a CCHS-approved public `ETH/CAD` market rate
  at the receipt-issue time. CCHS remains the only receipt issuer and eligible-amount decision-maker.

## Security and prohibited-action checks

- Secret-pattern scan: passed across 179 repository files.
- `git diff --check`: passed.
- The repository contains no test artwork masters, completed rights packages, credentials, signed
  transactions, or private CCHS correspondence.
- The UI contains no in-app buy, bid, claim, custody, order matching, fulfilment, or settlement path.

## External release blockers

1. CCHS legal name, CRA registration number, current charity evidence, confirmed Sepolia and later
   production beneficiary wallets.
2. CCHS written confirmation of the direct-holder receipt workflow, issue-time `ETH/CAD` source
   policy, holder-advantage valuation, and post-sellout physical-artwork acceptance.
3. Formal title/attribution and hash-bound mint, metadata, listing, and takedown authorization for
   each of the 13 works.
4. Thirteen distinct high-resolution watermarked holder files and immutable no-preview metadata
   URIs.
5. A funded Sepolia signer and approved action-time confirmation before any external listing.
6. Final one-time GitHub CI against the exact committed change set.

Until those blockers are satisfied, media publication, Sepolia deployment, series creation,
OpenSea discovery/listing claims, receipt claims, mainnet, real-value operation, and an ArtFi
exchange remain blocked.
