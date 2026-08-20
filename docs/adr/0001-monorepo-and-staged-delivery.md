# ADR 0001: Monorepo and staged delivery

Status: accepted
Date: 2026-08-19

## Context

The inherited PRD spans a DApp, Go backend, smart contracts, data services, and a browser wallet extension. The prior handoff contained screenshots and documents but no reproducible source repository.

## Decision

Use `GiraffeTechnology/ArtFi` as the single source of truth and organize it as a monorepo. Deliver the external-wallet DApp before the custom browser wallet. Every stage has explicit exit gates and remains Sepolia-only until independent audit and compliance approval.

## Consequences

- Product, API, contract, and operations changes remain traceable in one repository.
- A custom wallet cannot silently expand the MVP's custody and security boundary.
- Mainnet is a separate approval decision, not an automatic final development step.
