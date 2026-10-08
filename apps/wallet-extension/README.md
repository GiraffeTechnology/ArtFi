# ArtFi Wallet Extension Alpha

This package is a separately gated, non-custodial Hoodi signing coordinator. It does not import,
generate, store, or sign with a mnemonic or private key. Approved hardware-wallet and
WalletConnect adapters remain the only signing boundary.

The extension provides:

- An EIP-6963 page provider, registered per origin. ArtFi's web app accepts one connector,
  RainbowKit's `injectedWallet`, which ignores a wallet that does not announce itself over
  EIP-6963; before this existed no wallet in the ArtFi ecosystem could connect to ArtFi.
  `provider.js` runs in the page's world and announces the provider, `bridge.js` relays from the
  isolated world, and the service worker answers. The requesting origin is always the browser's
  `sender.origin`, never a value the page supplies, so one site cannot borrow another's grant.
  `window.ethereum` is deliberately left alone: EIP-6963 exists so several wallets can coexist.
- Connection without signing. `eth_chainId`, `eth_accounts` and `eth_requestAccounts` are
  answered; every signing method is refused by name, because the vault holds account descriptors
  and no key material and no `ExternalSigner` is configured yet. A signature is never fabricated
  to make a surface look complete.

- Versioned WebCrypto AES-256-GCM encrypted connector metadata using PBKDF2-SHA256 with a random
  128-bit salt, 96-bit nonce, 600,000 iterations, authenticated context, and no extractable key.
- Service-worker-memory-only unlocked state; worker restart locks the coordinator automatically.
- Per-origin method grants with expiry, HTTPS enforcement, phishing-deny hooks, and punycode review.
- Hoodi-only transaction validation, fresh simulation attestation, explicit one-time
  confirmation, origin binding, and a five-minute maximum lifetime.
- Manifest V3 with no default host access. Script and host access are optional permissions that
  must be granted explicitly, per origin, from the popup. The page scripts are registered at run
  time for that one origin rather than declared against every HTTPS site, and disabling a site
  unregisters them and hands the host permission back. Grants are persisted and rehydrated on
  startup because registered scripts outlive the service worker while in-memory grants do not;
  the vault itself stays memory-only.

## Connecting a site

Open the extension popup on the site, unlock the coordinator, and choose **Enable for this
site**. A page cannot enable itself: `eth_requestAccounts` from an unenabled origin is refused
with EIP-1193 `4100`, and the service worker rejects `site.*` messages that do not come from an
extension page. Until a site is enabled, `eth_accounts` reports an empty list, which is what
EIP-1193 means by "not connected".

## Build and test

```bash
pnpm --filter @giraffetechnology/artfi-wallet-extension lint
pnpm --filter @giraffetechnology/artfi-wallet-extension test
pnpm --filter @giraffetechnology/artfi-wallet-extension build
```

Load `apps/wallet-extension/dist` as an unpacked development extension only after reviewing the
current commit. The Alpha has no browser-store, production-signing, or mainnet approval.
