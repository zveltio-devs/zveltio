# ── Stage 1: Build Studio ─────────────────────────────────────────────────────
FROM oven/bun:1 AS studio-builder

WORKDIR /app

# Copy workspace root and studio package
COPY package.json turbo.json ./
COPY packages/studio/package.json ./packages/studio/
COPY packages/sdk/package.json ./packages/sdk/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY packages/sdk/ ./packages/sdk/
COPY packages/studio/ ./packages/studio/

# Build studio static output
WORKDIR /app/packages/studio
RUN bun run build

# ── Stage 2: Build Engine + embed Studio ─────────────────────────────────────
FROM oven/bun:1 AS engine-builder

WORKDIR /app

# Copy workspace root
COPY package.json turbo.json ./
COPY packages/engine/package.json ./packages/engine/
COPY packages/sdk/package.json ./packages/sdk/

RUN bun install --frozen-lockfile

# Copy engine source
COPY packages/engine/ ./packages/engine/
COPY packages/sdk/ ./packages/sdk/

# Embed the built studio
COPY --from=studio-builder /app/packages/studio/build ./packages/engine/src/studio-dist/

# Build standalone binary
WORKDIR /app/packages/engine
RUN bun build src/index.ts --compile --outfile /app/zveltio-server --target bun

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM ubuntu:24.04 AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the compiled binary
COPY --from=engine-builder /app/zveltio-server ./zveltio-server
RUN chmod +x zveltio-server

# Extensions are mounted as a volume at runtime
VOLUME ["/app/extensions"]

EXPOSE 3000

ENV PORT=3000
ENV HOST=0.0.0.0
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["./zveltio-server"]
