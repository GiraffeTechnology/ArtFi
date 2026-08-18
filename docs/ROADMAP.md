# ArtFi staged delivery roadmap

## Planning rules

- `GiraffeTechnology/ArtFi` is the single source of truth.
- Each stage ships through a branch and pull request with explicit acceptance evidence.
- A later stage may be researched early, but cannot be release-eligible until all earlier exit gates pass.
- Sepolia is the only allowed chain until Stage 7.
- Regulatory, security, and custody gates can stop delivery regardless of feature completion.

## Stage 0 - Foundation

Goal: establish a reproducible repository, architecture, environments, quality gates, and PRD traceability.

Deliverables:

- Monorepo with Web, API, contracts, documentation, and CI boundaries.
- Next.js and Go health surfaces.
- Local MySQL and Redis through Docker Compose.
- Branch, review, security, environment, and Definition of Done policies.
- PRD requirements mapped to stages and acceptance criteria.

Exit gate:

- Fresh clone can install, test, lint, typecheck, and build.
- CI passes on the Stage 0 pull request.
- No committed secrets.
- Stage 1 issues have owners and acceptance criteria.

## Stage 1 - Read-only product and wallet connection

Goal: reproduce the core product surfaces without write transactions.

Scope:

- Responsive home, projects, RWA market, fractional market, detail, and portfolio shells.
- Shared UI tokens and accessible component foundations.
- Wallet connection through RainbowKit/Wagmi/Viem.
- Sepolia network enforcement, address display, balance, and reconnect handling.
- API health, configuration, error contract, logging, and database migrations.
- Replace broken artwork URLs with validated metadata and licensed placeholders.

Exit gate:

- Desktop/mobile journeys pass visual and accessibility checks.
- Unsupported chains cannot initiate ArtFi transactions.
- Read-only API and frontend integration tests pass.

## Stage 2 - RWA creation and NFT minting

Goal: create an asset record, upload metadata, and mint a verifiable NFT on Sepolia.

Scope:

- Asset ownership and provenance fields.
- Validated image upload to R2-compatible storage.
- Metadata creation and immutable content references.
- NFT factory and asset contracts with role controls and pause capability.
- Mint review, wallet confirmation, receipt, retry, and failure recovery.
- Contract tests, API tests, and transaction trace evidence.

Exit gate:

- Minted bytecode and source are verified.
- Metadata can be reproduced from persisted records.
- Unauthorized minting and malformed uploads are rejected.

## Stage 3 - Vault, DAO, deposit, and fractionalization

Goal: complete the PRD's central RWA-to-fractional-token journey on Sepolia.

Scope:

- Create DAO/Vault with validated names and governance parameters.
- Approve and deposit one or more NFTs into the Vault.
- Configure symbol, supply, reserve price, and distribution.
- Deploy fractional token and reconcile emitted events.
- Idempotent API processing and transaction recovery.
- Unit, fuzz, invariant, integration, and fork tests.

Exit gate:

- Custody and ownership invariants hold across deposit and fractionalization.
- Supply, decimals, permissions, pause, and recovery rules are documented and tested.
- No privileged action is controlled by an undocumented EOA.

## Stage 4 - Market, bids, claims, portfolio, and governance

Goal: deliver complete user-facing asset participation and DAO operation.

Scope:

- Search, filter, pagination, project and asset detail.
- Crowdfunding/order/bid/claim flows with expiry, cancellation, refund, and settlement.
- Portfolio, transaction history, offers, and notifications.
- DAO proposal, voting, quorum, timelock, execution, and treasury visibility.
- Indexing and reconciliation for on-chain events.

Exit gate:

- Money and token flows reconcile against chain receipts.
- Cancellation, refund, reorg, duplicate event, and partial failure tests pass.
- Governance permissions and timelocks are independently reviewed.

## Stage 5 - ArtFi wallet extension alpha

Goal: implement the PRD wallet scope as a separately gated product, without blocking the core DApp.

Scope:

- Extension architecture, account vault, network controller, transaction confirmation, permissions, and phishing protection.
- Hardware wallet and WalletConnect compatibility where approved.
- Isolated signing boundary and encrypted local storage.
- Migration, recovery, update, telemetry, and incident controls.

Exit gate:

- Independent wallet threat model and security review complete.
- No custom cryptographic primitive or plaintext key persistence.
- Extension store and browser permission reviews pass.

## Stage 6 - Security, compliance, and operations

Goal: make the system eligible for controlled real-world evaluation.

Scope:

- KYC/KYB, AML/sanctions, investor eligibility, jurisdiction, privacy, and retention controls.
- Asset title, custody, valuation, redemption, dispute, and insolvency procedures.
- Multi-signature roles, timelocks, signer rotation, transaction simulation, and emergency pause.
- SAST, dependency, secret, container, IaC, and license scanning.
- Metrics, logs, traces, alerting, backups, disaster recovery, and incident runbooks.

Exit gate:

- Legal and compliance sign-off is recorded.
- Recovery objectives are tested.
- All P0/P1 findings are closed or formally accepted by accountable owners.

## Stage 7 - Independent audit and controlled launch

Goal: produce an auditable release candidate and launch with bounded risk.

Scope:

- Independent smart-contract and application security audits.
- Remediation and auditor retest against the exact release commit.
- Load, chaos, penetration, and end-to-end release testing.
- Deployment manifest, verified addresses, SBOM, rollback and communication plans.
- Allowlisted, capped pilot before any broader launch.

Exit gate:

- Audit report, commit hash, bytecode, deployment addresses, and remediation evidence match.
- Mainnet and real-asset activation require a separate written go/no-go approval.
