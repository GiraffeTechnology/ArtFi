# PR #114 market-mirror test report

## Identity

- Repository: `GiraffeTechnology/ArtFi`
- Pull request: `#114`
- Code commit under test: `048283b1913ca3bdb8ee9a58ad39ed40ce162147`
- Code tree under test: `ab6d0cdaefdc7755dd6837b71d42b6043b7bfa3e`
- Scope: fail-closed realtime/snapshot convergence, crash-window head overlap,
  bounded disk-spooled realtime buffering, recoverable durable-log tails,
  post-commit sink recovery, crash-safe reclamation, cleanup exclusion, and
  process-instance lock identity

This report contains no credentials, private endpoints, host names, IP addresses,
wallet material, RPC values, or internal filesystem locations.

## Results

| Gate                                 | Result                                    |
| ------------------------------------ | ----------------------------------------- |
| Prettier                             | PASS                                      |
| Market-mirror focused suite          | PASS — 33/33                              |
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
- incomplete spool and checkpoint tails recover from the latest committed byte
  offset;
- a resumed snapshot overlaps every collection head before continuing its saved
  cursor, recovering realtime events from the prior process's crash window;
- realtime events are spooled outside the process heap until the REST snapshot
  commits;
- event-count and byte-count limits fail startup closed before queued promise
  closures can grow without bound;
- queue overflow while the committed spool is replaying still fails startup
  closed before realtime readiness is published;
- after snapshot commit, one rejected sink delivery does not disable later
  realtime events;
- a failed REST snapshot discards buffered realtime events;
- completed snapshot payloads are removed while exclusion remains held;
- the stable snapshot directory survives writer handoff without recursive
  deletion;
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
