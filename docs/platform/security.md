# Security

Two documents cover security, and they answer different questions:

- **This one** — the threat model, what counts as a finding, and the operator's
  hardening guide.
- **[security-model.md](security-model.md)** — the technical model: cookies and
  CSRF, CSP, secrets at rest, sandboxes, per-extension isolation and RBAC,
  retention, and **how to report a vulnerability**.

---

## Reporting a vulnerability

**Do not open a public issue.** Email `security@zveltio.com`. Both repositories
are public, so a committed secret is a disclosed secret and rates accordingly.
Full policy in [security-model.md](security-model.md#reporting-vulnerabilities).

---

## 1. Threat model

Who we defend against, in priority order:

1. An authenticated user of tenant A reaching tenant B's data.
2. An unauthenticated request reaching anything.
3. A lower-privileged user escalating within their own tenant.
4. A third-party extension exceeding what the operator granted it.
5. An operator's own misconfiguration having silent security consequences.

**The operator is trusted.** They have shell access to the machine and
credentials for the database. A vulnerability that requires already being the
instance administrator is generally not a finding — that person owns the box.
What *is* a finding is a misconfiguration whose security consequences are
silent, because the operator cannot defend against what the system does not
tell them.

**There is no public data API.** Everything under `/api/*` requires a session.
Anonymous requests reach nothing, so a threat model that assumes an
internet-facing unauthenticated data surface is modelling the wrong system.

### Where security decisions actually live

| Concern | Where it is decided |
|---|---|
| Tenant isolation | `lib/tenancy/` — `tenant-manager.ts`, `tenant-context.ts`, `rls.ts` |
| Authorization / RBAC | `lib/tenancy/permissions.ts` (Casbin, **with domains** = per tenant) |
| Row and column access | `lib/tenancy/entity-access.ts`, `column-permissions.ts`, `row-rule-policy.ts` |
| Session / auth | Better-Auth, wired in `lib/auth.ts` |
| Per-request middleware | `middleware/` — tenant guard, membership, rate limit, URL validation |
| Extension loading and sandbox | `lib/extensions/` — `load.ts`, `register.ts`, `extension-sandbox.ts`, `capabilities.ts` |
| SSRF validation | `lib/security/url-validator.ts` (`assertPublicUrl`), used by `edge-functions/safe-fetch.ts` |
| Worker SQL policy | `lib/extensions/worker-sql-policy.ts` |

---

## 2. Deliberate design decisions

These read as findings and are not. Each is a decision with a mechanism behind
it; the mechanism is named so it can be checked.

**2.1 — Postgres RLS policies exist but the engine's own role bypasses them.**
Intentional in that shape. Enforcement lives in `withTenantIsolation`:
`SET LOCAL ROLE zveltio_rls` plus a `set_config` GUC read by
`zveltio_tenant_scope_ok`.

**2.2 — `/ext/*` is fail-closed at the engine, not per-extension.**
`middleware/extension-auth-gate.ts` requires a valid session for anything under
`/ext/<name>/*` unless the manifest declares that sub-path in `publicRoutes`. An
extension author who forgets an inline check gets 401, not exposure.

**2.3 — Localhost calls in the AI and storage extensions are by design.**
Ollama and SeaweedFS are meant to be reached on loopback.

**2.4 — Extension bundles, not sources, are what runs.**
The runtime loads `engine/index.js`, a built bundle — not `engine/routes.ts`.

**2.5 — `media/` and `public/` storage keys are served unsigned deliberately.**
Everything else under `/files/*` requires a valid signature. The two public
namespaces are the exception, not an oversight (`routes/files.ts`).

---

## 3. Operator hardening guide

### Security Overview

Zveltio implements **defense in depth** security with multiple layers:

```
┌─────────────────────────────────────────┐
│  Layer 1: Network (Firewall, SSL/TLS)  │
├─────────────────────────────────────────┤
│  Layer 2: Application (Rate Limiting)  │
├─────────────────────────────────────────┤
│  Layer 3: Authentication (Better-Auth)  │
├─────────────────────────────────────────┤
│  Layer 4: Authorization (Casbin RBAC)    │
├─────────────────────────────────────────┤
│  Layer 5: Emergency Admin Access         │
├─────────────────────────────────────────┤
│  Layer 6: Database (Encryption, RLS)     │
├─────────────────────────────────────────┤
│  Layer 7: Audit (Logging, Monitoring)   │
└─────────────────────────────────────────┘
```

**Security Principles:**

- ✅ Least Privilege Access
- ✅ Zero Trust Architecture
- ✅ Defense in Depth
- ✅ Fail Secure (not fail open)
- ✅ Security by Default

---

### Authentication Security

#### Password Security

**Requirements enforced:**

```typescript
// Password must have:
- Minimum 8 characters
- At least 1 uppercase letter
- At least 1 lowercase letter
- At least 1 number
- At least 1 special character

// Passwords are hashed using bcrypt
```

#### Session Security

```typescript
// Session configuration (Better-Auth)
{
  sessionMaxAge: 7 * 24 * 60 * 60, // 7 days
  sessionUpdateAge: 24 * 60 * 60,  // Refresh daily
  sessionCookie: {
    httpOnly: true,        // ✅ Prevent XSS
    secure: true,         // ✅ HTTPS only
    sameSite: 'strict',   // ✅ CSRF protection
    path: '/'
  }
}
```

#### Environment Variables

```bash
# Authentication - CRITICAL
BETTER_AUTH_SECRET=CHANGE_ME_64_RANDOM_CHARACTERS
BETTER_AUTH_URL=https://api.yourdomain.com
```

#### API Key Security

API keys are hashed with **HMAC-SHA256** (not plain SHA-256) using `BETTER_AUTH_SECRET` as a keyed salt. This prevents rainbow-table attacks against the predictable `zvk_` prefix format even if the database is compromised.

- Raw key shown **only once** at creation — never stored
- Keys start with `zvk_` prefix for easy identification
- Scoped per collection and action (`read`, `create`, `update`, `delete`)
- Optional expiry date and per-key rate limit
- Revocable immediately via `DELETE /api/api-keys/:id`

---

### Authorization & RBAC

#### Casbin Policies

**Default Secure Policies:**

```csv
# p, subject, resource, action, scope
p, admin, *, *, ALL
p, manager, data, read, ORGANIZATION
p, manager, data, write, DEPARTMENT
p, employee, data, read, OWN
```

#### Emergency Admin Access

Zveltio has a special **Emergency Admin Access** mechanism for emergency access:

```typescript
// In permissions.ts - checked BEFORE Casbin
const isGod = result.rows[0]?.role === 'god';
if (isGod) return true; // Emergency Admin bypass — all permission checks skipped!
```

> **Note:** This mechanism provides a fail-safe guarantee that administrators cannot be permanently locked out through misconfiguration.

**⚠️ Security Warning:**

- Only create ONE Emergency Admin (Super-Admin) user for emergency access
- Use the Emergency Admin account only when absolutely necessary
- Monitor Emergency Admin activity closely

#### Hardening

- ❌ Never grant `ALL` scope to non-admin users
- ✅ Use specific scopes (ORGANIZATION, DEPARTMENT, OWN)
- ✅ Review permissions quarterly
- ✅ Implement approval workflows for sensitive actions

---

### API Security

#### SSRF Protection

All outbound HTTP requests (webhooks, edge functions, AI provider calls) pass through `safeFetch` + `validatePublicUrl`, which blocks:

- `localhost` / `127.0.0.0/8`
- RFC 1918 ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- Link-local `169.254.0.0/16` (AWS metadata endpoint)
- Docker default bridge `172.17.0.0/16`
- Kubernetes internal `10.96.0.0/12`

Webhook outbound headers are also sanitized — the following are blocked regardless of what is configured: `Authorization`, `Cookie`, `Set-Cookie`, `Host`, `X-Forwarded-For`, `X-Real-IP`, `Proxy-Authorization`.

#### Body Limits

A 10MB body limit is enforced globally on all `/api/*` routes (excluding storage upload and CSV/JSON import, which have their own limits and streaming).

#### Rate Limiting

Zveltio uses a sliding-window rate limiter backed by Valkey sorted sets. When Valkey is unavailable, an in-memory limiter takes over and **fails closed** (limits still enforced — no open bypass on outage).

**Default limits per tier:**

| Tier | Limit | Applies to |
|------|-------|------------|
| `auth` | 10 req/min | `/api/auth/*` sign-in/sign-up |
| `api` | 200 req/min | All authenticated API calls |
| `ai` | 20 req/min | `/api/ai/*` AI endpoints |
| `write` | 60 req/min | POST / PUT / PATCH data mutations |
| `ddl` | 10 req/min | Schema changes (create/drop collection) |
| `destructive` | 10 req/min | Bulk deletes |
| `ext` | 600 req/min | Extension routes (`/ext/*`) |
| `files` | 1200 req/min | Public file serving (`/files/*`) |
| `form` | 20 req/min | Public form submissions |
| `share` | 10 req/min | Share links and their passwords |
| `scim` | 100 req/min | SCIM provisioning (`/scim/v2/*`) |
| `edge-public` | 60 req/min | Anonymous edge function invocations |
| `recovery-bootstrap` | 5 per 15 min | Emergency admin recovery (`/api/permissions/bootstrap`) |

Limits are identified **per user ID** for authenticated requests, **per API key** for key requests, or **per IP** for unauthenticated ones (using the real TCP connection address; `X-Forwarded-For` is only trusted when `TRUSTED_PROXY=true`). The caller is the one verified before the limiters run: a valid session, else an active key that may act in the request's tenant. An invalid or foreign key or session is counted per IP, so rotating fake credentials does not buy a fresh bucket; a string that is not in the shape the engine mints keys in (`zvk_` + 32 hex characters) is refused without a database lookup.

**Per IP by design:** `auth`, `form`, `share` and `scim`. These are the surfaces that stop guessing (passwords, share-link passwords, SCIM tokens), so they stay per IP even for a signed-in caller: keyed per caller, anyone holding many accounts or keys would guess that many times as fast.

**`Retry-After`** on a `429` is the time until the window admits a request again: when the entry whose expiry frees a slot leaves the sliding window (the in-memory fallback: when its fixed window starts over), not a full window from now. A repeat offender's escalated cooldown is the exception, and carries the cooldown's own length.

**DB-driven live config:** Every tier above has a row in `zv_rate_limit_configs` and can be changed at runtime without a restart via `PATCH /api/admin/rate-limits/:keyPrefix`; `POST /api/admin/rate-limits/reset` restores every tier to the default compiled into its limiter. A change applies at once on every instance: once it commits, the instance that made it announces it on the realtime bus (Valkey pub/sub, or `pg_notify` without Valkey) and each instance drops its cached copy. The bus is lossy, so each instance also re-reads its cached limits after 60 seconds at most.

**Per-API-key overrides:** Individual API keys can have their own window/max via `PUT /api/api-keys/:id/rate-limit`, which takes precedence over tier defaults. Useful for trusted integrations that need higher limits.

**Per-tenant limit (multi-tenant installs).** The buckets above are keyed per user, API key or IP, so on their own the members of one tenant together could consume the capacity of an instance they share with other tenants. An optional per-tenant bucket closes that. It is **off by default**: with no configuration nothing changes, and single-tenant installs never need it.

- **Config** — rows in the same `zv_rate_limit_configs` table, set with `PATCH /api/admin/rate-limits/:keyPrefix` (instance admins only; a tenant admin cannot change it, and every change is audited). `tenant:<tier>` is the default for every tenant on that tier (`api`, `write`, `ai`, …; `GET /api/admin/rate-limits` returns the valid names as `tiers`). `tenant:<tier>:<tenantId>` overrides it for one tenant. The first `PATCH` of a tenant key creates the row and needs both `window_ms` and `max_requests`. The Studio lists these rows under Settings → Rate limiting and can add one.
- **Resolution** — the tenant's own active row, then the tier's active `tenant:<tier>` row, then off. Setting `is_active: false` on an override drops that tenant back to the default. Changes apply at once, on every instance, like the tier limits above.
- **Bucket** — `rl:<tier>:t:<tenantId>`, the same sliding window as the other buckets, with the same fail-closed in-memory fallback. Counting and admitting is one atomic Valkey script, so concurrent requests on several instances never together admit more than the limit, nor refuse one while a slot is free. The tenant is the one the request resolved (`x-tenant-slug` or subdomain, else the default tenant). An unknown slug is refused before any limiter runs, so a caller cannot invent a tenant to escape the bucket.
- **Checked in addition to the caller's own bucket.** The caller's own bucket is checked first, and a request it refuses never spends the tenant's budget, so one member hammering the API cannot lock out the rest of the tenant. Refusals are not counted in the tenant bucket, and there is no adaptive escalation on it: a busy tenant is held at its limit, not locked out.
- **Authenticated traffic only.** Anyone can name a tenant with `x-tenant-slug`, and membership is verified only for signed-in users. If anonymous requests counted, a handful of addresses could exhaust any tenant's budget. Anonymous traffic, such as public forms, stays limited per IP by its tier. An API key counts against the tenant it acts in, and only when it is valid there. A root-tenant key may act in any tenant, so a root key sent with `x-tenant-slug: b` counts against tenant B's bucket, not the root tenant's: the request consumes B's capacity, whoever issued the key.
- **Response** — `429` with `Retry-After` and `{"error": "Tenant rate limit exceeded"}`, so an operator can tell it from the per-caller `Too Many Requests`.
- The IP allowlist skips the tenant bucket like every other limit. The god user has no exemption, the same as with the other buckets.

It protects resources; it is not a subscription plan. Zveltio's core has no plans, quotas or usage metering.

#### CORS Configuration

```typescript
// NEVER use wildcard in production
app.use(
  '*',
  cors({
    origin: ['https://studio.yourdomain.com', 'https://app.yourdomain.com'],
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);
```

#### Input Validation

```typescript
import { z } from 'zod';

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(100),
  password: z
    .string()
    .min(8)
    .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
});
```

#### SQL Injection Prevention

Zveltio uses **Kysely** (parameterized queries) exclusively — raw SQL string concatenation is never used in the codebase:

```typescript
// ✅ SAFE - Parameterized
await db.selectFrom('users').where('email', '=', userInput).execute();

// ❌ NEVER DO THIS
await sql.raw(`SELECT * FROM users WHERE email = '${userInput}'`);
```

Table names are also validated — user-created collections are prefixed with `zvd_` and all dynamic table references go through `safeTableName()` which enforces this prefix, preventing table injection attacks.

#### Edge Function Sandbox

User-defined edge functions run in an isolated Bun worker with:

- **Memory limit:** 64MB watchdog (50ms check interval, kills worker if exceeded)
- **SSRF blocked:** `safeFetch` replaces global `fetch`
- **Globals blocked:** `process`, `Bun`, `require`, `globalThis`, `eval`, `Function`, `__proto__`
- **Prototype frozen** at worker startup (prevents prototype pollution)
- **Timeout:** configurable per function

#### Encrypted Secrets at Rest

| Secret | Encryption | Env var |
|---|---|---|
| IMAP/SMTP passwords | AES-256-GCM | `MAIL_ENCRYPTION_KEY` |
| AI provider API keys | AES-256-GCM | `AI_KEY_ENCRYPTION_KEY` |

Generate keys with: `openssl rand -hex 32`

---

### Database Security

#### Connection Security

```bash
# Use SSL for database connections
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=true
```

#### Connection Pooling with PgDog

PgDog is a multi-threaded Rust-based connection pooler with native SCRAM-SHA-256 support. Configuration is auto-generated at startup from environment variables via `pgdog-init`.

```toml
# pgdog.toml (auto-generated by pgdog-init)
[general]
host = "0.0.0.0"
port = 6432
pool_mode = "transaction"
max_client_conn = 1000
default_pool_size = 25
```

#### Access Control

```sql
-- Application user (limited permissions)
CREATE USER zveltio_app WITH PASSWORD 'strong_password';
GRANT CONNECT ON DATABASE zveltio_prod TO zveltio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO zveltio_app;

-- Admin user (full access)
CREATE USER zveltio_admin WITH PASSWORD 'different_strong_password';
GRANT ALL PRIVILEGES ON DATABASE zveltio_prod TO zveltio_admin;
```

#### Row-Level Security (RLS)

```sql
-- Enable RLS on sensitive tables
ALTER TABLE zvd_user_data ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own data
CREATE POLICY user_isolation ON zvd_user_data
  USING (user_id = current_setting('app.current_user_id')::uuid);
```

---

### Network Security

#### Firewall Configuration

```bash
# Allow only necessary ports
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP
ufw allow 443/tcp  # HTTPS
ufw enable
```

#### SSL/TLS

Always use HTTPS in production:

```bash
# Use Let's Encrypt
CERTBOT_AUTO_RENEW=true
```

---

### Security Checklist

#### Before Production

- [ ] Change `BETTER_AUTH_SECRET` to a strong 64-character random string
- [ ] Enable SSL/TLS with valid certificates
- [ ] Configure CORS to whitelist specific domains
- [ ] Enable 2FA for all admin users
- [ ] Set up database user with minimal permissions
- [ ] Configure firewall to allow only necessary ports
- [ ] Set up monitoring and alerting
- [ ] Create backup strategy

#### Ongoing

- [ ] Review logs weekly
- [ ] Rotate secrets quarterly
- [ ] Update dependencies monthly
- [ ] Review user permissions monthly
- [ ] Test backups quarterly

---

### Incident Response

If you suspect a security incident:

1. **Immediately** change all passwords
2. **Check** logs for suspicious activity
3. **Disable** affected user accounts
4. **Contact** security team
5. **Document** the incident

---

### See also

- [security-model.md](security-model.md) — the technical security model
- [multi-tenancy.md](multi-tenancy.md) — how tenant isolation is enforced
- [../engine/authorization.md](../engine/authorization.md) — RBAC and row rules
- [operations.md](operations.md) — deployment hardening
