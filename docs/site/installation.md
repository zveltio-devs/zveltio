<script>
  import VersionedInstall from '$lib/components/VersionedInstall.svelte';
</script>

# 🚀 Zveltio Installation Guide

---

## System Requirements

| Tier            | CPU      | RAM    | Disk        | Users     |
| --------------- | -------- | ------ | ----------- | --------- |
| **Minimum**     | 1 core   | 2 GB   | 20 GB SSD   | &lt; 20   |
| **Small**       | 2 cores  | 4 GB   | 50 GB SSD   | &lt; 100  |
| **Recommended** | 4 cores  | 8 GB   | 200 GB SSD  | &lt; 1000 |
| **Enterprise**  | 8+ cores | 32 GB+ | 500 GB NVMe | 1000+     |

> **WSL / local dev**: 2 GB RAM minimum. Docker Desktop on Windows: allocate at least 3 GB to WSL2 in `.wslconfig`.

---

## Option 1 — One-Click Install (Recommended)

The smart installer auto-detects your environment: uses **Bun native** mode if Bun is installed, **Docker** otherwise.

The installer:

- Generates secure credentials automatically (`.env`)
- Starts PostgreSQL, Valkey, SeaweedFS via Docker
- Runs database migrations
- Creates the first admin account interactively
- Starts the engine

<VersionedInstall />

---

## Option 2 — Docker Compose (Manual)

### Full Stack (Engine + all infrastructure)

```bash
# Download compose file and example env
curl -fsSL https://get.zveltio.com/releases/latest/docker-compose.yml -o docker-compose.yml
curl -fsSL https://get.zveltio.com/releases/latest/.env.example -o .env

# Edit .env — at minimum set these:
# POSTGRES_PASSWORD, SECRET_KEY, S3_SECRET_KEY

docker compose up -d
```

Services started:

| Service         | Image                          | Port |
| --------------- | ------------------------------ | ---- |
| PostgreSQL 18   | pgvector/pgvector:pg18         | —    |
| PgDog (pooler)  | ghcr.io/pgdogdev/pgdog         | —    |
| Valkey          | valkey/valkey:8-alpine         | —    |
| SeaweedFS       | chrislusf/seaweedfs:3.68       | 8333 |
| Engine + Studio | ghcr.io/zveltio/zveltio-engine | 3000 |

### Infrastructure Only (run engine natively)

Use this if you have Bun installed and want to run the engine outside Docker:

```bash
curl -fsSL https://get.zveltio.com/releases/latest/docker-compose.infra.yml -o docker-compose.infra.yml
curl -fsSL https://get.zveltio.com/releases/latest/.env.example -o .env
# Edit .env
docker compose -f docker-compose.infra.yml up -d
zveltio migrate
zveltio start
```

### Engine Only (bring your own infrastructure)

Use this when you have existing PostgreSQL, Redis, and S3:

```bash
curl -fsSL https://get.zveltio.com/releases/latest/docker-compose.engine.yml -o docker-compose.yml
# Set DATABASE_URL, REDIS_URL, S3_ENDPOINT in .env
docker compose up -d
```

---

## Option 3 — Native Binary

Download and run without Docker at all:

```bash
# Linux x64
curl -fsSL https://get.zveltio.com/releases/latest/zveltio-linux-x64 -o zveltio
chmod +x zveltio

# macOS Apple Silicon
curl -fsSL https://get.zveltio.com/releases/latest/zveltio-macos-arm64 -o zveltio
chmod +x zveltio

# Run
./zveltio migrate
./zveltio start
```

