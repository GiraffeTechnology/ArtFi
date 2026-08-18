# ArtFi

ArtFi is GiraffeTechnology's RWA and digital art platform for minting real-world assets as NFTs, placing them into vaults, fractionalizing ownership, and governing assets through DAOs.

This repository is the single source of truth for the rebuilt ArtFi platform.

## Current status

- Delivery phase: **Stage 1 - Read-only product and wallet connection**
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
  api-client/   OpenAPI-generated types and fetch client
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
pnpm api:generate
pnpm dev
```

The web app runs at `http://localhost:3000`. Start the read-only API in a second terminal:

```bash
cd apps/api
go run ./cmd/server
```

The health endpoint is `http://localhost:8080/healthz`; the OpenAPI contract is at `apps/api/openapi/openapi.yaml`.

## Quality gates

```bash
pnpm peers check
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
(cd apps/api && go vet ./... && go test -race ./...)
docker compose config
```

## Delivery plan

See [the staged roadmap](docs/ROADMAP.md), [PRD traceability](docs/PRD_TRACEABILITY.md), [Stage 1 acceptance evidence](docs/STAGE_1_ACCEPTANCE.md), and [architecture](docs/ARCHITECTURE.md).
