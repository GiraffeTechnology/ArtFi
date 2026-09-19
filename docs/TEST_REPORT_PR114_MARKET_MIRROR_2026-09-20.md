# PR #114 market-mirror test report

## Identity

- Repository: `GiraffeTechnology/ArtFi`
- Pull request: `#114`
- Code commit under test: `3f34c6b5ac8cfe96f9ec9650e3b0c70b659d665b`
- Code tree under test: `e523166dbf7ff76557ee00d7e32e39df228481c6`
- Scope: fail-closed realtime/snapshot convergence, complete durable writes,
  crash-safe reclamation, cleanup exclusion, and process-instance lock identity

This report contains no credentials, private endpoints, host names, IP addresses,
wallet material, RPC values, or internal filesystem locations.

## Results

| Gate                                 | Result                                    |
| ------------------------------------ | ----------------------------------------- |
| Prettier                             | PASS                                      |
| Market-mirror focused suite          | PASS — 29/29                              |
| Forced no-cache Turbo matrix         | PASS — 15/15 tasks, 0 cached              |
| Web unit suite                       | PASS — 106/106                            |
| Wallet extension suite               | PASS — 6/6                                |
| API client suite                     | PASS — 2/2                                |
| Production-mode web build            | PASS — 32 routes generated                |
| Agent suite                          | PASS — 34/34                              |
| Secret scan                          | PASS — 406 repository files               |
| Hoodi chain consistency              | PASS — 18 layers agree on chain ID 560048 |
| Release schema                       | PASS                                      |
| Charity package schema and verifier  | PASS                                      |
| Hoodi Admin Safe schema and verifier | PASS — 1 positive, 15 negative            |

## Regression evidence

`apps/market-mirror/src/opensea.test.ts` proves both sides of the lock
boundary:

- a complete owner record is fsynced before an atomic hard-link publishes it;
- concurrent stale-owner contenders preserve exclusive single-writer behavior;
- process-instance identity distinguishes an exited owner from a reused PID;
- an abandoned stale reclamation marker is recoverable;
- short durable-log writes complete before fsync and cursor advancement;
- realtime events remain buffered until the REST snapshot commits;
- a failed REST snapshot discards buffered realtime events;
- completed snapshot payloads are removed while exclusion remains held;
- a live owner remains protected from reclamation;
- recovered work resumes without exposing a partial snapshot;
- successful replay removes the completed snapshot state.

## Limits

- These are repository and build results, not live OpenSea runtime evidence.
- No transaction, signing, broadcast, custody, settlement, or real-asset action
  was performed.
- Earlier exact-head CI results are not reused here; the report commit requires
  its own CI and fresh review.
- XM.3 remains `IMPLEMENTED-NOT-VERIFIED`.
