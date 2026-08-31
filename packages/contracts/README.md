# ArtFi contracts

Stage 2 and Stage 3 provide the deliberately narrow Sepolia write paths:

- `ArtFiRWA`: immutable-metadata ERC-721 with explicit minter/admin/pauser roles.
- `RWARegistry`: validates content-addressed metadata, enforces request idempotency, records
  the immutable commitment, and atomically mints the NFT.
- `ArtFiCharityEditions`: an ERC-1155 charity-edition boundary that creates exactly 100 units per
  artwork in one transaction, exposes no additional mint or burn path, and hash-records the
  reconciled sellout and later CCHS physical-donation acceptance.
- `DeployStage2.s.sol`: Sepolia-only role-handoff script that leaves no deployer mint role.
- `DeployCharityEditions.s.sol`: separately gated, opt-in Sepolia deployment for the fixed charity
  editions; it assigns only the final admin, series-creator, donation-recorder, and pauser roles.
- `ArtFiVault`: single-asset ERC-721 custody with pause controls and recovery disabled after
  fractionalization.
- `FractionalToken`: immutable fixed-supply ERC-20 with explicit admin and pauser roles.
- `VaultFactory`: atomic custody and token issuance with request idempotency and one-vault-per-NFT
  enforcement.
- `DeployStage3.s.sol`: Sepolia-only vault-factory deployment and role-handoff script.
- `ArtFiMarket`: future exchange candidate retained for security regression only; it is excluded from
  current deployment and release paths until the compliance launch gate is approved.
- `ArtFiGovernor`: one-Vault RWA governance with historical vote snapshots, a fixed 10% proposal
  threshold, selector-bound proposal classes, and mandatory Timelock execution.
- `ArtFiDAOActions`: evidence-gated, Timelock-only action registry for market migration, physical
  assistance requests, shared failure-cost records, and independently verified buyout terms.
- `ArtFiGovernanceBootstrap`: atomic RWA binding and role configuration that leaves the Timelock
  self-administered and gives ArtCCH no voting override.
- `DeployStage4.s.sol`: Sepolia-only RWA governance deployment. It does not deploy `ArtFiMarket`.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @giraffetechnology/artfi-contracts format:check
pnpm --filter @giraffetechnology/artfi-contracts build
pnpm --filter @giraffetechnology/artfi-contracts test
forge test --match-path test/RWARegistry.t.sol --gas-report
forge test --match-path test/VaultFlow.t.sol --gas-report
forge test --match-path test/MarketGovernance.t.sol --gas-report
```

The tests cover authorization, pause/recovery, metadata constraints, idempotency conflicts,
custody, fixed fractional supply, fixed 100-unit charity editions, sellout-before-donation ordering,
one-vault-per-NFT, snapshot rights validation, exact governance thresholds, proposal-class
anti-downgrade, buyout evidence failure, fuzzed commitments, and registry/vault/edition supply
invariants.

## Deployment gate

The deployment script refuses every chain except Sepolia (`11155111`). It accepts only public
role addresses from environment variables; the signing method is provided separately to Forge
(hardware wallet, keystore, or approved CI signer). Never put a raw key in this repository or
an `.env` file.

After a reviewed deployment, copy `deployments/sepolia.example.json`, fill every evidence field,
verify source and constructor arguments, and commit the manifest in a separate deployment PR.
No inherited address is authoritative without matching source, transaction, roles, and bytecode.

### Hoodi consolidated administration safe

The separate Hoodi path uses chain ID `560048` and does not alter the historical Sepolia release
manifest or verifier. Run `DeployAdminSafe.s.sol` first, then pin its public address and runtime
code hash before running Stage 2, Stage 3, or the optional charity stage. All final admin, pauser,
registrar, creator, and donation-recorder roles are held by that one validated safe. The RWA NFT
minter is held only by the Registry, and the Stage 2 bootstrap deployer retains no privileged role.

`release/hoodi-admin-safe-deployment.schema.json` and
`scripts/release/verify-hoodi-admin-safe-deployment.mjs` require every stage to bind the same
chain/address/code-hash identity. Future `VaultFactory.createVault` child-vault role arguments remain
a separately controlled action and must also bind the validated safe. This milestone does not claim
that the safe is an ERC-721 or ERC-1155 treasury receiver.
