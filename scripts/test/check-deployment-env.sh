#!/usr/bin/env bash
set -euo pipefail

variables=(
  ARTFI_RPC_URL
  SEPOLIA_RPC_URL
  ETH_RPC_URL
  ARTFI_DEPLOYER_PRIVATE_KEY
  PRIVATE_KEY
  ETHERSCAN_API_KEY
  OPENSEA_API_KEY
  R2_ENDPOINT
  R2_BUCKET
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  ARTFI_OBJECT_PUBLIC_BASE_URL
)

for variable in "${variables[@]}"; do
  if [[ -n "${!variable:-}" ]]; then
    printf '%s=present\n' "$variable"
  else
    printf '%s=absent\n' "$variable"
  fi
done
