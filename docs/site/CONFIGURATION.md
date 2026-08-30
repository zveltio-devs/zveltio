# ⚙️ Zveltio Configuration

Complete reference for all environment variables used by the Zveltio engine.

---

## Table of Contents

- [Required Variables](#required-variables)
- [Database](#database)
- [Authentication](#authentication)
- [Storage (S3/MinIO)](#storage-s3minio)
- [Cache (Valkey/Redis)](#cache-valkeyredis)
- [AI Providers](#ai-providers)
- [OAuth Providers](#oauth-providers)
- [Extensions](#extensions)
- [Multi-Tenancy](#multi-tenancy)
- [Observability](#observability)
- [Example .env files](#example-env-files)

---

## Required Variables

These must be set for the engine to start:

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/zveltio` |
| `BETTER_AUTH_SECRET` | Secret key for session signing (min 32 chars) | `your-super-secret-32-char-key-here` |
| `BETTER_AUTH_URL` | Public URL of the engine (used in OAuth redirects) | `https://api.yourapp.com` |

---

## Database

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | Full PostgreSQL connection string (preferred) |
| `DATABASE_HOST` | `localhost` | DB host (alternative to URL) |
| `DATABASE_PORT` | `5432` | DB port |
| `DATABASE_NAME` | `zveltio` | Database name |
| `DATABASE_USER` | `postgres` | DB user |
| `DATABASE_PASSWORD` | — | DB password |
| `DATABASE_HOST_DIRECT` | — | Direct host (bypasses PgDog for DDL migrations) |
| `DATABASE_PORT_DIRECT` | `5432` | Direct port |
| `DB_POOL_MAX` | `25` | **Ceiling on concurrent in-flight requests**, not a throughput knob — the tenant transaction pins one pooled connection per request. Must satisfy `DB_POOL_MAX × engine instances ≤ pooler pool size ≤ max_connections − 10`. The engine prints the arithmetic at boot. Verify a change with `scripts/bench-concurrency.ts`. |
| `DB_IDLE_TIMEOUT_MS` | `30000` | Idle connection timeout (ms) |
| `TEST_DATABASE_URL` | — | Separate DB for integration tests |

### Connection string format

```
postgresql://USER:PASSWORD@HOST:PORT/DATABASE?sslmode=require
```

For PgDog (transaction pooling), use `DATABASE_HOST_DIRECT` for DDL operations that require a persistent session connection:

```env
DATABASE_URL=postgresql://user:pass@pgdog:6432/zveltio
DATABASE_HOST_DIRECT=postgres
DATABASE_PORT_DIRECT=5432
```

---

## Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTER_AUTH_SECRET` | — | **Required.** Session signing secret (32+ chars) |
| `BETTER_AUTH_URL` | — | **Required.** Public engine URL for OAuth callbacks |

Generate a secure secret:

```bash
openssl rand -base64 32
```

---

## Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed CORS origins |
| `SITE_URL` | — | Public site URL (used in sitemap.xml generation) |
| `TEST_PORT` | `3001` | Port used by integration test runner |

```env
CORS_ORIGINS=https://app.yourapp.com,https://admin.yourapp.com
SITE_URL=https://yourapp.com
```

---

## Storage

Zveltio ships two storage drivers. **`local` is the default** — a zero-dependency
filesystem driver, so a single-node self-hosted install needs no object store at
all. Switch to **`s3`** (SeaweedFS / AWS S3 / Cloudflare R2 / any S3-compatible
endpoint) when you want shared/off-host storage or horizontal scaling.

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_DRIVER` | auto | `local` or `s3`. Unset → `s3` when `S3_ENDPOINT` is set, else `local`. |
| `STORAGE_LOCAL_DIR` | `<cwd>/storage` | local driver: where uploaded files live (writable + persistent). Installers set this explicitly. |
| `S3_ENDPOINT` | — | s3 driver: S3-compatible endpoint URL (also auto-selects s3 when set) |
| `S3_ACCESS_KEY` | — | Access key ID |
| `S3_SECRET_KEY` | — | Secret access key |
| `S3_BUCKET` | `zveltio` | Bucket name |
| `S3_REGION` | `us-east-1` | Region (any value for non-AWS) |
| `S3_PUBLIC_URL` | — | Public base URL for file downloads |
| `BACKUP_DIR` | `/tmp/zveltio-backups` | Local directory for backup files |

### local driver (default)

```env
STORAGE_DRIVER=local
STORAGE_LOCAL_DIR=/opt/zveltio/storage   # or leave unset for <cwd>/storage
```

At boot the engine probes this directory and warns loudly if it is not writable
(uploads would otherwise fail with a 502). Grant the service user write access,
point `STORAGE_LOCAL_DIR` at a writable path, or switch to `s3`.

### SeaweedFS / S3-compatible example

```env
STORAGE_DRIVER=s3
S3_ENDPOINT=http://seaweedfs:8333
S3_ACCESS_KEY=zveltio
S3_SECRET_KEY=change-me
S3_BUCKET=zveltio
S3_REGION=us-east-1
S3_PUBLIC_URL=http://localhost:8333/zveltio
```

### AWS S3 example

```env
S3_ENDPOINT=https://s3.amazonaws.com
S3_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE
S3_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_BUCKET=my-zveltio-bucket
S3_REGION=eu-west-1
S3_PUBLIC_URL=https://my-zveltio-bucket.s3.eu-west-1.amazonaws.com
```

---

## Cache (Valkey/Redis)

| Variable | Default | Description |
|----------|---------|-------------|
| `VALKEY_URL` | `redis://localhost:6379` | Valkey or Redis connection URL |

> Zveltio uses `ioredis` which is fully compatible with both Valkey and Redis.

```env
VALKEY_URL=redis://valkey:6379
# With auth:
VALKEY_URL=redis://:password@valkey:6379
# With TLS:
VALKEY_URL=rediss://valkey:6380
```

---

## AI Providers

AI providers are **not** configured through the environment. They live in the
`zv_ai_providers` table and are managed from the admin UI, or over the API:

```http
PUT /api/ext/ai/providers/openai
{ "api_key": "sk-...", "default_model": "gpt-4o", "is_active": true, "is_default": true }
```

Supported names are `openai`, `anthropic`, `ollama`, and any OpenAI-compatible
provider given both an `api_key` and a `base_url`.

API keys are encrypted at rest by the host under `AI_KEY_ENCRYPTION_KEY` — the
extension never holds the key material.

> **Changed.** `OPENAI_API_KEY`, `OPENAI_MODEL`, `ANTHROPIC_API_KEY`,
> `ANTHROPIC_MODEL`, `OLLAMA_URL`, `OLLAMA_MODEL` and `AI_EMBED_TIMEOUT_MS` were
> read directly by the AI extension and are no longer consulted. They were a
> second source of truth for a setting that already had one: a provider
> configured that way did not appear in `GET /providers`, could not be edited or
> disabled from the admin UI, and its key sat unencrypted in the process
> environment — so "which model is this instance using" had two answers and only
> one of them was on screen.

### Provider priority

The provider whose row has `is_default = true` is used when a caller does not
name one. Configure several rows for fallback; each is enabled independently
with `is_active`.

---

## OAuth Providers

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth app client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth app client secret |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `MICROSOFT_CLIENT_ID` | Microsoft Entra app client ID |
| `MICROSOFT_CLIENT_SECRET` | Microsoft Entra app client secret |
| `MICROSOFT_TENANT_ID` | Microsoft Entra tenant ID (`common` for multi-tenant) |

OAuth callback URL pattern: `{BETTER_AUTH_URL}/api/auth/callback/{provider}`

```env
GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=abc123...
```

---

## Extensions

| Variable | Default | Description |
|----------|---------|-------------|
| `ZVELTIO_EXTENSIONS` | — | Comma-separated list of extensions to load |
| `EXTENSIONS_DIR` | *(see resolution order)* | Directory containing extension packages on disk |
| `ZVELTIO_EXTENSIONS_PATH` | — | Optional **additional** directory scanned for extra extensions (CI) |

### `EXTENSIONS_DIR` resolution

When unset, the engine picks the first path that exists:

1. `./extensions/` relative to the process CWD
2. `../zveltio-extensions` sibling of the monorepo (local dev)
3. `./extensions/` as the install target

Set explicitly in production and recommended for monorepo contributors:

```env
EXTENSIONS_DIR=/opt/zveltio/extensions
# or, locally:
EXTENSIONS_DIR=/home/you/zveltio-extensions
```

> **Dev footgun:** `packages/engine/extensions/` is gitignored and holds
> marketplace install artifacts, not the source repo. Stale installs can lag
> behind `zveltio-extensions`. Prefer `EXTENSIONS_DIR` pointing at the clone.

### Format

```env
ZVELTIO_EXTENSIONS=ai,compliance/ro/efactura,workflow/approvals
EXTENSIONS_DIR=/app/extensions
```

### Available extensions

> **Note:** Automation `flows` are **engine-core** (`/api/flows`), not an installable extension. No entry needed in `ZVELTIO_EXTENSIONS`.

| ID | Description |
|----|-------------|
| `ai` | Multi-provider AI: chat, embeddings, semantic search, schema generation, agentic workflows |
| `workflow/approvals` | Multi-step approval workflows |
| `workflow/checklists` | Reusable checklists attached to records |
| `content/page-builder` | Block-based CMS page editor |
| `developer/edge-functions` | Deploy TypeScript functions inside the engine |
| `geospatial/postgis` | PostGIS proximity search, bbox, clustering, geofences |
| `compliance/ro/efactura` | Romanian e-Factura (UBL 2.1 XML + ANAF submission) |
| `compliance/ro/documents` | Romanian documents: contracts, PV, NIR, dispozitii |
| `compliance/ro/procurement` | Romanian procurement: PO, supplier registry, budget |
| `compliance/ro/etransport` | Romanian e-Transport monitoring (ANAF) |
| `compliance/ro/saft` | Romanian SAF-T D.394 XML audit files |

---

## Multi-Tenancy

| Variable | Default | Description |
|----------|---------|-------------|
| `ZVELTIO_TENANT_ID` | — | Default tenant ID (single-tenant mode) |
| `ZVELTIO_TENANT_NAME` | — | Default tenant display name |
| `ZVELTIO_FAIL_CLOSED_TENANT` | unset | Set to `1` to make `zveltio_tenant_scope_ok` return **no rows** when `zveltio.current_tenant` is unset (migration 047). Default remains fail-open-to-default-tenant. **Do not enable** on single-tenant installs or jobs that omit tenant context. |
| `ZVELTIO_ALLOW_UNENFORCED_RLS` | unset | Escape hatch when the engine role can bypass RLS and `zveltio_rls` is unavailable. Required to start in production in that state; only defensible on single-tenant installs. |

In multi-tenant mode, tenants are resolved from:
1. `X-Tenant-Slug` request header
2. Subdomain matching (e.g., `acme.yourapp.com`)
3. `ZVELTIO_TENANT_ID` env fallback

---

## Security

| Variable | Default | Description |
|----------|---------|-------------|
| `RECOVERY_TOKEN` | — | Emergency bootstrap token (min 32 chars). When set, enables `POST /api/permissions/bootstrap` to promote any user to `god` role. Remove after use. |
| `METRICS_TOKEN` | — | When set, protects `GET /metrics` with `Authorization: Bearer <token>`. If unset, metrics are public (acceptable behind a firewall). |
| `MAIL_ENCRYPTION_KEY` | — | 32-byte hex key for encrypting IMAP/SMTP passwords at rest. Generate: `openssl rand -hex 32` |
| `AI_KEY_ENCRYPTION_KEY` | — | 32-byte hex key for encrypting AI provider API keys at rest. Generate: `openssl rand -hex 32` |

```bash
# Generate secure keys
openssl rand -hex 32   # for RECOVERY_TOKEN, MAIL_ENCRYPTION_KEY, AI_KEY_ENCRYPTION_KEY
openssl rand -base64 32  # for BETTER_AUTH_SECRET
```

---

## Mobile Push Notifications

| Variable | Default | Description |
|----------|---------|-------------|
| `FCM_SERVER_KEY` | — | Firebase Cloud Messaging legacy server key. Enables Android + Web push. |
| `APNS_KEY` | — | ES256 private key in PEM/p8 format for APNS token-based auth. |
| `APNS_KEY_ID` | — | 10-character key ID from Apple Developer console. |
| `APNS_TEAM_ID` | — | 10-character Apple Developer team ID. |
| `APNS_BUNDLE_ID` | — | App bundle identifier (e.g. `com.example.app`). |
| `APNS_PRODUCTION` | `false` | Set to `true` to use the production APNS endpoint instead of sandbox. |

When either `FCM_SERVER_KEY` or `APNS_KEY` is configured, in-app notifications (`sendNotification()`) automatically also deliver mobile push to all registered device tokens for the target user.

---

## Caching

| Variable | Default | Description |
|----------|---------|-------------|
| `QUERY_CACHE_TTL_SECONDS` | `10` | TTL in seconds for Valkey-backed GET list query cache. Set to `0` to disable. Cache is invalidated automatically on any write to the collection. |

---

## Observability

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OpenTelemetry OTLP endpoint URL |
| `OTEL_SERVICE_NAME` | `zveltio-engine` | Service name in traces/metrics |

If `OTEL_EXPORTER_OTLP_ENDPOINT` is not set, telemetry is a no-op (zero overhead).

```env
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_SERVICE_NAME=zveltio-production
```

---

## Example .env files

### Development

```env
# Server
PORT=3000
HOST=0.0.0.0
CORS_ORIGINS=http://localhost:5173,http://localhost:5174
SITE_URL=http://localhost:3000

# Database
DATABASE_URL=postgresql://zveltio:zveltio@localhost:5432/zveltio

# Auth
BETTER_AUTH_SECRET=dev-secret-change-in-production-32chars
BETTER_AUTH_URL=http://localhost:3000

# Cache
VALKEY_URL=redis://localhost:6379

# Storage
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=zveltio
S3_REGION=us-east-1
S3_PUBLIC_URL=http://localhost:9000/zveltio

# AI providers are configured in the admin UI, not here — see "AI Providers".
# The host still needs this to encrypt the keys it stores:
AI_KEY_ENCRYPTION_KEY=<openssl rand -hex 32>

# Extensions
ZVELTIO_EXTENSIONS=ai,workflow/approvals
EXTENSIONS_DIR=../zveltio-extensions
```

### Production

```env
# Server
PORT=3000
HOST=0.0.0.0
CORS_ORIGINS=https://app.yourapp.com,https://admin.yourapp.com
SITE_URL=https://yourapp.com

# Database
DATABASE_URL=postgresql://zveltio:strongpassword@postgres:5432/zveltio?sslmode=require
DATABASE_HOST_DIRECT=postgres-primary
# Concurrent in-flight requests per engine instance. Check the arithmetic:
# DB_POOL_MAX × instances must fit inside the server's max_connections, with
# ~10 left over for migrations, backups and a psql session.
DB_POOL_MAX=60

# Auth
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=https://api.yourapp.com

# OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...

# Cache
VALKEY_URL=redis://:strongpassword@valkey:6379

# Storage (AWS S3)
S3_ENDPOINT=https://s3.amazonaws.com
S3_ACCESS_KEY=AKIA...
S3_SECRET_KEY=...
S3_BUCKET=yourapp-zveltio
S3_REGION=eu-west-1
S3_PUBLIC_URL=https://cdn.yourapp.com

# AI providers are rows in zv_ai_providers, managed from the admin UI.
# This key encrypts them at rest.
AI_KEY_ENCRYPTION_KEY=<openssl rand -hex 32>

# Extensions
ZVELTIO_EXTENSIONS=ai,workflow/approvals,workflow/checklists

# Observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_SERVICE_NAME=zveltio-production
```
