# ArtCCH charity editions — pre-chain evidence

Recorded on 2026-08-20 against base commit `d754c6b64bfc12841148dba12c66c0e249be8d22`
plus the uncommitted charity-edition working-tree change set on
`agent/stages-2-7-completion`.

## Decision

The fixed-edition contract, private-master package gate, optional deployment tooling, and standard
probe are locally testable. The batch is **not authorized** for media upload, metadata publication,
Sepolia deployment, series creation, OpenSea listing, or receipt claims. No transaction was
broadcast and no artwork file was copied into Git or a public website.

## Product boundary verified in code

- One ERC-1155 token ID represents one approved artwork series.
- The complete supply of exactly `100` units is minted once during series creation.
- No external follow-on mint or burn function exists.
- The recorded primary unit price is `0.01 ETH` (`10000000000000000` wei).
- A duplicate artwork ID or duplicate master-artwork SHA-256 cannot create another series.
- Sellout evidence cannot be recorded until the original distribution wallet holds zero units.
- Physical-donation acceptance evidence cannot be recorded until sellout evidence exists.
- Series creation, transfers, sellout records, and donation records are blocked while paused.
- The contract performs no sale, order matching, settlement, custody of proceeds, or ArtFi exchange
  operation.

## Automated evidence

- `forge fmt --check`: passed.
- `forge build src --sizes`: passed.
- `forge lint --severity high`: passed.
- `forge test --force -vvv`: 35 passed, 0 failed, 0 skipped.
- Charity-edition suite: 9 passed, including 512 fixed-supply fuzz runs.
- Existing invariants: two suites at 256 runs and 16,384 calls each, zero reverts.
- `ArtFiCharityEditions` runtime size: 9,264 bytes; EIP-170 margin: 15,312 bytes.
- No-broadcast local deployment simulation with Sepolia chain ID: passed; gas used `2,014,600`.
- ERC-1155 and ERC-1155 metadata interface assertions: passed.
- Charity-package schema and negative regression tests: passed.
- Sepolia deployment-tooling verifier and all related shell syntax checks: passed.
- Repository formatting and secret-pattern scan: passed across 172 files.
- Go `1.26.5` `go vet ./...` and `go test -race ./...`: passed.
- MySQL `8.4` integration: five forward migrations produced exactly 22 tables; persistence,
  chain-event dedupe/conflict/reorg, and external-market mirror dedupe/ordering tests passed.
- Redis `8` integration: real cache store, lookup, namespace invalidation, and failure-bypass tests
  passed against an isolated empty database.
- Integration cleanup: all five down migrations produced exactly 0 tables; the unique temporary
  database was dropped, the isolated Redis database was cleared, and the task-started Redis service
  was stopped. The Singapore dependency bridge was closed by its recorded PID and all task-specific
  temporary dependency caches and bridge artifacts were removed.

The contract test script uses `forge test --force` because a preceding targeted `forge build src`
can otherwise leave Foundry's incremental cache without test artifacts and produce a false
"no tests found" result.

## Artwork intake evidence

The requested list contained `UNIT-A16-000.png` twice. It was deduplicated as the same file, leaving
13 unique works and a planned total of 1,300 edition units. Every source exists in the authoritative
local `花瓶3/assets` registry, and the observed file bytes, dimensions, and SHA-256 values match its
source manifests.

The complete local-only intake is outside Git at:

`C:\Users\Administrator\Documents\Giraffe ArtFi\mint-packages\artcch-charity-editions-intake-2026-08-20.json`

The intake asserts ArtCCH as rights holder and credits `Michael Yip's team`, records no public
artwork preview, and forbids any unwatermarked web download. It is explicitly marked
`not-authorized-for-upload-mint-or-listing`.

## Privacy and holder-access boundary

- Public token metadata contains no artwork `image` field and no artwork preview URI.
- The unwatermarked master is verified locally by hash but is never returned by metadata or a web
  endpoint.
- The only planned holder asset is a distinct, high-resolution **watermarked** file, delivered after
  wallet ownership verification without an in-browser preview.
- A completed package fails if the watermarked file has the same SHA-256 as the master.
- UI continues to use generic approved placeholders and does not import these 13 masters.

## CCHS and physical-artwork boundary

- All primary proceeds are designated for CCHS, but deployment/listing remains blocked until CCHS
  confirms the beneficiary/distribution wallet in writing.
- Holders contact CCHS directly regarding an official Canadian donation receipt. ArtFi does not
  issue the receipt, determine the eligible amount, or guarantee a tax credit.
- Product policy requires the public-market ETH/CAD rate at the CCHS receipt-issue time. The
  evidence schema binds the `ETH/CAD` pair, CCHS-approved public source selection, provider and issue
  timestamps, quoted rate, and snapshot hash. ArtFi cannot calculate or override the eligible
  amount. Release requires CCHS written confirmation of the final valuation and holder-advantage
  treatment.
- NFT ownership conveys no physical title, possession, redemption, copyright, commercial-use, or
  reproduction right.
- ArtCCH retains the physical work until all 100 primary subscriptions are independently reconciled.
  CCHS physical-donation acceptance is then documented and only its evidence hash is placed on
  chain.

## Release blockers

1. CCHS legal name, CRA registration number, and current registered-charity evidence.
2. CCHS-confirmed Sepolia distribution wallet and the separately approved production wallet.
3. CCHS written confirmation of direct-holder receipt workflow, valuation date/method, ETH/CAD
   source policy, holder-identification evidence, and valuation of the NFT/download advantage.
4. CCHS written acceptance of the post-sellout physical-artwork donation procedure.
5. Formal title and public attribution for each of the 13 works.
6. Hash-bound ArtCCH mint, metadata-publication, external-listing, and takedown authorization.
7. Thirteen distinct high-resolution watermarked holder files and their verified hashes.
8. Thirteen immutable, no-preview metadata URIs and their canonical hashes.
9. A fresh action-time confirmation for the exact external collection, token ID, quantity, unit
   price, currency, duration, fees/royalties, beneficiary wallet, and wallet signature.
10. Funded Sepolia signer and approved Singapore egress if live test deployment is resumed.
