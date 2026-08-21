# Security policy

## Supported environments

Only local development and Sepolia are permitted until Stage 7 release approval. Mainnet, real assets, and real-money operation are prohibited before independent audit and compliance sign-off.

## Reporting

Do not open public issues containing vulnerability details or secrets. Report security issues privately to the repository administrators.

## Mandatory controls

- No private keys or seed phrases in source, CI variables, logs, tickets, or chat.
- A local test private key may be read only from `ARTFI_TEST_PRIVATE_KEY_FILE`; the file must be
  outside the repository, non-symlinked, restricted to the local user, and read-only. It is never
  a production signer and must not be copied to a server or CI runner.
- Production signing must use an approved signer or multi-signature wallet.
- Contract roles must be least-privilege, monitored, and documented.
- Every deployed contract must map to a reviewed source commit and verified bytecode.
- TLS is mandatory outside local development.
- The product must not claim third-party audit completion without a verifiable report and matching commit hash.
