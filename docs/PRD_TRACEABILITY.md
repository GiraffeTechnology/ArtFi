# PRD traceability matrix

Status values:

- `planned`: accepted into the staged roadmap
- `in-progress`: implementation has started
- `implemented-in-pr`: code and automated evidence exist on a stage pull request but are not merged
- `evidence-required`: screenshots or prose exist, but code/runtime evidence is missing
- `gated`: blocked by an explicit security, legal, or operational gate

| ID           | PRD capability                              | Stage | Current status    | Required acceptance evidence                                                                                             |
| ------------ | ------------------------------------------- | ----: | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| WEB-001      | Home, projects, markets, detail, portfolio  |     1 | implemented-in-pr | 18 desktop/mobile route and accessibility checks                                                                         |
| WEB-002      | Search, filter, pagination                  |     4 | planned           | API/UI integration and empty/error/loading states                                                                        |
| WALLET-001   | External wallet connection                  |     1 | in-progress       | Injected wallet, Sepolia enforcement, connect/reconnect/network tests                                                    |
| RWA-001      | Image upload and metadata                   |     2 | evidence-required | Validated upload, provenance, storage and metadata tests                                                                 |
| RWA-002      | NFT contract selection and mint             |     2 | evidence-required | Verified contract, receipt, failure and authorization tests                                                              |
| DAO-001      | Create DAO/Vault                            |     3 | evidence-required | Contract event, persisted record, permission tests                                                                       |
| DAO-002      | Select, approve, and deposit NFTs           |     3 | evidence-required | Custody invariant and multi-NFT tests                                                                                    |
| DAO-003      | Fractional token configuration and issue    |     3 | evidence-required | Supply/decimal/role/invariant tests                                                                                      |
| MARKET-001   | Crowdfunding/order/bid/claim                |     4 | evidence-required | Settlement, refund, expiry and replay tests                                                                              |
| GOV-001      | Proposal, vote, timelock, execution         |     4 | planned           | Governance lifecycle and permission tests                                                                                |
| API-001      | Go API, OpenAPI and error contract          |   0-2 | implemented-in-pr | Health, catalog, portfolio, CORS, problem response and generated-client tests                                            |
| DATA-001     | MySQL persistence and migrations            |     1 | implemented-in-pr | MySQL 8.4 forward/rollback execution produces 2 then 0 catalog tables in local and CI gates                              |
| DATA-002     | Redis cache and invalidation                |     1 | planned           | Cache consistency and failure-mode tests                                                                                 |
| STORE-001    | R2-compatible object storage                |     2 | planned           | Integrity, access control and lifecycle tests                                                                            |
| CONTRACT-001 | NFT factory and asset contracts             |     2 | planned           | Unit, fuzz, invariant, verification evidence                                                                             |
| CONTRACT-002 | Vault and fractional contracts              |     3 | planned           | Custody, supply, pause and upgrade evidence                                                                              |
| EXT-001      | ArtFi browser wallet extension              |     5 | gated             | Threat model, security review, browser-store acceptance                                                                  |
| SEC-001      | Authentication, RBAC and session security   |   2-4 | planned           | Authorization matrix and negative tests                                                                                  |
| SEC-002      | Independent security audit                  |     7 | gated             | Signed report mapped to release commit and addresses                                                                     |
| OPS-001      | CI/CD, monitoring, backup, rollback         |   0-7 | in-progress       | Passing pipeline and tested runbooks                                                                                     |
| COMP-001     | KYC/KYB, AML/sanctions, jurisdiction        |     6 | gated             | Legal/compliance approval and operational tests                                                                          |
| COMP-002     | Asset title, custody, valuation, redemption |     6 | gated             | Approved operating model and evidence chain                                                                              |
| RIGHTS-001   | Artwork licensing and attribution           |   1-2 | gated             | Stage 1 uses original CSS placeholders; real catalog media still needs source, license, attribution and takedown records |

No item may be marked complete solely from a screenshot or PRD statement.
