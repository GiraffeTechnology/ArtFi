# Stage 1 acceptance evidence

## Delivered scope

- Responsive home, projects, project detail, RWA market, fractional market, asset detail, and portfolio routes.
- Original CSS-generated artwork placeholders; no broken remote image URLs or unlicensed catalog media.
- RainbowKit UI over Wagmi/Viem with a standard injected-wallet connector and Sepolia-only configuration.
- Read-only wallet address, network, and test ETH context. No write hook, signature request, or transaction button exists.
- Go read-only API with health, public configuration, assets, projects, portfolio, CORS, request IDs, structured logs, and problem responses.
- OpenAPI 3.1 contract, generated TypeScript definitions, typed fetch client, and reversible MySQL catalog migration.

## Automated evidence

- Dependency supply-chain policy and peer dependency checks pass.
- Prettier, ESLint, TypeScript, Vitest, Next production build, and OpenAPI generation pass.
- Go formatting, vet, and race-enabled API tests pass.
- Playwright validates eight representative routes on desktop and mobile.
- Axe reports no serious or critical violations on those routes.
- Browser tests assert that the wallet entry point does not expose buy, mint, bid, or claim actions.
- The MySQL 8.4 migration creates two catalog tables and the rollback returns the schema to zero tables.

## Deliberate boundaries

- Catalog data and valuations are representative fixtures, not offers or production records.
- Wallet extension automation does not yet simulate an injected provider; reconnect and unsupported-chain automation remains.
- Redis is provisioned but no cache path is enabled, so there is no invalidation behavior to verify yet.
- Minting, custody, fractionalization, trading, bids, claims, and governance execution remain disabled.
