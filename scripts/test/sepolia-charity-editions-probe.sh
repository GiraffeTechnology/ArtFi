#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/lib/require-sin-public-chain.sh"

: "${ARTFI_RPC_URL:?ARTFI_RPC_URL is required}"
: "${ARTFI_CHARITY_EDITIONS_ADDRESS:?ARTFI_CHARITY_EDITIONS_ADDRESS is required}"

chain_id="$(cast chain-id --rpc-url "$ARTFI_RPC_URL")"
if [[ "$chain_id" != "11155111" ]]; then
  printf 'expected Sepolia chain id 11155111, received %s\n' "$chain_id" >&2
  exit 1
fi

code="$(cast code "$ARTFI_CHARITY_EDITIONS_ADDRESS" --rpc-url "$ARTFI_RPC_URL")"
if [[ "$code" == "0x" ]]; then
  printf 'no deployed bytecode at %s\n' "$ARTFI_CHARITY_EDITIONS_ADDRESS" >&2
  exit 1
fi

erc1155="$(
  cast call "$ARTFI_CHARITY_EDITIONS_ADDRESS" \
    'supportsInterface(bytes4)(bool)' 0xd9b67a26 --rpc-url "$ARTFI_RPC_URL"
)"
erc1155_metadata="$(
  cast call "$ARTFI_CHARITY_EDITIONS_ADDRESS" \
    'supportsInterface(bytes4)(bool)' 0x0e89341c --rpc-url "$ARTFI_RPC_URL"
)"
editions="$(
  cast call "$ARTFI_CHARITY_EDITIONS_ADDRESS" \
    'EDITIONS_PER_ARTWORK()(uint256)' --rpc-url "$ARTFI_RPC_URL"
)"
unit_price="$(
  cast call "$ARTFI_CHARITY_EDITIONS_ADDRESS" \
    'PRIMARY_PRICE_WEI()(uint256)' --rpc-url "$ARTFI_RPC_URL"
)"

if [[ "$erc1155" != "true" || "$erc1155_metadata" != "true" ]]; then
  printf 'ERC-1155 interface discovery failed\n' >&2
  exit 1
fi
if [[ "$editions" != "100" ]]; then
  printf 'unexpected editions-per-artwork constant: %s\n' "$editions" >&2
  exit 1
fi
if [[ "$unit_price" != "10000000000000000" ]]; then
  printf 'unexpected primary unit-price constant: %s\n' "$unit_price" >&2
  exit 1
fi

if [[ -n "${ARTFI_CHARITY_TOKEN_ID:-}" ]]; then
  supply="$(
    cast call "$ARTFI_CHARITY_EDITIONS_ADDRESS" \
      'totalSupply(uint256)(uint256)' "$ARTFI_CHARITY_TOKEN_ID" --rpc-url "$ARTFI_RPC_URL"
  )"
  if [[ "$supply" != "100" ]]; then
    printf 'unexpected fixed supply for token %s: %s\n' "$ARTFI_CHARITY_TOKEN_ID" "$supply" >&2
    exit 1
  fi
  printf 'tokenId=%s\n' "$ARTFI_CHARITY_TOKEN_ID"
  printf 'fixedSupply=%s\n' "$supply"
fi

printf 'chainId=%s\n' "$chain_id"
printf 'erc1155=%s\n' "$erc1155"
printf 'erc1155Metadata=%s\n' "$erc1155_metadata"
printf 'editionsPerArtwork=%s\n' "$editions"
printf 'primaryPriceWei=%s\n' "$unit_price"
printf 'charityEditionsStandardsProbe=pass\n'
