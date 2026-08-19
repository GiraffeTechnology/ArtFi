# Stage 6 acceptance evidence

Stage 6 supplies engineering controls for security, compliance, privacy, and recovery. It cannot
provide the independent legal approvals or third-party data required for real-world operation.

## Delivered

- Production-configured write routes fail closed without a constant-time checked operator bearer;
  the indexer retains a separate credential boundary.
- Pseudonymous compliance policy rejects unverified, sanctioned, stale, expired, ineligible, or
  unapproved-jurisdiction assertions.
- MySQL schemas for identity assertions, legal/custody evidence, valuations, redemption, disputes,
  security audit events, and controlled retention jobs.
- Repository secret-pattern scanner and a minimal, non-root, static API container image.
- Compliance, segregation-of-duty, incident, backup, recovery, deployment, and rollback runbooks.

## Verified development evidence

- Go tests cover default-deny operator writes and every compliance denial gate.
- Secret pattern scan passes across tracked and unignored repository files.
- Stage 1–6 MySQL forward and full rollback execution is required by the final quality workflow.

## External exit gates still required

- Legal/compliance/privacy approval for each jurisdiction, asset class, investor type, and provider.
- Approved KYC/KYB, AML/sanctions, custody, valuation, redemption, dispute, and insolvency vendors.
- Multisignature signer ceremony, rotation exercise, backup restore drill, alert test, and incident
  tabletop with accountable owners.
- Independent SAST/dependency/container/IaC/license review and closure or formal acceptance of all
  P0/P1 findings.

No external approval or operational drill is represented as complete by this document.
