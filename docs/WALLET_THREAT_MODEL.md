# ArtFi Wallet Alpha threat model

## Security objective

Coordinate explicit Sepolia signing requests without putting a seed phrase or private key inside
the ArtFi extension. A hardware wallet or separately reviewed WalletConnect signer remains the
cryptographic boundary.

## Trust boundaries

1. A web origin is untrusted until the user grants specific, expiring methods.
2. Content-page JavaScript is always untrusted and must never access extension storage.
3. The Manifest V3 service worker is trusted only for the reviewed release commit and auto-locks
   whenever its in-memory state is lost.
4. Connector/session metadata is sensitive. It is encrypted at rest and decrypted only into
   service-worker memory.
5. Hardware-wallet and WalletConnect implementations are external dependencies requiring their
   own approval, version pinning, and security review.
6. Simulation, RPC, phishing feeds, extension updates, and browser distribution are supply-chain
   dependencies and are not trusted merely because they are online.

## Primary threats and controls

| Threat                       | Control                                                                               | Remaining gate                                          |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Seed/private-key theft       | Alpha never accepts or stores either                                                  | Independent code and runtime review                     |
| Malicious origin             | HTTPS/localhost policy, punycode review, denylist hook, method-scoped expiring grants | Maintained phishing feed and appeal process             |
| Cross-origin approval replay | Confirmation binds origin, request and expiry; approval is one-time                   | Browser integration/penetration test                    |
| Wrong-chain signing          | Transaction and simulation must both be Sepolia                                       | Hardware/WalletConnect adapter enforcement              |
| Blind signing                | Fresh successful simulation and explicit confirmation required                        | Independent simulation provider and UI review           |
| Storage theft                | AES-GCM, PBKDF2-SHA256, random salt/nonce, non-extractable key                        | Password UX, rate limiting, browser-keystore evaluation |
| Plaintext persistence        | Unlocked payload exists only in service-worker memory                                 | Runtime instrumentation and crash review                |
| Overbroad extension access   | No default host access; scripting/hosts are optional                                  | Browser-store permission review                         |
| Malicious update/dependency  | Locked versions, CI, SBOM/signing plan                                                | Reproducible package and store provenance               |

## Explicit non-goals for Alpha

- Mainnet or real-value signing.
- Seed generation, private-key import, software signing, or cloud key backup.
- Browser-store publication or automatic installation.
- Production telemetry, remote phishing feeds, hardware adapters, or WalletConnect transport.

Those capabilities require a separate approved design, independent review, penetration testing,
and written go/no-go decision.
