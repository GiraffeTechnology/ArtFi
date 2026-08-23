# UNIT-A02 isolated Base Sepolia RWA/DAO test

Traceability: RWA-002, GOV-001, GOV-002, GOV-003, GOV-004, GOV-005, OPS-004.

UNIT-A02 is an isolated test fixture. It is not a member of the 37-artwork charity release,
must not appear in the production 20-artwork manifest, and cannot be deployed on any mainnet.
Successful testing never grants production authorization.

## On-chain test model

- `ArtFiA02TestAsset` deploys only when `chainid == 84532` and mints exactly 100 ERC-1155
  test units to ArtFi1. It has no later mint or burn function.
- An `ArtFiRWA` ERC-721 is the single custody representative deposited permanently in an
  `ArtFiVault` for this exercise. Its metadata commitment is the same isolated A02 test metadata.
- The Vault issues exactly 100 fixed `FractionalToken` governance units. One ERC-1155 test unit and
  one whole governance unit are transferred as a paired test bundle. The integration evidence must
  reconcile both balances after every transfer.
- The unchanged production `ArtFiGovernor`, `ArtFiDAOActions`, and self-administered timelock apply
  the 10% proposal threshold and strict approval thresholds: more than 50%, more than 66.6667%, and
  more than 80%.
- The test price verifier accepts only the deployed A02 Vault and the pinned synthetic evidence
  digest. It is not a market-price oracle, valuation, settlement module, or production verifier.

The NFT and custody commitments are test mappings. They do not themselves prove or transfer legal
title, do not make the NFT redeemable, and do not authorize forced settlement or automatic closeout.

## Wallet and execution boundary

- ArtFi1 is the issuer, initial holder and nonce source.
- ArtFi2 is the buyer/member used for paired ERC-1155 and governance-unit transfers, delegation,
  proposal creation, voting and receipt verification.
- Every public RPC, estimate, simulation, signed-transaction broadcast and receipt query originates
  from the approved non-sandbox Windows host through `ArtFiChainBridge/sin/v1` and SIN.
- Private keys never leave the local offline signer. Raw signed transactions never enter Git,
  stdout, CI, servers or logs.
- Additional test wallets, if generated, are Base Sepolia-only and must never receive L1 or other
  real-value assets.

## Required evidence

Before any transaction is signed, pin chain identity, contract creation bytecode, runtime hashes,
metadata and declaration SHA-256 digests, sender, recipient, nonce, fee limits and exclusive output
files in a short-lived policy. Simulate each payload before local offline signing. After broadcast,
record transaction hash, receipt block, emitted events, total supply, ArtFi1/ArtFi2 paired balances,
delegation checkpoints, proposal state transitions, threshold outcome, timelock execution and the
fact that no mainnet state changed.
