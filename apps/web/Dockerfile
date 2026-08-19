ARG NODE_IMAGE=node:24.18.0-bookworm-slim

FROM ${NODE_IMAGE} AS build

ENV NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_SEPOLIA_RPC_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SEPOLIA_RPC_URL=$NEXT_PUBLIC_SEPOLIA_RPC_URL

RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @giraffetechnology/artfi-web build \
    && cp -a /app/node_modules/.pnpm/@swc+helpers@* \
      /app/apps/web/.next/standalone/node_modules/.pnpm/

FROM ${NODE_IMAGE} AS runtime

ENV HOSTNAME=0.0.0.0 \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "apps/web/server.js"]
