# UI deployment contract

`io.artcch.com` is the public ArtFi UI origin. DNS, TLS, host firewall, and reverse-proxy changes
belong to the server-configuration task; this repository supplies the application image and the
routes that infrastructure must expose.

## Image build

Build from the repository root so the Web workspace and generated API client are both available:

```bash
docker build -f apps/web/Dockerfile -t artfi-web:<commit> .
```

The image is an unprivileged Next.js standalone runtime on port `3000`. It contains no `.env`, Git
metadata, contract broadcast artifacts, keystore, or local test output.

## Reverse-proxy boundary

- `/` and Next.js assets -> ArtFi Web container port `3000`.
- `/api/health` -> ArtFi Web container port `3000`; expected JSON includes `status: "ok"`,
  `chainId: 11155111`, and `marketplaceMode: "external-mirror"`.
- `/v1/*` -> ArtFi API port `8080` on the private application network.
- The public origin is `https://io.artcch.com`; HTTP must redirect to HTTPS.
- Forward `Host`, `X-Forwarded-For`, `X-Forwarded-Proto`, and a request ID. Do not forward arbitrary
  client authentication headers to operator-only endpoints.

The Web client defaults to same-origin API paths. A different API origin requires the immutable
build argument `NEXT_PUBLIC_API_URL` and a matching API `ARTFI_WEB_ORIGIN`; runtime environment
changes alone cannot rewrite a compiled `NEXT_PUBLIC_*` value.

## Deployment acceptance

1. Pin the image to the exact Git commit or digest; never deploy `latest`.
2. Bind the container only to a private interface or loopback behind the approved proxy.
3. Verify `/api/health`, every legacy UI route, static assets, wallet connection without signing,
   Sepolia enforcement for project writes, CSP/security headers, and the absence of any ArtFi-operated orderbook, matching, custody, fulfillment, or settlement. External fulfillment remains separately gated and wallet-confirmed.
4. Route `/v1/*` only after the API health check and origin policy pass.
5. Roll back by image digest if health, accessibility, API routing, or wallet-chain checks fail.

This contract does not authorize DNS, TLS, server, mainnet, real-value, or marketplace changes.
