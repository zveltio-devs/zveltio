# ── Stage 1: Build Studio + Client ────────────────────────────
FROM oven/bun:1.3-alpine AS frontend-builder

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
COPY packages/sdk-vue/package.json ./packages/sdk-vue/
COPY packages/studio/package.json ./packages/studio/

RUN bun install --frozen-lockfile

WORKDIR /app/packages/engine

COPY packages/engine ./

RUN if [ "$TARGETARCH" = "arm64" ]; then \
      bun scripts/gen-embedded-migrations.ts && \
      bun scripts/gen-worker-source.ts && \
      bun build src/binary-entry.ts --compile --outfile /zveltio --target bun-linux-arm64; \
    else \
      bun scripts/gen-embedded-migrations.ts && \
      bun scripts/gen-worker-source.ts && \
      bun build src/binary-entry.ts --compile --outfile /zveltio --target bun-linux-x64; \
    fi

# ── Stage 3: Production image ─────────────────────────────────
FROM oven/bun:1.3-alpine AS production

LABEL org.opencontainers.image.title="Zveltio Engine"
LABEL org.opencontainers.image.description="Zveltio Business OS — Engine + Studio"
LABEL org.opencontainers.image.source="https://github.com/zveltio/zveltio"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.vendor="DaRe IT Systems S.R.L."

# Numeric ids, pinned to what `adduser -S` assigned in every image so far, so
# existing volumes stay writable. Kubernetes `runAsNonRoot` refuses an image
# whose USER is a name ("cannot verify user is non-root").
# setpriv: the extension runner (ext-runner in the release compose) drops each
# extension to a uid of its own with it; Bun's spawn ignores `uid`.
# tini: PID 1 when the entrypoint runs the runner beside the engine, to reap
# the extension processes a dead runner leaves behind.
RUN apk add --no-cache curl tzdata setpriv tini && \
    addgroup -S -g 101 zveltio && \
    adduser -S -u 100 -G zveltio zveltio

COPY --from=engine-builder /zveltio /usr/local/bin/zveltio
COPY docker/zveltio-entrypoint.sh /usr/local/bin/zveltio-entrypoint
RUN chmod +x /usr/local/bin/zveltio /usr/local/bin/zveltio-entrypoint

# Static files live outside /data: a volume mounted on /data (the Helm chart's
# PVC) hid them, and /admin served the "Studio UI files are missing" page.
COPY --from=frontend-builder /app/packages/studio/dist /app/studio-dist
COPY --from=frontend-builder /app/packages/client/dist /app/client-dist
ENV STUDIO_DIST_PATH=/app/studio-dist
ENV CLIENT_DIST_PATH=/app/client-dist

WORKDIR /data

# /data must be writable by the zveltio user — the engine downloads extension
# packages into /data/extensions/ and ensureExtensionCoreDeps() writes
# package.json + node_modules there at first start. Without this chown, the
# unprivileged user cannot create files in /data (which is root-owned by the
# WORKDIR directive when no USER has been set yet).
# /data/storage exists in the image so a fresh named volume mounted there
# inherits zveltio ownership instead of root's.
RUN mkdir -p /data/extensions /data/storage && chown -R zveltio:zveltio /data
# The extension runner's socket directory: root's, so neither the engine nor an
# extension can replace the socket. A fresh volume mounted there inherits it.
RUN mkdir -p /run/zveltio-ext && chmod 0755 /run/zveltio-ext

ENV PORT=3000
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

EXPOSE 3000

USER 100:101

# As uid 100 it runs the binary; as root it also starts the extension runner
# in this container and drops the engine to 100:101 (docker/zveltio-entrypoint.sh).
ENTRYPOINT ["/usr/local/bin/zveltio-entrypoint"]
CMD ["start"]

# ── Stage 4: one container, extension runner included ─────────
# The default target: what fly.toml, railway.json and render.yaml build, and
# what `docker build .` gives. Those platforms cannot run the runner as a
# second container, and third-party extensions run only on the runner in
# production. The published image is `production` (release.yml), whose user
# the chart and the release compose rely on; `docker run --user 0:0` gives it
# this behaviour. A name, not 0: Fly.io's init looks the user up in /etc/passwd.
FROM production AS standalone
USER root
# One container is one instance: without Valkey the permission caches live in
# the process, so the engine runs in single-instance mode (the newest instance
# serves, lib/runtime/single-instance.ts) and the production guard accepts it.
# Setting VALKEY_URL turns the mode off; then replicas are safe.
ENV ZVELTIO_SINGLE_INSTANCE=1
