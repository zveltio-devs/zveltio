# ── Stage 1: Build Studio ─────────────────────────────────────
FROM oven/bun:1.3-alpine AS studio-builder

WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/client/package.json ./packages/client/
COPY packages/engine/package.json ./packages/engine/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/sdk-react/package.json ./packages/sdk-react/
COPY packages/sdk-vue/package.json ./packages/sdk-vue/
COPY packages/studio/package.json ./packages/studio/

RUN bun install --frozen-lockfile

COPY packages/studio ./packages/studio
COPY packages/sdk ./packages/sdk

ENV PUBLIC_ENGINE_URL=""
RUN cd packages/studio && bun run build

# ── Stage 2: Build Engine ─────────────────────────────────────
FROM oven/bun:1.3-alpine AS engine-builder

WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/client/package.json ./packages/client/
COPY packages/engine/package.json ./packages/engine/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/sdk-react/package.json ./packages/sdk-react/
COPY packages/sdk-vue/package.json ./packages/sdk-vue/
COPY packages/studio/package.json ./packages/studio/

RUN bun install --frozen-lockfile

COPY packages/engine ./packages/engine
COPY packages/sdk ./packages/sdk

COPY --from=studio-builder /app/packages/studio/dist ./packages/engine/studio-dist

RUN bun build packages/engine/src/index.ts \
    --compile \
    --outfile /zveltio \
    --target bun-linux-x64

# ── Stage 3: Production image ─────────────────────────────────
FROM oven/bun:1.3-alpine AS production

LABEL org.opencontainers.image.title="Zveltio Engine"
LABEL org.opencontainers.image.description="Zveltio Business OS — Engine + Studio"
LABEL org.opencontainers.image.source="https://github.com/zveltio/zveltio"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.vendor="DaRe IT Systems S.R.L."

RUN apk add --no-cache curl tzdata && \
    addgroup -S zveltio && \
    adduser -S zveltio -G zveltio

COPY --from=engine-builder /zveltio /usr/local/bin/zveltio
RUN chmod +x /usr/local/bin/zveltio

WORKDIR /data

ENV PORT=3000
ENV NODE_ENV=production
ENV SERVE_STUDIO=true

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:${PORT}/api/health || exit 1

EXPOSE 3000

USER zveltio

ENTRYPOINT ["/usr/local/bin/zveltio"]
CMD ["start"]
