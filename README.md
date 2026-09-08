# ArtFi

ArtFi is GiraffeTechnology's RWA and digital art platform for minting real-world assets as NFTs, placing them into vaults, fractionalizing ownership, and governing assets through DAOs.

This repository is the single source of truth for the rebuilt ArtFi platform.

## Current status

- Delivery phase: **Stage 2–7 integrated implementation**
- Allowed chain: **Sepolia only**
- Mainnet and real-money operation: **not approved**
- Live Sepolia/OpenSea evidence run: **pending after pre-chain gates; not claimed as passed**
- PRD: converted into staged, testable requirements

## Workspace

```text
apps/
  web/          Next.js user application
  api/          Go API
  wallet-extension/  Non-custodial Manifest V3 Alpha
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
- Foundry 1.5.x for contract work

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
pnpm contracts:format:check
pnpm contracts:lint
pnpm contracts:build
pnpm contracts:test
(cd apps/api && go vet ./... && go test -race ./...)
docker compose config
```

## Delivery plan

**The current baseline is three documents.** Read them before anything else, and see
[`AGENTS.md`](AGENTS.md) for how they bind:

- [**PRD**](docs/PRD.md) — what must exist and how it must behave
- [**Acceptance standard**](docs/ACCEPTANCE.md) — what proves it exists, and the G1–G4 promotion gates
- [**Status**](docs/STATUS.md) — where every requirement stands right now, item by item

Client directives override them where they conflict, newest first:
[2026-08-30 delivery](docs/DIRECTIVE_2026-08-30_DELIVERY.md) (measurement, G3 split, Hoodi test
payload) and [2026-08-24 Hoodi](docs/DIRECTIVE_2026-08-24_HOODI.md) (test chain).

### Superseded, retained as history

The documents below predate the baseline above. They record how the project got here; they are not
the acceptance target.

[the staged roadmap](docs/ROADMAP.md), [PRD traceability](docs/PRD_TRACEABILITY.md),
[Claude Code acceptance PRD](docs/PRD_CLAUDE_CODE_ACCEPTANCE.md),
[Stage 1 acceptance evidence](docs/STAGE_1_ACCEPTANCE.md),
[Stage 2 acceptance evidence](docs/STAGE_2_ACCEPTANCE.md),
[Stage 3 acceptance evidence](docs/STAGE_3_ACCEPTANCE.md),
[Stage 4 acceptance evidence](docs/STAGE_4_ACCEPTANCE.md),
[Stage 5 acceptance evidence](docs/STAGE_5_ACCEPTANCE.md),
[Stage 6 acceptance evidence](docs/STAGE_6_ACCEPTANCE.md),
[Stage 7 acceptance evidence](docs/STAGE_7_ACCEPTANCE.md),
[pre-chain deployment evidence](docs/PRECHAIN_DEPLOYMENT_EVIDENCE.md),
[UI deployment contract](docs/UI_DEPLOYMENT_CONTRACT.md),
[Sepolia mint package gate](docs/MINT_PACKAGE.md),
[Sepolia/OpenSea validation status](docs/TESTNET_MARKETPLACE_VALIDATION.md), and
[architecture](docs/ARCHITECTURE.md).

## 专利申请状态与披露边界

以下申请状态由项目负责人确认；负责人明确允许公开以下专利申请号：

| 申请名称 | 申请号 | 关联范围 |
| --- | --- | --- |
| 一种链外数据源事实的无人值守出具系统及方法 | `202611389399.6` | Oracle |
| 一种基于链下登记簿的数据凭证映射方法及系统 | `202611389374.6` | ERC 登记簿凭证映射标准 |

两项申请均已提交并取得受理通知。申请受理不等于专利授权，也不表示技术交付或生产验收完成。

本次仅披露上述申请名称、申请号及申请状态，不上传受理通知书 PDF、申请材料、个人信息、客户私域数据或其他商业信息。不得要求负责人向 AI 提供保密协议、商业尽调材料或与技术无关的信息，作为更新上述状态或推进无关技术开发、脱敏测试的前提。技术验收仍依据代码、可复核测试及授权范围内的运行证据，不代替任何人的法律或商业签署。
