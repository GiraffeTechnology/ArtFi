# ArtFi monitor-only candidate

User directive: test and production 24×7 operations, with CTYun **host alias** Aivan
QWEN3.5:9B preferred for sanitized analysis. This is not the Giraffe Agent product.
Implementation maps to PRD M6.3 and NFR.7. Neither is verified by unit tests.

Current candidate: deterministic local probes → durable incident/recovery queue →
optional bounded classifier and notifier. No shell/action executor, signing, database
mutation, transaction broadcast or legal-rights decision exists. Model output accepts
only four suggestion labels; it cannot change a probe result or execute instructions.
Notifications use an explicit field projection, not the persisted event object. A
restored event must have a valid original logical check ID, environment, category and
bounded identity fields before either optional adapter is called; arbitrary diagnostic fields
are never forwarded. The two corresponding negative tests use synthetic markers only.

`node --test scripts/ops/*.test.mjs` tests the core and an actual ephemeral loopback
HTTP server. That server is synthetic test infrastructure, not a deployed ArtFi service.
`node scripts/ops/monitor-service.mjs /controlled/config.json --once` runs one tick;
without `--once` it is a standalone loop independent of a Codex conversation.

Configuration is not supplied with invented endpoints. A verified deployment supplies
schemaVersion 1, enabled true, inventoryVerified true, mode monitor-only, environment
test/production, the verified four-host logical hostRole, independent absolute
stateDirectory and stopFile, intervalMs 1000–300000 and 1–64 checks. Each check has a
logical id, category, maxAgeMs, kind and approved **literal loopback** HTTP URL.
Liveness probes only establish process HTTP availability, not DB/provider readiness.
The sanitized-metrics adapter accepts exactly available/fresh/observedAt; no raw body,
credentials or application data is forwarded to an LLM.

Open deployment gates: actual CTYun Aivan endpoint/model/auth/resource verification,
approved notification channel, service-user ACLs and single-instance enforcement,
startup/crash recovery service unit, bounded retention/rotation, capacity/backup/mirror
telemetry adapters, controlled four-machine inventory, and test fault/soak evidence.
The local host-capacity adapter supplies only host telemetry. The optional backup
integrity adapter below supplies file-integrity/age observations only; mirror freshness,
database readiness and real backup/restore acceptance remain separate requirements.
The `artfi-monitor@.service` template proposes separate test/production users/state,
nonblocking process-lifetime flock, least privilege, loopback-only networking and
bounded restart attempts. It is not installed. Verified target paths/runtime pins,
user creation, journal retention and an external stale-heartbeat watcher remain
deployment prerequisites. Reaching the restart limit needs human intervention;
never report it as a running 24x7 service.
There is no default model/notifier enabled. Events persist pending a verified channel;
delivery uses stable IDs and bounded retries, requiring receiver deduplication. Pending
events must not be silently evicted. Tests and production must use separate identities,
directories and notification routes. A STOP file disables collection without deleting
evidence. No production 24×7 availability or Qwen integration is claimed.

### Operational queue retention (not an audit-log archive)

`deliveredRetentionMs` defaults to seven days after the notifier acknowledges the
stable event ID; the accepted range is one second to ninety days. `maxQueueEntries`
defaults to 4096 (range 1–10000). Acknowledged records expire by age or are removed
oldest-first to admit new events at capacity. Separate persistent counters record
age/capacity removals. This local queue is not an immutable long-term audit archive;
receiver-side archival and journal rotation remain deployment gates.

`pending` and `needs-human` records are never automatically removed. When no
acknowledged slot can be reclaimed, the entire new observation batch is discarded
atomically, previous incident IDs/queue remain, and `collection.status` becomes
`capacity-blocked` with `MONITOR_QUEUE_CAPACITY_BLOCKED`. The successful collection
heartbeat is **not** advanced. Existing pending notifications can still drain. A
later successful collection records the gap's start/end; observations during that
gap are not retroactively invented. Lowering capacity below an existing unexpired
queue is refused without rewriting it. Operators must supply enough capacity and a
verified channel; an independent watcher must alert on this status/stale heartbeat.

`monitor-crash.test.mjs` starts independent test-only Node workers, kills only those
owned child processes after persistence or after a synthetic receiver applies an
event but before ACK, then restarts a new worker against the same test state. Stable
IDs prevent duplicate receiver effects **only when the receiver deduplicates them**;
delivery itself remains at-least-once. This is not a systemd reboot test, disk-full
test, power-loss durability proof, or verification of a real notification channel.
The fixture is not imported by the production service.

`monitor-storage.test.mjs` reproduces serialization and rename failures on owned
temporary test directories. Failed writes preserve prior committed bytes and remove
only the temporary file created by that write; unrelated files are untouched.
Serialization happens before file creation. Write/cleanup failures propagate bounded
error codes, not success. This does not establish disk-full, parent-directory fsync,
power-loss durability or recovery of temporary files after an uncatchable process kill.

