#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/lib/require-sin-public-chain.sh"

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

if [[ "${ARTFI_DEPLOY_CHARITY_EDITIONS:-false}" == "true" ]]; then
  required+=(
    ARTFI_EDITION_CREATOR
    ARTFI_DONATION_RECORDER
  )
fi

# ArtFiMarket and RevenueDistributor hold user value, so their opt-ins carry two
# conditions the other stages do not. Both fail closed: an operator who omits either
# gets a refusal, not a default.
#
#   ARTFI_TEST_PAYLOAD_CLASS   must be TEST_ONLY_NO_REAL_VALUE. PRD.md §7.0 confines
#                              Hoodi to separately generated test assets; this makes the
#                              operator state that on every money-handling deployment.
#   ARTFI_REVIEWED_COMMIT      must equal the commit being deployed. ACCEPTANCE.md §3
#                              excludes evidence taken from a different commit, and G3-A
#                              freezes the contract suite; a deployment that cannot name
#                              its own reviewed commit cannot produce G2 evidence.
if [[ "${ARTFI_DEPLOY_MARKET:-false}" == "true" ]]; then
  required+=(
    ARTFI_MARKET_ADMIN
    ARTFI_MARKET_PAUSER
    ARTFI_MARKET_TOKEN_MANAGER
    ARTFI_TEST_PAYLOAD_CLASS
    ARTFI_REVIEWED_COMMIT
  )
fi

if [[ "${ARTFI_DEPLOY_REVENUE_DISTRIBUTOR:-false}" == "true" ]]; then
  required+=(
    ARTFI_REVENUE_FRACTION_TOKEN
    ARTFI_REVENUE_ADMIN
    ARTFI_REVENUE_DISTRIBUTOR
    ARTFI_TEST_PAYLOAD_CLASS
    ARTFI_REVIEWED_COMMIT
  )
fi

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

# Value checks for the money-handling opt-ins. The loop above only proves the settings
# are non-empty; these prove they say the right thing.
if [[ "${ARTFI_DEPLOY_MARKET:-false}" == "true" \
  || "${ARTFI_DEPLOY_REVENUE_DISTRIBUTOR:-false}" == "true" ]]; then
  if [[ "${ARTFI_TEST_PAYLOAD_CLASS:-}" != "TEST_ONLY_NO_REAL_VALUE" ]]; then
    printf 'refusing deployment: ARTFI_TEST_PAYLOAD_CLASS must be TEST_ONLY_NO_REAL_VALUE\n' >&2
    exit 1
  fi
  head_commit="$(git -C "$repo_root" rev-parse HEAD)"
  if [[ "${ARTFI_REVIEWED_COMMIT,,}" != "${head_commit,,}" ]]; then
    printf 'refusing deployment: ARTFI_REVIEWED_COMMIT %s does not match HEAD %s\n' \
      "$ARTFI_REVIEWED_COMMIT" "$head_commit" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
    printf 'refusing deployment: the working tree is dirty, so HEAD is not what would deploy\n' >&2
    exit 1
  fi
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
  printf 'refusing deployment: DEPLOYER_ADDRESS does not match the selected keystore account\n' >&2
  exit 1
fi

balance="$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$ARTFI_RPC_URL")"
if [[ "$balance" == "0" ]]; then
  printf 'refusing deployment: the test-only deployer has no Hoodi ETH\n' >&2
  exit 1
fi

printf 'chainId=%s\n' "$chain_id"
printf 'deployer=%s\n' "$DEPLOYER_ADDRESS"
printf 'balanceWei=%s\n' "$balance"
printf 'preflight=pass\n'
