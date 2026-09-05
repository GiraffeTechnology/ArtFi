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

artfi_market_deployed=false
if [[ "${ARTFI_DEPLOY_MARKET:-false}" == "true" ]]; then
  : "${ARTFI_MARKET_ADMIN:?ARTFI_MARKET_ADMIN is required}"
  : "${ARTFI_MARKET_PAUSER:?ARTFI_MARKET_PAUSER is required}"
  : "${ARTFI_MARKET_TOKEN_MANAGER:?ARTFI_MARKET_TOKEN_MANAGER is required}"
  forge script script/DeployMarket.s.sol:DeployMarket \
    --rpc-url "$ARTFI_RPC_URL" "${wallet_args[@]}" "${verify_args[@]}" --broadcast --slow
  artfi_market_deployed=true
fi

artfi_revenue_distributor_deployed=false
if [[ "${ARTFI_DEPLOY_REVENUE_DISTRIBUTOR:-false}" == "true" ]]; then
  : "${ARTFI_REVENUE_FRACTION_TOKEN:?ARTFI_REVENUE_FRACTION_TOKEN is required}"
  : "${ARTFI_REVENUE_ADMIN:?ARTFI_REVENUE_ADMIN is required}"
  : "${ARTFI_REVENUE_DISTRIBUTOR:?ARTFI_REVENUE_DISTRIBUTOR is required}"
  forge script script/DeployRevenueDistributor.s.sol:DeployRevenueDistributor \
    --rpc-url "$ARTFI_RPC_URL" "${wallet_args[@]}" "${verify_args[@]}" --broadcast --slow
  artfi_revenue_distributor_deployed=true
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
printf 'artfiMarketDeployed=%s\n' "$artfi_market_deployed"
printf 'revenueDistributorDeployed=%s\n' "$artfi_revenue_distributor_deployed"
