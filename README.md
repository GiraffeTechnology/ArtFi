# ArtFi

ArtFi is a commercial digital art and real-world asset platform. It is a commercial application, not a demo.

This repository is the single source of truth for the rebuilt ArtFi platform.

**It is private.** It is on GitHub so external auditors and VC auditors can read it, not for public distribution. The deployment environment is named in one place, [`docs/DEPLOYMENT_ENVIRONMENT.md`](docs/DEPLOYMENT_ENVIRONMENT.md), so it can be removed at any time with a single deletion; everything else refers to roles and placeholders. Partner and ecosystem identities stay placeholders regardless.

## Product lines

ArtFi supports three product lines. **All trading is available both on ArtFi and on OpenSea, and ArtFi is primary.** OpenSea and other third-party venues are an early-stage state; the target is ArtFi itself as an ERC-8415-standard **artwork RWA market**. That is product direction — until the client rules otherwise, third-party venue support is built, tested and counted exactly as it is today.

| #   | Product line                | What is traded                          | Venues                               | Opens when                                                                                                |
| --- | --------------------------- | --------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 1   | ERC-8415 asset products     | One whole artwork, as a custody receipt | ArtFi + OpenSea                      | Oracle path, ERC-8415 wallet, and ArtCCH registration projected to a third-party registry chain all exist |
| 2   | Artwork investment products | Fund tokens / fractions of one artwork  | ArtFi + OpenSea                      | Exempt-market compliance is complete                                                                      |
| 3   | Charity NFT editions        | Fixed 100-unit ERC-1155 editions        | OpenSea first, then ArtFi, in stages | Staged — and delivery stays launch-ready throughout                                                       |

**For a registry-backed asset the registry of record is the holder authority**, and the on-chain token is its projection. Registries of record are a class, not a company: ArtCCH's registry is part of its own-account business and has the same nature as a third-party registry chain. It records the artwork's physical parameters, the holder, and provenance. The authority belongs to the registrar role, so **ArtFi treats ArtCCH as a third party** — no seller allowlist, no admin path that can move its holdings, matching blind to seller identity. **ArtFi is a consumer of registries and operates none of them**, and its own stores are authoritative for nothing.

**On ArtFi, trading settles by signature.** The asset stays in its owner's wallet and moves only in the atomic fill that owner signed. **ArtFi never custodies, never acts as counterparty, and never settles a trade for anyone.** Being a venue is not permission to hold.

**On OpenSea**, ArtFi mirrors attributed listings, offers, sales, transfers and cancellations — each with source, time, freshness and a deep link to the venue — and execution there completes on OpenSea.

The rollout sequence above is a **business** decision about when a capability is switched on. It is not an engineering gate: a track that has not opened is still built, tested and counted in [`docs/STATUS.md`](docs/STATUS.md).

### 1. ERC-8415 asset products — one whole artwork

ArtFi applies ERC-8415 concepts to connect physical artwork identity, custody records, ownership state, and blockchain settlement. ERC-8415 covers asset identity, registry synchronization, ownership-related workflows, and asset lifecycle management.

```text
Artwork → ArtCCH off-chain registration → third-party registry chain → ArtFi / OpenSea
```

A token may represent one specific artwork custody certificate. Opening this line requires an Oracle call path, an ERC-8415 wallet, and off-chain registration at ArtCCH projected onto a third-party registry chain.

### 2. Artwork investment products — fractions and fund tokens

An artwork may form an independent investment product with tokenized participation and asset-specific governance.

```text
Artwork → Single-asset fund → Fund token → DAO governance
```

Fund token holders participate in governance according to the defined governance rules. For direct artwork receipt products, governance follows the defined asset authority model. **Token possession alone does not define governance rights unless the asset model specifies it.**

This line opens after exempt-market compliance is complete — a client-side legal step, not an engineering deliverable.

### 3. Charity NFT editions — an independent product line

