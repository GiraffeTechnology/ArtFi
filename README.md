# ArtFi

ArtFi is GiraffeTechnology's RWA and digital art platform for minting real-world assets as NFTs, placing them into vaults, fractionalizing ownership, and governing assets through DAOs.

This repository is the single source of truth for the rebuilt ArtFi platform.

## Current status

- Delivery phase: **Stage 0 - Foundation**
- Allowed chain: **Sepolia only**
- Mainnet and real-money operation: **not approved**
- PRD: converted into staged, testable requirements

## Workspace

```text
apps/
  web/          Next.js user application
  api/          Go API
packages/
  contracts/    Solidity contracts and deployment tooling
  ui/           Shared UI package (Stage 1)
docs/           Product, architecture, security, and operations
```

## Quick start

Prerequisites:

- Node.js 24 LTS
- pnpm 11.22.0
- Go 1.26.x
- Docker with Compose

```bash
cp .env.example .env
docker compose up -d mysql redis
pnpm install
pnpm dev
```

The web app runs at `http://localhost:3000`. The API health endpoint runs at `http://localhost:8080/healthz`.

## Delivery plan

See [the staged roadmap](docs/ROADMAP.md), [PRD traceability](docs/PRD_TRACEABILITY.md), and [architecture](docs/ARCHITECTURE.md).
