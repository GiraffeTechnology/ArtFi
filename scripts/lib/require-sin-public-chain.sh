#!/usr/bin/env bash

if [[ "${ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE:-}" != "sin" ]]; then
  printf '%s\n' \
    'refusing public-chain operation: ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE must be sin' >&2
  exit 1
fi
