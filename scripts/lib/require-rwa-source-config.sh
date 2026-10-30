#!/usr/bin/env bash
# Guarded Stage 2 deployment inputs only. No key, signature or network operation.
: "${ARTFI_SOURCE_AUTHORITY:?ARTFI_SOURCE_AUTHORITY is the independent public source-authority address}"
: "${ARTFI_RWA_TEST_ONLY:?ARTFI_RWA_TEST_ONLY must explicitly be true or false}"
if [[ ! "$ARTFI_SOURCE_AUTHORITY" =~ ^0x[0-9a-fA-F]{40}$ || "${ARTFI_SOURCE_AUTHORITY,,}" == 0x0000000000000000000000000000000000000000 ]]; then
  printf 'refusing deployment: invalid public source authority\n' >&2
  exit 1
fi
if [[ "$ARTFI_RWA_TEST_ONLY" != true && "$ARTFI_RWA_TEST_ONLY" != false ]]; then
  printf 'refusing deployment: ARTFI_RWA_TEST_ONLY must be true or false\n' >&2
  exit 1
fi
artfi_source_admin="${ARTFI_ADMIN:-}"
artfi_source_registrar="${ARTFI_REGISTRAR:-}"
if [[ "${ARTFI_SOURCE_AUTHORITY,,}" == "${artfi_source_admin,,}" || "${ARTFI_SOURCE_AUTHORITY,,}" == "${artfi_source_registrar,,}" ]]; then
  printf 'refusing deployment: source authority must be independent from ArtFi admin and registrar\n' >&2
  exit 1
fi
