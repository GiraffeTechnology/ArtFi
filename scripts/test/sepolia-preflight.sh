#!/usr/bin/env bash
set -euo pipefail

required=(
  ARTFI_RPC_URL
  ARTFI_DEPLOYER_ACCOUNT
  ARTFI_KEYSTORE_PASSWORD_FILE
  DEPLOYER_ADDRESS
  ARTFI_ADMIN
  ARTFI_REGISTRAR
  ARTFI_PAUSER
  ARTFI_VAULT_CREATOR
)

for variable in "${required[@]}"; do
  if [[ -z "${!variable:-}" ]]; then
    printf 'missing required deployment setting: %s\n' "$variable" >&2
    exit 1
  fi
done

if [[ ! -f "$ARTFI_KEYSTORE_PASSWORD_FILE" ]]; then
  printf 'keystore password file is not readable\n' >&2
  exit 1
fi

chain_id="$(cast chain-id --rpc-url "$ARTFI_RPC_URL")"
if [[ "$chain_id" != "11155111" ]]; then
  printf 'refusing deployment: expected Sepolia chain id 11155111, received %s\n' "$chain_id" >&2
  exit 1
fi

account_address="$(
  cast wallet address \
    --account "$ARTFI_DEPLOYER_ACCOUNT" \
    --password-file "$ARTFI_KEYSTORE_PASSWORD_FILE"
)"
if [[ "${account_address,,}" != "${DEPLOYER_ADDRESS,,}" ]]; then
  printf 'refusing deployment: DEPLOYER_ADDRESS does not match the selected keystore account\n' >&2
  exit 1
fi

balance="$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$ARTFI_RPC_URL")"
if [[ "$balance" == "0" ]]; then
  printf 'refusing deployment: the test-only deployer has no Sepolia ETH\n' >&2
  exit 1
fi

printf 'chainId=%s\n' "$chain_id"
printf 'deployer=%s\n' "$DEPLOYER_ADDRESS"
printf 'balanceWei=%s\n' "$balance"
printf 'preflight=pass\n'
