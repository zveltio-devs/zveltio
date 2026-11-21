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
- [Escape hatches](#escape-hatches)
- [Server paths and limits](#server-paths-and-limits)
- [Connection pool](#connection-pool)
- [Extensions, registry and diagnostics](#extensions-registry-and-diagnostics)
- [Observability](#observability)
- [Example .env files](#example-env-files)

---

## Required Variables

These must be set for the engine to start:

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/zveltio` |
| `BETTER_AUTH_SECRET` | Secret key for session signing (min 32 chars). Or set `BETTER_AUTH_SECRETS` instead | `your-super-secret-32-char-key-here` |
| `BETTER_AUTH_URL` | Public URL of the engine (used in OAuth redirects) | `https://api.yourapp.com` |

### Secrets from files (`<NAME>_FILE`)

Every credential below can come from a file instead of the environment. Set
`<NAME>_FILE` to the file's path, for example `DATABASE_URL_FILE=/run/secrets/db`
with Docker or Kubernetes secrets. One trailing newline is dropped.

Prefer it in production. A value passed as a variable stays readable in the
process environment (`/proc/self/environ`) for the life of the process, to
anything running in it, and removing it from `process.env` does not change that.
A value read from a file never gets there.

`APNS_KEY`, `APPLE_CLIENT_SECRET`, `BACKUP_DB_PASSWORD`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_SECRETS`, `DATABASE_PASSWORD`, `DATABASE_URL`, `DISCORD_CLIENT_SECRET`,
`ELECTRIC_SECRET`, `FCM_SERVER_KEY`, `FIELD_ENCRYPTION_KEY`,
`GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, `MAIL_ENCRYPTION_KEY`,
`METRICS_TOKEN`, `MICROSOFT_CLIENT_SECRET`, `NATIVE_DATABASE_URL`,
`RECOVERY_TOKEN`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `TWITTER_CLIENT_SECRET`,
`VALKEY_URL`, `VAPID_PRIVATE_KEY`.

Setting both `<NAME>` and `<NAME>_FILE`, or naming a missing or empty file, stops
the engine at boot with the variable's name.

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
| `DB_POOL_MAX` | `40` | **Ceiling on concurrent in-flight requests**, not a throughput knob — the tenant transaction pins one pooled connection per request. Must satisfy `DB_POOL_MAX × engine instances ≤ pooler pool size ≤ max_connections − 10`. The engine prints the arithmetic at boot. The whole budget is held, not just reserved: with the `bun` driver the first query opens all `DB_POOL_MAX` connections (`Bun.SQL` has no minimum or lazy option; measured on Bun 1.3.14, also after an idle close), and `pg` opens them on demand. Verify a change with `scripts/bench-concurrency.ts`. Never below 2 (a smaller value is raised to it): a boot migration or extension install holds its lock on one connection while its work runs on another. One worker-isolated extension serves at most a quarter of it at once; past that its calls answer 503 `extension.busy` (ADR 0056). | Unset, the engine asks the server for `max_connections` at boot and derives a size; this number is the fallback when it cannot ask or `DB_POOL_AUTOSIZE=0`. |
| `ZVELTIO_INSTANCES` | `1` | How many engine instances share this database. The one number autosizing cannot derive — every replica sizing to "what fits" collectively exhausts the server, under exactly the load that started the extra replicas. |
| `DB_POOL_SHARE` | `0.5` | Fraction of the server's usable connections this deployment may take. The database is rarely the engine's alone: migrations, backups, a psql session, another application. |
| `DB_POOL_AUTOSIZE` | `1` | `0` keeps the flat default instead of asking the server. |
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
| `BETTER_AUTH_SECRET` | — | **Required** unless `BETTER_AUTH_SECRETS` is set. Session signing secret (32+ chars). Beside `BETTER_AUTH_SECRETS` it is only the key that decrypts values written before the list |
| `BETTER_AUTH_SECRETS` | — | Versioned secrets for rotation, Better Auth's format `<version>:<secret>,<version>:<secret>`. The **first** entry is current: everything is signed and encrypted with it; older entries only decrypt what they wrote. A malformed list stops the engine at boot. See [Rotating the auth secret](security.md#rotating-better_auth_secret) |
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
| `ZVELTIO_SCHEMA_DIR` | — | Dev only (read only under `NODE_ENV=development` or `test`; unset is production): every schema change made through the engine rewrites this directory as `zveltio schema pull` would, and a rename, type change or drop also writes its `migrations/<id>.json`. See [rfc-schema-as-code.md](../engine/rfc-schema-as-code.md) §7. |
| `ZVELTIO_MAP_TILES` | OpenStreetMap (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`) | The tile server every map in Studio and the client draws from, served to them as `map_tiles` in `GET /api/settings/public`. An `https://` URL template with `{z}`, `{x}` and `{y}` (optional `{s}`, `{r}`); anything else refuses boot. Each tile request carries the viewer's IP address to that host: set your own server to keep it, or `off` to load no tiles at all (a map view then shows its list of places only). |
| `ZVELTIO_MAP_ATTRIBUTION` | `© OpenStreetMap contributors` when `ZVELTIO_MAP_TILES` is unset, else empty | The attribution text shown on the map, as text (front ends escape it). Your tile provider's terms usually require one. |

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
| `S3_PUBLIC_URL` | — | Base URL for **public** objects only (`public/`, `media/` keys). Private objects are always served by presigned URL. |
| `BACKUP_DIR` | `/tmp/zveltio-backups` | Local directory for backup files |
| `AUDIT_ANCHOR_TARGET` | — (no anchor) | Where each audit chain's head is anchored outside the database, at boot and hourly, one new file per write (ADR 0060 decision 5): an absolute directory that must already exist (never created: an absent one is an unmounted target), or `s3://<bucket>/<prefix>` (write-once needs the bucket's object lock) with `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` read from the environment, never from the Studio's storage settings. `GET /api/admin/audit/verify` compares the chains with the latest anchor. Point it at storage the database host cannot rewrite. See [security-model.md](security-model.md#audit-trail-adr-0060). |

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

### Private by default — bucket policy

Objects are private on every driver. Only keys under `public/` (uploads sent
with `public=true`) and `media/` (display assets) get a bare public URL; every
other key — `uploads/…`, `backups/…` — is reachable only through a time-limited
presigned URL (`GET /api/storage/:id/signed-url`).

The engine cannot enforce that on S3: the **bucket policy** does. Allow anonymous
read on the two public prefixes and nothing else. If the whole bucket is
public-read, anyone can strip the `X-Amz-*` query off a presigned link and keep
the file forever. *Settings → Storage → Test connection* fails on such a bucket.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": ["arn:aws:s3:::my-zveltio-bucket/public/*",
                 "arn:aws:s3:::my-zveltio-bucket/media/*"]
  }]
}
```

Objects stored before this rule keep their stored key (the key in
`zv_media_files.storage_path` is authoritative; nothing is moved). A legacy
private file under `uploads/…` stays readable through its presigned URL; a bare
URL handed out for it earlier stops working once the bucket is restricted, which
is the point.

---

## Cache (Valkey/Redis)

| Variable | Default | Description |
|----------|---------|-------------|
| `VALKEY_URL` | `redis://localhost:6379` | **Required in production.** Valkey or Redis connection URL. The engine refuses to start without it — see the note below. |
| `ZVELTIO_SINGLE_INSTANCE` | — | `1` runs production without Valkey, on one serving instance: the newest instance serves and older ones answer 503. Ignored when `VALKEY_URL` is set. See the note below. |

> Zveltio uses `ioredis` which is fully compatible with both Valkey and Redis.

> **Required, not recommended.** Every shipped install path provisions Valkey:
> `docker-compose.yml` will not start the engine until the cache is healthy, and
> both installers fall back apt → prebuilt binary → build from source rather than
> skip it. The engine refuses to start in production when `VALKEY_URL` is unset.
>
> The reason is correctness, not latency: permission invalidation is published
> through the cache, so without one a revoked grant reaches only the replica that
> revoked it. To run exactly one instance without Valkey, set
> `ZVELTIO_SINGLE_INSTANCE=1`: caches and rate limits stay in memory, which is
> correct on one process. Each instance writes a heartbeat to `zv_instances`
> every 10 seconds, and the newest one serves. An older instance that sees a
> newer one keeps serving for 15 seconds (the load balancer's switch), then
> answers 503 to everything except `/api/health` and closes its realtime
> connections. It stays up rather than exit, so an orchestrator does not
> restart it into the newest. `ZVELTIO_ALLOW_NO_CACHE=1`, the older hatch, is
> no longer read.

```env
VALKEY_URL=redis://valkey:6379
# With auth:
VALKEY_URL=redis://:password@valkey:6379
# With TLS:
VALKEY_URL=rediss://valkey:6380
```

---

## AI Providers

AI is the opt-in `ai` extension (ADR 0027); the engine holds no AI settings.
Providers are rows of its `ai_providers` collection, managed from the admin UI
or the data API. The API key is a `secret` field, encrypted under
`FIELD_ENCRYPTION_KEY` and readable only by the extension's job, and the model's
host must be bound to the extension's `provider` egress slot.

> **Changed.** `AI_KEY_ENCRYPTION_KEY` is no longer read: the engine's `ai`
> keyring is gone with ai 1.x. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
> `OLLAMA_URL` and the other provider variables were dropped before that.

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

**First boot needs the npm registry.** Extensions import `hono`, `zod`,
`kysely` and `@hono/zod-validator` by name, and the compiled binary does not
expose its own copies. At boot, if `<EXTENSIONS_DIR>/node_modules/hono` is
missing, the engine creates `EXTENSIONS_DIR` if needed, writes a
`package.json` there with the engine's own version ranges, and runs
`bun install`; without `bun` on the `PATH`, or when it fails (the log says
which, with its last error line), it downloads the four tarballs from
`registry.npmjs.org` at the versions the engine was built against. A boot
that cannot do either logs `Core package install failed` and keeps running,
but an extension with engine routes then does not load. On an air-gapped host,
populate `<EXTENSIONS_DIR>/node_modules` beforehand (`bun install` in that
directory on a connected machine, then copy it). Worker-isolated extensions'
jobs also need Deno: see `ZVELTIO_DENO_PATH`.

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
| `geospatial/postgis` | Location history and map components; proximity and bbox search through the data API |
| `compliance/ro/efactura` | Romanian e-Factura (UBL 2.1 XML + ANAF submission) |
| `compliance/ro/documents` | Romanian documents: contracts, PV, NIR, dispozitii |
| `compliance/ro/procurement` | Romanian procurement: PO, supplier registry, budget |
| `compliance/ro/etransport` | Romanian e-Transport monitoring (ANAF) |
| `compliance/ro/saft` | Romanian SAF-T D.394 XML audit files |

---

## Multi-Tenancy

| Variable | Default | Description |
|----------|---------|-------------|
| `ZVELTIO_TENANT_ID` | — | Tenant id requests fall back to when no header or subdomain names one (single-tenant mode). Must be the `id` of an existing `zv_tenants` row: the engine refuses to boot otherwise — create the tenant first, or unset the variable to serve the default tenant. A suspended tenant named here answers 403 like any other. (`ZVELTIO_TENANT_NAME` is no longer read: the name is the row's.) |
| `BACKUP_DB_USER` | unset | Role `pg_dump` connects as. **Required on a hardened install**: the engine's own role is bound by `FORCE ROW LEVEL SECURITY`, so `pg_dump` as the engine fails on a virgin database. Create a role with `BYPASSRLS`, used for nothing else — see [DISASTER-RECOVERY.md](disaster-recovery.md). Unset falls back to the engine's own credentials. |
| `BACKUP_DB_PASSWORD` | unset | Password for `BACKUP_DB_USER`. Only read when that is set. |
| `ZVELTIO_FAIL_CLOSED_TENANT` | unset (closed) | A query with no tenant context sees **no rows** and may write none — the default since migration 123 (DR-03), held by the database itself, so it also binds a connection the engine never configured. `=0` is the opt-out: boot stores `zveltio.fail_closed_tenant = 'off'` on the database (ALTER DATABASE, as the database owner) and such a query sees and writes the **default tenant** again; the engine warns at every boot while it is set. Removing it resets the stored value; a stored `'off'` the engine cannot reset refuses the boot. Any value but `0` is closed. |

In multi-tenant mode, tenants are resolved from:
1. `X-Tenant-Slug` request header
2. Subdomain matching (e.g., `acme.yourapp.com`)
3. `ZVELTIO_TENANT_ID` env fallback

---

## Security

| Variable | Default | Description |
|----------|---------|-------------|
| `RECOVERY_TOKEN` | — | Emergency bootstrap token (min 32 chars). When set, enables `POST /api/permissions/bootstrap` to promote any user to `god` role. Remove after use. |
| `METRICS_TOKEN` | — | Protects `GET /metrics` with `Authorization: Bearer <token>`. **Unset, `/metrics` returns 403, not metrics** — it fails closed rather than leak uptime, heap and request counts to an anonymous caller. This row previously said the opposite. To scrape without a token over a trusted network, set `METRICS_ALLOW_UNAUTHENTICATED=1` and mean it. |
| `MAIL_ENCRYPTION_KEY` | — | 32-byte hex key for encrypting IMAP/SMTP passwords at rest. Generate: `openssl rand -hex 32` |
| `ZVELTIO_CONSOLE_HOST` | — | Recommended in production. A bare hostname (`admin.example.com`; no scheme, port or path — the engine refuses to start otherwise). When set, the Console (`/admin`), `/api/admin/*`, every configuration mutation and every extension mutation authorized against `admin` answer only on that host and 404 on any other; what the App uses answers on every host. The console host also refuses a request whose `Origin` names another host, so a script on the main domain cannot use the Console's session (sessions are host-only cookies, but the two hosts are same-site). Sign in to the Console on that host. The engine matches the `Host` header and trusts no `X-Forwarded-Host`: a proxy must pass `Host` through. Point the CLI and any script that configures the engine at the console host. Unset, every route answers on every host. |

```bash
# Generate secure keys
openssl rand -hex 32   # for RECOVERY_TOKEN, MAIL_ENCRYPTION_KEY
openssl rand -base64 32  # for BETTER_AUTH_SECRET
```

---

## Escape hatches

Every variable here turns OFF something the engine otherwise guarantees. They
exist because each has a legitimate use — a single-tenant install, a private
network, a migration window — and they are collected in one place because the
question "what can weaken this deployment?" deserves an answer that is a list
rather than a grep.

None of them is on by default. On a hardened install every one of them is off —
`NODE_ENV=production` (or unset: only `development` and `test` are not
production), the rest absent — and the engine says so: it warns at
every boot for each mode that is on, and for each removed variable still set.
The table is generated from the register in
`packages/engine/src/lib/operational-modes.ts`, which is also the only code that
reads these variables (ADR 0058). **removed**: nothing reads it any more;
**dated**: kept until the version named; **permanent**: kept;
**delegated**: not a variable, an exemption an admin gives row by row;
**platform**: the platform's variable, classified here.

<!-- BEGIN generated by scripts/gen-operational-modes.ts — edit the register, not this table -->

| Mode | What it turns off | When it is defensible | Class | Removal |
|------|-------------------|-----------------------|-------|---------|
| `ZVELTIO_COLLECTION_RLS_EXEMPT` | Was: the listed extensions ran without collection permissions in the database. Removed — no extension is exempt, and a membership of `zveltio_coll_exempt` granted before the upgrade admits nothing (migration 125). | Never. Adapt the extension (`ctx.internals.asSystem`). | removed | removed (ADR 0058) |
| `ZVELTIO_ALLOW_UNENFORCED_RLS` | Was: starting in production when the engine role bypasses RLS and `zveltio_rls` is unavailable. Removed — that boot is refused. | Never. Run the engine as a plain role, or let migration 030 create `zveltio_rls`. | removed | removed (ADR 0058) |
| `DEMO_MODE_ALLOW_IN_PROD` | Was: the demo account credentials on `/api/health` in production. Removed — production never publishes them. | Never. | removed | removed (ADR 0058) |
| `ALLOW_INSECURE_LDAP` | Refusing plaintext LDAP binds (auth/ldap): with `true` or `1`, passwords cross the network in the clear. | A directory on a private network that cannot do LDAPS or StartTLS yet. | dated | 3.1.0 |
| `ZVELTIO_ALLOW_PLAINTEXT_ENCRYPTED_FIELDS` | Refusing to write a field marked `encrypted: true` when `FIELD_ENCRYPTION_KEY` is unset. With `=1` the value is stored in the clear. | Never on an install holding PII. A development database, or a deliberate migration off encryption. | dated | 3.1.0 |
| `ZVELTIO_FAIL_CLOSED_TENANT` | The closed tenant fallback: with `=0` a query with no tenant context reads and writes the default tenant's rows instead of none. | A single-tenant install whose own code (an extension's background work, a script on the engine's role) reads tenant tables without a tenant, until that code sets one. | dated | 3.1.0 |
| `ZVELTIO_SINGLE_INSTANCE` | The production refusal to run without `VALKEY_URL`: with `=1` one instance runs without a cache, instances heartbeat in `zv_instances` and only the newest serves. | Exactly one engine process. | permanent | permanent |
| `REQUIRE_EXTENSION_SIGNATURES` | Was: with `=false` an extension archive without a registry signature installed, with a warning. Removed — a missing signature refuses the install, and an unsigned directory never runs, inline or on the runner (ADR 0056 amendment 2026-11-18). | Never. A mirror signs with its own key on `REGISTRY_PUBLIC_KEYS_JSON`; your own extension is signed with a key on `OPERATOR_PUBLIC_KEYS_JSON`. | removed | removed (ADR 0056) |
| `ZVELTIO_EXT_TRANSPORT` | With `=process`, a worker-isolated extension runs as a child of the engine, under its uid. Refused in production (any `NODE_ENV` but `development` or `test`, unset included), where it runs on the extension runner. | Development without a runner. | permanent | permanent |
| `ZVELTIO_EDGE_TRANSPORT` | Where edge function invocations and flow `run_script` steps run in **development** (`NODE_ENV=development` or `test`): unset or `process`, a child of the engine, under the engine's user — the named development placement, logged once, no boundary; `=runner`, the extension runner. In production — every other `NODE_ENV`, unset included — every invocation runs on the extension runner ([RFC](../engine/rfc-extension-runner.md), steps 5 and 10; ADR 0058) whatever its egress, and `=process` stops the engine at boot: the `zveltio-ext-runner@edge` instance on bare metal, the runner container (`ZVELTIO_EXT_RUNNER_SOCKET`) in compose and Helm, under a uid that cannot read the engine's files, environment or processes, with no network. On the runner a function's `fetch` crosses to the engine, which performs it with the SSRF guard and only to the hosts in its `egress` (a column of the function, set in Studio; exact `host` on the scheme's default port, or `host:port`; every redirect hop checked again; 1 MiB request and 5 MiB response bodies, 50 requests and 6 in flight per invocation); a function that declares no egress is refused until it lists its hosts. Same ceilings (`EDGE_MEMORY_LIMIT_MB`, `EDGE_CPU_LIMIT_S`, below 1024 MiB floored: the runner has no per-invocation cgroup), same results; no pre-spawned pool. | `=runner` on a development machine that has a runner. Never in production, where it changes nothing and `=process` is refused. | permanent | permanent |
| `ZVELTIO_ALLOW_MIGRATION_DIVERGENCE` | Refusing to start against a schema newer than the binary. | A rollback window you are actively supervising. | permanent | permanent |
| `ZVELTIO_ALLOW_MISSING_DB` | Gates and the harness lane refusing to run without a database, rather than passing having checked nothing. Never read by a running engine. | A lint-only CI job that genuinely has no Postgres. | permanent | permanent |
| `METRICS_ALLOW_UNAUTHENTICATED` | `/metrics` refusing anonymous callers when no `METRICS_TOKEN` is set. | A Prometheus scraper on a private network. | permanent | permanent |
| `RATE_LIMIT_ALLOWLIST` | Rate limiting, for the listed CIDRs. | An internal load generator, or a known reverse proxy. | permanent | permanent |
| `ZVELTIO_REGISTRATION_ENABLED` | The refusal to self-register (`registration_disabled`). `1` or `true` opens `POST /api/auth/sign-up/email` to anyone; any other non-empty value closes it, whatever the Console says. | An instance that is genuinely meant to accept public sign-ups. | permanent | permanent |
| `NODE_ENV` | `development` or `test` turns off the production refusals: `productionGuardViolations` (no cache, `CORS_ORIGINS=*`, …), the RLS-unenforceable refusal, the extension-runner requirement and edge placement, inline code only on a registry signature (an unsigned source checkout runs inline when the catalogue names it first-party), Secure session cookies, the admin gate on `/api/openapi.json`, the demo credentials kept off `/api/health`, and mounts the unauthenticated `POST /__zveltio_dev_reload`. Every other value — unset included — is production (ADR 0058, owner 2026-11-17): a hand-started engine without it boots as production. Every guard asks `isProduction()`; `check:modes` refuses a direct comparison with `'production'`. | Set `NODE_ENV=development` (or `test`) explicitly on a machine that serves nobody. | platform | permanent |
| `zv_api_keys.rls_bypass` | An API key that reads past row rules, within its issuer's own `data:view_all` (ADR 0028, 0037). Set per key by an admin who holds it; never by a variable. | A service key that must read whole collections, such as an export. | delegated | permanent |
| `ZVELTIO_ALLOW_UNVERIFIED_LDAPS` | LDAPS certificate verification (auth/ldap), for every tenant: with `1` or `true` the directory is not authenticated, so whoever sits on the path reads the bind and user passwords. Was the Console field `tls_verify`; a stored `false` is ignored since auth/ldap 4.0.0. | A directory with a self-signed certificate. Prefer trusting its CA with `NODE_EXTRA_CA_CERTS`, which keeps verification on. | dated | 3.1.0 |
| `ZVELTIO_ALLOW_SAML_ANY_AUDIENCE` | The SAML assertion audience check (auth/saml), for every tenant: with `1` or `true` an assertion the identity provider issued for another service signs a person in here. Was the Console field `audience_check`; a stored `false` is ignored since auth/saml 3.0.0. | An identity provider that sends an audience you cannot match. Prefer setting the expected audience in the SAML settings. | dated | 3.1.0 |

<!-- END generated: operational modes -->

Four more do the opposite — they make the engine STRICTER, and are worth knowing
for the same reason:

| Variable | What it tightens |
|----------|------------------|
| `RATE_LIMIT_DENYLIST` | Comma-separated CIDRs refused before any handler runs. The twin of `RATE_LIMIT_ALLOWLIST` above; keep the pair configured together. |
| `ZVELTIO_STRICT_TENANT_SCOPE` | A query against a tenant-scoped table outside tenant context throws instead of falling back. |
| `ZVELTIO_REQUIRE_CATALOG` | An unreachable extension registry blocks the load instead of degrading to the local catalogue. |
| `ZVELTIO_REQUIRE_REVOCATION_CHECK` | An unreachable registry blocks extension loading instead of warning. |

---

## Server paths and limits

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_NAME` | `Zveltio` | Issuer name for TOTP enrolment; what an authenticator app shows. |
| `BASE_URL` | `BETTER_AUTH_URL`, else `http://localhost:$PORT` | Absolute origin used to sign local storage URLs and to build links. |
| `PUBLIC_URL` | — | Public origin when it differs from `BASE_URL` (behind a proxy or CDN). |
| `STUDIO_DIST_PATH` | `$CWD/studio-dist` | Where the compiled Studio is served from. |
| `CLIENT_DIST_PATH` | `$CWD/client-dist` | Where the compiled public web host is served from. |
| `ZVELTIO_CLIENT_SSR` | unset | `1` renders the public web host on the server, inside the engine process (ADR 0005). Pages that fail to render fall back to the SPA shell. |
| `STORAGE_DIR` | `STORAGE_LOCAL_DIR`, else `$CWD/storage` | Root of the `local` storage driver. |
| `MAX_UPLOAD_BYTES` | `52428800` (50 MB) | Largest accepted upload; the request cap is this plus 5 MB of envelope. |
| `MAX_EXT_BODY_BYTES` | the import limit | Largest request body an `/ext/*` route may receive. |
| `REQUEST_LOG_SAMPLE_RATE` | `1` | Fraction of non-error requests written to the request log. Errors are always logged. |
| `SLOW_QUERY_THRESHOLD_MS` | driver default | Queries slower than this are recorded. `0` records every query — useful in CI, expensive in production. |
| `OPENAPI_PUBLIC` | unset | `true` serves `/api/openapi.json` without authentication. |
| `PASSKEY_RP_ID` | hostname of `BASE_URL` | WebAuthn relying-party id. Set it when the browser origin differs from the engine's. |
| `PASSWORD_LEGACY_SCRYPT_DEADLINE` | — | ISO date after which a legacy scrypt password hash is refused rather than transparently re-hashed to argon2id. |
| `MIGRATIONS_AUTO` | `1` | `0` boots without applying pending migrations. The engine still refuses to run against a schema NEWER than itself. |
| `ZVELTIO_VERSION` | the build's version | Overrides the version the migration runner compares against. Diagnostics only. |

## Connection pool

The shipped defaults serve one engine against one database. CI overrides them
because it boots many engines against one Postgres — see the note at the top of
`.github/workflows/ci.yml`.

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_AUTH_POOL_MAX` | `3` | Separate small pool for authentication queries, so a saturated main pool cannot lock everyone out. |
| `DB_ACQUIRE_TIMEOUT_MS` | `5000` | How long a request waits for a pooled connection before failing. |
| `ZVELTIO_DB_DRIVER` | `bun` | The driver under the engine's connection pool: `bun` (`Bun.SQL`) or `pg` (node-postgres, still on the Bun runtime). `pg` binds parameters as `Bun.SQL` does, so stored values do not change; use it to step around a `Bun.SQL` defect. Realtime `LISTEN` keeps its own node-postgres connection either way (`Bun.SQL` has no `LISTEN`). |
| `DB_QUERY_ACQUIRE_TIMEOUT_MS` | `35000` | How long a statement outside a transaction (boot, jobs, after-commit work) waits for a pooled connection. |
| `DB_IDLE_IN_TXN_TIMEOUT_MS` | `60000` | `idle_in_transaction_session_timeout` for pooled connections. |
| `NATIVE_DATABASE_URL` | — | Direct (non-pooler) connection string, for operations a transaction pooler cannot carry — `LISTEN/NOTIFY`, `CREATE INDEX CONCURRENTLY`. |

## Extensions, registry and diagnostics

| Variable | Default | Description |
|----------|---------|-------------|
| `ZVELTIO_REGISTRY_URL` | `https://registry.zveltio.com` | Extension registry, read by the engine and the CLI. Point it at `http://127.0.0.1:9` in tests so nothing dials the real one. `REGISTRY_URL` (the old engine name) is still read, with a warning, until 3.0.0. |
| `ZVELTIO_CATALOG_PATH` | bundled catalogue | Path to a `catalog.json` to use instead of the bundled one. It lists what can be installed, never who published it: only a name the bundled catalogue (or the registry) lists is first-party, whatever `is_official` or `publisher_tier` the file sets (ADR 0056). |
| `OPERATOR_PUBLIC_KEYS_JSON` | unset | The operator's own trusted signing keys, `[{ "keyId", "publicKeyHex" }]` as `zveltio keys export <id>` prints them; kept apart from `REGISTRY_PUBLIC_KEYS_JSON`. An extension directory signed with one (`zveltio extension sign`) loads at level 3, private: verified at every load, on the extension runner, never inline. A key here confers nothing higher, and a directory whose `signature.json` names a key not listed is refused, not loaded unsigned. See [signatures](../extensions/signatures.md#your-own-extensions-level-3). |
| `ZVELTIO_EXTENSION_DEV_RELOAD` | unset | Enables `POST /__zveltio_dev_reload`, used by `zveltio extension dev`. Never in production. |
| `ZVELTIO_IMPORT_LOGS_CONTRACT` | unset | Arms the import-logs reconciler, which is opt-in by design. |
| `ZVELTIO_TRACE_SQL_ERRORS` | unset | `1` logs the full SQL of every failing statement. Statements may contain data. |
| `ZVELTIO_TRACE_CONNECTIONS` | unset | `1` logs pool acquire/release, for diagnosing exhaustion. |
| `ZVELTIO_EXT_TRANSPORT` | `runner` in production, `process` elsewhere | Where worker-isolated (third-party) extensions run ([RFC](../engine/rfc-extension-runner.md), step 9). `runner`: on the extension runner, under a uid of their own — a `zveltio-ext-runner@<instance>` unit per extension on bare metal (`zveltio ext-runner setup`, run by the native installer and `update.sh`), the runner container in compose and Helm (`ZVELTIO_EXT_RUNNER_SOCKET`), and on Fly.io, Railway, Render and `docker run` the runner the image's entrypoint starts in the same container when it starts as root (the Dockerfile's default target, or `--user 0:0`; it sets this variable and the socket, and drops the engine to uid 100). `process`: a child of the engine speaking the same protocol, under the engine's user — no boundary, the development transport. Production refuses `process` and refuses the extension when no runner answers (the reason is its `loadError` in `/api/admin/extensions/health`); it never falls back to the engine's process. There is no in-thread transport any more. |
| `ZVELTIO_EXT_RUNNER_SOCKET` | — | On the runner, set by its unit: the unix socket one `zveltio-ext-runner@<instance>` listens on (`/run/zveltio-ext/<instance>/runner.sock`); the engine derives the same path from the extension name. In containers (the release compose's `ext-runner` service, Helm `extRunner.enabled`) it is set on **both** the engine and the one runner container, and the engine connects to it instead of starting systemd units. |
| `ZVELTIO_EXT_RUNNER_UID_BASE` | unset | Container runner, and the bare-metal `zveltio-ext-runner@edge` instance (its drop-in sets `400000`: a uid per edge invocation, uids 400000–465535 must stay unused on the host): it starts as root with only `CAP_SETUID`, `CAP_SETGID` and `CAP_KILL` and runs each extension process under its own uid from this value up (65536 reserved, ≥ 1000). Set, the runner refuses to run as anything but root; unset, it refuses root. Its socket directory must belong to root. Each process is also loaded with a seccomp filter that refuses every socket ([ADR 0023](../engine/rfc-extension-runner.md#network)), through `setpriv --seccomp-filter`: the runner image needs util-linux 2.41 or newer (the release image has it). Under a systemd unit that already bans sockets (the `edge` instance) the filter is not loaded, so an older `setpriv` works there. At start the runner checks that a process it starts opens no `AF_INET`, `AF_INET6` or `AF_SMC` socket and refuses to start otherwise (on systemd its unit's `RestrictAddressFamilies=AF_UNIX`, written by `zveltio ext-runner setup` and rewritten by `update.sh`, gives the same ban). There is no setting to turn the check off. |
| `ZVELTIO_DENO_PATH` | unset | The Deno binary the job runner spawns ([ADR 0022](../engine/rfc-extension-model-v3.md)): worker-isolated extensions' jobs run in Deno with no permissions. Unset, the engine downloads Deno 2.9.8 the first time such a job is registered, into `<EXTENSIONS_DIR>/.deno/2.9.8/`, and checks the archive's and the binary's pinned SHA-256 (the binary's again before its first spawn after each boot). Set it on air-gapped hosts or in an image that ships Deno; only its presence is checked. An air-gapped host that keeps the digest check copies the pinned binary to `<EXTENSIONS_DIR>/.deno/2.9.8/deno` instead. The release image is alpine (musl) and carries glibc's loader and libraries for Deno, which ships no musl build. Until Deno is available those jobs wait in their queues. The extension runner runs the jobs and looks for Deno itself, never downloading it: the pinned binary under its own `EXTENSIONS_DIR` (the unit `zveltio ext-runner setup` writes sets it; the runner containers share `/data/extensions`), or `ZVELTIO_DENO_PATH` set in the **runner's** environment too (the one-container entrypoint passes it on; compose and Helm need it on the `ext-runner` service, with the binary mounted there). |
| `ZVELTIO_JOB_RUNNER_CONCURRENCY` | `4` | Deno job runs at once, per engine process (about 60 MB each). A job is claimed only when a slot is free. On the `runner` transport (`ZVELTIO_EXT_TRANSPORT`) each run is a Deno process in its extension's runner, under the runner's uid and socket ban (ADR 0023); production never runs one as the engine's child, and on `process` there it claims none. On bare metal the runs share their extension unit's `MemoryMax=1G` and `TasksMax=64` (a Deno is about 9 tasks) with the extension's routes. One extension takes every slot but one (ADR 0056), so another's jobs always find one. |
| `ZVELTIO_ENGINE_UID` | — | Runner only, required: the numeric uid of the engine service. The runner serves no other uid (SO_PEERCRED) and refuses to run as that uid or as root. |

## Electric (optional sync)

| Variable | Default | Description |
|----------|---------|-------------|
| `ELECTRIC_URL` | — | Electric 1.x HTTP API, reachable from the engine only (e.g. `http://electric:3000`). Absent: `GET /api/electric/v1/shape` answers `503`. Set: the engine proxies shapes it builds from the caller's grants, tenant, row rules and column permissions (see `docs/engine/offline-sync.md`). |
| `ELECTRIC_SECRET` | — | The `ELECTRIC_SECRET` the Electric service runs with. Sent by the engine only; clients never see it. Both must be set. |

## Demo mode

Only read when demo mode is on. See `middleware/demo-mode.ts` for what it gates.

| Variable | Default | Description |
|----------|---------|-------------|
| `DEMO_EMAIL` | `demo@zveltio.com` | Account the demo instance seeds and advertises. |
| `DEMO_PASSWORD` | `demo123456` | Its password. Public by design; never reuse it elsewhere. |
| `DEMO_RESET_CRON` | — | Cron expression for resetting the demo data. |

## Additional OAuth providers

Same shape as the providers in [OAuth Providers](#oauth-providers): set both
halves or leave both unset.

| Variable | Description |
|----------|-------------|
| `APPLE_CLIENT_ID`, `APPLE_CLIENT_SECRET`, `APPLE_TEAM_ID`, `APPLE_KEY_ID` | Sign in with Apple. All four are required together. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Discord. |
| `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET` | X / Twitter. |

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

## Web Push (browser notifications)

| Variable | Default | Description |
|----------|---------|-------------|
| `VAPID_PUBLIC_KEY` | — | base64url, 65 bytes. Also served to the browser by `GET /api/notifications/push/vapid-public-key`. |
| `VAPID_PRIVATE_KEY` | — | base64url, 32 bytes. The signing half — treat it as a secret. |
| `VAPID_SUBJECT` | — | `mailto:` or `https:` URL identifying the operator to the push service. |

Mint a pair with `bun run scripts/generate-vapid-keys.ts`. All three must be set; with any of them missing the sender stays off and `GET /api/notifications/push/vapid-public-key` answers `{ "enabled": false }`, which is the browser's signal not to offer the subscribe prompt.

This is a separate path from FCM/APNS above and is gated on its own keys alone. It needs no third-party account — the keys are generated on this install and registered nowhere — so it is the browser-notification path available to an instance with no route to Google. It does not replace FCM/APNS for native mobile apps.

Rotating `VAPID_PRIVATE_KEY` invalidates every existing subscription: the push service checks the JWT against the key the browser subscribed with. Subscribers have to subscribe again, so rotate only when the key is believed compromised.

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

# Extensions
ZVELTIO_EXTENSIONS=ai,workflow/approvals,workflow/checklists

# Observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_SERVICE_NAME=zveltio-production
```

## Variables the engine READS but you do not set

Two of these exist already in any systemd user session, and the engine only
passes them through:

| Variable | Why the engine reads it |
| --- | --- |
| `XDG_RUNTIME_DIR` | `systemd-run` needs the session bus to create the per-invocation cgroup scope that bounds an edge function's memory. Handed to `systemd-run` and unset before the sandboxed interpreter starts, so it never reaches user code. |
| `DBUS_SESSION_BUS_ADDRESS` | Same, and the same handling. |
| `HTTPS_PROXY` / `HTTP_PROXY` (and the lowercase spellings) | Bun's `fetch` honours them, so the engine checks whether an egress proxy is configured. When one is, outbound requests are left addressed to the hostname instead of being pinned to the address the SSRF guard validated — the proxy is what opens the connection, and rewriting the URL underneath it is an interaction the engine does not claim to have tested. **Consequence: with a proxy configured, the DNS rebinding race stays open**, exactly as it was before pinning existed. If your proxy does not itself restrict internal targets, that is where to close it. |

Absent — a container without systemd, a non-Linux host — the engine falls back
to `RLIMIT_AS`, which cannot express a budget under about 1 GiB and says so in
the log once. Nothing else changes.
