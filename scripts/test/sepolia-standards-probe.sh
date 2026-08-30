#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/lib/require-sin-public-chain.sh"

: "${ARTFI_RPC_URL:?ARTFI_RPC_URL is required}"
: "${ARTFI_RWA_ADDRESS:?ARTFI_RWA_ADDRESS is required}"
: "${ARTFI_REGISTRY_ADDRESS:?ARTFI_REGISTRY_ADDRESS is required}"
: "${ARTFI_VAULT_FACTORY_ADDRESS:?ARTFI_VAULT_FACTORY_ADDRESS is required}"

chain_id="$(cast chain-id --rpc-url "$ARTFI_RPC_URL")"
if [[ "$chain_id" != "560048" ]]; then
  printf 'expected Hoodi chain id 560048, received %s\n' "$chain_id" >&2
  exit 1
fi

for address in "$ARTFI_RWA_ADDRESS" "$ARTFI_REGISTRY_ADDRESS" "$ARTFI_VAULT_FACTORY_ADDRESS"; do
  code="$(cast code "$address" --rpc-url "$ARTFI_RPC_URL")"
  if [[ "$code" == "0x" ]]; then
    printf 'no deployed bytecode at %s\n' "$address" >&2
    exit 1
  fi
done

erc721="$(cast call "$ARTFI_RWA_ADDRESS" 'supportsInterface(bytes4)(bool)' 0x80ac58cd --rpc-url "$ARTFI_RPC_URL")"
erc721_metadata="$(cast call "$ARTFI_RWA_ADDRESS" 'supportsInterface(bytes4)(bool)' 0x5b5e139f --rpc-url "$ARTFI_RPC_URL")"
name="$(cast call "$ARTFI_RWA_ADDRESS" 'name()(string)' --rpc-url "$ARTFI_RPC_URL")"
symbol="$(cast call "$ARTFI_RWA_ADDRESS" 'symbol()(string)' --rpc-url "$ARTFI_RPC_URL")"
registry_nft="$(cast call "$ARTFI_REGISTRY_ADDRESS" 'nft()(address)' --rpc-url "$ARTFI_RPC_URL")"

if [[ "$erc721" != "true" || "$erc721_metadata" != "true" ]]; then
  printf 'ERC-721 interface discovery failed\n' >&2
  exit 1
fi
if [[ "${registry_nft,,}" != "${ARTFI_RWA_ADDRESS,,}" ]]; then
  printf 'registry points to an unexpected NFT contract\n' >&2
  exit 1
fi

printf 'chainId=%s\n' "$chain_id"
printf 'erc721=%s\n' "$erc721"
printf 'erc721Metadata=%s\n' "$erc721_metadata"
printf 'name=%s\n' "$name"
printf 'symbol=%s\n' "$symbol"
printf 'registryNft=%s\n' "$registry_nft"
printf 'standardsProbe=pass\n'
