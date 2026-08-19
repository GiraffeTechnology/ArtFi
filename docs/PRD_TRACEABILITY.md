# PRD traceability matrix

Status values:

- `planned`: accepted into the staged roadmap
- `in-progress`: implementation has started
- `implemented-in-pr`: code and automated evidence exist on a stage pull request but are not merged
- `implemented-in-branch`: code and local automated evidence exist on the Stage 2–7 integration branch
- `evidence-required`: screenshots or prose exist, but code/runtime evidence is missing
- `gated`: blocked by an explicit security, legal, or operational gate

| ID           | PRD capability                                 |                   Stage | Current status        | Required acceptance evidence                                                                                                          |
| ------------ | ---------------------------------------------- | ----------------------: | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| WEB-001      | Home, projects, markets, detail, portfolio     |                       1 | implemented-in-pr     | 18 desktop/mobile route and accessibility checks                                                                                      |
| WEB-002      | Search, filter, pagination                     |                       4 | implemented-in-branch | API filtering/pagination tests; legacy UI binding remains in integrated debugging                                                     |
| WALLET-001   | External wallet connection                     |                       1 | implemented-in-branch | Injected wallet, Sepolia enforcement, connect/reconnect/network tests                                                                 |
| RWA-001      | Image upload and metadata                      |                       2 | implemented-in-branch | Validated upload, provenance, storage and metadata tests                                                                              |
| RWA-002      | NFT contract selection and mint                |                       2 | implemented-in-branch | Verified contract, receipt, failure and authorization tests                                                                           |
| DAO-001      | Create DAO/Vault                               |                       3 | implemented-in-branch | Contract event, persisted record, permission tests                                                                                    |
| DAO-002      | Select, approve, and deposit NFTs              |                       3 | implemented-in-branch | Custody invariant and replay tests; multi-NFT support remains a Stage 4 extension                                                     |
| DAO-003      | Fractional token configuration and issue       |                       3 | implemented-in-branch | Supply/decimal/role/invariant tests                                                                                                   |
| MARKET-001   | ArtFi-operated crowdfunding/order/bid/claim    | Future, post-compliance | gated                 | Compliance strategy, legal approval, independent audit, surveillance controls, and written go/no-go; excluded from current deployment |
| MARKET-002   | Approved external marketplace real-time mirror |                       4 | implemented-in-branch | Versioned adapter, OpenSea Stream + REST backfill, source allowlist, dedupe/stale-event tests, read-only API and external deep links  |
| GOV-001      | Proposal, vote, timelock, execution            |                       4 | implemented-in-branch | Governance lifecycle, Timelock and role tests                                                                                         |
| API-001      | Go API, OpenAPI and error contract             |                     0-2 | implemented-in-pr     | Health, catalog, portfolio, CORS, problem response and generated-client tests                                                         |
| DATA-001     | MySQL persistence and migrations               |                     1-3 | implemented-in-branch | MySQL 8.4 forward/rollback and runtime-restart hydration tests                                                                        |
| DATA-002     | Redis cache and invalidation                   |                       1 | planned               | Cache consistency and failure-mode tests                                                                                              |
| STORE-001    | R2-compatible object storage                   |                       2 | implemented-in-branch | Integrity, access control and lifecycle tests                                                                                         |
| CONTRACT-001 | NFT factory and asset contracts                |                       2 | implemented-in-branch | Unit, fuzz, invariant, verification evidence                                                                                          |
| CONTRACT-002 | Vault and fractional contracts                 |                       3 | implemented-in-branch | Custody, supply, pause, role, replay, and recovery evidence                                                                           |
| EXT-001      | ArtFi browser wallet extension                 |                       5 | gated                 | Non-custodial Alpha implemented; independent review and browser-store acceptance remain required                                      |
| SEC-001      | Authentication, RBAC and session security      |                     2-6 | implemented-in-branch | Default-deny operator/indexer boundaries and negative tests; production OIDC remains gated                                            |
| SEC-002      | Independent security audit                     |                       7 | gated                 | Signed report mapped to release commit and addresses                                                                                  |
| OPS-001      | CI/CD, monitoring, backup, rollback            |                     0-7 | implemented-in-branch | Passing local gates, release verifier and runbooks; environment drills remain gated                                                   |
| COMP-001     | KYC/KYB, AML/sanctions, jurisdiction           |                       6 | gated                 | Fail-closed policy/schema implemented; legal/provider approval remains required                                                       |
| COMP-002     | Asset title, custody, valuation, redemption    |                       6 | gated                 | Evidence schema/runbook implemented; approved operating model remains required                                                        |
| RIGHTS-001   | Artwork licensing and attribution              |                     1-2 | gated                 | Stage 1 uses original CSS placeholders; real catalog media still needs source, license, attribution and takedown records              |

No item may be marked complete solely from a screenshot or PRD statement.

Live Sepolia deployment, standards probing, NFT minting, and OpenSea discovery were initially
deferred and later scheduled for after the pre-chain gates. Their absence does not downgrade
implemented code or automated evidence, but those runtime checks remain unpassed and must not be
represented as completed acceptance evidence.
