# Cluster operations

Scope: inherited PRD M6.2 and M6 monitoring. The package includes configuration
renderers, lifecycle tools and isolated tests. These files do not deploy or modify
a host. Actual production allocations, TLS material, network access and service
activation belong to the authorized deployment operator.

## Two application nodes

Install the **same checked artifact** into distinct node prefixes using
`runtime/bin/node tools/install/artfi.mjs install --prefix ...`. Each node has its
own web/API listeners, logs, process records and Next cache. Use one approved
public web origin and the same primary database. The node configurations must
share the existing session/bridge/indexer secrets through the operator's protected
configuration delivery; independently generated node secrets do not form a shared
login service. Share the object-storage bucket and rights-aware storage policy.
No production credentials belong in this repository or installation archive.

The load-balancer prerequisite is an approved prebuilt Nginx installation (1.30.5
was exercised here). Application installation does not compile or install Nginx.
Copy `tools/operations/cluster-config.example.json` outside the release, replace
its explicitly TEST_ONLY loopback allocations, and render with:

```sh
runtime/bin/node tools/operations/cluster-config.mjs private-cluster.json nginx.conf
nginx -t -c /absolute/path/nginx.conf
```

The renderer never starts or reloads Nginx. Its example ports are local test
allocations, not production defaults. On CTYun, set `hostClass` to `ctyun`;
TCP 443 remains reserved for SSH. Reuse confirmed allocations rather than guessing.
The public listener proxies to **web nodes only**. The separate internal API pool
must not become a public bypass around the web BFF. Set each web node's
`ARTFI_API_URL` to its approved internal API pool. Keep the same-origin public
GET-only relay and authenticated mutations unchanged.

### Existing delivery and execution zones

The chain-capable BFF must run in the approved SIN execution zone. Do not set the
SIN flag on a delivery/database node just to bypass the application's boundary.
The optional `bffExecution` pool keeps the public origin unchanged while routing
only `/api/*` to approved execution-side Next/BFF instances from the same package.
Pages and the public catalog relay stay on the delivery web pool; the Go API and
primary database retain their established delivery-side placement.

Set `bffExecution.executionZone` to `sin`, its two or more explicitly allocated
`backends`, and verified `backendTLS` for remote hosts. It creates no new public
listener. Configure execution instances with their existing SIN zone setting,
private venue/RPC inputs, the same public origin/session bridge identity and the
approved internal Go API URL. Delivery instances do not receive public-chain
execution permission. Proxy headers preserve the public Host and scheme; browser
cookies keep their ordinary same-origin authentication boundary. No new wallet
protocol or cross-origin session sharing is introduced.

This optional pool is a routing tool for existing approved allocations, not a
request to provision a new cloud, change a firewall or guess a port. Its isolated
test uses separate labeled loopback backends and makes no public-chain request.

Non-loopback listeners require explicit certificate/key paths. Remote backends
require `backendTLS` with the approved shared certificate `serverName` and
`certificateAuthority` path. Internal remote API listeners additionally require
`allowedClients` IP/CIDR entries. TLS files are operator-provided private inputs;
this tool neither issues certificates nor weakens certificate verification.

Nginx uses bounded passive upstream failure detection. A failed GET can fail over.
A POST already dispatched to an upstream is **not automatically replayed** on
another node: its result may be unknown and the application must reconcile the
existing operation. Restore a failed node, verify readiness, and let the passive
recovery window expire. This is not a claim of zero dropped requests during every
compound failure or a replacement for application idempotency.

Uploads, sessions, signed orders and Vault operation state are primary-database
backed. Process-local maps are not the authority for shared upload completion or
Vault submission/replay. Shared object storage is still required; per-node memory
stores are only isolated test fixtures. MySQL replicas are recovery/read-only
operations targets; application mutations and authoritative session reads stay
on the primary. See `MYSQL_RECOVERY.md` for database lifecycle procedures.

## Health, logs and alerts

`/healthz` reports API process liveness. `/readyz` additionally queries the mandatory
primary database and returns 503 while it is unavailable. Optional chain, venue
or object-storage features retain their own explicit unavailable states. Start
application services after the schema and database are ready; if an API was
started before its initial persistence connection succeeded, restart that API
when the database is ready. A connected pool can reconnect after a later outage. API SIGTERM shutdown stops
accepting new work and gives accepted requests up to twenty seconds to complete;
a hard kill still uses the documented durable-operation reconciliation.

API process logs and Nginx access logs are JSON. Access summaries omit query
strings, headers, credentials and request bodies. The existing service-unit
stdout/stderr streams are collected by the service manager; the operator's
approved central collector can combine these structured streams across hosts.
Do not ship secret-bearing raw configuration, database dumps or wallet material
to a log service. Production central log destination and notification routing
remain deployment inputs.

`tools/operations/monitor.mjs` performs bounded read-only application, primary
readiness, host-memory/load/disk and optional chain-freshness probes. It emits
machine-readable alerts on stdout and exits nonzero on alerts in `--once` mode;
`--watch` emits recurring samples for the approved supervisor/alert collector.
It does not send external notifications or invent a destination.

```sh
runtime/bin/node tools/operations/monitor.mjs private-monitor.json --once
runtime/bin/node tools/operations/monitor.mjs private-monitor.json --watch
```

Use a format-1 JSON object with `probes`, `intervalSeconds` (5–3600), optional
`diskPath`, `minimumFreeMemoryRatio`, `minimumFreeDiskRatio`, and
`maximumLoadPerCPU`. An HTTP probe has `name`, `kind: "http"`, `url`, and optional
expected `service`. A chain probe has `kind: "chain"`, `chainId`,
`maxAgeSeconds` and the approved read RPC URL. Public-chain probes require
`executionZone: "sin"`; they must not run from the delivery/database zone.
Credential-bearing URLs are rejected. Missing, stale, wrong-chain and unavailable
results remain distinct. No transaction or signature is sent by monitoring.

## Isolated regression

The source tests use fresh loopback listeners and TEST_ONLY requests:

```sh
node --test scripts/operations/cluster-config.test.mjs scripts/operations/monitor.test.mjs
ARTFI_TEST_NGINX=/absolute/path/to/nginx node --test scripts/operations/cluster-runtime.integration.mjs
```

The Nginx regression validates its generated configuration, two web/API pools,
backend outage/recovery and a dispatched uncertain POST recorded exactly once.
MySQL-backed Go integration separately verifies live cross-instance upload
completion, Vault create/replay/submission and readiness. These tests do not
constitute production cluster deployment, independent security review, live
chain acceptance, or a final continuous-operation soak.
