# ArtFi Wallet Extension Alpha

This package is a separately gated, non-custodial Sepolia signing coordinator. It does not import,
generate, store, or sign with a mnemonic or private key. Approved hardware-wallet and
WalletConnect adapters remain the only signing boundary.

The extension provides:

- Versioned WebCrypto AES-256-GCM encrypted connector metadata using PBKDF2-SHA256 with a random
  128-bit salt, 96-bit nonce, 600,000 iterations, authenticated context, and no extractable key.
- Service-worker-memory-only unlocked state; worker restart locks the coordinator automatically.
- Per-origin method grants with expiry, HTTPS enforcement, phishing-deny hooks, and punycode review.
- Sepolia-only transaction validation, fresh simulation attestation, explicit one-time
  confirmation, origin binding, and a five-minute maximum lifetime.
- Manifest V3 with no default host access. Script and host access are optional permissions that
  must be granted explicitly.

## Build and test

```bash
pnpm --filter @giraffetechnology/artfi-wallet-extension lint
pnpm --filter @giraffetechnology/artfi-wallet-extension test
pnpm --filter @giraffetechnology/artfi-wallet-extension build
```

Load `apps/wallet-extension/dist` as an unpacked development extension only after reviewing the
current commit. The Alpha has no browser-store, production-signing, or mainnet approval.
