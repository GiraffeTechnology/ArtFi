#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/lib/require-sin-public-chain.sh"
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

if [[ "${ARTFI_DEPLOY_CHARITY_EDITIONS:-false}" == "true" ]]; then
  : "${ARTFI_EDITION_CREATOR:?ARTFI_EDITION_CREATOR is required}"
  : "${ARTFI_DONATION_RECORDER:?ARTFI_DONATION_RECORDER is required}"
  forge script script/DeployCharityEditions.s.sol:DeployCharityEditions \
    --rpc-url "$ARTFI_RPC_URL" "${wallet_args[@]}" "${verify_args[@]}" --broadcast --slow
fi

if [[ "${ARTFI_DEPLOY_GOVERNANCE:-false}" == "true" ]]; then
  : "${ARTFI_RWA_VAULT:?ARTFI_RWA_VAULT is required}"
  : "${ARTFI_BUYOUT_PRICE_VERIFIER:?ARTFI_BUYOUT_PRICE_VERIFIER is required}"
  : "${ARTFI_TIMELOCK_DELAY_SECONDS:?ARTFI_TIMELOCK_DELAY_SECONDS is required}"
  : "${ARTFI_VOTING_DELAY_BLOCKS:?ARTFI_VOTING_DELAY_BLOCKS is required}"
  : "${ARTFI_VOTING_PERIOD_BLOCKS:?ARTFI_VOTING_PERIOD_BLOCKS is required}"
  : "${ARTFI_QUORUM_PERCENT:?ARTFI_QUORUM_PERCENT is required}"
  forge script script/DeployStage4.s.sol:DeployStage4 \
    --rpc-url "$ARTFI_RPC_URL" "${wallet_args[@]}" "${verify_args[@]}" --broadcast --slow
fi

printf 'deployment=complete\n'
printf 'artfiMarketDeployed=false\n'
