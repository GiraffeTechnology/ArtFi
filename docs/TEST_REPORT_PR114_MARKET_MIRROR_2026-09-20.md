# PR #114 market-mirror test report

## Identity

- Repository: `GiraffeTechnology/ArtFi`
- Pull request: `#114`
- Code commit under test: `2d910cc1d678a8fb88eefabb3749af524afc7ceb`
- Code tree under test: `3ad9c6e6898610b7a88a9059cbe9dd744badc309`
- Scope: fail-closed realtime/snapshot convergence, crash-window head overlap,
  reconnect-triggered REST gap-fill,
  bounded disk-spooled realtime buffering, recoverable durable-log tails,
  snapshot withholding after realtime-buffer failure, post-commit sink
  recovery, reclaimer-owned crash-safe reclamation, cleanup exclusion, and
  process-instance lock identity

This report contains no credentials, private endpoints, host names, IP addresses,
wallet material, RPC values, or internal filesystem locations.

## Results

| Gate                                 | Result                                    |
| ------------------------------------ | ----------------------------------------- |
| Prettier                             | PASS                                      |
| Market-mirror focused suite          | PASS — 40/40                              |
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
- a live reclaimer owns its marker, so a contender cannot remove the marker
  and steal the stale lock;
- short durable-log writes complete before fsync and cursor advancement;
- incomplete spool and checkpoint tails recover from the latest committed byte
  offset;
- a resumed snapshot overlaps every collection head before continuing its saved
  cursor, traversing provider pages until the last committed event boundary and
  recovering crash windows larger than one provider page;
- realtime events are spooled outside the process heap until the REST snapshot
  commits;
- event-count and byte-count limits fail startup closed before queued promise
  closures can grow without bound;
- a separate cumulative byte limit prevents the retained realtime spool from
  consuming unbounded disk during a long snapshot;
- realtime-buffer failure withholds the REST snapshot instead of exposing an
  incomplete view;
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
- the initial connection waits for every collection acknowledgement without
  launching a duplicate recovery crawl;
- each later fully acknowledged connection generation schedules exactly one
  serialized REST gap-fill, while stale socket replies are ignored;
- a rejected reconnect gap-fill is surfaced as a fatal stream failure so the
  service exits and startup recovery can run again.

## Limits

- These are repository and build results, not live OpenSea runtime evidence.
- No transaction, signing, broadcast, custody, settlement, or real-asset action
  was performed.
- Earlier exact-head CI results are not reused here; the report commit requires
  its own CI and fresh review.
- XM.3 remains `IMPLEMENTED-NOT-VERIFIED`.
