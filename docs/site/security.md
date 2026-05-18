# 🔒 Zveltio Security Guide

Security best practices and hardening guide for Zveltio.

---

## Table of Contents

- [Security Overview](#security-overview)
- [Authentication Security](#authentication-security)
- [Authorization & RBAC](#authorization--rbac)
- [API Security](#api-security)
- [Database Security](#database-security)
- [Network Security](#network-security)
- [Security Checklist](#security-checklist)

---

## Security Overview

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

## Authentication Security

### Password Security

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

### Session Security

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

### Environment Variables

```bash
# Authentication - CRITICAL
BETTER_AUTH_SECRET=CHANGE_ME_64_RANDOM_CHARACTERS
BETTER_AUTH_URL=https://api.yourdomain.com
```

### API Key Security

API keys are hashed with **HMAC-SHA256** (not plain SHA-256) using `BETTER_AUTH_SECRET` as a keyed salt. This prevents rainbow-table attacks against the predictable `zvk_` prefix format even if the database is compromised.

- Raw key shown **only once** at creation — never stored
- Keys start with `zvk_` prefix for easy identification
- Scoped per collection and action (`read`, `create`, `update`, `delete`)
- Optional expiry date and per-key rate limit
- Revocable immediately via `DELETE /api/api-keys/:id`

---

## Authorization & RBAC

### Casbin Policies

**Default Secure Policies:**

```csv
# p, subject, resource, action, scope
p, admin, *, *, ALL
p, manager, data, read, ORGANIZATION
p, manager, data, write, DEPARTMENT
p, employee, data, read, OWN
```

### Emergency Admin Access

Zveltio has a special **Emergency Admin Access** mechanism for emergency access:

```typescript
// In permissions.ts - checked BEFORE Casbin
const isGod = result.rows[0]?.role === 'god';
if (isGod) return true; // Emergency Admin bypass — all permission checks skipped!
```

> **Note:** This mechanism is equivalent to Supabase's `service_role` key and Directus's admin token. It provides a fail-safe guarantee that administrators cannot be permanently locked out through misconfiguration.

**⚠️ Security Warning:**

- Only create ONE Emergency Admin (Super-Admin) user for emergency access
- Use the Emergency Admin account only when absolutely necessary
- Monitor Emergency Admin activity closely

### Hardening

- ❌ Never grant `ALL` scope to non-admin users
- ✅ Use specific scopes (ORGANIZATION, DEPARTMENT, OWN)
- ✅ Review permissions quarterly
- ✅ Implement approval workflows for sensitive actions

---

## API Security

### SSRF Protection

All outbound HTTP requests (webhooks, edge functions, AI provider calls) pass through `safeFetch` + `validatePublicUrl`, which blocks:

- `localhost` / `127.0.0.0/8`
- RFC 1918 ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- Link-local `169.254.0.0/16` (AWS metadata endpoint)
- Docker default bridge `172.17.0.0/16`
- Kubernetes internal `10.96.0.0/12`

Webhook outbound headers are also sanitized — the following are blocked regardless of what is configured: `Authorization`, `Cookie`, `Set-Cookie`, `Host`, `X-Forwarded-For`, `X-Real-IP`, `Proxy-Authorization`.

### Body Limits

A 10MB body limit is enforced globally on all `/api/*` routes (excluding storage upload and CSV/JSON import, which have their own limits and streaming).

### Rate Limiting

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

Limits are identified **per user ID** for authenticated requests, or **per IP** for unauthenticated ones (using the real TCP connection address; `X-Forwarded-For` is only trusted when `TRUSTED_PROXY=true`).

**DB-driven live config:** All tier limits are stored in `zv_rate_limit_configs` and can be changed at runtime without a restart via `PATCH /api/admin/rate-limits/:keyPrefix`. Changes take effect within 60 seconds (config cache TTL).

**Per-API-key overrides:** Individual API keys can have their own window/max via `PUT /api/api-keys/:id/rate-limit`, which takes precedence over tier defaults. Useful for trusted integrations that need higher limits.

### CORS Configuration

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

### Input Validation

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

### SQL Injection Prevention

Zveltio uses **Kysely** (parameterized queries) exclusively — raw SQL string concatenation is never used in the codebase:

```typescript
// ✅ SAFE - Parameterized
await db.selectFrom('users').where('email', '=', userInput).execute();

// ❌ NEVER DO THIS
await sql.raw(`SELECT * FROM users WHERE email = '${userInput}'`);
```

Table names are also validated — user-created collections are prefixed with `zvd_` and all dynamic table references go through `safeTableName()` which enforces this prefix, preventing table injection attacks.

### Edge Function Sandbox

User-defined edge functions run in an isolated Bun worker with:

- **Memory limit:** 64MB watchdog (50ms check interval, kills worker if exceeded)
- **SSRF blocked:** `safeFetch` replaces global `fetch`
- **Globals blocked:** `process`, `Bun`, `require`, `globalThis`, `eval`, `Function`, `__proto__`
- **Prototype frozen** at worker startup (prevents prototype pollution)
- **Timeout:** configurable per function

### Encrypted Secrets at Rest

| Secret | Encryption | Env var |
|---|---|---|
| IMAP/SMTP passwords | AES-256-GCM | `MAIL_ENCRYPTION_KEY` |
| AI provider API keys | AES-256-GCM | `AI_KEY_ENCRYPTION_KEY` |

Generate keys with: `openssl rand -hex 32`

---

## Database Security

### Connection Security

```bash
# Use SSL for database connections
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=true
```

### Connection Pooling with PgDog

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

### Access Control

```sql
-- Application user (limited permissions)
CREATE USER zveltio_app WITH PASSWORD 'strong_password';
GRANT CONNECT ON DATABASE zveltio_prod TO zveltio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO zveltio_app;

-- Admin user (full access)
CREATE USER zveltio_admin WITH PASSWORD 'different_strong_password';
GRANT ALL PRIVILEGES ON DATABASE zveltio_prod TO zveltio_admin;
```

### Row-Level Security (RLS)

```sql
-- Enable RLS on sensitive tables
ALTER TABLE zvd_user_data ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own data
CREATE POLICY user_isolation ON zvd_user_data
  USING (user_id = current_setting('app.current_user_id')::uuid);
```

---

## Network Security

### Firewall Configuration

```bash
# Allow only necessary ports
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP
ufw allow 443/tcp  # HTTPS
ufw enable
```

### SSL/TLS

Always use HTTPS in production:

```bash
# Use Let's Encrypt
CERTBOT_AUTO_RENEW=true
```

---

## Security Checklist

### Before Production

- [ ] Change `BETTER_AUTH_SECRET` to a strong 64-character random string
- [ ] Enable SSL/TLS with valid certificates
- [ ] Configure CORS to whitelist specific domains
- [ ] Enable 2FA for all admin users
- [ ] Set up database user with minimal permissions
- [ ] Configure firewall to allow only necessary ports
- [ ] Set up monitoring and alerting
- [ ] Create backup strategy

### Ongoing

- [ ] Review logs weekly
- [ ] Rotate secrets quarterly
- [ ] Update dependencies monthly
- [ ] Review user permissions monthly
- [ ] Test backups quarterly

---

## Incident Response

If you suspect a security incident:

1. **Immediately** change all passwords
2. **Check** logs for suspicious activity
3. **Disable** affected user accounts
4. **Contact** security team
5. **Document** the incident

---

## Learn More

- [Authorization Guide](/authorization)
- [Installation Guide](/installation)
- [Deployment Guide](/deployment)
