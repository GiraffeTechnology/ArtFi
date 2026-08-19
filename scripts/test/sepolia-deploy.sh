#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
"$repo_root/scripts/test/sepolia-preflight.sh"

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

if [[ "${ARTFI_DEPLOY_GOVERNANCE:-false}" == "true" ]]; then
  : "${ARTFI_GOVERNANCE_TOKEN:?ARTFI_GOVERNANCE_TOKEN is required}"
  : "${ARTFI_TIMELOCK_DELAY_SECONDS:?ARTFI_TIMELOCK_DELAY_SECONDS is required}"
  : "${ARTFI_VOTING_DELAY_BLOCKS:?ARTFI_VOTING_DELAY_BLOCKS is required}"
  : "${ARTFI_VOTING_PERIOD_BLOCKS:?ARTFI_VOTING_PERIOD_BLOCKS is required}"
  : "${ARTFI_PROPOSAL_THRESHOLD:?ARTFI_PROPOSAL_THRESHOLD is required}"
  : "${ARTFI_QUORUM_PERCENT:?ARTFI_QUORUM_PERCENT is required}"
  forge script script/DeployStage4.s.sol:DeployStage4 \
    --rpc-url "$ARTFI_RPC_URL" "${wallet_args[@]}" "${verify_args[@]}" --broadcast --slow
fi

printf 'deployment=complete\n'
printf 'artfiMarketDeployed=false\n'