Fixed ERC-1155 editions for cultural and philanthropic fundraising: one artwork, one token ID, exactly 100 units, minted once. They are **not** required to follow the ERC-8415 asset model.

The only holder benefit is a high-resolution **watermarked** copy, released after wallet ownership is verified. The unwatermarked master never enters public metadata, a website download, or any browser-delivered object. An edition conveys no copyright, physical title, possession, redemption, commercial-use or reproduction right.

All primary proceeds are designated for CCHS. **ArtFi issues no receipt, determines no eligible amount, and promises no tax credit** — holders contact CCHS directly.

Rollout runs OpenSea first, then ArtFi, in stages — **and the build stays launch-ready throughout.**

## Operations

Delivery and the database run on a domestic cloud; on-chain operation runs in the approved **SIN execution zone**. Which vendors these are is bound in [`docs/DEPLOYMENT_ENVIRONMENT.md`](docs/DEPLOYMENT_ENVIRONMENT.md), the only file that names one. An operations agent maintains 24/7 service and reaches a model through a replaceable provider interface — **the model vendor is swappable at any time**, so no prompt, schema or control path may depend on one. Model output is advisory; transaction authority comes from deterministic policy.

Partner and vendor identities appear in governing material only as neutral placeholders.

## Current status

- Delivery phase: **Stage 2–7 integrated implementation**
- Test chain: **Hoodi `560048`**; the production chain is undecided
- Mainnet and real-money operation: **not approved**
- Runtime chain evidence: **none on any chain; not claimed as passed**
- Requirement status, item by item: [`docs/STATUS.md`](docs/STATUS.md)

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

**ArtFi is delivered in stages, not as one complete end-state handover.** Only the complete RWA
market is handed over whole. **Every delivery is measured by what is visible and operable in the
UI** — a stage is delivered when a user in its intended role can carry out its function from the
ArtFi UI, desktop and mobile, with visual sign-off and the usual evidence. An endpoint, contract,
test or generated client that no screen reaches is progress, not a handover. The stages are in
[`docs/PRD.md`](docs/PRD.md) §3.2; a stage does not require mainnet.

**The current baseline is three documents.** Read them before anything else, and see
[`AGENTS.md`](AGENTS.md) for how they bind:

- [**PRD**](docs/PRD.md) — what must exist and how it must behave
- [**Acceptance standard**](docs/ACCEPTANCE.md) — what proves it exists, and the G1–G4 promotion gates
- [**Status**](docs/STATUS.md) — where every requirement stands right now, item by item

Client directives override them where they conflict, newest first:
[2026-09-19 trading and rollout](docs/DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md) (venues,
phased rollout, operations topology),
[2026-09-18 charity module](docs/DIRECTIVE_2026-09-18_CHARITY_MODULE.md) (charity requirement
coverage),
[2026-09-18 product alignment](docs/DIRECTIVE_2026-09-18_PRODUCT_ALIGNMENT.md) (positioning, asset
models, product invariants),
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

| 申请名称                                   | 申请号           | 关联范围               |
| ------------------------------------------ | ---------------- | ---------------------- |
| 一种链外数据源事实的无人值守出具系统及方法 | `202611389399.6` | Oracle                 |
| 一种基于链下登记簿的数据凭证映射方法及系统 | `202611389374.6` | ERC 登记簿凭证映射标准 |

两项申请均已提交并取得受理通知。申请受理不等于专利授权，也不表示技术交付或生产验收完成。

本次仅披露上述申请名称、申请号及申请状态，不上传受理通知书 PDF、申请材料、个人信息、客户私域数据或其他商业信息。不得要求负责人向 AI 提供保密协议、商业尽调材料或与技术无关的信息，作为更新上述状态或推进无关技术开发、脱敏测试的前提。技术验收仍依据代码、可复核测试及授权范围内的运行证据，不代替任何人的法律或商业签署。
