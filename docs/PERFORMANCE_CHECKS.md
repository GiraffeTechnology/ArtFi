# Finite local performance checks

## Requirement and scope

The baseline is the incorporated original NFR in [PRD §5](PRD.md#5-nonfunctional-requirements): API p95 below 500 ms, at least 100 concurrent users and 50 concurrent trades, trade confirmation below 30 seconds excluding block confirmation, gas estimation below 5 seconds, page load below 3 seconds, wallet connection below 2 seconds, and 48 continuous hours in the applicable final-deployment acceptance.

`scripts/test/performance-local.mjs` is a reproducible, finite, **TEST_ONLY local regression profile**. It supplies useful measurements of actual application processes and actual local contract settlement. It does not declare final-production NFR acceptance, public Hoodi acceptance, 48-hour availability, or Stage 2 NO-HIL soak. The numeric chain ID `560048` only selects the application's supported schema. Every block, asset, balance, signer, session, and receipt in this profile is freshly generated locally.

## What runs

1. Start an official no-fork Anvil bound to `127.0.0.1`, with no pre-generated accounts, no stored keys, no raw transaction logging, and no external RPC parameter. Generate disposable signers in memory and fund them with local test balances.
2. Verify the existing compiled contract artifacts against **every source hash in their Solidity compiler metadata**. Stale artifacts fail before deployment. Deploy the existing whole-artwork and fractional markets plus the existing test-token fixtures, configure permissions, and prepare balances and allowances. Setup work is excluded from timing.
3. For each market, run a burst of 50 gas estimates and submit 50 distinct buyer transactions concurrently. Disable automatic mining until the transaction pool proves all 50 are pending and none are nonce-gap queued. Mine one local block, then check all successful receipts, the matching settlement events, resulting ownership or fractional balances, the consumed intent state, buyer payment debits, seller payment credits, and the absence of resting market balances. An intent submission, transaction hash, or HTTP acknowledgment never counts as settlement. The EVM still executes transactions serially inside the block; the concurrency observation is 50 simultaneously in-flight trades.
4. Start a fresh real MySQL instance and apply the selected bundle's migrations. Start two instances of the selected actual Go API binary, two instances of the selected packaged Next web application, and actual Nginx using the delivered cluster-config renderer. All processes and the load generator run in one session/network namespace.
5. Establish **100 distinct wallet-signed web sessions**, using the actual challenge/verification BFF. Feed public signed-order envelopes and decoded events from the local settlement receipts into the existing API projection routes. This is receipt-derived test data, not fabricated settlement status. Only settlement receipts are indexed; the smaller fixture does not claim complete historical portfolio reconstruction.
6. Warm up the exact routes, then run two sequential profiles: direct internal API through Nginx, and complete web/BFF through Nginx. Each uses 100 virtual users, one outstanding request per user, 12 rounds of three requests, zero think time, and no retries. Every user reads its own persistent session, a nonempty order page, and its own nonempty authenticated portfolio/history/notifications. Requests use a 10-second timeout. Health probes are excluded from all latency samples.
7. When explicitly requested by duration flags, retain both unchanged burst profiles and then add one time-bounded profile per HTTP surface. These also use 100 users, one outstanding request each, zero think time, and no retries. A shared request-start budget enforces both the selected duration and a strict per-surface request-count cap. The result records which bound stopped traffic; reaching the cap early is never described as completing the requested duration.
8. Verify that all four web/API backends served requests. Stop all child services, remove only this run's disposable database, and retain reports, service logs, non-secret request timings, and transaction receipt identifiers.

The profiles are intentionally finite and sequential. They do not prove simultaneous market-wide production load, long-running stability, large historical databases, browser rendering performance, wallet-provider UX, live OpenSea settlement, or public-chain congestion/finality. No RWA issuance flow is called. This is not an independent security review.

## Run it

Prerequisites:

- The source workspace's installed Node dependencies, including `ethers`
- A complete extracted ArtFi installation bundle with `source-manifest.json`, migrations, packaged Node and Next web runtime
- The exact API executable being evaluated, supplied separately so the selected artifact is unambiguous
- MySQL 8.4 binaries and supporting libraries, actual Nginx, and official Anvil
- Current precompiled Solidity artifacts in `packages/contracts/out`; rebuild through the repository's normal contract-build procedure if the source-hash check reports them stale
- Enough disk space for a disposable MySQL data directory; coordinate other builds/load generators before measurement

Official Anvil packages are published under [`@foundry-rs/anvil`](https://www.npmjs.com/package/@foundry-rs/anvil); the measured tooling version is recorded in each report. This runner does not download software or silently select an external service.

```sh
node --test scripts/test/performance-common.test.mjs

node scripts/test/performance-local.mjs \
  --smoke \
  --bundle-root "$BUNDLE" \
  --api-binary "$API_BINARY" \
  --mysql-base "$MYSQL_BASE" \
  --nginx "$NGINX_BINARY" \
  --anvil "$ANVIL_BINARY" \
  --output-root "$EVIDENCE_ROOT"
```

The smoke flag runs four users and two trades per market; **a smoke pass is never a concurrency-NFR pass**. After arranging a quiet resource window, replace `--smoke` with `--measurement-window-approved` for the fixed 100-user / 50-trade profile. There is no parameter for a remote target.

For an additional **30-second sample per surface**, append `--duration-seconds 30 --max-requests 90000`. The default burst behavior is unchanged when these flags are absent. Supported duration is at most 60 seconds and the safety cap is at most 150,000 requests per surface. The 90,000-request choice allows headroom over the preliminary measured throughput while limiting worst-case work. This is closed-loop concurrency with no additional rate limit or think time, not a fixed arrival-rate test. Outstanding requests are allowed to finish after the duration stops new starts, so total wall time can slightly exceed 30 seconds.

The full run exits 0 when this local profile's correctness and latency thresholds are met, 2 when measured local thresholds are not met **or the request cap ends a requested timed profile early**, and 1 for setup or assertion failure. It does not skip missing dependencies and report success. Each run creates a unique `performance-local-*` evidence directory.

## Evidence format and interpretation

- `results.json`: environment, timestamps, chosen artifact paths, executable hashes, bundle source-manifest hash, migration hashes, harness hashes, test data counts, topology, per-route sample counts and p50/p95/p99/max, failure counts, throughput, and explicit unrun acceptance dimensions
- `local-chain-results.json`: exact artifact hashes, test-only contract addresses, all settled receipt hashes/block numbers, 50-pending assertions, gas-estimate timing, RPC-submission timing, and receipt-plus-state-verification timing
- `api-samples.json` and `web-bff-samples.json`: all burst HTTP samples, including failures; the optional additional profiles write separate `duration-api-samples.json` and `duration-web-bff-samples.json` files. No wallet secrets, cookies, session tokens, sale signatures, or raw signed transactions are included.
- Nginx and service logs: request status/routing evidence without authentication headers

Percentiles use the nearest-rank method. HTTP time includes response-body consumption and validation and is measured at the load generator. A route's errors cannot be hidden by excluding failed samples. The p95 threshold is checked per route, as well as reported in aggregate. Trade timing includes the deliberately controlled local mining delay and state verification; public block confirmation/finality is not inferred from it. Gas-estimate and settlement thresholds use the maximum measured sample, while API latency uses p95 as specified.

## Measured preliminary candidate: 2026-10-06

The initial smoke check and the final pre-measurement smoke check each passed with four signed users, two actual settlements per market, and 24 requests per HTTP profile. A subsequent **full local profile** ran from `2026-10-06T02:24:00.129Z` to `2026-10-06T02:24:17.607Z` and returned `local-profile-thresholds-met`.

Selected artifacts:

- Frozen v7 installation bundle: `artfi-integrated-candidate-20261006-linux-x64`
- Bundle source-manifest SHA-256: `4bcb919213b2b842072a61675e38dca2353ad2964c52ff2febebd91fbffb0e20`
- Source-built M6 API executable SHA-256: `715ea681940b6c1a66d28d48064f61070b8623b1dccf95bb30742333d7d9603a`
- Packaged web server SHA-256: `49774097763c85104f5a1b0ba12d7407cb51a067b498df78d90b94bff755c632`
- Linux x64 shared executor; 9 visible logical CPUs, approximately 9.7 GiB memory; Node 24.21.0, MySQL 8.4.11, Anvil 1.7.1, Nginx 1.30.5
- Quiet window coordinated with the delivery owner; other work existed on the executor. **Exclusive resource isolation was not established.** The load generator, database, application services, and local EVM shared this machine.
- 100 distinct signed sessions, 100 real locally settled order envelopes, 250 indexed events taken from the settlement receipts, and 39 MySQL tables from the bundle's 13 migrations. No Redis was configured.

| HTTP surface                   | Users / peak in flight | Requests / failures | Aggregate p95 |    Worst endpoint p95 | Aggregate p99 / maximum | Timed HTTP duration |
| ------------------------------ | ---------------------: | ------------------: | ------------: | --------------------: | ----------------------: | ------------------: |
| Internal API through Nginx     |              100 / 100 |           3,600 / 0 |     76.487 ms |  Portfolio: 86.384 ms |    104.385 / 161.257 ms |             1.572 s |
| Packaged web/BFF through Nginx |              100 / 100 |           3,600 / 0 |    218.476 ms | Portfolio: 267.873 ms |    518.000 / 911.137 ms |             3.231 s |

Each endpoint has 1,200 samples. API p95 by route: session 56.225 ms, orders 75.810 ms, portfolio 86.384 ms. Web/BFF p95 by route: session 196.453 ms, orders 194.913 ms, portfolio 267.873 ms. The web tail exceeded 500 ms at p99; it is preserved rather than hidden behind the passing p95 requirement. Both web backends and both API backends served requests.

| Local contract profile          | Simultaneously pending | Receipt/state verified | Receipt + state p95 / maximum | Maximum gas-estimate time | Local blocks |
| ------------------------------- | ---------------------: | ---------------------: | ----------------------------: | ------------------------: | -----------: |
| Whole-artwork signed settlement |                     50 |                50 / 50 |          490.225 / 491.030 ms |                 64.210 ms |            1 |
| Fractional signed settlement    |                     50 |                50 / 50 |          431.468 / 432.729 ms |                 52.403 ms |            1 |

The HTTP phases together lasted less than five seconds; these are finite burst measurements, **not sustained-capacity or soak evidence**. The local trade times include controlled mining and verification. This result covers the specifically identified v7/M6 artifacts only. A changed combined installation candidate needs its own exact-artifact rerun before inheriting this claim.

Checkpoint evidence is preserved separately in the delivery workspace's `evidence/performance-preliminary-v7/`: the complete results, raw HTTP samples, local receipt identifiers, executable/source/artifact hashes, run summary, and an independent offline recomputation receipt with file digests. The original run's service logs remain in `runtime-cache/performance-local-Ep4zPs/`. The disposable database was stopped and removed. Three focused helper tests and the full local smoke/profile ran successfully. One earlier harness-only smoke attempt failed before service startup due to a variable-name collision; that was fixed and both smoke and full profile were rerun. No application code was changed for the measurements.

Final-production acceptance, 48-hour availability, and Stage 2 NO-HIL soak remain **not run** by these scripts.

The optional timed-profile request-budget helper has three additional passing focused tests (six helper tests total). Its exact combined-candidate runtime measurement is pending the selected installation artifact and a coordinated resource window; adding the flags alone does not establish a timed-profile pass.
