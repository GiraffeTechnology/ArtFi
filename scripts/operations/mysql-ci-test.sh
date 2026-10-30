#!/usr/bin/env bash
# Reproduce the real MySQL M6.2 suite on a Docker-capable Linux CI runner.
# TEST_ONLY: no published ports, no mounted Docker socket, no production sources.
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
CACHE="${ARTFI_MYSQL_CI_CACHE:-${RUNNER_TEMP:-$ROOT/.artfi-test-cache}/mysql-operations}"
mkdir -p "$CACHE"
CACHE="$(cd "$CACHE" && pwd)"
RUN="$(mktemp -d "$CACHE/ci-XXXXXX")"
IMAGE="${ARTFI_MYSQL_CI_IMAGE:-mysql:8.4}"

# Record the actual official image digest in CI evidence. Override the default
# with an approved mysql@sha256:... reference when pinning a deployment pipeline.
if [[ "$IMAGE" != mysql:8.4 && "$IMAGE" != mysql@sha256:* ]]; then
  echo "Use the official mysql:8.4 image or its approved immutable digest." >&2
  exit 1
fi
docker pull "$IMAGE"
docker image inspect "$IMAGE" --format '{{json .RepoDigests}}' > "$RUN/mysql-image-digests.json"
(
  cd "$ROOT/apps/api"
  CGO_ENABLED=0 go build -trimpath -o "$RUN/artfi-migrate" ../../scripts/install/migrate/main.go
)

# Both servers and all clients live in one disposable network namespace. There
# are no external connections, mapped service ports or privileged containers.
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$ROOT,dst=/source,readonly" \
  --mount "type=bind,src=$RUN,dst=/test-cache" \
  --mount "type=bind,src=$NODE,dst=/artfi-node,readonly" \
  --workdir /source \
  --env ARTFI_MYSQL_BASE=/usr \
  --env ARTFI_MYSQL_TEST_CACHE=/test-cache \
  --env ARTFI_MYSQL_MIGRATOR=/test-cache/artfi-migrate \
  --env ARTFI_MYSQL_TEST_PORT=34860 \
  --entrypoint /bin/sh "$IMAGE" -c '
    set -eu
    export ARTFI_MYSQL_SERVER_BIN="$(command -v mysqld)"
    /artfi-node --version
    mysql --version
    exec /artfi-node --test scripts/operations/mysql-recovery.test.mjs scripts/operations/mysql-integration.test.mjs
  ' 2>&1 | tee "$RUN/test.log"

echo "TEST_ONLY MySQL CI evidence: $RUN"
echo "Publish only the synthetic test.log, summary.json and image digest; never real connection files or database dumps."
