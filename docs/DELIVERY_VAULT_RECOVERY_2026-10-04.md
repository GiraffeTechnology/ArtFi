# Vault recovery correction — 2026-10-04

## Requirement and change

PRD section 4.2 prohibits an administrative path that redirects customer property.
The pre-fractionalization `ArtFiVault.emergencyRecover(address)` path previously
accepted any nonzero recipient selected by the vault administrator. It now accepts
only the recorded `originalOwner`.

The method ABI, administrator and pause checks, original-owner recovery, and the
post-fractionalization recovery prohibition remain intact. Existing deployed
contracts are not changed by this source correction; any later deployment must
use its actual reviewed bytecode and authorized process.

## Local verification

Base source: `5946534296fa371eb2a4c502c91fbeb78d4ea32d`.
The regression uses separate administrator and depositor actors, attempts both
administrator and third-party recipients, and checks unchanged ownership and
vault state after each rejection. It then proves owner recovery still works.

- `testAdministrativeRecoveryCannotRedirectToAdminOrThirdParty` fails against the
  original contract with `admin redirected a user's deposited NFT`.
- The same regression passes with the correction.
- `VaultFlowTest`: 13 tests passed, including 512 fuzz cases and the 256-run,
  64-depth custody invariant.
- Full Foundry suite and formatting check passed with Foundry 1.8.4 / Solidity
  0.8.30. Existing high-severity lint warnings in the administrative Safe and
  signed market helpers remain visible; the lint command exits successfully.
- Exact-head GitHub CI is a separate merge requirement. No deployment, live
  wallet signature, asset transfer, or production remediation was performed.

This bounded correction does not assert full PRD completion.
