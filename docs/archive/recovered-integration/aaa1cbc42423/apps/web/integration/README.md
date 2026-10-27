# Whole-receipt Oracle source-contract integration

This opt-in test is outside the default `vitest run src` unit suite. It exercises
ArtFi's reader with the actual reviewed Oracle attestation and SDK verifier source,
using ephemeral in-memory Ed25519 keys and TEST_ONLY_NO_REAL_VALUE records.
HTTP transport is intercepted; there are no live Oracle, wallet or chain calls.
The test grants no financial authority and changes no production trust policy.

Provide an isolated source directory containing these files from Oracle commit
`a502450a22eeeece8cea9cf1843486720b54d09d`, normalized to LF, with an ESM
`package.json` (`type: module`). The test checks all three SHA-256 pins before import:

- `src/domain/attestation-service.js`: `b39667861a3933dcf2310f75e916b323ba33ec3ee26a1d6e8e111a7470fea8a0`
- `src/domain/canonical-json.js`: `da46c747668371ed9585a1598b2edd4a0c5ce3ee0a4272ff85fe78cebc209d21`
- `src/sdk/verifier.js`: `e0bb76cf7bffb2baa1106ab8303be02ad321c2341552c5b4ed3e3757969ea7f6`

From `apps/web`, with the locked dependencies already installed:

```sh
ARTFI_TEST_ORACLE_SOURCE=/absolute/isolated/source pnpm exec vitest run integration/whole-receipt-oracle-contract.test.mjs
pnpm exec eslint integration/whole-receipt-oracle-contract.test.mjs
```

Missing source or a pin mismatch fails setup; no test silently skips. Keys exist
only in memory and are neither exported nor printed. The upstream source remains
a test input, not a copied production Oracle implementation.

## Observed scoped result

On 2026-10-13 at 10:40:12 UTC, existing isolated Linux Node 24.18.0 / Vitest 5.0.3
passed all six cases; Prettier and ESLint exited zero. The normalized test SHA-256
was `abcf5cd974c2cb3d32a666d0377aeeda594a2e652ce8fa85bbac5965e5adf34e`.
Application source remained parent `eb2b350af672ff22dfc4cc39c4c07eae45581c24`;
the test and boundary-document correction are an uncommitted overlay. The initial
source-file EACCES setup failure executed zero tests and remains failed diagnostic.

This closes a real-signature test gap in the reader's consumption contract. It
does not establish controlled production issuance, source truth, durable service
authentication, deployment verifier identity, financial release or full delivery.
