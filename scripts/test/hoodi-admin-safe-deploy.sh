#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/lib/require-sin-public-chain.sh"
"$repo_root/scripts/test/hoodi-admin-safe-preflight.sh"

cd "$repo_root/packages/contracts"
wallet_args=(
  --account "$ARTFI_DEPLOYER_ACCOUNT"
  --password-file "$ARTFI_KEYSTORE_PASSWORD_FILE"
)
verify_args=()
if [[ -n "${ETHERSCAN_API_KEY:-}" ]]; then
  verify_args=(--verify --verifier etherscan)
fi

forge script script/DeployStage2.s.sol:DeployStage2 \
  --rpc-url "$ARTFI_RPC_URL" "${wallet_args[@]}" "${verify_args[@]}" --broadcast --slow
forge script script/DeployStage3.s.sol:DeployStage3 \
  --rpc-url "$ARTFI_RPC_URL" "${wallet_args[@]}" "${verify_args[@]}" --broadcast --slow
if [[ "${ARTFI_DEPLOY_CHARITY_EDITIONS:-false}" == "true" ]]; then
  forge script script/DeployCharityEditions.s.sol:DeployCharityEditions \
    --rpc-url "$ARTFI_RPC_URL" "${wallet_args[@]}" "${verify_args[@]}" --broadcast --slow
fi

printf 'hoodiAdminSafeDeployment=complete\n'
