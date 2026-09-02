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

### Software it needs running

The table above is hardware. This is what has to exist for the engine to start.
Every install path below provisions the required ones for you — this is here so
you know what you are running, and what you may leave out.

| Service | Version | Required? | What breaks without it |
| --- | --- | --- | --- |
| **PostgreSQL** | 18, with the `vector` extension | **Required** | Nothing runs. This is the product's state — collections, auth, audit trail, and the row-level security that separates tenants. |
| **Valkey** (or Redis-compatible) | 8 | **Required** | The engine refuses to boot in production. Permission and identity caches go to the database on every request, and a revoked grant reaches only the replica that revoked it. To run without one deliberately, set `ZVELTIO_ALLOW_NO_CACHE=1`. |
| **Object storage** (SeaweedFS, MinIO, S3) | S3-compatible | Optional | Nothing. Uploads default to the local filesystem; storage switches to S3 only when `S3_ENDPOINT` is set or `STORAGE_DRIVER=s3`. |
| **PgDog** (connection pooler) | — | Optional | Nothing at one engine. It matters when several engine replicas share one Postgres — see [HORIZONTAL_SCALING.md](HORIZONTAL_SCALING.md). |
| **Prometheus + Grafana** | — | Optional | Only observability. The metrics endpoint exists either way; see [monitoring.md](monitoring.md). |

**Bun ≥ 1.3.13** is needed to build from source or to develop. The released
binaries are compiled and do not need it.

Valkey moved from optional to required deliberately, and the reason is written
down in [CONFIGURATION.md](CONFIGURATION.md#cache-valkeyredis): without a shared
cache, a permission change is not a slower operation, it is one that silently
does not reach the other replicas.

---

## Option 1 — One-Click Install (Recommended)

The smart installer auto-detects your environment: uses **Bun native** mode if Bun is installed, **Docker** otherwise.

The installer:

- Generates secure credentials automatically (`.env`)
- Starts PostgreSQL and Valkey (files use the built-in **local storage driver** by default; SeaweedFS is opt-in — see below)
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
| SeaweedFS       | chrislusf/seaweedfs:3.68       | 8333 (opt-in — `--profile storage`, `STORAGE_DRIVER=s3`) |
| Engine + Studio | ghcr.io/zveltio/zveltio-engine | 3000 |

> **Storage:** By default the engine stores uploaded files on local disk (the
> `engine_storage` volume) — no object store required. To use SeaweedFS or any
> S3-compatible service instead, start it with `docker compose --profile storage up -d`
> and set `STORAGE_DRIVER=s3` in `.env`.

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

### Extension settings

An extension never reads the engine's environment. It is handed only the
variables named `ZVELTIO_EXT_<EXTENSION>_<KEY>`, with the prefix stripped, and
sees nothing else — not `DATABASE_URL`, not `BETTER_AUTH_SECRET`, and not
another extension's keys. `<EXTENSION>` is the extension name uppercased with
`/` and `-` replaced by `_`, so `finance/banking` reads
`ZVELTIO_EXT_FINANCE_BANKING_*`.

| Variable | Extension | Description |
|----------|-----------|-------------|
| `ZVELTIO_EXT_BILLING_STRIPE_WEBHOOK_SECRET` | `billing` | Stripe webhook HMAC secret |
| `ZVELTIO_EXT_SEARCH_MEILISEARCH_URL` | `search` | Meilisearch URL (default `http://localhost:7700`) |
| `ZVELTIO_EXT_SEARCH_MEILISEARCH_API_KEY` | `search` | Meilisearch API key |
| `ZVELTIO_EXT_SEARCH_TYPESENSE_HOST` | `search` | Typesense host (default `http://localhost`) |
| `ZVELTIO_EXT_SEARCH_TYPESENSE_PORT` | `search` | Typesense port (default `8108`) |
| `ZVELTIO_EXT_SEARCH_TYPESENSE_API_KEY` | `search` | Typesense API key |
| `ZVELTIO_EXT_SMS_TWILIO_ACCOUNT_SID` | `sms` | Twilio account SID |
| `ZVELTIO_EXT_SMS_TWILIO_AUTH_TOKEN` | `sms` | Twilio auth token |
| `ZVELTIO_EXT_SMS_TWILIO_FROM_NUMBER` | `sms` | Sender number |
| `ZVELTIO_EXT_SMS_VONAGE_API_KEY` | `sms` | Vonage API key |
| `ZVELTIO_EXT_SMS_VONAGE_API_SECRET` | `sms` | Vonage API secret |
| `ZVELTIO_EXT_SMS_VONAGE_FROM_NUMBER` | `sms` | Sender number |

The unprefixed forms (`STRIPE_WEBHOOK_SECRET`, `MEILISEARCH_HOST`,
`TWILIO_AUTH_TOKEN`, …) are no longer read. AI providers moved further: they are
rows in `zv_ai_providers` managed from the admin UI, not environment variables
at all.

---

## Development Setup

> For contributors or those building extensions. See
> [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for footguns (`EXTENSIONS_DIR`, CORS,
> `studio-dist/`).

```bash
git clone https://github.com/zveltio-devs/zveltio.git
git clone https://github.com/zveltio-devs/zveltio-extensions.git   # sibling repo
cd zveltio
bun install

# Start infrastructure
docker compose -f docker-compose.infra.yml up -d

# Copy and edit env
cp .env.example .env
# Required: DATABASE_URL, BETTER_AUTH_SECRET
# Recommended: EXTENSIONS_DIR=../zveltio-extensions
# Split Studio dev: CORS_ORIGINS includes http://localhost:5173

# Run migrations
bun run -T packages/engine/src/db/migrate.ts

# Embed Studio (or skip and use split dev with VITE_ENGINE_URL)
bun run studio:build && bun run studio:embed

# Start engine (hot reload)
cd packages/engine && bun run dev

# Optional — Studio with HMR (second terminal)
cd packages/studio
VITE_ENGINE_URL=http://localhost:3000 bun run dev
```

**Access:**

- Engine API: http://localhost:3000 (or `PORT` in `.env`)
- Studio embedded: http://localhost:3000/admin
- Studio dev: http://localhost:5173/admin (requires `VITE_ENGINE_URL` + CORS)

---

## Next Steps

- [Configuration Reference](/configuration)
- [Authorization & RBAC](/authorization)
- [Extensions](/extensions)
- [Deployment to Production](/deployment)
- [Horizontal Scaling](/horizontal-scaling)
