# Local test wallet

The ArtFi browser application continues to use a standard external EIP-1193 wallet. Raw private
keys are never bundled into the Web application, uploaded to the API, stored in MySQL, copied to a
server, or exposed to CI.

For offline Sepolia test-signing checks, the local operator may configure one private-key file by
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
$env:ARTFI_CHAIN_ID = "11155111"
$env:ARTFI_TEST_PRIVATE_KEY_FILE = Join-Path $env:LOCALAPPDATA "ArtFi\secrets\sepolia-test-wallet.key"
pnpm wallet:test-local
```

The self-test prints only the public address and verification result. It signs a fixed,
domain-separated ownership message offline; it does not create or broadcast a transaction.

The local file signer refuses production mode, every chain other than Sepolia, repository-contained
files, symlinks, malformed values, and insecure permissions. Contract deployment continues to use
the separately encrypted Foundry keystore path documented in `packages/contracts/README.md`.
