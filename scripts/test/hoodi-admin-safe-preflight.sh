#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/lib/require-sin-public-chain.sh"
source "$repo_root/scripts/lib/require-rwa-source-config.sh"

required=(
  ARTFI_RPC_URL
  ARTFI_DEPLOYER_ACCOUNT
  ARTFI_KEYSTORE_PASSWORD_FILE
  DEPLOYER_ADDRESS
  ARTFI_ADMIN_SAFE
  ARTFI_ADMIN_SAFE_CODEHASH
)
for variable in "${required[@]}"; do
  if [[ -z "${!variable:-}" ]]; then
    printf 'missing required Hoodi admin-safe setting: %s\n' "$variable" >&2
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
if [[ "${DEPLOYER_ADDRESS,,}" == "${ARTFI_ADMIN_SAFE,,}" ]]; then
  printf 'refusing deployment: bootstrap deployer must not be the admin safe\n' >&2
  exit 1
fi

safe_code="$(cast code "$ARTFI_ADMIN_SAFE" --rpc-url "$ARTFI_RPC_URL")"
if [[ "$safe_code" == "0x" ]]; then
  printf 'refusing deployment: ARTFI_ADMIN_SAFE has no runtime code\n' >&2
  exit 1
fi
safe_codehash="$(cast keccak "$safe_code")"
if [[ "${safe_codehash,,}" != "${ARTFI_ADMIN_SAFE_CODEHASH,,}" ]]; then
  printf 'refusing deployment: admin safe runtime code hash mismatch\n' >&2
  exit 1
fi
owners="$(cast call "$ARTFI_ADMIN_SAFE" 'owners()(address[])' --rpc-url "$ARTFI_RPC_URL")"
threshold="$(cast call "$ARTFI_ADMIN_SAFE" 'threshold()(uint256)' --rpc-url "$ARTFI_RPC_URL")"
delay_seconds="$(cast call "$ARTFI_ADMIN_SAFE" 'delaySeconds()(uint64)' --rpc-url "$ARTFI_RPC_URL")"
owner_occurrences="$(grep -Eo '0x[0-9a-fA-F]{40}' <<<"$owners" | wc -l)"
owner_count="$(grep -Eo '0x[0-9a-fA-F]{40}' <<<"$owners" | tr '[:upper:]' '[:lower:]' | sort -u | wc -l)"
if (( owner_count != owner_occurrences || owner_count < 2 || threshold < 2 || threshold > owner_count || delay_seconds == 0 )); then
  printf 'refusing deployment: admin safe owner/threshold/delay policy failed\n' >&2
  exit 1
fi

printf 'chainId=%s\n' "$chain_id"
printf 'deployer=%s\n' "$DEPLOYER_ADDRESS"
printf 'adminSafe=%s\n' "$ARTFI_ADMIN_SAFE"
printf 'adminSafeCodehash=%s\n' "$safe_codehash"
printf 'adminSafeOwnerCount=%s\n' "$owner_count"
printf 'adminSafeThreshold=%s\n' "$threshold"
printf 'adminSafeDelaySeconds=%s\n' "$delay_seconds"
printf 'preflight=pass\n'
