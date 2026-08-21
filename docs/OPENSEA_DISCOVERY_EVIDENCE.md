# OpenSea NFT discovery evidence boundary

Status: pre-chain implementation complete; no live OpenSea acceptance is claimed.

## Implemented flow

1. After a confirmed Sepolia `createAsset` transaction, the browser decodes the registry's `AssetCreated` event and verifies the request ID and recipient.
2. The browser reads the registry's immutable `nft()` address and combines it with the emitted token ID. The registry address is never misrepresented as the ERC-721 collection address.
3. A currently authorized administrator may request `POST /v1/rwa/discovery-checks` through the server-only operator gateway.
4. The API first calls OpenSea's supported-chains endpoint. It performs the NFT lookup only when OpenSea reports the requested chain as supported.
5. The API records exactly one of `discovered`, `not-found`, or `unsupported-chain`, plus the observation time, upstream HTTP status, and SHA-256 digest of the upstream response. The OpenSea API key and raw response remain server-side.
6. An OpenSea asset link is returned only for a validated `discovered` result whose identifier matches the requested token ID.

The implementation follows the current official OpenSea V2 surfaces:

- `GET /api/v2/chains`
- `GET /api/v2/chain/{chain}/contract/{address}/nfts/{identifier}`

## Fail-closed statements

- An upstream timeout, malformed payload, oversized payload, non-200/non-404 response, mismatched token identifier, missing API key, missing database, or failed evidence write returns an error and creates no acceptance claim.
- `not-found` is time-bounded negative evidence, not proof that the token can never be indexed.
- `unsupported-chain` records OpenSea's observed capability boundary; it is not replaced by explorer or local ERC-721 evidence.
- The mock-server tests prove request validation and result classification only. They are not live Sepolia/OpenSea evidence.
- NFT discovery is not a listing. Listing creation remains a distinct wallet approval and typed-signature action that requires fresh collection, token, quantity, price, currency, duration, fee, rights, and compliance confirmation.
- Discovery never requires publishing an artwork preview or an unwatermarked master image.

Live evidence may be marked passed only after the stored check identifies the real deployed collection and token and the returned OpenSea page is independently reviewed.
