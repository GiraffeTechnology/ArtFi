# PR #115 operations compatibility test report

## Identity

- Repository: `GiraffeTechnology/ArtFi`
- Pull request: `#115`
- Code commit under test: `d3da59973da3927c18cfdaa8d7a5802cb6fad612`
- Code tree under test: `647824b6c78617179d971dad458f210eda36af58`
- Scope: versioned compatibility mapping for a frozen operations-health
  producer while preserving ArtFi's vendor-neutral internal role

This report contains no credentials, private endpoints, host names, IP addresses,
wallet material, RPC values, or internal filesystem locations. The historical
producer identifier remains confined to the executable compatibility contract
and is not reproduced in this report.

## Results

| Gate                                 | Result                                    |
| ------------------------------------ | ----------------------------------------- |
| Prettier                             | PASS                                      |
| Focused operations dependency suite  | PASS — 7/7                                |
| Forced no-cache Turbo matrix         | PASS — 15/15 tasks, 0 cached              |
| Market-mirror suite                  | PASS — 25/25                              |
| Web unit suite                       | PASS — 106/106                            |
| Wallet extension suite               | PASS — 6/6                                |
| API client suite                     | PASS — 2/2                                |
| Production-mode web build            | PASS — 32 routes generated                |
| Agent suite                          | PASS — 36/36                              |
| Secret scan                          | PASS — 405 repository files               |
| Hoodi chain consistency              | PASS — 18 layers agree on chain ID 560048 |
| Release schema                       | PASS                                      |
| Charity package schema and verifier  | PASS                                      |
| Hoodi Admin Safe schema and verifier | PASS — 1 positive, 15 negative            |

## Compatibility evidence

- The frozen producer artifact and its version are unchanged.
- The source-specific producer role is accepted only by schema version 2 at the
  compatibility boundary.
- ArtFi's internal role remains `artfi-delivery-link`.
- Unknown producer roles and source-specific internal roles fail closed.
- The dependency remains `productionReady: false`; no health input can
  self-promote into the complete Operations Agent.

## Limits

- This verifies the repository contract and combined branch, not a live
  operations-agent installation or 7x24 behavior.
- No signing, transaction, broadcast, custody, RPC, real-asset, or production
  action was performed.
- The report commit requires its own CI and fresh review.
- Existing delivery statuses are unchanged.
