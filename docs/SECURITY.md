# Zveltio Security Model

Living document. Operators should read this before exposing an engine to
the public internet.

---

## Cookie security & CSRF

Zveltio relies on **SameSite cookies + HMAC-signed session tokens** for
CSRF defence, not a separate CSRF token. This is the modern, standard
SPA pattern (used by GitHub, Vercel, Linear). It works because:

- Better-Auth's `better-auth.session_token` cookie has
  `HttpOnly + SameSite=Lax + Secure (in prod)`. `SameSite=Lax` means
  browsers refuse to attach the cookie to a cross-site POST/PUT/PATCH/
  DELETE — so a malicious `evil.com` form submitting to
  `engine.example.com/api/data/users` arrives without the cookie and is
  rejected at auth.
- The cookie value itself is signed with HMAC-SHA256 over the random
  token using `BETTER_AUTH_SECRET`. Even an attacker who steals the
  cookie name can't forge a session without that server-side secret.
- The studio fetches go through `$lib/api.ts`, which sets
  `credentials: 'include'` and uses same-origin paths.

**CSRF tokens are not required.** A double-submit token would add no
real defence on top of `SameSite=Lax` for state-changing requests, and
the engine would still have to issue + verify them — extra surface for
the same guarantee.

### Cross-origin deployments (`CROSS_DOMAIN_AUTH=true`)

If Studio runs on a different origin than the engine (multi-domain
SaaS), the `SameSite=Lax` cookie is dropped on every cross-origin
request and auth breaks. Set `CROSS_DOMAIN_AUTH=true` to switch to
`SameSite=None; Secure`. Caveats:

- **`Secure` is required** by browsers whenever `SameSite=None` is set.
  HTTPS-only — `http://` deployments won't work.
- **CORS** must be configured: set `CORS_ORIGINS=https://studio.example.com,…`.
- Modern browsers refuse third-party cookies entirely in many contexts
  (Safari ITP, Firefox ETP, Chrome's cookie phase-out). Cross-domain
  SSO over cookies is fragile — prefer a single-origin proxy when you
  can.

---

## Content Security Policy

`/admin/*` ships with a strict CSP including:

- `script-src 'self' 'nonce-{per-request}' 'strict-dynamic' 'unsafe-inline'`
- `style-src 'self' 'unsafe-inline'`
- `frame-ancestors 'none'` (clickjacking)
- `object-src 'none'`
- `form-action 'self'`
- `base-uri 'self'`

Modern browsers ignore `'unsafe-inline'` once a nonce is present
(CSP3). We keep it as a fallback so Studio loads on browsers that
don't understand nonces yet (very rare in 2026; we'll remove once
telemetry shows zero hits on the legacy code path).

### Nonce + HTML caching

The HTML response (`/admin/index.html` and the SPA fallback) is served
with `Cache-Control: no-store` precisely because the CSP nonce is
regenerated per request. Browsers must not cache the document, but the
hashed JS/CSS bundles under `/_app/immutable/` keep the long-cache
header — they don't contain the nonce.

---

## Authentication paths

| Path | Method | Auth | Notes |
|---|---|---|---|
| `/api/auth/*` | Better-Auth | password / OAuth / passkey / magic-link | Built-in |
| `/ext/auth/saml/*` | SAML 2.0 | IdP-asserted | `ctx.internals.createBetterAuthSession` bridges to Better-Auth |
| `/ext/auth/ldap/*` | Bind via ldapts | Username + password | Same SSO bridge as SAML |
| `/api/api-keys/*` | session key for management | `X-API-Key` / `Authorization: Bearer zvk_…` for usage | HMAC-SHA256 of key stored, never plaintext |

### Rate-limiting

| Path | Limit |
|---|---|
| `/api/auth/sign-in/*` | 10/min/IP |
| `/api/auth/sign-up/*` | 10/min/IP |
| `/api/auth/forgot-password` | 10/min/IP |
| `/ext/auth/ldap/login` | 10/min/IP |
| `/ext/auth/ldap/test` | 10/min/IP |
| `/ext/auth/saml/callback` | 10/min/IP |
| `/api/ai/*` | per-tier (see `aiRateLimit`) |
| `/api/data/*` writes | 60/min/user |
| `/api/data/*` deletes (collection-level) | 10/min/user |
| `/api/*` (default) | 200/min/user |

`TRUSTED_PROXY=true` is required when running behind nginx/Caddy/Cloudflare
to honour `X-Forwarded-For`. Without it, every client behind the proxy
shares the same rate-limit bucket. The middleware warns once at boot if
it detects forwarded headers without `TRUSTED_PROXY` set.

---

## Secrets at rest

`FIELD_ENCRYPTION_KEY` (32 bytes / 64 hex chars) is the master key for
field-level encryption:

- Collection fields with `encrypted: true` are AES-256-GCM encrypted
  before insert and decrypted on read.
- LDAP `bindPassword` and SAML `privateKey` in `zv_settings` are
  encrypted via `ctx.internals.encryptSecret` / `decryptSecret`.
- Mail provider passwords + AI API keys are encrypted (existing —
  `MAIL_ENCRYPTION_KEY`, `AI_KEY_ENCRYPTION_KEY` envs).

