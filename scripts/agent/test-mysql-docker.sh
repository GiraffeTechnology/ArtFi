#!/usr/bin/env bash
# Hosted-CI only: an isolated official MySQL container and ephemeral TEST_ONLY DB.
# Does not connect to or restart the application's existing compose services.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CACHE=${ARTFI_AGENT_TEST_CACHE:-"$ROOT/.artfi-test-cache"}
mkdir -p "$CACHE"
DATA=$(mktemp -d "$CACHE/artfi-stage2-mysql.XXXXXX")
export ARTFI_AGENT_TEST_MYSQL_DATA="$DATA" ARTFI_AGENT_TEST_MYSQL_PORT=${ARTFI_AGENT_TEST_MYSQL_PORT:-33326}
export ARTFI_AGENT_TEST_MYSQL_CONFIG="$DATA/database.json"
export ARTFI_AGENT_TEST_DOCKER_PROJECT="artfi-agent-test-$(date +%s)-$$"
export ARTFI_AGENT_TEST_DOCKER_COMPOSE="$DATA/compose.yaml"
export ARTFI_AGENT_TEST_MYSQL_CONTROL="$ROOT/scripts/agent/test-mysql-docker-control.sh"
cat > "$ARTFI_AGENT_TEST_DOCKER_COMPOSE" <<YAML
services:
  mysql:
    image: mysql:8.4.11
    command: ["--mysqlx=OFF"]
    environment:
      MYSQL_ROOT_PASSWORD: TEST_ONLY_ISOLATED_MYSQL_ROOT
    ports:
      - "127.0.0.1:${ARTFI_AGENT_TEST_MYSQL_PORT}:3306"
    labels:
      artfi.test_only: "true"
    healthcheck:
      test: ["CMD-SHELL", "MYSQL_PWD=TEST_ONLY_ISOLATED_MYSQL_ROOT mysql --protocol=TCP -h127.0.0.1 -uroot -e 'SELECT 1' >/dev/null 2>&1"]
      interval: 2s
      timeout: 2s
      retries: 40
    volumes:
      - isolated-data:/var/lib/mysql
volumes:
  isolated-data:
YAML
COMPOSE=(docker compose -p "$ARTFI_AGENT_TEST_DOCKER_PROJECT" -f "$ARTFI_AGENT_TEST_DOCKER_COMPOSE")
# Only this newly created, uniquely named TEST_ONLY compose project is removed.
trap '"${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true' EXIT
"${COMPOSE[@]}" up --detach --wait --wait-timeout 120 mysql
MYSQL=("${COMPOSE[@]}" exec -T -e MYSQL_PWD=TEST_ONLY_ISOLATED_MYSQL_ROOT mysql mysql --protocol=TCP -h127.0.0.1 -uroot)
"${MYSQL[@]}" -e "CREATE DATABASE artfi_stage2_isolated_test; CREATE USER 'artfi_agent_test'@'%' IDENTIFIED BY 'TEST_ONLY_ISOLATED_DATABASE_PASSWORD'; GRANT SELECT, INSERT, UPDATE ON artfi_stage2_isolated_test.* TO 'artfi_agent_test'@'%';"
for migration in "$ROOT/apps/api/migrations/"*.up.sql; do "${MYSQL[@]}" artfi_stage2_isolated_test < "$migration"; done
printf '%s' 'TEST_ONLY_ISOLATED_DATABASE_PASSWORD' > "$DATA/test-password"
chmod 600 "$DATA/test-password"
node --input-type=module -e 'import {writeFileSync} from "node:fs"; writeFileSync(process.env.ARTFI_AGENT_TEST_MYSQL_CONFIG,JSON.stringify({host:"127.0.0.1",port:Number(process.env.ARTFI_AGENT_TEST_MYSQL_PORT),database:"artfi_stage2_isolated_test",user:"artfi_agent_test",passwordFile:process.env.ARTFI_AGENT_TEST_MYSQL_DATA+"/test-password",tls:null}))'
"${MYSQL[@]}" -e 'SELECT VERSION() AS actual_mysql_version; SELECT COUNT(*) AS migrated_tables FROM information_schema.tables WHERE table_schema="artfi_stage2_isolated_test";'
cd "$ROOT/apps/agent-runtime"
node --test --test-concurrency=1 test/mysql.integration.mjs test/action-mysql.integration.mjs test/http-mysql.integration.mjs

if [[ ${ARTFI_AGENT_RUN_BROWSER:-0} == 1 ]]; then node test/browser-runtime-runner.mjs; fi
