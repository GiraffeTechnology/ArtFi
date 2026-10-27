# Whole-receipt Oracle attestation boundary

## Source-bound reuse

Reviewed Oracle commit: `a502450a22eeeece8cea9cf1843486720b54d09d`.
Tree: `68f33620d9d5464bdec50bc947a28c38d088e1a0`.

- `src/domain/attestation-service.js`: existing `giraffe-attestation.v1`
  envelope, canonical hash, signature, validity and revocation verification.
- `src/sdk/verifier.js`: all five expected subject fields are required.
- `src/app.js`: existing attestation GET and verification POST routes.
- `src/services/oracle-control-plane.js`: controlled source/fact mappings.
- `src/domain/settlement-coordinator.js`: settlement finalization, not issuance
  of a contract-consumable payment authorization.

ArtFi's `readWholeReceiptOracleAttestation` uses the existing configured Oracle
read service. Its fixed installation policy binds attestation ID, purpose, signer
set, source authority, full canonical source-record hash and exact fact/value.
The asset ID and chain/contract/token identity come from the authenticated journal
and are checked against signed segment preimages before calling Oracle. Neither
browser-selected policy nor a certificate locator/hash substitutes for the
canonical source-record hash. Only the already-public envelope and subject are
posted for verification; private participants, grants and execution references
are not sent. Reads and verification are bounded, with redirects refused.

The verified observation always returns `sourceAuthenticatedForPayment: false`
and `registrationAuthorized: false`. It never writes journal state, sends a
transaction, issues an attestation or enables a production route.

## Remaining precise integration boundary

Controlled issuance maps six scalar facts, but also checks and signs the full
canonical source-record hash. In the reviewed Oracle commit,
`OracleControlPlane.issueAttestation()` checks source provenance and recomputes
`evidenceHash(sourceRecord)` before issuance; `AttestationService.issue()` includes
that hash in the signed envelope. Scalar vocabulary alone therefore does not
prove that exact-segment binding is impossible or require a new payment signature.

ArtFi already recomputes the private-participant settlement snapshot and binds
journal preimages to the signed trade. The remaining lookup is the reviewed
mechanism connecting the authenticated full record to that exact segment and
the deployed verifier's expected authority and replay domain. Generic envelope
verification alone does not establish this end-to-end connection. No reviewed
implementation/deployment has yet been bound to `verifyRegistration` here.

The remaining input is the existing deployment's reviewed contract-verifier
reference and semantic policy connecting those authenticated records to the exact
signed segment, plus its isolated asset/journal/source record binding. Do not
invent a new signer, signature format, trusted party or authorization from a
public projection. The synthetic test-only Oracle is not a deployment candidate.

## Evidence limitations

The three focused Web suites have 88 passing cases on isolated Linux, including
subject/source drift, expiry, revoked responses, verifier rejection, malformed
responses and private-journal mismatch. Their transport responses are fixtures:
they test strict consumption, not actual cryptographic verification or real
Oracle connectivity. Full source-bound Web regression is recorded separately.
No previous contract/local-EVM result is relabeled as real Oracle acceptance.
