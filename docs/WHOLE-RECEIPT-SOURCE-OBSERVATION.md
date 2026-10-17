# Bound whole-artwork receipt source observations

The optional Oracle application receipt API returns one source snapshot containing
token identity, chain/contract/register/source-authority identity, block number/hash,
the register entry, immutable mint policy commitment, five-word receipt binding,
and an availability flag. This initial ArtFi consumer reads its exact historical
version and compares the complete response against an independently frozen
application expectation.

Use `readWholeReceiptSourceVersion(expected, signal?)` only in the trusted
server composition. It reuses `ARTFI_ORACLE_READ_API_URL`, including an existing
bridge prefix, and calls only:

```text
GET v1/oracle/projection/{tokenId}/receipt/version/{version}
```

No endpoint, headers, cookies, body, credentials or source identity supplied by a
browser are forwarded. Version must be an exact decimal uint64 string of at least
two. Token/block/time values remain decimal strings, including values above the
JavaScript safe-integer limit. There is no fallback to current or legacy APIs.

## Complete expected binding

The caller must supply the authenticated immutable native plan plus approved
source/deployment and mint-policy context, reduced to this exact object:

- `tokenId`.
- `source`: chainId, contract, registerId, sourceAuthority.
- `mintPolicyHash`.
- `entry`: recordCommitment, previousCommitment, registryReference, holder,
  version, effectiveAt.
- `receiptBinding`: schemaId, mintPolicyHash, segmentDigest, requestHash,
  receiptDocumentHash.

The schema is the existing Oracle extension's
`keccak256("oracle.receipt-binding.v1")`. The consumer introduces no replacement
policy, document, segment, authorization or journal digest algorithm. All five
commitments must be present and nonzero, and the tuple's policy hash must match
the immutable mint commitment. It compares every source domain field, immutable
entry field and tuple member. It never derives these expectations from the
response it is checking, catalogue text or caller-selected browser data.

Expectations and results are independent, deeply frozen bounded JSON snapshots.
Accessor properties, non-plain objects, missing/extra fields, noncanonical or
out-of-range integers and invalid addresses/hashes are refused. A fully zero
binding with receiptAvailable=false means unavailable. A partial tuple or an
inconsistent availability flag is malformed. Legacy policy absence and initial
mint entries cannot satisfy this registration-receipt requirement.

A later register entry may close a historical entry's supersededAt interval.
The consumer preserves that observed interval and original effectiveAt rather
than requiring history to remain current or changing an old deadline. Invalid
intervals are refused; holder, version and all original commitments must still
match. Block identity is retained so the native journal and independent chain
verifier can reconcile the exact observation.

## Transport and authority limits

Requests are GET-only/no-store, omit credentials and reject redirects. Remote
HTTP, URL credentials, query strings and fragments are refused; existing
non-production loopback HTTP remains available for isolated testing. A four-second
deadline covers headers and streamed data. Response type, fatal UTF-8 decoding
and a 64 KiB byte limit are checked. Cancellation covers in-flight streams.
Failure returns only a fixed error code; upstream diagnostics and private
source information are not copied into application error messages. No retry,
alternate endpoint or fallback proof is created.

A matching result is an `oracle-receipt-source-observation`. Its authorization,
finality and originalDocumentVerification values are all NOT_ESTABLISHED.
The Oracle API promises a canonical snapshot at its observed block, but this
client does not independently prove that claim from HTTP. Canonical chain
rechecks, transaction/event evidence, required confirmations/finality, original
institution document/profile verification, admitted native journal/CAS state,
policy deadlines and the real Wallet held authorization remain independent
requirements before an action. Never convert this read into payment authority,
a valid grant or a second source receipt.

The source's production original-document verifier/profile must be supplied and
accepted by its owner. A synthetic format fixture is not an approved institution
parser. This client does not manufacture one. It does not expose a browser route,
enable execution, change a deployment, issue a transaction or alter previously
submitted consumer, journal or Wallet source. Connection of this new read to the
installed authenticated native workflow remains owner integration work.

## Independent validation

The 29 authored Vitest cases cover complete identity/commitment comparisons,
legacy/partial bindings, full-width integers, historical closure, getter and
mutation isolation, the exact upstream route, transport privacy, malformed and
oversized data, cancellation and stream deadlines. They use synthetic responses
only. The initial author has not executed tests, a compiler or live Oracle calls.

Run the affected source test independently with the existing web workspace:

```sh
pnpm --filter @giraffetechnology/artfi-web exec vitest run src/lib/whole-receipt-source-observation.test.ts
```

Source formatting and byte readback are separate from test, runtime integration
and full-product acceptance. Submitted changes and ordinary validation belong
to their assigned independent owner.
