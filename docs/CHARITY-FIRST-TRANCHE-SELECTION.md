# Fixed first charity tranche selection

The first tranche contains UNIT-A01, A04, A05, A11, A14, A15, A16, A17,
A20, A21, A22, A23 and A24. A16 appears once. Each work has 100 ERC-1155
units, giving 13 works and 1300 units. The retained formal index contains
37 works (A01 and A03 through A38); withdrawn A02 remains excluded.

The read-only selector accepts an explicit existing batch directory:

```sh
node scripts/release/select-ye-yongrun-first-tranche.mjs --batch-directory release/mint-batches/ye-yongrun-unit-a01-a38
```

It writes a selection JSON to stdout. It does not write package files,
generate manifests, alter either historical or future batch inputs, use a
wallet, query chain state, or sign or broadcast transactions. The directory
must already contain its original package index and package bytes.
The historical Sepolia index remains historical; selecting from it is not
an instruction to mint its token IDs again. An existing Hoodi index can be
selected explicitly with its own directory; there is no network fallback.

The selection binds the original index bytes with SHA256, checks the full
37-record membership and uniqueness, then reads exactly the selected 13
package basenames. Each selected package must match its indexed byte hash,
chain, series, 100-unit immutable supply, recipient, price, master hash and
metadata URI. Existing no-preview, token-gated watermarked-holder delivery
and pending listing-confirmation flags are checked. Output contains only
selection references, not master paths, image bytes or private rights files.

`selection-only`, `executionAuthorized: false`, and `not-evaluated` release
eligibility and chain state are unconditional. The source index's retained
`blocked-pre-mint` label is reproduced as provenance, not a current on-chain
assertion. This is a consistency selector, not a replacement for the existing
charity package and public-metadata verifiers. It does not establish master
or holder-file availability, rights evidence, CCHS approval, beneficiary
confirmation, donation, tax treatment, listing eligibility or mint status.
Release verification and action-time wallet confirmation still apply.

Authored synthetic regressions can be run independently with:

```sh
node --test scripts/release/charity-first-tranche.test.mjs
```

The synthetic fixtures contain no genuine artwork or CCHS documents and
establish no entitlement. They cover exact selection, historical network
retention, duplicate/missing/withdrawn works, source-byte tampering, supply,
recipient, filename, network, master binding and privacy failures. Initial
submission is authored source only; independent execution and acceptance
must be recorded against the exact submitted commit.
