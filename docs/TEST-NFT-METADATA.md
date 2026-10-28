# Reviewed Hoodi test NFT metadata

The isolated test NFT flow needs a stable metadata URI before minting. The new
read-only route `/api/test-nft/metadata/<sha256>` serves reviewed public JSON from
the deployed test artifact. It performs no upload, signing, mint, RWA activation,
source attestation, wallet lookup, or image delivery.

The route is available only when `ARTFI_ENV` is exactly `test` and
`ARTFI_CHAIN_ID` is exactly `560048`. The server-controlled
`ARTFI_TEST_NFT_METADATA_MANIFEST` selects an absolute manifest file in the
reviewed metadata artifact. No URL, private storage reference, default directory,
or example asset is supplied by the application. Production and other chains
return 404. Missing or invalid configured artifacts return a redacted 503.

The manifest has exactly three fields: `schema` equal to
`artfi-test-nft-metadata/1`, numeric `chainId` equal to 560048, and `hashes`, a
unique list of 1–100 nonzero lowercase SHA-256 strings. Each listed metadata file
has the basename `<sha256>.json` in the same artifact directory. The request can
select only a listed digest; query parameters are rejected.

Both manifest and metadata use ASCII JSON formatted with two-space indentation
and one final LF, without a BOM. Canonical round-trip validation rejects duplicate
keys and extra syntax. Files must be regular, final symlinks are rejected, reads
are bounded, and an observed file change rejects the response. Manifest and
metadata limits are 16 KiB and 8 KiB respectively. Metadata bytes must match the
requested digest before any body is returned.
Validation never rewrites the input artifact; a successful response returns its
original bytes rather than serializing the parsed object again.

The fixed metadata profile contains only `name`, `description` and `properties`.
Names distinguish a simulated warehouse record from digitally native artwork;
the description explicitly states TESTNET, NO REAL-WORLD VALUE and NO LEGAL
EFFECT. Properties bind the corresponding kind 0 or 1 and source SHA-256, keep
`testOnly` true, and keep real value, legal title and institutional evidence false.
There are no image, animation, external URL, master, holder-file, arbitrary
attribute, or free-text extension fields. This profile is for the isolated test
payload and does not replace general RWA or charity metadata validation.

The actual deployment owner supplies the reviewed artifact and returns the real
complete HTTPS route. Independently read back those exact bytes and digest before
using the URI in the fixed Wallet mint request. A local artifact or a proposed URL
is not a published URI. Serving JSON proves neither source authenticity nor mint,
Vault, fractionalization, governance, or full-product acceptance. Preserve those
separate receipt and authority checks and the existing final archive procedure.
