# ── Stage 1: Build Studio + Client ────────────────────────────
FROM oven/bun:1.3-alpine AS frontend-builder

WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/client/package.json ./packages/client/
COPY packages/engine/package.json ./packages/engine/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/sdk-react/package.json ./packages/sdk-react/
COPY packages/sdk-react-native/package.json ./packages/sdk-react-native/
COPY packages/sdk-vue/package.json ./packages/sdk-vue/
COPY packages/studio/package.json ./packages/studio/

RUN bun install --frozen-lockfile

COPY packages/sdk ./packages/sdk
COPY packages/studio ./packages/studio
COPY packages/client ./packages/client

# Build SDK first — client imports from @zveltio/sdk (dist/index.js must exist)
RUN cd packages/sdk && bun run build

# Studio at /admin/ — PUBLIC_ENGINE_URL="" means same-origin API calls
ENV PUBLIC_ENGINE_URL=""
RUN cd packages/studio && bun run build

# Client at / — same-origin API calls
RUN cd packages/client && bun run build

# ── Stage 2: Build Engine Binary ──────────────────────────────
FROM oven/bun:1.3-alpine AS engine-builder

ARG TARGETARCH

WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/client/package.json ./packages/client/
COPY packages/engine/package.json ./packages/engine/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/sdk-react/package.json ./packages/sdk-react/
COPY packages/sdk-react-native/package.json ./packages/sdk-react-native/
COPY packages/sdk-vue/package.json ./packages/sdk-vue/
COPY packages/studio/package.json ./packages/studio/

RUN bun install --frozen-lockfile

COPY packages/engine ./packages/engine
COPY packages/sdk ./packages/sdk

RUN if [ "$TARGETARCH" = "arm64" ]; then \
      bun build packages/engine/src/index.ts --compile --outfile /zveltio --target bun-linux-arm64; \
    else \
      bun build packages/engine/src/index.ts --compile --outfile /zveltio --target bun-linux-x64; \
    fi

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

# Static files served at runtime from CWD (/data)
COPY --from=frontend-builder /app/packages/studio/dist ./studio-dist
COPY --from=frontend-builder /app/packages/client/dist ./client-dist

# /data must be writable by the zveltio user — the engine downloads extension
# packages into /data/extensions/ and ensureExtensionCoreDeps() writes
# package.json + node_modules there at first start. Without this chown, the
# unprivileged user cannot create files in /data (which is root-owned by the
# WORKDIR directive when no USER has been set yet).
RUN mkdir -p /data/extensions && chown -R zveltio:zveltio /data

ENV PORT=3000
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

EXPOSE 3000

USER zveltio

ENTRYPOINT ["/usr/local/bin/zveltio"]
CMD ["start"]
