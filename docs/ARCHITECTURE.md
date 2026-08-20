# Architecture

## System boundaries

```text
Browser
  -> Next.js web application
      -> Go API
          -> MySQL
          -> Redis
          -> R2-compatible object storage
      -> EIP-1193 wallet provider
          -> Sepolia / approved RPC
              -> ArtFi contracts
```

The browser wallet extension described by the PRD is a separate Stage 5 product. The core DApp integrates standard external wallets first and must not take custody of seed phrases or private keys.

## Monorepo boundaries

- `apps/web`: user interface, wallet connection, transaction review, and API client.
- `apps/api`: public API, authentication, asset records, transaction reconciliation, storage orchestration, and operational endpoints.
- `packages/contracts`: Solidity source, deployment scripts, generated ABIs, and contract tests.
- `packages/ui`: shared tokens and accessible components beginning in Stage 1.

## Technology baseline

- Node.js 24 LTS
- pnpm 11
- Next.js 16 and React 19
- Go 1.26
- MySQL 8.4
- Redis 8
- Foundry and OpenZeppelin for smart contracts
- Wagmi, Viem, and RainbowKit for external wallet integration

Exact dependency versions are locked by generated lock files and updated through reviewed pull requests.

## Security boundaries

- Private keys never enter the web or API process.
- All transaction intent is displayed for wallet confirmation.
- Contract addresses are injected from versioned deployment manifests, not hardcoded into UI components.
- Production secrets come from an approved secret manager, never `.env` files in Git.
- External traffic uses HTTPS/WSS. Plain HTTP is local-development only.
- On-chain writes are Sepolia-only until the Stage 7 gate.

## Data ownership

- MySQL is the authoritative off-chain business record.
- The blockchain is authoritative for ownership, approvals, vault custody, token supply, and governance execution.
- The API reconciles chain events idempotently and retains block/transaction/log identity.
- Object storage contains immutable media/metadata objects with recorded hashes and provenance.
