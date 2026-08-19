# Compliance operating model

ArtFi remains testnet-only until accountable legal and compliance owners approve a jurisdiction,
asset class, investor population, custodian, payment rail, privacy schedule, and redemption model.

The engineering boundary stores pseudonymous subject/provider hashes rather than identity
documents. An approved external KYC/KYB and sanctions provider must issue short-lived assertions.
The policy engine fails closed for pending/rejected identity, sanctions uncertainty, stale/expired
evidence, unapproved jurisdiction, or missing investor eligibility.

Every real asset requires independently approved and content-hashed title, custody, insurance,
valuation methodology, redemption, dispute, and insolvency evidence. No smart contract, database
row, test, or administrator may substitute for legal title or regulatory approval.

Production duties must be separated: compliance reviewers cannot deploy code; deployers cannot
approve their own roles; custodians cannot approve valuations; support cannot alter audit records.
Exceptions require an identified owner, expiry, written rationale, compensating control, and audit
record. Retention/destruction jobs require privacy approval and evidence of completion.
