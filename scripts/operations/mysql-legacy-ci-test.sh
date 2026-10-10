#!/usr/bin/env bash
# Explicit adoption compatibility: all 22 checks, including two real MySQL servers.
# TEST_ONLY: no production sources, external runtime network, ports or Docker socket.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
for tool in docker node go; do
  command -v "$tool" >/dev/null || { echo "Missing CI prerequisite: $tool" >&2; exit 1; }
done
if [[ "$(id -u)" == 0 ]]; then
  echo "Run this fixture as the non-root CI runner account." >&2
  exit 1
fi
NODE="$(node -p 'process.execPath')"
node -e 'if (+process.versions.node.split(".")[0] < 24) process.exit(1)'
CACHE="${ARTFI_LEGACY_CI_CACHE:-${RUNNER_TEMP:-$ROOT/.artfi-test-cache}/mysql-legacy-adoption}"
mkdir -p "$CACHE"
CACHE="$(cd "$CACHE" && pwd)"
RUN="$(mktemp -d "$CACHE/ci-XXXXXX")"
IMAGE="${ARTFI_LEGACY_CI_IMAGE:-mysql:8.4.11}"
if [[ "$IMAGE" != mysql:8.4.11 && "$IMAGE" != mysql@sha256:* ]]; then
  echo "Use official mysql:8.4.11 or its approved immutable digest." >&2
  exit 1
fi
# Pull only the official image; the disposable test container has no network.
docker pull "$IMAGE"
docker image inspect "$IMAGE" --format '{{json .RepoDigests}}' > "$RUN/mysql-image-digests.json"
(
  cd "$ROOT/apps/api"
  CGO_ENABLED=0 go build -trimpath -o "$RUN/artfi-migrate" ../../scripts/install/migrate/main.go
)

status=0
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$ROOT,dst=/source,readonly" \
  --mount "type=bind,src=$RUN,dst=/test-cache" \
  --mount "type=bind,src=$NODE,dst=/artfi-node,readonly" \
  --workdir /source \
  --env ARTFI_MYSQL_BASE=/usr \
  --env ARTFI_MYSQL_MIGRATOR=/test-cache/artfi-migrate \
  --env ARTFI_LEGACY_TEST_CACHE=/test-cache \
  --env ARTFI_LEGACY_TEST_PORT=34971 \
  --entrypoint /bin/sh "$IMAGE" -c '
    set -eu
    : "${ARTFI_MYSQL_BASE:?}" "${ARTFI_MYSQL_MIGRATOR:?}" "${ARTFI_LEGACY_TEST_CACHE:?}"
    test -x "$ARTFI_MYSQL_MIGRATOR"
    export ARTFI_MYSQL_SERVER_BIN="$(command -v mysqld)"
    test -x "$ARTFI_MYSQL_SERVER_BIN"
    "$ARTFI_MYSQL_SERVER_BIN" --version | grep -F "Ver 8.4.11 " >/dev/null
    exec /artfi-node --test --test-reporter=tap \
      scripts/operations/mysql-legacy-adoption.test.mjs \
      scripts/operations/mysql-legacy-adoption.integration.test.mjs \
      scripts/operations/mysql-recovery.test.mjs > /test-cache/test.tap 2>&1
  ' > "$RUN/container.log" 2>&1 || status=$?

# Retain only a schema-filtered synthetic summary and official image digest.
# Raw TAP/exception logs, cnf files, backup SQL, plans and datadirs stay private.
ARTFI_LEGACY_CI_RUN="$RUN" ARTFI_LEGACY_CI_STATUS="$status" node --input-type=module <<'JS'
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.env.ARTFI_LEGACY_CI_RUN;
const read = (path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
const tap = read(join(directory, "test.tap"));
const counts = Object.fromEntries(["tests", "pass", "fail", "skipped"].map((name) => [name, Number(tap.match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1] ?? -1)]));
const checks = [];
for (const name of readdirSync(directory).filter((value) => /^legacy-[A-Za-z0-9]+$/.test(value))) {
  try {
    const report = JSON.parse(read(join(directory, name, "summary.json")));
    for (const item of report.results ?? []) {
      if (typeof item.name === "string" && item.name.length <= 180 && !/[\r\n]/.test(item.name) && ["PASSED", "FAILED"].includes(item.result)) checks.push({ name: item.name, result: item.result });
    }
  } catch { /* An interrupted fixture is a failure, never a skipped success. */ }
}
const passed = process.env.ARTFI_LEGACY_CI_STATUS === "0" && counts.tests === 22 && counts.pass === 22 && counts.fail === 0 && counts.skipped === 0 && checks.length === 15 && checks.every((item) => item.result === "PASSED");
const summary = { scope: "TEST_ONLY fresh isolated MySQL; no production verification", result: passed ? "PASSED" : "FAILED", expectedMysqlVersion: "8.4.11", counts, integrationChecks: checks };
writeFileSync(join(directory, "public-summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
if (!passed) process.exitCode = 1;
JS
