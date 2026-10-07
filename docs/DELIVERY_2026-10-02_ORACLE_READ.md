# Whole-artwork Oracle read integration

This connects the existing whole-artwork receipt screen to the implemented public Oracle read API. The delivery owner selected this bounded integration when resuming the three-section coding task after requirement-source review. Its authority is the current receipt/voucher product definition and that explicit integration task; issue or PRD inheritance is not used to approve additional scope.

## User path

Open the configured whole-artwork page, inspect the Oracle token/asset state and certificate/warehouse facts, refresh them, and recover from an unavailable or offline source. The source's public facts and observed chain state are shown separately; neither is presented as proof of unspecified rights. Other artwork pages cannot read the configured token under a different identity.

The same-origin `GET /api/assets/{slug}/oracle` resolves only a known catalogue slug and its existing whole-artwork collection/token/slug binding. It reads the existing Oracle token endpoint and the returned asset endpoint. The adapter and UI:

- validate token, asset, certificate and warehouse subject bindings;
- preserve the source's case-sensitive contract key;
- whitelist documented public fields and strip unknown/private fields;
- reject redirects, bound each request to four seconds and 64 KiB, and omit upstream credentials and raw errors;
- separately attribute the token and asset reads, including differing reported states;
- distinguish missing configuration, wrong-page binding, 404, 410, invalid data, timeout and transport failure;
- hide previous successful facts while refreshing or while a read is paused offline, and allow retry;
- report that the public source does not expose a registry-holder address, source-authority identity, signed proof, freshness expiry or finality.

A reported `VALID` value is the Oracle's public read state. It is not an unconditional right to transact, physical title, mint authority or confirmation that pickup occurred. The panel is informational. It introduces no issuance or trading prerequisite, and does not implement or determine any separate attestation or pre-mint policy.

## Existing source contract

Oracle source was pinned to `59295e82c7ce78d13661dcada278ec2a1c3ebbbf` and checked against its implemented routes and public schema projections:

- [Token and asset routes](https://github.com/GiraffeTechnology/Oracle/blob/59295e82c7ce78d13661dcada278ec2a1c3ebbbf/src/app.js#L309-L351)
- [Public record field projections](https://github.com/GiraffeTechnology/Oracle/blob/59295e82c7ce78d13661dcada278ec2a1c3ebbbf/src/domain/schema-registry.js#L100-L150)

No new Oracle endpoint is assumed. This change does not import the independent BoundedIntent Agent stack.

## Configuration and handoff

Base: merged ArtFi `da59d3c383b2dca33e949049d59867fcd0a03093` (same file tree as the fully-tested #131 head).

The only new setting is the empty, server-only `ARTFI_ORACLE_READ_API_URL` placeholder. The existing artfi control task should resolve the already-deployed Oracle read service through the established bridge/backend path. It reuses the current whole-artwork public collection/token/slug settings and Hoodi chain. No public URL variable, Docker build argument, new host, credential or live source was configured.

The required sequence remains: complete coding and tests, hand over a fixed candidate and non-secret configuration contract, deploy through the existing authorized task, then verify runtime behavior. The UI and chain-execution zone and backend/database split remain as recorded in `DEPLOYMENT_ENVIRONMENT.md`. This code work did not inspect or modify those servers.

## Verification

After integration with the latest #131 fixes:

- Web unit suite: 252 passing (206 existing and 46 Oracle adapter/state/route regressions).
- Web lint, TypeScript and default Next/Turbopack build: passing.
- Independent review completed; the identified offline-paused stale-fact defect was fixed and independently rechecked with actual QueryObserver/onlineManager tests.
- Fourteen desktop/mobile browser cases are registered in the separate `oracle-browser` CI job. Local browser execution is unavailable because this cloud runtime denies Chromium's required sockets; no local browser or screenshot pass is claimed.
- No live Oracle/registry call, mint, transaction, deployment or full product acceptance is claimed. Exact-head CI results are recorded on the pull request.
