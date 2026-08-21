# Security and operations runbook

## Production data source

- Production MySQL must use the confirmed CTYun route documented in
  `docs/CTYUN_MYSQL_DEPLOYMENT_CONTRACT.md`.
- The MySQL container in `docker-compose.yml` is development/CI-only.
- Production remains configuration-gated until the CTYun schema, least-privilege principal, TLS,
  secret injection, migrations, backup, and restore evidence are approved.
- Never bypass the abcdyi loopback tunnel or commit/print the resolved `MYSQL_DSN`.

## Availability and recovery targets

- Pilot target: RPO 15 minutes for MySQL and object metadata; RTO 4 hours.
- Encrypt backups with an approved KMS key, separate production credentials from backup operators,
  and keep one immutable copy in a separate failure domain.
- Test restore into an isolated account at least quarterly. Verify row counts, foreign keys, object
  hashes, latest chain checkpoint, and application smoke tests before recording evidence.

## Incident sequence

1. Declare severity and incident commander; preserve timestamps, request IDs, chain data, and logs.
2. Contain with the narrowest control: disable API writes, pause affected contracts, revoke a
   signer, or block an origin. Do not destroy evidence.
3. Reconcile database state against finalized Sepolia receipts and mark removed/reorged events.
4. Recover from a verified artifact and tested backup; rotate affected credentials and signers.
5. Notify legal/compliance and users according to the approved jurisdiction plan.
6. Publish a blameless report with root cause, impact, timeline, remediation owners, and retest.

## Deployment and rollback

- Deploy only the reviewed commit and manifest; verify image digest, SBOM, migrations, bytecode,
  addresses, roles, and Timelock parameters.
- Database rollback must be proven before deployment. Contract rollback uses pause plus a new
  reviewed deployment; immutable contracts are never described as upgraded in place.
- Roll back application traffic first, keep indexer checkpoints, and replay idempotently after the
  cause is understood.

Mainnet, real assets, and real value require a separate written go/no-go decision.
