# Stage 2 acceptance evidence

Stage 2 implements the first narrowly authorized write path. It remains Sepolia-only and is
disabled at runtime until a reviewed registry address, HTTPS public asset base, and R2-compatible
object-store credentials are supplied.

## Delivered

- `ArtFiRWA` ERC-721 with separate admin, minter, and pauser roles and paused transfers.
- `RWARegistry` with metadata URI constraints, SHA-256 commitments, atomic minting, and replay-safe
  request IDs that reject conflicting reuse.
- Sepolia-only deployment script with deployer-role removal and an evidence manifest template.
- Browser upload hashing, API byte/digest/type verification, authenticated S3 SigV4 object writes,
  immutable metadata generation, wallet review, submission recording, and receipt states.
- MySQL 8.4 tables for uploads, mint intents, and replay-safe chain events with complete rollback.
- OpenAPI 3.1 contract and regenerated TypeScript schema.

## Verified development evidence

- Solidity 0.8.30 compile and size check: `ArtFiRWA` 6,238 bytes; `RWARegistry` 4,742 bytes.
- Foundry: 9/9 tests, 513 fuzz cases, and 256 invariant runs × 64 calls (16,384 calls, zero reverts).
- Foundry high-severity lint: no findings.
- Go 1.26.5: `go vet ./...` and `go test -race ./...` pass.
- API lifecycle tests cover upload integrity, idempotent mint preparation, conflicting replay,
  transaction attachment, and AWS SigV4 headers.
- Next.js production build: 23 static/SSG pages including `/create/rwa`.
- Playwright + axe: 22/22 desktop/mobile checks.
- MySQL migration sequence: Stage 1 + Stage 2 `5` tables, Stage 2 rollback `2`, full rollback `0`.

The Foundry development tool was executed from the official image pinned to
`ghcr.io/foundry-rs/foundry@sha256:043752653d5be351c71709091b3db97c4421c907eb40ea294195e7f532aadf46`
(Forge 1.5.1-stable).

## External exit gates still required

- Deploy reviewed bytecode to Sepolia through an approved signer and role-address set.
- Verify source, constructor arguments, bytecode, transactions, and role ownership.
- Exercise a real injected-wallet registrar transaction and reconcile its event from an approved RPC.
- Provide a rights-cleared test image and approved R2 bucket for the runtime evidence chain.

No mainnet, real asset, real-money, or inherited PRD address is enabled by this stage.
