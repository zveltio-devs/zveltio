FROM oven/bun:1-alpine

# vite build needs git for some plugins; apk adds ~5 MB
RUN apk add --no-cache git

WORKDIR /app

# Install Studio dependencies first (cached layer)
COPY packages/studio/package.json ./
RUN bun install --frozen-lockfile

# Copy Studio source (routes, scripts, configs)
COPY packages/studio/ ./

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:3001/health || exit 1

CMD ["bun", "run", "builder-server.ts"]
