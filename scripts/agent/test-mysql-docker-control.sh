#!/usr/bin/env bash
set -euo pipefail
DATA=${ARTFI_AGENT_TEST_MYSQL_DATA:?}
PROJECT=${ARTFI_AGENT_TEST_DOCKER_PROJECT:?}
FILE=${ARTFI_AGENT_TEST_DOCKER_COMPOSE:?}
[[ "$DATA" == */artfi-stage2-mysql.* && "$PROJECT" == artfi-agent-test-* && "$FILE" == "$DATA/compose.yaml" && -f "$DATA/database.json" ]] || { echo 'ISOLATED_DOCKER_TEST_REQUIRED' >&2; exit 1; }
COMPOSE=(docker compose -p "$PROJECT" -f "$FILE")
case "${1:-}" in
start) "${COMPOSE[@]}" up --detach --wait --wait-timeout 120 mysql >/dev/null;;
stop) "${COMPOSE[@]}" stop --timeout 15 mysql >/dev/null;;
*) echo 'TEST_MYSQL_ACTION_INVALID' >&2; exit 1;;
esac
