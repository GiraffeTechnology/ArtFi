#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repository_root"

test_database="artfi_codex_test_$(date +%s)_$$"
test_project="artfi-mysql-test-$$"
mysql_host_port="${ARTFI_MYSQL_TEST_PORT:-33306}"
if [[ ! "$test_database" =~ ^artfi_codex_test_[0-9]+_[0-9]+$ ]]; then
  echo "refusing unsafe test database name" >&2
  exit 1
fi
if [[ ! "$test_project" =~ ^artfi-mysql-test-[0-9]+$ ]] ||
  [[ ! "$mysql_host_port" =~ ^[0-9]+$ ]]; then
  echo "refusing unsafe test project or port" >&2
  exit 1
fi

export MYSQL_HOST_PORT="$mysql_host_port"
compose=(docker compose -p "$test_project")

cleanup() {
  "${compose[@]}" exec -T -e MYSQL_PWD=local-root-only mysql mysql -uroot \
    -e "DROP DATABASE IF EXISTS \`$test_database\`;" >/dev/null 2>&1 || true
  "${compose[@]}" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${compose[@]}" up -d --wait mysql
"${compose[@]}" exec -T -e MYSQL_PWD=local-root-only mysql mysql -uroot \
  -e "CREATE DATABASE \`$test_database\`;"

for migration in \
  apps/api/migrations/000001_stage1_catalog.up.sql \
  apps/api/migrations/000002_stage2_rwa_mint.up.sql \
  apps/api/migrations/000003_stage3_vault_fractional.up.sql \
  apps/api/migrations/000004_stage4_market_governance.up.sql \
  apps/api/migrations/000005_stage6_compliance_operations.up.sql \
  apps/api/migrations/000006_dao_rwa_governance.up.sql \
  apps/api/migrations/000007_external_trade_orchestration.up.sql; do
  "${compose[@]}" exec -T -e MYSQL_PWD=local-root-only mysql mysql -uroot "$test_database" < "$migration"
done

test "$("${compose[@]}" exec -T -e MYSQL_PWD=local-root-only mysql mysql -N -uroot "$test_database" \
  -e 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE();')" = "27"

docker run --rm --network host \
  -e GOPROXY=off \
  -e ARTFI_INTEGRATION_MYSQL_DSN="root:local-root-only@tcp(localhost:$mysql_host_port)/$test_database?parseTime=true" \
  -v "$repository_root:/src" \
  -v /home/dev/go/pkg/mod:/go/pkg/mod \
  -w /src/apps/api \
  golang:1.26.5-bookworm \
  sh -lc '/usr/local/go/bin/go test -race ./...'

for rollback in \
  apps/api/migrations/000007_external_trade_orchestration.down.sql \
  apps/api/migrations/000006_dao_rwa_governance.down.sql \
  apps/api/migrations/000005_stage6_compliance_operations.down.sql \
  apps/api/migrations/000004_stage4_market_governance.down.sql \
  apps/api/migrations/000003_stage3_vault_fractional.down.sql \
  apps/api/migrations/000002_stage2_rwa_mint.down.sql \
  apps/api/migrations/000001_stage1_catalog.down.sql; do
  "${compose[@]}" exec -T -e MYSQL_PWD=local-root-only mysql mysql -uroot "$test_database" < "$rollback"
done

test "$("${compose[@]}" exec -T -e MYSQL_PWD=local-root-only mysql mysql -N -uroot "$test_database" \
  -e 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE();')" = "0"

echo "MySQL 8.4 migrations, race tests, and rollback passed."
