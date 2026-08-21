# Administrator mint authentication boundary

Status: implemented for pre-chain deployment; production remains disabled until reviewed runtime configuration and contract deployment are present.

## Request path

1. The administrator connects a standard external wallet on Sepolia.
2. The web server issues a short-lived, domain-bound signing challenge in an HttpOnly, SameSite=Strict cookie.
3. The wallet signs the message. The signature creates no transaction and grants no rights.
4. The server verifies the signature, including contract-wallet signatures supported by the configured public client, and checks `REGISTRAR_ROLE` on the reviewed RWA registry.
5. The server issues a ten-minute HttpOnly session. Every proxied write rechecks the current on-chain role.
6. Only the upload and RWA-intent API namespaces may pass through the operator gateway. The gateway injects the operator bearer credential on the server; it never returns that credential or private topology to the browser.
7. The external wallet remains the only component that signs the final `createAsset` transaction. The API, web server, database, CI, and Git repository never receive a wallet private key.

## Fail-closed controls

- The operator origin and upstream URL must be HTTPS, except loopback development on `localhost`.
- Cross-origin write requests, unapproved API paths, oversized bodies, expired sessions, role revocation, invalid signatures, and missing runtime secrets are rejected.
- Runtime variables `ARTFI_OPERATOR_API_URL`, `ARTFI_OPERATOR_BEARER_TOKEN`, and `ARTFI_OPERATOR_SESSION_SECRET` are server-only and must be supplied outside Git.
- The browser cannot enable this write path with a `NEXT_PUBLIC_*` variable.
- Contract authorization is the final authority. A valid web session cannot bypass registry roles.

This control does not prove artwork title, copyright, physical custody, charity eligibility, securities-law status, or OpenSea discovery. Those remain separate acceptance gates.
