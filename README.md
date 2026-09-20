# ArtFi

ArtFi is a commercial digital art and real-world asset application platform.

This repository is the source of truth for the rebuilt ArtFi application. It is not a demo repository.

## Product Positioning

ArtFi is an application layer built on top of asset identity, registry synchronization and blockchain settlement infrastructure.

Architecture boundary:

```
User / Collector / Investor
          |
          v
       ArtFi
          |
          v
       Oracle
          |
          v
   ERC8415-Kit
          |
          v
     ERC-8415
```

ArtFi does not implement ERC-8415 infrastructure directly. It consumes application-facing capabilities provided through the Oracle integration layer.

## Product Lines

### 1. Artwork Asset Market

ArtFi supports physical artwork digital representation and trading workflows.

Current asset models include:

### Full Artwork Asset Receipt

One artwork corresponds to one asset representation:

```
Artwork
   |
Custody / Registry Record
   |
ERC-8415 asset representation
   |
Market workflow
```

The asset model preserves the distinction between:

- blockchain tradeable position;
- registry-confirmed asset state.

### Artwork Investment Product

ArtFi also supports asset-specific investment structures:

```
Artwork
   |
Single-asset investment product
   |
Fund participation
   |
Governance rules
```

Governance rights depend on the defined asset model and are not derived from token possession alone.

## 2. DAO Governance

Governance follows the underlying asset structure.

For investment products:

- participation rights follow defined governance rules;
- voting rights are asset-model dependent.

ArtFi does not assume every token represents identical governance authority.

## 3. Charity NFT Editions

Charity NFT editions are an independent product line for cultural and philanthropic fundraising.

They are not required to follow the ERC-8415 asset model.

## Current Implementation Status (2026-09-20)

The repository has moved beyond a prototype, but production release has not been completed.

Current implementation includes:

### Smart Contracts

- artwork market contracts;
- fractional asset components;
- revenue distribution components;
- DAO governance contracts;
- charity NFT related contracts.

### Backend

- API service structure;
- asset workflows;
- external market integration framework;
- OpenAPI definitions;
- runtime validation boundaries.

### Frontend

- Next.js application;
- responsive user interface framework;
- multi-language support framework;
- wallet/application interaction layer.

### Verification and Testing

Implemented:

- contract unit tests;
- fuzz/invariant tests;
- API tests;
- frontend contract tests;
- browser contract tests.

However:

- no production chain deployment is approved;
- no real-money operation is approved;
- runtime chain evidence must be collected before production acceptance.

## Delivery Status

Current status:

```
Implementation:
      Advanced

Runtime verification:
      In progress

Production acceptance:
      Not completed
```

The repository uses evidence-based delivery:

```
Code
  |
Tests
  |
Runtime Environment
  |
User Visible Workflow
  |
Acceptance Evidence
```

Code completion alone does not equal production delivery.

## Repository Structure

```
apps/
  web/                 Next.js application
  api/                 API service
  wallet-extension/    Wallet extension alpha

packages/
  contracts/           Solidity contracts
  api-client/          Generated API client

docs/                  Product, architecture and delivery documents
```

## Development

Requirements:

- Node.js 24 LTS
- pnpm
- Go
- Docker
- Foundry

Example:

```bash
pnpm install
pnpm dev
```

## Quality Gates

The full verification process includes:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm contracts:test
```

## Documents

Primary documents:

- `docs/PRD.md` — product requirements;
- `docs/ACCEPTANCE.md` — acceptance criteria;
- `docs/STATUS.md` — requirement-by-requirement evidence status;
- `AGENTS.md` — engineering execution rules.

Historical documents remain for traceability but are not the acceptance target unless referenced by the current baseline documents.

## Scope Boundary

ArtFi is:

- a commercial application;
- an asset marketplace and user experience layer;
- a vertical application consuming infrastructure services.

ArtFi is not:

- ERC-8415 protocol implementation;
- Oracle infrastructure;
- legal title adjudication system;
- custody replacement system.

## Patent Disclosure Boundary

The following application status may be publicly disclosed:

| Application | Number | Scope |
| --- | --- | --- |
| 一种链外数据源事实的无人值守出具系统及方法 | `202611389399.6` | Oracle |
| 一种基于链下登记簿的数据凭证映射方法及系统 | `202611389374.6` | ERC registry credential mapping |

Patent filing does not mean grant, production acceptance or commercial deployment.
