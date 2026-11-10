# Node 24 runs the gateway's TypeScript sources directly; only the dashboard is built.
FROM node:24-slim AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/

FROM base AS dashboard
RUN pnpm install --frozen-lockfile --filter @toolcallstack/search-dashboard
COPY apps apps
RUN pnpm --filter @toolcallstack/search-dashboard build

FROM base
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter @toolcallstack/search-gateway
COPY apps/gateway apps/gateway
COPY --from=dashboard /app/apps/dashboard/dist apps/dashboard/dist
USER node
EXPOSE 4310
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4310) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "apps/gateway/src/server.ts"]
