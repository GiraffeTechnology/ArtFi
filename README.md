# ArtCCH:ArtFi

ArtCCH:ArtFi is a commercial digital art and Real-World Asset (RWA) application platform.

This repository is the source of truth for the ArtFi application. It is not a demo and it is not an ERC-8415 implementation repository.

## Product Blueprint

ArtFi is the application layer in the ERC-8415 ecosystem:

```
ERC-8415
(Standard)
      |
      v
ERC8415-Kit
(Infrastructure)
      |
      v
Oracle
(Verification / Integration Layer)
      |
      v
ArtCCH:ArtFi
(Application Layer)
```

ArtFi consumes infrastructure capabilities through Oracle. It does not directly implement ERC-8415 protocol logic.

---

# Product Lines

The PRD defines three product lines.

## 1. ERC-8415 Based Artwork Asset Products

Purpose:

Represent physical artwork identity, custody records, registry synchronization and market workflows.

Blueprint:

```
Artwork
   |
Custody
   |
Registry
   |
ERC-8415 asset representation
   |
Market workflow
```

The system preserves the distinction between:

- blockchain tradeable position;
- registry-confirmed asset state.

ArtFi must not merge these concepts.

```
ERC-721 ownerOf
        !=
Confirmed registry holder
```

---

## 2. Artwork Investment Products

ArtFi supports artwork-specific investment structures.

Blueprint:

```
Artwork
   |
Single-asset investment product
   |
Fund participation
   |
DAO governance
```

Governance rights depend on the asset model.

Token possession alone does not automatically define governance authority.

---

## 3. Charity NFT Editions

Charity NFT editions are an independent cultural and philanthropic product line.

They are not required to follow the ERC-8415 asset model and have independent requirements.

---

# Functional Blueprint

## M1 — Smart Contracts

PRD scope:

- artwork asset contracts;
- auction and market contracts;
- fractional asset components;
- revenue distribution;
- governance contracts;
- multi-signature administration;
- deployment tooling;
- contract testing.

## M2 — Backend Core Trading

Business model:

ArtFi is a trading intermediary, not a custodian or exchange.

Required architecture:

```
User Wallet
      |
Signed Intent
      |
ArtFi Backend
      |
On-chain Settlement
```

Rules:

- ArtFi does not hold user assets;
- ArtFi does not control user funds;
- administration cannot move user property;
- chain state remains ownership authority.

Backend scope:

- authentication;
- wallet binding;
- order workflow;
- signed intents;
- trade history;
- API services;
- audit records.

## M3 — Frontend UX

PRD scope:

- artwork discovery;
- market interface;
- personal centre;
- holdings display;
- governance interface;
- charity interface;
- responsive and multilingual UI.

Prototype screens define UX direction, not final delivery alone.

## M4 — DAO Governance

Governance blueprint:

- voting power model;
- proposal lifecycle;
- timelock execution;
- administrative controls.

Governance follows asset structure.

## M5 — Security

Required:

- security review;
- penetration testing;
- remediation verification;
- secret/key protection.

## M6 — Operations

Required:

- deployment;
- monitoring;
- CI/CD;
- production operation evidence.

---

# Current Implementation Status (2026-09-20)

The repository contains substantial implementation across the PRD scope, but production acceptance is not complete.

Implemented areas include:

## Contracts

- artwork market foundations;
- fractional asset foundations;
- revenue distribution components;
- governance contracts;
- charity NFT related contracts.

## Backend

- API service framework;
- asset workflows;
- external market integration framework;
- OpenAPI definitions;
- runtime validation boundaries.

## Frontend

- Next.js application;
- responsive UI framework;
- multilingual framework;
- wallet/application interaction layer.

## Testing

Implemented:

- contract tests;
- fuzz/invariant tests;
- API tests;
- frontend contract tests;
- browser contract tests.

Current limitations:

- production chain deployment is not approved;
- real-money operation is not approved;
- runtime evidence remains required for acceptance.

---

# Delivery Rule

ArtFi follows evidence-based delivery:

```
Code
  |
Tests
  |
Deployment Environment
  |
User Visible Workflow
  |
Acceptance Evidence
```

Code completion alone does not equal delivery.

---

# Repository Structure

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

---

# Primary Documents

| Document           | Purpose                                       |
| ------------------ | --------------------------------------------- |
| docs/PRD.md        | Product blueprint and functional requirements |
| docs/ACCEPTANCE.md | Delivery evidence and promotion rules         |
| docs/STATUS.md     | Requirement status                            |
| AGENTS.md          | Engineering execution rules                   |

Historical documents provide traceability but are not acceptance targets unless referenced by current baseline documents.

---

# Scope Boundary

ArtFi is:

- commercial application layer;
- artwork marketplace and user experience platform;
- consumer of Oracle and ERC-8415 ecosystem infrastructure.

ArtFi is not:

- ERC-8415 protocol implementation;
- ERC8415-Kit infrastructure;
- Oracle infrastructure;
- legal title adjudication system;
- custody replacement system.

---

# Patent Disclosure Boundary

Publicly disclosed applications:

| Application                                | Number           | Scope                           |
| ------------------------------------------ | ---------------- | ------------------------------- |
| 一种链外数据源事实的无人值守出具系统及方法 | `202611389399.6` | Oracle                          |
| 一种基于链下登记簿的数据凭证映射方法及系统 | `202611389374.6` | ERC registry credential mapping |

Patent filing does not mean grant, production acceptance or commercial deployment.