> The engine serves the Studio UI itself — no separate process needed. (The
> installer fetches the pre-built Studio into `studio-dist/` alongside the
> binary; in Docker it's baked into the image.)

---

## Option 4 — Compose Builder

Configure interactively and download a custom `docker-compose.yml`:

**[https://get.zveltio.com/builder](https://get.zveltio.com/builder)**

Choose components, ports, extensions, and deployment mode. Download the generated files.

---

## Post-Install Steps

### 1. Run Migrations

```bash
# CLI
zveltio migrate

# Or Docker
docker compose run --rm engine migrate
```

### 2. Create Admin Account

```bash
# CLI
zveltio create-god

# Or Docker
docker compose run --rm engine create-god --email admin@your-org.com
```

### 3. Verify Installation

```bash
curl http://localhost:3000/api/health
```

Expected:

```json
{ "status": "ok" }
```

### 4. Access Studio

Open **http://localhost:3000/admin** and log in with the admin account created above.

---

## Updating

```bash
# Check for updates
zveltio update --check

# Update to latest
zveltio update

# Update to specific version
zveltio update --version 3.0.0-beta.12
```

The `update` command backs up your `.env`, pulls the new image/binary, runs migrations, and restarts the engine.

---

## CLI Reference

```bash
zveltio start           # Start engine (production)
zveltio dev             # Start engine (development, hot reload)
zveltio migrate         # Run pending migrations
zveltio rollback        # Rollback last migration
zveltio create-god      # Create super-admin user
zveltio update          # Update to latest version
zveltio update --check  # Check for available updates
zveltio install <ext>   # Install an extension
zveltio extensions list # List installed extensions
zveltio generate-types  # Generate TypeScript types from collections
zveltio version         # Show current version
```

---

## Troubleshooting

### Database not connecting

```bash
docker compose ps
docker compose logs postgres
# Verify POSTGRES_PASSWORD is set in .env
```

### Port already in use

Edit `.env` and change the conflicting port:

```env
PORT=3001
POSTGRES_PORT=5433
VALKEY_PORT=6380
S3_PORT=8334
```

### Engine not starting

```bash
# View logs
docker compose logs engine
# or (native)
cat zveltio/zveltio.log
```

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | ✅ | Secret for HMAC signing (min 32 chars, `openssl rand -hex 32`) |
| `VALKEY_URL` | ✅ | Valkey connection string (e.g. `redis://:password@host:6379`) |
| `PORT` | — | HTTP port (default: `3000`) |
| `NODE_ENV` | — | `production` / `development` |
| `MAIL_ENCRYPTION_KEY` | ✅ if using mail | AES-256-GCM key for IMAP/SMTP passwords (`openssl rand -hex 32`) |
| `AI_KEY_ENCRYPTION_KEY` | ✅ if using AI | AES-256-GCM key for AI provider API keys (`openssl rand -hex 32`) |
| `METRICS_TOKEN` | — | Bearer token protecting `GET /metrics`. If unset, metrics are public. |
| `SLOW_QUERY_THRESHOLD_MS` | — | Log requests slower than this (default: `200`) |
| `TRUSTED_PROXY` | — | Set to `true` to trust `X-Forwarded-For` headers (behind nginx/ALB) |
| `STRIPE_WEBHOOK_SECRET` | — | Billing extension: Stripe webhook HMAC secret |
| `MEILISEARCH_HOST` | — | Search extension: Meilisearch URL |
| `MEILISEARCH_API_KEY` | — | Search extension: Meilisearch API key |
| `TYPESENSE_HOST` | — | Search extension: Typesense host |
| `TWILIO_ACCOUNT_SID` | — | SMS extension: Twilio account SID |
| `TWILIO_AUTH_TOKEN` | — | SMS extension: Twilio auth token |

---

## Development Setup

> For contributors or those building extensions.

```bash
git clone https://github.com/zveltio-devs/zveltio.git
cd zveltio
bun install

# Start infrastructure
docker compose -f docker-compose.infra.yml up -d

# Copy and edit env
cp .env.example .env

# Run migrations
bun run -T packages/engine/src/db/migrate.ts

# Start engine (hot reload)
bun --watch packages/engine/src/index.ts

# Start Studio (separate terminal)
cd packages/studio && bun run dev
```

**Access:**

- Engine API: http://localhost:3000
- Studio: http://localhost:5173/admin (dev) or http://localhost:3000/admin (production)

---

## Next Steps

- [Configuration Reference](/configuration)
- [Authorization & RBAC](/authorization)
- [Extensions](/extensions)
- [Deployment to Production](/deployment)
- [Horizontal Scaling](/horizontal-scaling)
