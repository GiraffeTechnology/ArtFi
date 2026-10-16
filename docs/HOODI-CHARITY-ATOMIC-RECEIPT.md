# Isolated Hoodi atomic charity receipt verification

This tool checks one completed, finalized Safe execution against an independently
selected Hoodi RPC route and a private expected-input manifest. It never creates
a wallet, signs, submits, retries or deploys a transaction. It does not reuse the
frozen Sepolia charity record or claim that historical individual mints were
atomic. Its batch ABI matches the separate atomic creation source increment;
installation and independent acceptance of that runtime are required first.

## Invocation

Use the existing installation and provider binding. The environment variable
name is explicit; there is no invented endpoint or deployment address default:

```sh
node scripts/release/verify-hoodi-charity-atomic-receipt.mjs \
  /controlled/path/private-expectations.json --rpc-env EXISTING_APPROVED_RPC
```

The code uses the already declared web-package ethers dependency, without
changing dependency or runtime versions. The caller supplies a separately
verified collection runtime code hash and Safe runtime code hash from actual
deployment evidence. A manifest and a provider cannot certify their own
authority. Never populate these fields from a guessed address or an unrelated
deployment. Credential-bearing RPC URLs stay in the existing environment
binding; failures deliberately omit underlying provider messages and URLs.

Manifest schema is `artfi-hoodi-charity-atomic-receipt/v1`, with exactly these
top-level fields:

- `schema`, `chainId: 560048`, `namespace: TESTNET-AI-...`.
- `testAssetMarkers`: TESTNET, NO REAL-WORLD VALUE, NO LEGAL EFFECT.
- `deployment`: collection, runtimeCodeHash, safe, safeRuntimeCodeHash.
- `execution`: transactionHash, safeTransactionId (positive decimal string),
  requestId (nonzero bytes32).
- `series`: an ordered 1–37-item list containing tokenId (positive decimal
  string), artworkId, masterArtworkHash, metadataHash, distributionWallet and
  metadataURI. IDs are contiguous. Artwork/master commitments are unique.
  URIs use HTTPS or IPFS and contain the isolated namespace as a path segment.

The test source contains artificial non-deployment examples. No real artist,
signature, donation document, valuation or holder-benefit assertion is an input
to this narrow technical verifier. It does not require those documents to test
an isolated payload.

## Bound checks

The receipt must be successful, canonical and at or below the RPC's finalized
height. The outer transaction is a zero-value execute of the exact Safe action.
At the receipt's block hash, both runtime hashes must match; the stored Safe
request must target the collection with zero value and encode precisely one
createSeriesBatch call containing every expected field. The stored threshold,
delay, confirmations, ready-at and executed state are checked against the same
block. This does not replace an independent owner/quorum deployment audit.

State reads use EIP-1898 blockHash with requireCanonical. An unsupported provider
fails; the tool does not silently fall back to latest or a different block.
Every log must bind the same transaction and block, have a unique log index and
be explicitly unremoved. For every expected series, exactly one fixed-100 mint,
URI and SeriesCreated event must match. Stored commitments, creation timestamp
and supply are independently queried at that block. The Safe execution event
must bind the exact ID list's return-data hash. Final receipt, canonical-block
and chain reads catch observed mid-check disagreement. No failed check is
automatically retried and no unknown result authorizes replay.

This deliberately narrow acceptance profile rejects additional collection
events (including recipient-driven transfers during mint callbacks). It
supports the exact direct ArtFiAdminSafe execute route; arbitrary routers,
multicall wrappers and direct non-Safe mints are outside this verifier's scope.
A narrow rejection does not prove the EVM transaction itself failed.

## Evidence limits and validation ownership

A successful output declares only atomic-charity-batch-receipt-only. It sets
wholeProductAccepted, assetGenerationVerified and metadataContentVerified to
false. AI generation, public metadata contents/labels, watermarked holder-file
privacy, deployment description labels, UI labels, marketplace, vault and DAO
acceptance remain separately required. No mainnet or real-value authorization
is introduced, and a frozen real release must never be placed in this namespace.

The independent test source registers 29 fixture cases, including 1/13/37
success scenarios and malformed, nonfinal, wrong-code, wrong-action, incomplete
event, supply, commitment, return-data, unsupported-RPC and reorg failures.
Fixtures are artificial RPC responses, not genuine Hoodi results. The initial
author has not executed these cases or any live provider query.

Independent validation command:

```sh
node --test scripts/test/hoodi-charity-atomic-receipt.test.mjs
```

Compilation/testing, real RPC execution and acceptance belong to their assigned
independent owners. Source formatting and byte readback do not establish a
passed suite, valid deployment or completed product delivery.

