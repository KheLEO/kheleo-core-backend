# Node 22 is the production reference; CI also verifies Node 24.
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apk add --no-cache openssl tini \
    && corepack enable \
    && corepack prepare pnpm@10.32.0 --activate \
    && chmod -R a+rX /opt/corepack
WORKDIR /app

FROM base AS build
ENV DATABASE_URL=postgresql://generate:generate@127.0.0.1:5432/generate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN DATABASE_URL=postgresql://generate:generate@127.0.0.1:5432/generate pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY scripts/create-entrypoint-shim.cjs ./scripts/create-entrypoint-shim.cjs
COPY src ./src
COPY keys ./keys
RUN pnpm prisma:generate && pnpm build \
    && pnpm prune --prod

FROM base AS production
ENV NODE_ENV=production PORT=3000
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/keys ./keys
COPY --from=build --chown=node:node /app/package.json /app/pnpm-lock.yaml ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/health',{signal:AbortSignal.timeout(3000)}).then(async r=>{const b=await r.json();process.exit(r.ok&&b.status==='ok'&&b.db==='ok'&&b.redis==='ok'?0:1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && pnpm start:prod"]
