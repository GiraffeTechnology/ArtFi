# Sepolia mint package gate

Every real artwork must pass a local mint-package check before upload, metadata publication, or a
Sepolia mint. Keep the artwork and rights evidence outside Git; the manifest records their SHA-256
digests, authorization scope, attribution, and the content-addressed artwork URI.

```bash
node scripts/release/verify-mint-package.mjs /secure/path/mint-package.json
```

The full gate requires explicit NFT-mint authorization and marketplace-listing eligibility, checks
both local files against their digests, rejects expired rights, and prints the reproducible artwork
and canonical token-metadata hashes. A successful package does not authorize an OpenSea listing:
`listingActionConfirmed` must remain `false`, and action-time confirmation is required immediately
before the external listing action.

Use `release/mint-package.example.json` only as a template. Do not commit completed manifests,
artwork, identity documents, contracts, correspondence, signatures, or other rights evidence.
