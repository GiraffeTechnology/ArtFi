# Stage 5 acceptance evidence

Stage 5 delivers the wallet extension as a separate, non-custodial Alpha. It does not change the
legacy DApp UI and cannot sign with a locally held private key.

## Delivered

- Manifest V3 package with no default host access and optional scripting/host permissions.
- Encrypted connector/session vault using browser WebCrypto AES-256-GCM and PBKDF2-SHA256.
- Service-worker-memory-only unlock state and automatic lock on worker restart.
- HTTPS origin validation, punycode/manual-review rule, phishing deny hooks, expiring method grants,
  and revocation.
- Sepolia-only request checks, fresh simulation requirement, one-time origin-bound confirmation,
  and five-minute expiry.
- Hardware-wallet/WalletConnect external-signer interface; no seed phrase, private-key import,
  custom cryptography, or software signer.
- Threat model and explicit production/store gates.

## Verified development evidence

- TypeScript strict typecheck passes.
- 6/6 tests cover encryption round trip, wrong/weak passwords, absence of plaintext session data,
  permission expiry, phishing-origin rejection, Sepolia enforcement, simulation freshness,
  one-time approval, and cross-origin rejection.
- A loadable unpacked-extension directory is produced with background worker, popup, manifest, and
  isolated modules.

## External exit gates still required

- Independent wallet threat-model review, code audit, penetration test, and retest.
- Reviewed hardware-wallet and WalletConnect adapters with version/provenance controls.
- Browser-store permission, privacy, update-signing, and distribution review.
- Production phishing intelligence, incident response, recovery UX, and telemetry approval.

The Alpha is development-only, Sepolia-only, and not approved for seed phrases, private keys,
mainnet, real assets, or real value.
