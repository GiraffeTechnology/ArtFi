# Local test wallet

The ArtFi browser application continues to use a standard external EIP-1193 wallet. Raw private
keys are never bundled into the Web application, uploaded to the API, stored in MySQL, copied to a
server, or exposed to CI.

For offline Hoodi test-signing checks, the local operator may configure one private-key file by
setting `ARTFI_TEST_PRIVATE_KEY_FILE` to an absolute path. The file must:

- be outside this repository;
- be a regular file rather than a symlink or reparse point;
- contain exactly one `0x`-prefixed 32-byte hexadecimal test key;
- be owned by the current user and readable but not writable by that user;
- grant no access to other interactive principals.

The Windows provisioner also locks the containing secrets directory so the read-only file cannot
be deleted and replaced through writable parent-directory permissions.

On Windows, provision a new dedicated test-only key without displaying it:

```powershell
./scripts/local/New-ArtFiTestWallet.ps1
$env:ARTFI_ENV = "test"
$env:ARTFI_CHAIN_ID = "560048"
$env:ARTFI_TEST_PRIVATE_KEY_FILE = Join-Path $env:LOCALAPPDATA "ArtFi\secrets\hoodi-test-wallet.key"
pnpm wallet:test-local
```

The self-test prints only the public address and verification result. It signs a fixed,
domain-separated ownership message offline; it does not create or broadcast a transaction.

## Named Hoodi test wallets

These public addresses identify the two local, test-only roles used by the pre-chain validation
plan:

- `ArtFi1`: `0x75F6e1BAc9bF07a54FECc416ef76327BbD2c3089` — initial mint and holding wallet.
- `ArtFi2`: `0xDE3c1D455c2CCe1bAcf1e70aAC7fA3B8cCb1ec2B` — asset-transfer receiving wallet.

Only the public addresses belong in the repository. Private keys and local key-file paths must
remain outside Git, servers, CI, logs, tickets, and documentation. Both wallets are Hoodi-only
and must not receive mainnet ETH or real-value assets.

The local file signer refuses production mode, every chain other than Hoodi, repository-contained
files, symlinks, malformed values, and insecure permissions. Contract deployment continues to use
the separately encrypted Foundry keystore path documented in `packages/contracts/README.md`.
