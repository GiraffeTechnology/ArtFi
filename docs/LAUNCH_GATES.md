# Controlled launch gates

A release candidate is identified by one immutable Git commit, SBOM hash, test-evidence hash,
deployment addresses, verified bytecode hashes, role inventory, audit report, remediation evidence,
rollback plan, and communication plan. Any code, address, role, or bytecode change invalidates the
approval set and requires retest.

The first launch is Sepolia and contract-enforced allowlisted/capped. Participant payment caps
default to zero and cumulative usage cannot be reset by a participant. Broader or mainnet launch
requires a separate manifest and written approval from at least two accountable owners with
security, legal, compliance, custody, and operations sign-off.

The release verifier intentionally fails when audit, legal, artifact, commit, or go/no-go evidence
is missing. `--schema-only` checks template structure but never authorizes a launch.