Restored check counters, incident IDs and statuses are validated before probing or
rewriting the heartbeat. Check lookup uses own properties so a valid logical ID such
as `constructor` cannot be mistaken for inherited state and silently suppress an
incident. Corrupted state is refused, not repaired or discarded automatically.

Pending and exhausted events keep their original validated check identity when the
active probe list changes; retiring a probe neither deletes its events nor blocks
remaining delivery. Only active probes collect new samples. Recovery records must
be healthy, incident records non-healthy, and delivered records require a timestamp
which is forbidden on pending/exhausted records. Corruption is rejected before any
probe/adapter or state rewrite, not silently pruned.

Durable observations bind category as well as logical check ID. Reusing an ID for
a different category resets its observation counters/incident, but preserves all old
queued events. Legacy category-less state can recover category only from its own
validated queued incident; without that evidence it resets instead of assuming the
new configuration's category. Contradictory category/incident state is rejected.

Service shutdown propagates into the active tick and its bounded probe/model/notifier
calls. Observation/queue persistence is separate from the completed-tick heartbeat:
the heartbeat advances only after processing reaches a non-aborted endpoint. An
interrupted notification retains the prior heartbeat and its durable pending ID/attempt.
An interrupted notification retains the persisted pending ID and attempt because its
remote effect is uncertain; receiver-side deduplication remains required. Local tests
exercise an actual hanging loopback request and notification cancellation. Filesystem
syscalls themselves are not abortable; these tests do not prove bounded shutdown of
a stalled storage device or a real systemd installation.

### Read-only host capacity checks

The service also accepts `kind: "host-capacity"`, `category: "capacity"` checks
with the existing logical `id` and `maxAgeMs`. Supply an explicit absolute `diskPath`
from the verified deployment inventory. There is no default path, endpoint, new
account, service installation or automatic resource cleanup. HTTP probe restrictions
remain unchanged, and capacity checks cannot include an HTTP URL or arbitrary fields.

Optional `minimumFreeDiskRatio`, `minimumFreeMemoryRatio` and `maximumLoadPerCPU`
use the existing read-only monitor defaults: 0.1, 0.05 and 2. Ratios must be strictly
between zero and one; load must be positive. `minimumFreeDiskBytes` is an optional
nonnegative safe integer floor in addition to the disk ratio. Block counters and
the byte-floor comparison use BigInt; missing, invalid or inaccessible measurements
are refused as healthy evidence. A completed low-capacity observation has
`available: false, fresh: true`; a telemetry read failure has both flags false.

Only `available`, `fresh` and `observedAt` enter the existing incident evaluator.
Disk paths, capacity numbers and exception text do not enter events, notifications
or optional model analysis. All configured thresholds must pass for a healthy sample.
Shutdown is checked before/after sampling, and the original monitor's bounded tick,
queue persistence, incident threshold, STOP file and heartbeat rules still apply.
Filesystem stat calls themselves are not abortable; a timed-out call cannot become a
successful tick. Host capacity does not establish DB, backup, chain or business health.
Unit/source checks and one read-only native host observation do not install this
service or establish durable incidents, real delivery channels or 24x7 availability.

### Read-only backup integrity observations

`kind: "backup-integrity"`, `category: "backup"` accepts the existing logical
`id`/`maxAgeMs` plus an explicit absolute `backupDirectory` and safe integer
`maxBackupAgeMs` of at least 1000 milliseconds. No path, backup schedule, storage
provider or age threshold is invented. The service identity must already have the
approved read access required by the recovery tool's owned private backup format;
this adapter never changes ownership, permissions or credentials.

The adapter reuses `tools/operations/mysql-recovery.mjs` verification of the completed
`artfi-mysql-backup-v1` manifest, schema checksum and actual SQL bytes/SHA-256. It
uses the manifest's canonical UTC `createdAt`, not a copied file's new modification
time. Missing, invalid or future creation times cannot report healthy. An intact
but old backup is stale; corruption or inaccessible storage is unavailable.

Only `available`, `fresh` and the current `observedAt` enter the incident evaluator.
Paths, SQL, schema, database names, hashes and exceptions never enter optional
model/notification payloads. In this check, healthy means only recent file integrity:
the observation explicitly does not verify authenticity, successful restoration,
off-host retention, encryption, RPO/RTO or database readiness. Accepting a trusted
backup for restore and verifying its independent recovery remain separate operator
actions. No restore, SQL execution, promotion, activation or deletion is performed.

The original bounded monitor signal propagates into the SQL read stream, and its
opened descriptor is closed after completion or failure. Slow scans can time out
instead of becoming healthy; storage syscalls themselves may remain uninterruptible.
An abort is not a guarantee that a stalled filesystem or device has terminated.
Choose the check inventory and interval within the verified host's actual resource
budget; unit fixtures do not establish real deployment or continuous operation.
