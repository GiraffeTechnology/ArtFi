# Isolated Hoodi charity input preparation

This offline preparation tool consumes the private two-artwork AI input bundle
and its exact `artfi-private-isolated-ai-input/v1` manifest. It is separate from
the historical charity release verifier. It does not require a real artist's
undertaking, CCHS director declaration, donation evidence or frozen inscription
to prepare isolated technical input. It never rewrites the Sepolia record.

```sh
node scripts/release/prepare-isolated-hoodi-charity.mjs /controlled/private-input
node scripts/release/prepare-isolated-hoodi-charity.mjs /controlled/private-input \
  --bindings /controlled/existing-approved-bindings.json
```

Both invocations only read local files and print a preparation descriptor. They
do not publish, fetch remote URLs, load credentials, create a wallet, deploy,
sign or send a transaction. Use existing approved Linux/runtime/storage and
original deployment references. There is no network or endpoint default.

## Private input profile

For this atomic-batch preparation profile, accept 2–37 distinct artwork inputs,
each with 100 immutable charity-test editions. This is a per-preparation bound,
not a total collection cap or a rule for every NFT model. Namespace is
TESTNET-AI-HOODI-..., chain ID is exactly 560048, and TESTNET / NO REAL-WORLD VALUE /
NO LEGAL EFFECT are required at manifest, intended deployment description and
metadata levels. Deployment references and execution acceptance remain absent.

Each ID uses TESTNET-AI-HOODI-NNN, with only its exact source-art/ID.png and
metadata/ID.json paths. Source files are read privately, bounded to 10 MiB each;
the manifest and each metadata file are bounded to 64 KiB. Symlink paths, path
escape, nonregular files, size/hash changes and duplicate source content are
refused. PNG signature, IHDR identity and bounded dimensions are checked.
This is a header/MIME check, not complete pixel decoding or CRC verification.

Metadata is an exact isolated profile containing no image, image_data,
animation_url, external artwork URL or holder preview. It binds the source SHA,
Hoodi identity, the three markers and explicit no-real-value/no-legal-effect
properties. It accepts only the isolated AI technical description, without
positive artist, fundraising, title, donation or holder-benefit assertions.
Exact metadata bytes are retained and SHA-256 is computed from those bytes;
the tool does not silently regenerate metadata after publication.

Generation-tool/visual-inspection declarations in a manifest are attributed
input claims. This tool cannot cryptographically prove that pixels came from
AI or that all captions are visible. The actual generation events, prompts,
source files and independent visual review remain separate evidence.
Neither source-art nor a generic watermark is a per-holder derivative.

Inputs stay outside public artwork-preview routes and production/mainnet
manifests. A private file path is never converted into a public download URL.

## Existing bindings, without invented values

Bindings are optional during input preparation. If absent, the output lists the
missing existing deployment, publication, producer-ID and recipient bindings.
Status remains PREPARATION_ONLY and no call inputs are manufactured.

The optional JSON has exactly:

- schema: artfi-isolated-hoodi-bindings/v1.
- namespace matching the input manifest, chainId: 560048.
- collection, safe, runtimeCodeHash, safeRuntimeCodeHash.
- assets in input order, each with id, artworkIdBytes32, metadataURI,
  metadataSha256 and distributionWallet.

Recover these values from the original authorized executor's actual existing
records. A copied declaration is not independent runtime or publication proof.
The frozen Sepolia collection, zero addresses/hashes, duplicate artwork IDs,
wrong order and mismatched metadata SHA are refused. URIs must be HTTPS or IPFS
within the isolated namespace, end in that exact artwork's JSON filename, and
contain no credentials/query/fragment or historical release reference.

The preparation prints the existing atomic contract's SeriesInput fields:
artworkId comes from the explicitly supplied approved producer value;
masterArtworkHash and metadataHash are the real file SHA-256 commitments;
distributionWallet and metadataURI come from the exact supplied bindings.
No replacement artwork-ID, receipt, journal, policy or authorization hash
algorithm is invented. Bindings are copied before asynchronous file reads and
accessors are refused without invocation.

Even with all supplied bindings, executionEnabled and runtimeBindingsObserved
remain false, authorization remains NOT_ESTABLISHED, and full product/atomic/UI
acceptance remain false. The descriptor does not encode or broadcast a
transaction and cannot serve as a grant, Safe approval or chain receipt.
Reviewed runtime installation, exact source/chain/Safe identity, simulation,
original signing authority, unknown-outcome reconciliation, actual receipt,
canonical/finality checks and real UI behavior remain separately required.

## Independent verification and limits

There are 31 authored Node test cases for exact input and commitment preparation,
isolation/preview/claim refusals, hash/size/MIME/identity failures, path/symlink
boundaries, missing bindings, publication mismatch and mutation/accessor isolation.
The fixture PNGs are explicitly synthetic headers, not generated artwork or
decoded image tests. The real private image bundle is a separate input corpus.

```sh
node --test scripts/test/isolated-hoodi-payload.test.mjs
```

The initial author has not run these tests or this tool against a live runtime.
Independent testing of both fixtures and actual input bytes belongs to the
assigned validation owner. This stage changes no historical verifier, deployed
contract, service configuration, credentials, database or production manifest.
Final accepted artifacts require the existing project Giraffe archival process
and complete independent byte readback before eligible source release.

