# Stage 7 acceptance evidence

Stage 7 produces a release-candidate control plane, not an assertion that third-party review or
mainnet approval has occurred.

## Delivered and verified

- Market participation/payment caps default to zero and are consumed on fixed orders, bids, and
  offerings; the cap-bypass negative test passes with the full market/governance suite (7/7).
- Release manifest template binds Sepolia, exact commit, deployments, bytecode, SBOM, tests,
  rollback, independent audit, legal approval, pilot cap, and separated go/no-go evidence.
- Release verifier supports non-authorizing schema checks and a full mode that fails closed on any
  missing or mismatched approval/evidence.
- Launch-gate documentation requires audit retest against the exact release commit.

## External gates still required

- Independent smart-contract, API, Web, and wallet audits plus remediation retest.
- Load, chaos, penetration, backup-restore, signer-rotation, and end-to-end pilot exercises in the
  approved environment.
- Real deployment/source/bytecode evidence, signed SBOM/provenance, legal/compliance approval, and
  written go/no-go decision.

Until those records exist, the candidate remains gated, Sepolia-only, and mainnet-disabled.
