# UI deployment contract

The complete deployment-configured URL for `io.artcch.com` is the ArtFi UI origin for the current three sections:
digital NFTs without physical backing linked to CCHS and primarily traded on OpenSea;
whole-artwork receipt/voucher tokens using ERC-8415; and the existing fractional trading
and DAO workflows. Native receipt and fractional settlement remain available where their
actual contracts and asset bindings are configured. External marketplace mirroring is a
separate integration and does not prohibit those native workflows.

The current application and technical write-testing chain is Hoodi `560048`. This contract
does not select or authorize a new production chain, mainnet deployment, real-asset opening,
or real-money transaction. Historical Sepolia deployment records remain historical evidence.

## Existing deployment topology

- SIN hosts the UI and chain execution.
- CTYun abcdyi and MySQL host backend and data services. SIN routes to them through the
  existing bridge; do not assume an API process on the UI host.
- Reuse the existing ArtFi build, bridge, Qwen API operations and 24-hour supervision after
  checking the current deployment configuration. A related `artcch.com` build must be
  identified as the intended ArtFi application before replacement.
- TCP `443` and occupied ports are excluded for the current CTYun/SIN deployment. Preserve
  SSH, shared bridges and other-task listeners. Inspect current allocations and choose a
  suitable free non-443 port under the client's existing deployment authority; do not invent
  a separate per-port approval requirement. Actual public-ingress authority remains scoped
  to its target rule. Configure the resulting complete public URL, not a default-443 origin.

DNS, TLS, host listeners and deployment changes belong to the existing deployment task.
This repository provides the application images and interface contract.

## Pinned image builds

Build from a clean checkout of the exact validated Git commit. From the repository root:

```bash
docker build -f apps/web/Dockerfile -t artfi-web:<commit> --build-arg ARTFI_BUILD_SHA=<commit> .
docker build -f apps/api/Dockerfile -t artfi-api:<commit> apps/api
```

Supply the existing public browser settings through the build arguments declared in
`apps/web/Dockerfile`. Next.js embeds `NEXT_PUBLIC_*` values during the build; runtime
environment changes cannot rewrite them. These settings include the API/RPC routes and the
specific charity, whole-artwork, fractional and governance deployment addresses. Keep each
market bound to its correct collection/token and catalogue route. Never put a credential in
a public build argument.

The Web image is an unprivileged Next.js standalone runtime on container port `3000`.
`ARTFI_BUILD_SHA` must be the full deployed commit SHA. The API image uses its existing
private `ARTFI_API_ADDR` listener, defaulting to `:8080`; this is not a host-port allocation.
Retain the previous image digest for the existing rollback procedure.

## Routing and server configuration

- `/`, Next.js assets and `/api/*` route to the SIN Web container. `/api/orders` and
  `/api/user/auth/*` are Next server routes, not direct browser access to internal API keys.
- Public `/v1/*` routes to the CTYun API through the established private bridge.
- Preserve the configured public `Host` and effective port at the UI proxy. Native order
  publication checks that Host and the exact browser Origin independently. Untrusted
  client-supplied forwarded headers do not establish authority.
- Keep Next `ARTFI_WEB_URL` and API `ARTFI_WEB_ORIGIN` consistent with
  the complete configured public URL, including its actual port. Public HTTP-to-HTTPS routing belongs to the SIN public origin;
  it must not consume CTYun's SSH port.
- Use the existing `ARTFI_API_URL`, `ARTFI_USER_AUTH_API_URL`, `ARTFI_OPERATOR_API_URL`
  and `ARTFI_ORACLE_READ_API_URL` server bindings. Resolve their supported upstream paths
  from existing operations configuration. Native order and ordinary-user auth adapters
  preserve configured bridge path prefixes.
- Reuse existing MySQL, cache, object storage and indexer configuration. Apply forward
  migrations `000009_native_signed_orders` and `000010_wallet_user_sessions` using the
  established migration procedure. Schema-down operations are not an application-image
  rollback and must not discard persistent orders or sessions.
- Operator, holder, indexer and ordinary-user credentials stay server-side. The ordinary
  user bridge and JWT settings in `.env.example` are empty placeholders. Supply existing
  authorized values through the secure operations workflow; never put production secrets
  in source, build arguments, browser JSON, logs or the handoff report.

## Health and deployed workflow verification

`/api/health` currently returns `status: "ok"`, `chainId: 560048`, `service: "artfi-web"`
and the configured `buildRevision`. Its retained `marketplaceMode: "external-mirror"`
field does not describe the availability of native receipt/fraction settlement. Do not change
that API field merely to reinterpret the deployment contract. API `/healthz` alone also does
not prove database-backed workflows are ready.

After publishing the pinned image, record the deployed SHA/digest and actual results:

1. Verify the public origin, health revision, static assets, existing routes and desktop/mobile
   wallet controls. Check a database-backed public read; an empty account and unavailable
   persistence must remain distinguishable.
2. Verify ordinary sign-in, refresh/reload and logout, explicit seller-bound order publication,
   public order lookup, navigation recovery and configured native settlement through the bridge.
3. Verify the configured whole-artwork Oracle source identity/status. A VALID status is not
   trading permission or proof of physical title.
4. Exercise the authorized test mint, owned-NFT, Vault, exact approval, deposit, issuance and
   holdings path, including failed logging/recovery, the second-NFT path and configured-role
   continuation. Preserve existing chain permissions and wallet confirmations.
5. Verify NFT/CCHS/OpenSea links, configured charity holder delivery, fractional trading,
   DAO delegation/proposal/vote/queue/execute and indexed history. Raw indexed balances are
   explicitly unscaled base units; removed history retains priority.

Current-head CI is code evidence. Actual deployment bindings and these observed runtime
results are separate evidence for the delivery owner's final acceptance. Missing configuration
must remain visible rather than being replaced by fabricated assets or a claimed successful
transaction. No Stage 2 or independent-wallet completion prerequisite is introduced here.
