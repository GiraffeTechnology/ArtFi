#!/usr/bin/env bash
# Starts a new local TEST_ONLY database. Never defaults to an existing database.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BASE=${ARTFI_TEST_MYSQL_BASE:?Set ARTFI_TEST_MYSQL_BASE to the official MySQL installation}
CACHE=${ARTFI_AGENT_TEST_CACHE:-"$ROOT/../runtime-cache"}
mkdir -p "$CACHE"
DATA=$(mktemp -d "$CACHE/artfi-stage2-mysql.XXXXXX")
export LD_LIBRARY_PATH="$BASE/usr/lib/x86_64-linux-gnu:$BASE/lib/private${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export ARTFI_AGENT_TEST_MYSQL_BASE="$BASE" ARTFI_AGENT_TEST_MYSQL_DATA="$DATA"
export ARTFI_AGENT_TEST_MYSQL_PORT=${ARTFI_AGENT_TEST_MYSQL_PORT:-33326}
export ARTFI_AGENT_TEST_MYSQL_CONTROL="$ROOT/scripts/agent/test-mysql-control.sh"
export ARTFI_AGENT_TEST_MYSQL_CONFIG="$DATA/database.json"
printf '%s' 'ISOLATED_TEST_DATABASE_PASSWORD_NOT_A_DEPLOYMENT_SECRET' > "$DATA/test-password"
chmod 600 "$DATA/test-password"
node --input-type=module -e 'import {writeFileSync} from "node:fs"; writeFileSync(process.env.ARTFI_AGENT_TEST_MYSQL_CONFIG,JSON.stringify({host:"127.0.0.1",port:Number(process.env.ARTFI_AGENT_TEST_MYSQL_PORT),database:"artfi_stage2_isolated_test",user:"artfi_agent_test",passwordFile:process.env.ARTFI_AGENT_TEST_MYSQL_DATA+"/test-password",tls:null}))'
mkdir "$DATA/data"
"$BASE/bin/mysqld" --no-defaults --initialize-insecure --basedir="$BASE" --datadir="$DATA/data" --log-error="$DATA/initialize.log"
cleanup() {
  status=$?
  bash "$ARTFI_AGENT_TEST_MYSQL_CONTROL" stop || status=1
  if ! python3 "$ROOT/scripts/agent/archive-test-data.py" "$DATA"; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
bash "$ARTFI_AGENT_TEST_MYSQL_CONTROL" start
MYSQL=("$BASE/bin/mysql" --no-defaults --protocol=TCP -h127.0.0.1 -P"$ARTFI_AGENT_TEST_MYSQL_PORT" -uroot)
"${MYSQL[@]}" -e "CREATE DATABASE artfi_stage2_isolated_test; CREATE USER 'artfi_agent_test'@'127.0.0.1' IDENTIFIED BY 'ISOLATED_TEST_DATABASE_PASSWORD_NOT_A_DEPLOYMENT_SECRET'; GRANT SELECT, INSERT, UPDATE ON artfi_stage2_isolated_test.* TO 'artfi_agent_test'@'127.0.0.1';"
for migration in "$ROOT/apps/api/migrations/"*.up.sql; do "${MYSQL[@]}" artfi_stage2_isolated_test < "$migration"; done
"${MYSQL[@]}" -e 'SELECT VERSION() AS actual_mysql_version;'
cd "$ROOT/apps/agent-runtime"
node --test --test-concurrency=1 test/mysql.integration.mjs test/action-mysql.integration.mjs test/http-mysql.integration.mjs

if [[ ${ARTFI_AGENT_RUN_BROWSER:-0} == 1 ]]; then node test/browser-runtime-runner.mjs; fi
