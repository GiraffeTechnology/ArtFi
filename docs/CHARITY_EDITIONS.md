# ArtCCH charity-edition gate

This gate covers the initial ArtCCH charity editions without enabling an ArtFi exchange.

## Immutable product rules

- Each approved artwork is one ERC-1155 token ID with exactly `100` units minted once.
- The recorded primary unit price is `0.01 ETH` (`10000000000000000` wei). ArtFi does not create,
  sign, match, fulfil, or settle marketplace orders.
- The original distribution wallet must have a zero balance and externally reconciled sale evidence
  before sellout can be recorded.
- Physical donation acceptance by CCHS can be hash-recorded only after sellout is recorded.
- An edition does not transfer copyright, physical title, possession, redemption, commercial-use,
  or reproduction rights.
- The only holder benefit is access to a high-resolution **watermarked** copy after wallet ownership
  verification. The unwatermarked master is never placed in public metadata, a website download,
  or a browser-delivered object.
- Public token metadata contains no artwork preview. OpenSea or another external marketplace may
  display a generic missing-image treatment; discovery must not be "fixed" by publishing the master.

## CCHS fundraising and receipt boundary

All primary proceeds are designated for CCHS. The approved external distribution/listing workflow
must route them to the CCHS-confirmed beneficiary wallet. Holders contact CCHS directly about an
official Canadian donation receipt. ArtFi does not issue a receipt, determine the eligible amount,
or promise a tax credit.

The receipt valuation policy uses a reasonable public-market ETH/CAD fair market value when CCHS
actually receives the gift. The evidence record preserves the ETH transfer and CCHS-received times,
receipt-confirmation and issue times, CCHS-approved public source, quoted ETH/CAD price, provider
timestamp, and snapshot digest. CCHS alone must decide the gift date, fair market value, every
holder advantage, and eligible amount in accordance with applicable law. ArtFi may only reproduce
an amount and evidence supplied or approved by CCHS. Release still requires CCHS's written
confirmation of the final method.

## Package verification

Keep completed packages, artwork masters, watermarked holder files, CCHS correspondence, rights
evidence, wallet attestations, price snapshots, and receipts outside Git.

```bash
node scripts/release/verify-charity-edition-package.mjs /secure/path/package.json
```

The schema-only example remains non-authorizing:

```bash
node scripts/release/verify-charity-edition-package.mjs \
  release/charity-edition-package.example.json --schema-only
```

Full validation fails closed until it can verify the master, the distinct watermarked holder file,
rights evidence, CCHS status and receipting-policy evidence, the non-zero CCHS-confirmed beneficiary
wallet, and marketplace-listing eligibility. `listingActionConfirmed` must remain `false`; a fresh
action-time confirmation is required for every external listing operation.

Deployment remains opt-in through `ARTFI_DEPLOY_CHARITY_EDITIONS=true`. After deployment, run
`scripts/test/sepolia-charity-editions-probe.sh` to verify the ERC-1155 and metadata interfaces,
fixed `100`-unit constant, and `0.01 ETH` recorded primary unit price. Supplying an already-created
`ARTFI_CHARITY_TOKEN_ID` additionally proves its on-chain total supply is exactly `100`.
