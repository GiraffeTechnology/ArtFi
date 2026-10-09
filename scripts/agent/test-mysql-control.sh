#!/usr/bin/env bash
set -euo pipefail
BASE=${ARTFI_AGENT_TEST_MYSQL_BASE:?}
DATA=${ARTFI_AGENT_TEST_MYSQL_DATA:?}
PORT=${ARTFI_AGENT_TEST_MYSQL_PORT:?}
[[ "$DATA" == */artfi-stage2-mysql.* && -f "$DATA/database.json" ]] || { echo 'ISOLATED_TEST_DATABASE_REQUIRED' >&2; exit 1; }
case "${1:-}" in
start)
  "$BASE/bin/mysqld" --no-defaults --basedir="$BASE" --datadir="$DATA/data" --socket= --pid-file="$DATA/mysql.pid" --bind-address=127.0.0.1 --port="$PORT" --mysqlx=OFF --log-error="$DATA/mysql.log" >"$DATA/stdout.log" 2>&1 &
  for i in $(seq 1 60); do
    if "$BASE/bin/mysql" --no-defaults --protocol=TCP -h127.0.0.1 -P"$PORT" -uroot -e 'SELECT 1' >/dev/null 2>&1; then exit 0; fi
    sleep 0.2
  done
  echo 'TEST_MYSQL_START_TIMEOUT' >&2; exit 1;;
stop)
  if [[ -f "$DATA/mysql.pid" ]]; then
    PID=$(cat "$DATA/mysql.pid")
    [[ "$PID" =~ ^[0-9]+$ ]] || exit 1
    kill -TERM "$PID" 2>/dev/null || true
    for i in $(seq 1 100); do [[ ! -f "$DATA/mysql.pid" ]] && exit 0; sleep 0.1; done
    echo 'TEST_MYSQL_STOP_TIMEOUT' >&2; exit 1
  fi;;
*) echo 'TEST_MYSQL_ACTION_INVALID' >&2; exit 1;;
esac
