#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/lib/require-sin-public-chain.sh"

required=(
  ARTFI_RPC_URL
  ARTFI_DEPLOYER_ACCOUNT
  ARTFI_KEYSTORE_PASSWORD_FILE
  DEPLOYER_ADDRESS
  ARTFI_ADMIN_SAFE_OWNERS
  ARTFI_ADMIN_SAFE_THRESHOLD
  ARTFI_ADMIN_SAFE_DELAY_SECONDS
)
for variable in "${required[@]}"; do
  if [[ -z "${!variable:-}" ]]; then
    printf 'missing required Hoodi safe-deployment setting: %s\n' "$variable" >&2
    exit 1
  fi
done
if [[ ! -f "$ARTFI_KEYSTORE_PASSWORD_FILE" ]]; then
  printf 'keystore password file is not readable\n' >&2
  exit 1
fi
chain_id="$(cast chain-id --rpc-url "$ARTFI_RPC_URL")"
if [[ "$chain_id" != "560048" ]]; then
  printf 'refusing deployment: expected Hoodi chain id 560048, received %s\n' "$chain_id" >&2
  exit 1
fi
account_address="$(
  cast wallet address \
    --account "$ARTFI_DEPLOYER_ACCOUNT" \
    --password-file "$ARTFI_KEYSTORE_PASSWORD_FILE"
)"
if [[ "${account_address,,}" != "${DEPLOYER_ADDRESS,,}" ]]; then
  printf 'refusing deployment: DEPLOYER_ADDRESS does not match selected account\n' >&2
  exit 1
fi

cd "$repo_root/packages/contracts"
forge script script/DeployAdminSafe.s.sol:DeployAdminSafe \
  --rpc-url "$ARTFI_RPC_URL" \
  --account "$ARTFI_DEPLOYER_ACCOUNT" \
  --password-file "$ARTFI_KEYSTORE_PASSWORD_FILE" \
  --broadcast --slow
printf 'hoodiAdminSafeDeployment=complete\n'
