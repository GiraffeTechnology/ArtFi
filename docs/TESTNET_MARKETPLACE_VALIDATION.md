# Sepolia and OpenSea validation strategy

This strategy produces test evidence only. Mainnet, real assets, real value, ArtFi order execution,
and exchange operation remain disabled.

## Current execution status

The initial live Sepolia run was deferred, then rescheduled by product-owner direction for after
all pre-chain deployment gates. Two test-only wallets have received faucet ETH, but no contract has
been broadcast, no token has been minted, and no OpenSea discovery or listing claim has been made.
Local contract, API, migration, UI, and adapter tests remain valid development evidence, but they
do not substitute for either live evidence track below.

Named public test roles:

- `ArtFi1`: `0x75F6e1BAc9bF07a54FECc416ef76327BbD2c3089` — initial mint and holding wallet.
- `ArtFi2`: `0xDE3c1D455c2CCe1bAcf1e70aAC7fA3B8cCb1ec2B` — asset-transfer receiving wallet.

No private key or local key-file path is part of this evidence record.

The deployment, standards-probe, mint, and marketplace-validation tooling stays available for a
future evidence run. Execution requires a funded test-only signer, the approved Singapore egress,
chain ID `11155111`, immutable test metadata with documented artwork rights, and a recorded
go/no-go for the live run.

## Track A - Ethereum deployability and standards

1. Pin the exact release commit, Solidity compiler, optimizer settings, chain ID `11155111`, role
   addresses, RPC endpoint, and funded test-only deployer. Record only the deployer address and
   balance; never record its private key.
2. Build from a clean checkout, record bytecode hashes and EIP-170/EIP-3860 margins, then deploy
   `ArtFiRWA`, `RWARegistry`, `VaultFactory`, and approved governance components. Do not deploy
   `ArtFiMarket`.
3. Wait for confirmations and record transaction hashes, receipts, contract addresses, block
   numbers, gas usage, runtime bytecode hashes, and explorer source-verification URLs.
4. Verify ERC-165 interface discovery, ERC-721 metadata and transfer behavior, ERC-20 metadata,
   EIP-2612 permit, ERC20Votes checkpoints, AccessControl roles, pause boundaries, Timelock roles,
   vault custody, fractional supply, replay protection, and unauthorized-call rejection.
5. Reconcile every emitted event through the API indexer and prove restart, replay, removal, and
   portfolio projection behavior against Sepolia receipts.

Acceptance requires deployed runtime hashes to equal locally built runtime hashes, all standard
interface probes to pass, no unexpected privileged role, and a complete rollback/role-rotation
record.

## Track B - OpenSea asset discovery

1. Upload a test-only image and ERC-721 metadata using HTTPS/IPFS-compatible immutable URLs. Include
   name, description, image, external URL, attributes, and a clear `TESTNET / NO REAL ASSET` marker.
2. Mint one token from the verified Sepolia `ArtFiRWA` contract to the approved test wallet and
   record its mint receipt and `tokenURI` response.
3. Confirm the token and collection are discoverable through OpenSea's supported testnet surface or
   NFT API. Record the canonical external URL/API response, metadata image result, ownership, chain,
   contract address, token ID, and observation time.
4. Change nothing mutable solely to force success. If OpenSea does not currently index Sepolia,
   record the external limitation and validate standards through the explorer plus an independent
   ERC-721 client; do not claim OpenSea acceptance.
5. For marketplace mirroring, run REST backfill first, then Stream subscriptions. Inject duplicates
   and out-of-order versions, interrupt the socket, reconnect, backfill the gap, and verify the ArtFi
   activity API converges while every action remains an attributed deep link to OpenSea.

OpenSea's current Stream SDK is mainnet-only. Therefore the Sepolia NFT discovery proof and the
real-time marketplace mirror proof are distinct evidence tracks: Sepolia validates the deployed
ERC-721 and metadata, while the mirror consumes read-only events for an explicitly allowlisted
mainnet collection. Neither track creates or fulfils an order through ArtFi.

## Reserved adapter interface

`MarketplaceAdapter` and normalized event schema version `1` are the compatibility boundary for
future approved sources. A new adapter must implement backfill and real-time lifecycle methods,
preserve the original source payload, emit a source-scoped monotonic version, and declare all
execution capabilities as unavailable. Enabling it additionally requires an API source allowlist
change, release-manifest approval, contract tests, replay/out-of-order tests, attribution review,
and a new evidence run. A schema-breaking change uses a new schema version and dual-read migration;
it never silently changes version `1` semantics.

## Evidence and go/no-go

- Evidence: release commit, UTC timestamps, redacted environment inventory, addresses, hashes,
  receipts, explorer/OpenSea URLs or API responses, interface probe output, mirror latency p50/p95,
  reconnect gap result, and signed test owner.
- Fail closed: missing credentials, unsupported chain, bytecode mismatch, incomplete source
  verification, stale metadata, mirror source outside the allowlist, or any ArtFi execution path.
- ArtFi exchange launch remains a separate future decision requiring completed compliance strategy,
  legal approval, independent audit, market surveillance, sanctions/transaction monitoring, and a
  written multi-party go/no-go.