If `FIELD_ENCRYPTION_KEY` is unset, the engine logs a loud warning at
boot listing every collection that has an `encrypted: true` field but
will be persisted in plaintext — see `lib/field-crypto.ts::checkFieldEncryptionAtBoot`.

Generate with: `openssl rand -hex 32`.

---

## Edge functions / scripts sandbox

User-supplied JavaScript (edge-functions, flow `run_script` steps) runs
in a Bun Worker with **`lockdownGlobals()`** applied before user code
executes:

- `Bun`, `process`, `Worker`, `Function`, `eval`, `require`, `module`,
  `exports`, `__dirname`, `__filename`, `importScripts` are replaced
  with non-configurable getter-throwers on `globalThis`.
- The `.constructor` slot on every kind of function prototype
  (Function, AsyncFunction, GeneratorFunction, AsyncGeneratorFunction)
  is replaced with a throwing stub, closing the classic
  `(()=>{}).constructor("return Bun")()` escape vector.
- `fetch` is replaced with `safeFetch` which blocks loopback /
  metadata-service / RFC1918 destinations (SSRF defence) and refuses
  non-http(s) schemes.
- Soft limits: 64 MB heap watchdog, default 5s wall-clock.

Worker isolation is process-thread level. For UNTRUSTED multi-tenant
arbitrary code, opt into the **subprocess-per-invocation** runner by
setting `EDGE_SANDBOX_MODE=subprocess`. The engine then spawns a fresh
Bun process per invocation (`Bun.spawn`) with:

- a minimal env (only `PATH` + `TMPDIR` — no `DATABASE_URL`,
  `BETTER_AUTH_SECRET`, or `FIELD_ENCRYPTION_KEY` leaks into the child);
- piped stdin/stdout/stderr (the child can't read the parent's stdin
  and can only return a single JSON line on stdout);
- a hard `SIGKILL` wall-clock timer at `timeoutMs + 3s` (Worker.terminate
  is best-effort; SIGKILL is enforced by the kernel);
- the same `lockdownGlobals()` JS-level lockdown inside the child, so
  even a successful escape from the sandbox only escapes into a
  separate process address space.

Trade-off: ~30 ms per-spawn vs. ~1 ms for Worker. Use Worker (the
default) for admin-authored edge functions, subprocess for marketplace
/ end-user-authored code.

---

## Multi-tenant isolation

Tenant isolation rests on three layers, all required:

1. **`tenant_id UUID` column** on each table, FK to `zv_tenants(id)`.
   Added automatically by `enableRLS(tableName)`.
2. **`ENABLE + FORCE ROW LEVEL SECURITY`** — FORCE matters. Without
   it, the engine connects as the table owner and Postgres lets the
   owner bypass policies; RLS becomes advisory. `enableRLS` issues
   both `ENABLE` and `FORCE`.
3. **`tenant_isolation` policy** comparing `tenant_id` against the
   PostgreSQL session variable `zveltio.current_tenant`, set by
   `tenantMiddleware` at request start via `SET LOCAL` inside a
   transaction.

### Routes touching tenant data MUST use `tenantTrx`

`SET LOCAL` persists only for the connection that owns the transaction.
Routes that read or write tenant-scoped data must use the per-request
transaction handle, not the pool:

```ts
// ❌ wrong — pool may hand to a different connection without the GUC
const rows = await db.selectFrom('zvd_orders').selectAll().execute();

// ✅ right — same connection, GUC active, RLS sees the tenant
const trx = c.get('tenantTrx') ?? db;
const rows = await trx.selectFrom('zvd_orders').selectAll().execute();
```

`routes/data.ts` already does this via `effectiveDb`. Any extension
that exposes a `zvd_*` route must follow the same pattern.

### Backfilling tenant_id

`enableRLS()` is typically run after a table already has data. Existing
rows get `tenant_id = NULL`, and the policy treats NULL as "not equal"
— so they become invisible to every tenant. `enableRLS` now logs a
warning with the orphan count + UPDATE statement. Operators must
backfill BEFORE the table is considered multi-tenant-safe.

---

## Retention

| Table | Default retention | Env var |
|---|---|---|
| `zv_request_logs` | 30 days | `REQUEST_LOG_RETENTION_DAYS` |
| `zv_slow_queries` | 30 days | `REQUEST_LOG_RETENTION_DAYS` (shared) |
| `zv_audit_log` | 365 days | `AUDIT_LOG_RETENTION_DAYS` |
| Soft-deleted rows (`_deletedAt`) | 30 days | hard-coded |

Set to `0` to disable purge for a given table. Purges run nightly at
03:00 from the garbage collector (`lib/garbage-collector.ts`).

---

## Demo mode

`DEMO_MODE=true` advertises throwaway credentials on `/api/health` so
the login page can prefill them. As of this release, **the engine refuses
to surface those credentials when `NODE_ENV=production`** unless
`DEMO_MODE_ALLOW_IN_PROD=true` is also set explicitly — defence in depth
for the operator-left-a-flag-on case. The `demo_mode: true` banner still
shows, so the misconfig stays visible.

---

## Reporting vulnerabilities

Email `security@zveltio.com` (or the org's configured contact). Please
include reproduction steps; we'll respond within 72h.
