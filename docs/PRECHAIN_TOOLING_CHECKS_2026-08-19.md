# Pre-chain tooling checks — 2026-08-19

Recorded at `2026-08-19T08:59:05Z` for deployment-tooling commit `fd9f6cf`.

## Decision

The Sepolia deployment package is ready for a funded live preflight. No transaction was broadcast,
no contract address was reserved, and no dry-run address is release evidence. ArtFiMarket remains
disabled and is not part of the deployment package. Governance deployment remains off by default.

## Test conditions and limits

- The checked chain was Sepolia `11155111` (`0xaa36a7`).
- Keystore decryption and signer-address matching passed using Foundry
  `--password-file`; no signing material is part of this published record.
- Admin, registrar, pauser and vault-creator roles all used the same test-only
  signer. This concentration was not approved for production or mainnet.
- The signer had zero balance, so the live preflight failed closed at the balance
  gate. No broadcast was performed.

## No-broadcast simulations

| Script         |    Chain | Estimated gas | Observed gas price | Estimated Sepolia ETH |
| -------------- | -------: | ------------: | -----------------: | --------------------: |
| `DeployStage2` | 11155111 |     3,689,495 |   2.000480322 gwei |   0.00738076214561739 |
| `DeployStage3` | 11155111 |     5,915,945 |   2.239876664 gwei |   0.01325098715100748 |

The combined observed estimate was approximately `0.02063174929662487` Sepolia ETH. This is not a
funding guarantee: the funded balance must also cover gas-price movement, the test NFT mint,
standards probes that require transactions, and any approved OpenSea testnet operation.

Both Forge runs ended with `SIMULATION COMPLETE` and were executed without `--broadcast`.

## Contract evidence

- `forge fmt --check`: passed.
- `forge build --sizes`: passed; all deployable runtime and initcode sizes are below EIP limits.
  The narrowest relevant runtime margin is `4,126` bytes for `VaultFactory`.
- `forge test -vv`: 26 passed, 0 failed, 0 skipped.
- Invariants: two suites at 256 runs and 16,384 calls each, with zero reverts.
- Fuzz: 513 commitment runs and 512 fixed-supply runs passed.
- Deployment-tooling regression check: passed.
- Repository secret-pattern scan: passed across 151 files.
- Sepolia shell syntax checks: passed for preflight, deployment, and standards-probe scripts.

## Live gates still required

1. Fund the test-only signer and rerun `scripts/test/sepolia-preflight.sh` through the configured public-chain
   bridge. The chain ID, signer, roles, and positive balance must all pass in the same run.
2. Obtain a real artwork that has explicit NFT minting, metadata publication, and marketplace
   listing authorization. Record the rights owner, scope, territory, duration, attribution, and
   content hashes without publishing private agreements.
3. Publish immutable, publicly retrievable test metadata and media with a clear
   `TESTNET / NO REAL-WORLD TITLE TRANSFER` notice.
4. Broadcast Stage 2 and Stage 3 only from the recorded commit, then compare deployed runtime
   hashes with the local build and run `sepolia-standards-probe.sh`.
5. Mint one authorized test NFT, verify ownership and metadata, and confirm OpenSea testnet
   discovery. Before creating a listing, separately confirm collection, token ID, price, currency,
   duration, royalties, and wallet signature.

Until those gates are complete, live deployment, minting, OpenSea discovery, and listing remain
unpassed and must not be described as delivered runtime evidence.
