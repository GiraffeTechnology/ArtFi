# Canonical Oracle receipt source recheck

This stage adds a read-only ArtFi verifier for the existing optional receipt
surface in [Oracle PR48](https://github.com/GiraffeTechnology/Oracle/pull/48),
pinned to source `b9c1b410a35fa017622c1971d714bb35defd57f1`,
tree `791be10df8551261f5a03ad4e139e83eafc59d71`. The exact
[contract](https://github.com/GiraffeTechnology/Oracle/blob/b9c1b410a35fa017622c1971d714bb35defd57f1/erc-8415/contracts/OracleRegisterProjection.sol)
and [extension contract](https://github.com/GiraffeTechnology/Oracle/blob/b9c1b410a35fa017622c1971d714bb35defd57f1/docs/RECEIPT_BINDING_EXTENSION.md)
define the getters and five-word tuple used here. The extension is
implementation-specific and does not add requirements to ERC-8415.

PR48 explicitly leaves HTTP exposure to a separate integration step. The
published Oracle main/PR49 application service has no receipt-version HTTP
route. A successful source-observation fixture therefore does not prove that
such a route is installed or available.

## Installation and input

A trusted installer supplies the existing approved provider request function,
the approved chain (Hoodi 560048 or isolated 31337), exact Oracle projection
contract and independently approved runtime code hash. The verifier creates no
provider, endpoint, credentials, deployment or environment fallback. These
parameters cannot come from a browser or from the HTTP snapshot being checked.

Call `createWholeReceiptChainVerifier(options).verify(expected, snapshot, signal?)`
with the independently authenticated immutable expectation and the source
snapshot. It first uses the existing strict bounded observation model and
compares the source to the installed chain/contract. It captures both inputs
before awaiting anything. It does not derive application segment or document
commitments from similarly named fields.

The Oracle projection is the contract read here. ArtFi does not ingest an
institution document or call a request-selected Kit endpoint. Original source
admission and institutional/profile verification remain Oracle responsibilities.
An approved projection code pin does not supply a missing institutional parser.

## Exact canonical reads

The verifier performs only `eth_chainId`, `eth_getBlockByNumber`,
`eth_getCode` and `eth_call`. No sender or transaction method is exposed.

1. Check the installed chain and the snapshot's exact block number/hash.
2. Pin code and every contract call to that block hash using EIP-1898
   `{blockHash, requireCanonical: true}`. Refuse missing/changed code and an
   unsupported block-reference mechanism; never substitute `latest`.
3. Read `registerId`, `sourceAuthority`, `mintPolicyHash(tokenId)`,
   `entryAt(tokenId, version)`, `receiptBinding(tokenId, version)` and
   `isFinalAsOf(tokenId, entry.effectiveAt)` using the exact source ABI.
   Decode and re-encode return values to refuse appended/noncanonical bytes.
4. Compare the complete source identity, immutable mint commitment, versioned
   entry and all five receipt words to the independent expectation. Also match
   the source snapshot's historical `supersededAt` interval exactly.
5. Read the provider's finalized block and recheck its canonical number/hash,
   the observation anchor and chain identity. A changed anchor, chain or
   contradictory finalized identity refuses the read, without retry.

A whole-read eight-second deadline and caller cancellation bound observation.
The existing provider may have an outstanding read after cancellation; its
late result cannot trigger another read or become a successful result.
Only fixed refusal codes escape; upstream diagnostics are not returned.

## Evidence and authority

The successful result is a deeply frozen `canonical-oracle-receipt-source`.
It retains the checked snapshot, code hash, finalized block, and two distinct
facts:

- `chainFinality` is `FINALIZED` or `NOT_FINALIZED`, according to the
  checked provider's finalized block relative to the observation anchor.
- `projectionFinalAsOf` is the actual projection boolean at the requested
  entry's original effective instant. It may legitimately be false for a
  current entry, independently of blockchain finality.

This is an observation through an approved provider, not an independently
verified Ethereum state proof or a guarantee against a later reorg. Do not
cache it as permanent truth. Applicable freshness, native journal/CAS,
per-operation grant, nonce, reservation, registration deadline and recovery
checks remain part of the installed action.

`authorization` and `originalDocumentVerification` remain
`NOT_ESTABLISHED`. No ERC-721 owner is substituted for the registered holder.
No fresh payment, receipt admission, wallet reservation release or registration
rollback is performed. Chain/source content matching alone cannot release
funds. The Go receipt consumer remains closed until its real authoritative
business/source/asset/segment/journal composition is installed and accepted.

## Validation scope

The authored synthetic RPC tests cover complete ABI/block binding, each
register-entry field, source/tuple/code mismatches, temporal versus blockchain
finality, closed history, legacy absence, EIP-1898 refusal, reorg/chain drift,
ABI padding, mutation/accessor isolation, installation capture, fixed errors,
timeout and cancellation. They are not executed Linux, genuine Oracle
deployment, institution verification or live-chain acceptance.

Ordinary QA must run formatting, TypeScript and the affected chain-verifier and
source-observation Vitest suites on the exact published source. Publication and
full-byte readback are separate evidence from those results.
