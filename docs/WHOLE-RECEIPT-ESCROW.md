# Whole-receipt asynchronous settlement boundary

## Product behavior

WholeReceiptEscrow extends settlement using the existing market's sale terms, allowlists, pause state and seller epoch. A seller explicitly signs the receipt-settlement authorization. Atomic-fill signatures are not interchangeable with receipt-settlement signatures.

The named buyer funds its own segment. Exact debit and credit checks reject non-exact payment behavior. The artwork moves directly from seller to buyer; the escrow does not hold the NFT.

Each segment has immutable buyer, seller, currency and amount. Registration confirmation is recorded separately from payment. A relayer cannot alter the payment recipient or amount. A failed payment preserves registered/unpaid state through transaction rollback.

Historical settlement uses its corresponding segment rather than the latest token holder. Exact confirmation replay is a no-op; changed replay is rejected. An unavailable later proof cannot undo an already settled prefix.

The registration-verifier interface requires authenticated evidence for the segment and corresponding registration record. A synthetic fixture does not establish live Oracle, registry, legal-title or production correctness.

## Private integration and checkpoint information

[REDACTED_INTERNAL_SOURCE_AND_DEPLOYMENT_REFERENCES]

[REDACTED_PRIVATE_OPERATIONAL_AND_CONTROL_INFORMATION]

[REDACTED_PRIVATE_AUDIT_AND_TEST_CHECKPOINTS]

This publication does not establish a deployment-ready workflow or end-to-end acceptance.
