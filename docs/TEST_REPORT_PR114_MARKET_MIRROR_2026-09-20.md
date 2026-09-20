# PR #114 XM.3 external-market mirror test report

## Identity

- Repository: `GiraffeTechnology/ArtFi`
- Pull request: `#114`
- Code commit under test: `fb3a949d853f12b69a6dcfe2e26ef35d6bba0180`
- Code tree under test: `fb5146485e57b2370dcff2eb7483a4037109c1b2`
- Scope: XM.2-XM.3 external-market adapter resilience, realtime/REST
  convergence, atomic cutover, complete-history streaming, zero-event cutover,
  reconnect recovery, bounded durable buffering, and user-visible mirror
  attribution.

This report contains no credentials, private endpoints, host names, IP
addresses, wallet material, RPC values, or internal filesystem locations.

## Results

| Gate                                             | Result                                                  |
| ------------------------------------------------ | ------------------------------------------------------- |
| Prettier                                         | PASS                                                    |
| Market-mirror focused suite                      | PASS — 42/42                                            |
| Forced no-cache Turbo matrix                     | PASS — 15/15 tasks, 0 cached                            |
| Web unit suite                                   | PASS — 106/106                                          |
| Wallet extension suite                           | PASS — 6/6                                              |
| API client suite                                 | PASS — 2/2                                              |
| Production-mode web build                        | PASS — 32 routes generated                              |
| Agent suite                                      | PASS — 34/34                                            |
| Desktop/mobile mirror-attribution browser matrix | PASS — 8/8                                              |
| Secret scan                                      | PASS — 406 repository files                             |
| Hoodi chain consistency                          | PASS — 18 layers agree on chain ID 560048               |
| Release schema                                   | PASS                                                    |
| Charity package schema and verifier              | PASS                                                    |
| Hoodi Admin Safe schema and verifier             | PASS — 1 positive, 15 negative                          |
| Fixed Go 1.26.5 `gofmt -l`                       | PASS — zero output, clean tree                          |
| Offline `go mod verify`                          | PASS — all modules verified                             |
| `go vet ./...`                                   | PASS                                                    |
| Snapshot deadline tests                          | PASS — 2/2                                              |
| Managed test-database integration                | NOT RUN — approved opaque TEST_ONLY profile unavailable |
| Exact-head GitHub CI                             | INFRASTRUCTURE FAILURE — 5 jobs, 0 steps, no logs       |

## Regression evidence

`apps/market-mirror/src/opensea.test.ts` proves:

- complete subscription acknowledgement before the initial REST crawl;
- explicit cursor exhaustion without a deployment page cap;
- retry and timeout handling through response-body parsing;
- durable resume across cursor, spool, and checkpoint crash windows;
- duplication, stale-version, reconnect, gap-fill, and sale/cancel ordering;
- bounded event, memory-closure, and retained-spool capacity;
- one atomic REST/pre-cutover realtime commit;
- post-cutover recovery without invalidating a complete cutover;
- reconnect gap-fill held behind the initial commit;
- fail-closed startup when buffering or recovery cannot remain complete;
- single-writer lock ownership across stale-owner and process-identity races.

`apps/api/internal/httpapi/handler_test.go` proves that authenticated NDJSON
snapshot requests replace the ordinary whole-request deadline with a 15-second
read/write idle deadline refreshed by each successful body read. Requests fail
closed before opening a database transaction if that bound cannot be enforced;
unauthorized or wrong-media requests retain the ordinary deadlines.

`apps/api/internal/httpapi/persistence_integration_test.go` adds the exact
managed-database regression for atomic rollback, idempotent replay, complete
commit, and a `201` zero-event cutover with `events=0` and `created=0`.
The test is present and selected by name, but was not executed because the
approved managed TEST_ONLY database profile was absent.

`apps/web/e2e/market-attribution.spec.ts` passed in desktop and mobile
Chromium. It proves visible source, order ID, observation time, freshness, and
the attributed HTTPS venue link; it also proves that missing, off-host, or
non-HTTPS links are not rendered and that the UI states execution completes on
the external venue.

## Authoritative Go evidence

The exact code head and both idle-deadline Go files were hash-bound before the
managed run. A fixed Go 1.26.5 image ran with networking disabled and a
run-specific temporary cache. `gofmt -l`, `go mod verify`, `go vet ./...`,
`TestMarketSnapshotRefreshesIdleDeadlinesWithProgress`, and
`TestMarketSnapshotKeepsOrdinaryDeadlinesUntilRequestIsAuthorized` all
completed successfully. The non-database HTTP API suite selected 34 top-level
tests: 33 passed, one existing Redis integration test skipped, and zero failed;
the skipped integration test is not counted as a pass. The checkout remained clean and all run-specific
process, cache, container, and temporary residue was removed.

- Terminal evidence SHA-256:
  `91218a7f778e5cc56e92f44421ba0e3816b406318bcf84828bb74388f2f3df71`
- Evidence index SHA-256:
  `134bdebc5bd068a1ff500daade8793a73331793df3d445eab4fa2bab516ba76c`
- Persistent evidence archive SHA-256:
  `2dad70ec754c67b82bd51a00413cb743a13ac62f565d1b43e0c8fb77e569cbc5`

## Managed database boundary

The database Gate0 ran and failed closed before any connection or mutation.
The managed tunnel was healthy, but no approved minimum-privilege opaque
TEST_ONLY profile was available in the execution context. Therefore:

- no database connection was attempted;
- no schema or account was created;
- no production schema, real data, or local database substitute was used;
- the integration test was not skipped and was not reported as passing;
- run-specific residue is zero.

Stable code: `CTYUN_MYSQL_MANAGED_TEST_PROFILE_UNAVAILABLE`.

Gate evidence SHA-256:
`feb4586cd3fc8c0ee40247e2cbcc063db814a032d93338136758542f9cc701b2`.

The only remaining database action is controlled injection of an opaque,
minimum-privilege TEST_ONLY profile permitting create/use/drop of one exclusive
random schema. After injection, the same exact-head test must run and remove
that schema.

## CI boundary

Code-head quality run `35478328795` terminated before execution. All five
jobs reported failure with zero steps and no logs, classified as
`CI_RUNNER_ZERO_STEP_INFRASTRUCTURE_FAILURE`. This is infrastructure evidence,
not a candidate test failure; no retry loop is used.

## Limits

- These are repository, browser-fixture, build, and bounded runtime results,
  not a live OpenSea connection.
- No transaction, signing, broadcast, custody, settlement, or real-asset action
  was performed.
- The database integration result and fresh final-head review remain open.
- XM.3 remains `IMPLEMENTED-NOT-VERIFIED`; no count or status is promoted by
  this report.

