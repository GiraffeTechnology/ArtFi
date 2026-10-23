# Build from the repository root with this Dockerfile's allowlisted context.
# The deployment owner binds NODE_IMAGE to the approved immutable image digest.
ARG NODE_IMAGE=node:24.18.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/market-mirror/package.json ./apps/market-mirror/package.json
RUN pnpm --filter @giraffetechnology/artfi-market-mirror... install --frozen-lockfile --ignore-scripts
COPY apps/market-mirror/tsconfig.json apps/market-mirror/tsconfig.build.json ./apps/market-mirror/
COPY apps/market-mirror/src ./apps/market-mirror/src
RUN pnpm --filter @giraffetechnology/artfi-market-mirror build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    OPENSEA_STREAM_STORAGE_PATH=/var/lib/artfi/market-mirror
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/market-mirror/node_modules ./apps/market-mirror/node_modules
COPY --from=build /app/apps/market-mirror/package.json ./apps/market-mirror/package.json
COPY --from=build /app/apps/market-mirror/dist ./apps/market-mirror/dist
RUN mkdir -p /var/lib/artfi/market-mirror \
    && chown node:node /var/lib/artfi/market-mirror
USER node
STOPSIGNAL SIGTERM
# No listener, signing agent, wallet, database or liveness-as-freshness probe.
CMD ["node", "apps/market-mirror/dist/index.js"]
