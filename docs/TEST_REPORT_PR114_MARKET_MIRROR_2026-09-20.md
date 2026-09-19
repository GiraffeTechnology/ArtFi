# PR #114 market-mirror test report

## Identity

- Repository: `GiraffeTechnology/ArtFi`
- Pull request: `#114`
- Code commit under test: `e52865d62f6db1c28ae3e1188515c679cd62cb94`
- Code tree under test: `895aa758b6d161ce79b3c6a67fc1081b17741bf0`
- Scope: stale-owner recovery for the durable OpenSea backfill lock

This report contains no credentials, private endpoints, host names, IP addresses,
wallet material, RPC values, or internal filesystem locations.

## Results

| Gate                                 | Result                                    |
| ------------------------------------ | ----------------------------------------- |
| Prettier                             | PASS                                      |
| Market-mirror focused suite          | PASS — 25/25                              |
| Forced no-cache Turbo matrix         | PASS — 15/15 tasks, 0 cached              |
| Web unit suite                       | PASS — 106/106                            |
| Wallet extension suite               | PASS — 6/6                                |
| API client suite                     | PASS — 2/2                                |
| Production-mode web build            | PASS — 32 routes generated                |
| Agent suite                          | PASS — 34/34                              |
| Secret scan                          | PASS — 405 repository files               |
| Hoodi chain consistency              | PASS — 18 layers agree on chain ID 560048 |
| Release schema                       | PASS                                      |
| Charity package schema and verifier  | PASS                                      |
| Hoodi Admin Safe schema and verifier | PASS — 1 positive, 15 negative            |

## Regression evidence

`apps/market-mirror/src/opensea.test.ts` proves both sides of the lock
boundary:

- a live owner preserves exclusive single-writer behavior;
- a dead owner no longer makes a durable cursor checkpoint permanently
  unreachable;
- recovered work resumes without exposing a partial snapshot;
- successful replay removes the completed snapshot state.

## Limits

- These are repository and build results, not live OpenSea runtime evidence.
- No transaction, signing, broadcast, custody, settlement, or real-asset action
  was performed.
- The prior exact-head CI attempt ended before any job step ran. Its result is
  not reused here; the report commit requires its own CI and fresh review.
- XM.3 remains `IMPLEMENTED-NOT-VERIFIED`.
