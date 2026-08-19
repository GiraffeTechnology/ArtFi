# Stage 3 acceptance evidence

Stage 3 implements the Sepolia vault and fractionalization boundary without changing the
established Stage 1 user interface. Runtime writes stay disabled until reviewed contract
addresses, MySQL, an approved signer, and a Sepolia RPC are configured.

## Delivered

- `ArtFiVault` with explicit admin, pauser, and fractionalizer roles, ERC-721 custody, pause
  controls, pre-issuance emergency recovery, and recovery lockout after fractionalization.
- `FractionalToken` with immutable fixed supply, 18 decimals, transfer pause controls, and
  documented role ownership.
- `VaultFactory` with one-vault-per-NFT enforcement, replay-safe request IDs, deterministic
  per-asset vault deployment, and emitted records for later chain reconciliation.
- Sepolia-only Stage 3 deployment script and an evidence-manifest template.
- Idempotent vault-intent and transaction-submission API endpoints with OpenAPI-generated types.
- Optional MySQL-backed runtime persistence and startup hydration for uploads, mint intents, and
  vault intents.
- MySQL 8.4 tables for vault and fractionalization records, plus a complete Stage 3 rollback.

## Verified development evidence

- Foundry: 10/10 vault-flow tests, 512 fuzz cases, and 256 invariant runs x 64 calls (16,384
  calls, zero reverts).
- Contract tests cover custody, authorization, one-vault-per-NFT, idempotency conflicts, fixed
  supply, pause behavior, and the post-issuance recovery lock.
- Go 1.26.5 API tests pass with restart hydration verified against MySQL 8.4.
- OpenAPI 3.1 contract regenerated into the TypeScript API client.
- MySQL migration sequence: Stage 1 + 2 + 3 `7` tables, Stage 3 rollback `5`, Stage 2 rollback
  `2`, and full rollback `0`.
- The existing UI is intentionally unchanged for this stage; transaction surfaces will be
  iterated during integrated debugging.

The Foundry development tool was executed from the official image pinned to
`ghcr.io/foundry-rs/foundry@sha256:043752653d5be351c71709091b3db97c4421c907eb40ea294195e7f532aadf46`
(Forge 1.5.1-stable).

## External exit gates still required

- Deploy reviewed bytecode to Sepolia through approved multisignature or hardware-backed signers.
- Verify source, constructor arguments, bytecode, transactions, and every privileged role.
- Execute and reconcile a real approve/deposit/fractionalize journey using approved test assets.
- Independently review governance parameters and privileged recovery behavior.

No mainnet, real asset, real-money, or undocumented privileged EOA is enabled by this stage.
