# Node 24 runs the gateway's TypeScript sources directly; only the dashboard is built.
FROM node:24-slim AS base
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The pnpm version pinned in package.json. Not through corepack, which Node 25 no longer ships.
RUN npm install -g "pnpm@$(node -p 'require("./package.json").packageManager.split("@")[1]')"
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/

FROM base AS dashboard
RUN pnpm install --frozen-lockfile --filter @toolcallstack/search-dashboard
# The dashboard imports a few gateway modules, whose tsconfig extends the root one.
COPY tsconfig.base.json ./
COPY apps apps
RUN pnpm --filter @toolcallstack/search-dashboard build

FROM base
LABEL org.opencontainers.image.source="https://github.com/Viktor286/toolcallstack-search" \
      org.opencontainers.image.description="Unified API gateway for web search providers" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter @toolcallstack/search-gateway
COPY apps/gateway apps/gateway
COPY --from=dashboard /app/apps/dashboard/dist apps/dashboard/dist
USER node
EXPOSE 4310
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4310) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "apps/gateway/src/server.ts"]
