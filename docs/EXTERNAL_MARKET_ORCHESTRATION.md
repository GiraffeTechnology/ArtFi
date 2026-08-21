# External marketplace orchestration

ArtFi mirrors approved external venues and may prepare a transaction for an external wallet. It is
not an exchange, broker-dealer, orderbook, matcher, custodian, fulfiller, settlement agent, or
counterparty. OpenSea/Seaport remains the executing venue and protocol.

## Runtime flow

1. The OpenSea adapter backfills REST events and subscribes to Stream events for reviewed
   collections. Every event retains its source payload, source version, observation time, and HTTPS
   OpenSea link.
2. `GET /v1/market/assets` returns every unique observed chain/contract/token pair with deterministic
   pagination and its latest order state. An empty or unavailable runtime source never falls back to
   fixture cards.
3. `POST /v1/market/intents` accepts an idempotent `fulfill-listing` request for an active mirrored
   order. The API key remains server-side. ArtFi asks OpenSea for unsigned fulfillment data and
   accepts only one same-chain call whose destination is the approved protocol address, calldata is
   bounded and well formed, decimal and hexadecimal values agree, and value does not exceed the
   mirrored listing price.
4. The UI shows chain, asset, order hash, destination, value, venue, and risk boundary before a
   separate user action requests an external-wallet signature. No signature or private key is sent
   to ArtFi.
5. The wallet transaction hash is recorded through the submission endpoint. OpenSea sale,
   cancellation, invalidation, or revalidation events reconcile the durable intent to the external
   authoritative result. Polling only displays stored state; it does not invent success.

## Fail-closed gates

- `ARTFI_EXTERNAL_TRADE_ENABLED` defaults to `false` in the API.
- `NEXT_PUBLIC_EXTERNAL_TRADE_ENABLED` defaults to `false` in the Web UI.
- A missing database, OpenSea API key, active canonical order, protocol address, HTTPS OpenSea URL,
  safe transaction shape, external wallet, or approved source rejects the request before a wallet
  prompt.
- Only the externally supplied chain may be used. Project mint, Vault, and DAO writes remain
  Sepolia-only.
- Cross-chain, multi-call, token-approval, bridge, sweep, offer-acceptance, listing creation, and
  ArtFi-operated order paths are rejected in this release.
- Live enabling requires a separate legal and security approval tied to exact chains, collections,
  payment tokens, OpenSea terms, limits, monitoring, incident response, and user disclosures.

Automated tests use a mock OpenSea fulfillment response. They prove validation, persistence,
idempotency, wallet-submission recording, event reconciliation, and rollback; they are not proof of
live OpenSea acceptance or a completed real-value transaction.
