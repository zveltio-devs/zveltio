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
| `DB_POOL_MAX` | `10` | Maximum connection pool size |
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

## Storage (S3/MinIO)

| Variable | Default | Description |
|----------|---------|-------------|
| `S3_ENDPOINT` | — | S3-compatible endpoint URL |
| `S3_ACCESS_KEY` | — | Access key ID |
| `S3_SECRET_KEY` | — | Secret access key |
| `S3_BUCKET` | `zveltio` | Bucket name |
| `S3_REGION` | `us-east-1` | Region (set to any value for MinIO) |
| `S3_PUBLIC_URL` | — | Public base URL for file downloads |
| `BACKUP_DIR` | `/tmp/zveltio-backups` | Local directory for backup files |

### MinIO example

```env
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=zveltio
S3_REGION=us-east-1
S3_PUBLIC_URL=http://localhost:9000/zveltio
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

At least one provider must be configured for AI features to work.

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENAI_MODEL` | `gpt-4o` | Default OpenAI model |
| `ANTHROPIC_API_KEY` | — | Anthropic Claude API key |
| `ANTHROPIC_MODEL` | `claude-opus-4-6` | Default Anthropic model |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL (self-hosted) |
| `OLLAMA_MODEL` | `llama3` | Default Ollama model |

### Provider priority

The first configured provider becomes the default. Configure multiple for fallback:

```env
# Primary: OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o

# Secondary: Anthropic (fallback)
ANTHROPIC_API_KEY=sk-ant-...

# Local: Ollama (dev/air-gap)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1
```

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
| `ZVELTIO_EXTENSIONS_PATH` | `./extensions` | Directory containing extension packages |

### Format

```env
ZVELTIO_EXTENSIONS=ai,compliance/ro/efactura,workflow/approvals
ZVELTIO_EXTENSIONS_PATH=/app/extensions
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

# AI (optional for dev)
OPENAI_API_KEY=sk-...

# Extensions
ZVELTIO_EXTENSIONS=ai,workflow/approvals
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
DB_POOL_MAX=20

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

# AI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
ANTHROPIC_API_KEY=sk-ant-...

# Extensions
ZVELTIO_EXTENSIONS=ai,workflow/approvals,workflow/checklists

# Observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_SERVICE_NAME=zveltio-production
```
