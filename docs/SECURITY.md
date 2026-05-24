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

### Tenant scoping of non-DB surfaces

DB queries are not the only place where tenant scoping has to be
enforced. The following surfaces also carry tenant context and would
leak across tenants if treated naively:

| Surface | Mechanism |
|---|---|
| Query result cache (`qc:*` keys) | Cache key namespace is `qc:{tenantId}:{collection}:{hash}`; invalidation is per-tenant. Set by `buildQueryCacheKey` / `invalidateQueryCache`. |
| SSE realtime (`broadcastDataEvent`) | Each `StreamSub` records the tenant id at subscribe time; broadcasts drop messages whose tenant id doesn't match. |
| WebSocket realtime (`broadcastEvent`) | `WSConnection.tenantId` captured at upgrade; `broadcastEvent(collection, event, data, tenantId)` filters strictly on it. |
| Cross-instance bus (`realtimeBus.publish`) | `RealtimeBusMessage.tenantId` carried in the envelope; the receiving engine forwards it to its own `broadcastEvent`. |
| AI embeddings (`zvd_ai_embeddings`) | Column `tenant_id` with `DEFAULT NULLIF(current_setting('zveltio.current_tenant'), '')::uuid` + FORCE RLS, plus the auto-embedding event payload carries `tenantId` (the event fires on the GLOBAL pool, so the GUC is unset and the DEFAULT can't help). See migration 009 in the AI extension. |
| Edge functions subprocess | Bootstrap file lives in a fresh `mkdtemp` dir (mode 0700) to defeat TOCTOU symlink attacks; subprocess runs with the parent's `process.execPath` (not `bun` via PATH) and a minimal env. |

### Backfilling tenant_id

`enableRLS()` is typically run after a table already has data. Existing
rows get `tenant_id = NULL`, and the policy treats NULL as "not equal"
— so they become invisible to every tenant. `enableRLS` now logs a
warning with the orphan count + UPDATE statement. Operators must
backfill BEFORE the table is considered multi-tenant-safe.

### Per-extension tenant isolation status

Tenant isolation is rolling out per extension (see [AUDIT-2026-05-24.md
§6.1](AUDIT-2026-05-24.md#61-systemic-multi-tenant-gap-in-extensions-other-than-ai)
for the full backlog). An extension is "tenant-safe" when ALL of the
following are true:

  1. Every table has a `tenant_id UUID` column with
     `DEFAULT NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid`.
  2. ENABLE + FORCE ROW LEVEL SECURITY on each table.
  3. A `tenant_isolation_<table>` policy that compares `tenant_id` to
     the GUC (with the NULL-or-match arm for single-tenant fallback).
  4. Every route in the extension's `engine/routes.ts` resolves DB
     access via `reqDb(c)` (returns `c.get('tenantTrx') ?? db`) — not
     the bare `db` parameter.

| Extension | Status | Migration |
|---|---|---|
| `ai` | ✅ tenant-safe | `001_initial.sql` (folded `009_embeddings_tenant_isolation.sql`) |
| `crm` | ✅ tenant-safe | `002_tenant_rls.sql` |
| `finance/invoicing` | ✅ tenant-safe | `002_tenant_rls.sql` |
| `hr/payroll` | ✅ tenant-safe | `002_tenant_rls.sql` |
| `compliance/ro/efactura` | ✅ tenant-safe | `002_tenant_rls.sql` |
| All other extensions | ⏳ pending — see §6.1 backlog | — |

Operators running in multi-tenant mode must NOT enable an extension
marked "pending" against shared production data. Single-tenant
deployments (no `tenantMiddleware`, no `X-Tenant-Slug` header) are
unaffected — the policy's NULL-or-match arm passes when the GUC is
empty.

---

## RBAC (per-extension authorization)

Three layers, applied in order, each one strictly stronger than the
last. Operators turn the knob that matches their threat model.

### 1. Authentication guard

Every extension's `app.use('*', async (c, next) => …)` first calls
`auth.api.getSession({ headers })`. No session → 401, no further
checks run. This is the minimum bar; bare auth without any role check
is what the platform shipped with through alpha.66 and is what every
extension had at the start of pass 6.

### 2. `permissionGate(ctx, '<resource>')`

The SDK's `permissionGate` middleware (declared in
[`packages/sdk/src/extension/permission-gate.ts`](../packages/sdk/src/extension/permission-gate.ts))
is layered AFTER the auth guard and gates the entire extension on a
single Casbin resource string. HTTP method → action mapping is
standard CRUD (`GET → read`, `POST → create`, `PATCH/PUT → update`,
`DELETE → delete`). OPTIONS preflight bypasses (browsers send no
credentials on preflight).

Currently applied to (added in pass 6 + PR #3):

  - `crm`, `hr/{employees,leave,payroll,time-tracking}`,
    `finance/{accounting,banking,expenses,invoicing,quotes,subscriptions}`,
    `operations/{assets,inventory,pos}`, `projects/{helpdesk,management}`,
    `content/media`, `integrations/api-connector`,
    `workflow/checklists`, `data/{import,export}`,
    `compliance/ro/{documents,efactura,etransport,procurement,saft}`,
    `ecommerce/store` (admin namespace only — public storefront stays open).

NOT applied to (intentional — finer-grained protection in place):

| Extension | Why no broad gate |
|---|---|
| `ai` | Each `/embed` and `/search` route does `checkPermission(user.id, body.collection, 'read'/'update')` — finer than a single resource gate. AI touches arbitrary user collections, so per-collection authorization is the correct shape. |
| `developer/graphql` | Per-resolver RBAC (~21 inline checkPermission calls). Mirrors AI's per-collection pattern at the resolver level. |
| `geospatial/postgis` | Per-collection `checkPermission(userId, 'data:${shortName}', 'read')` for each PostGIS-backed collection. |
| `content/{drafts,documents}`, `workflow/approvals`, `developer/{api-docs,validation}`, `analytics/quality` | Rich per-route checkPermission already in place (8-13 calls per file). |
| `auth/{ldap,saml}` | Routes are IdP callbacks; the caller is not an end user with a session. |
| `developer/edge-functions` | Engine-level admin gate on `/api/edge-functions` already covers it. |
| `compliance/gdpr`, `billing`, `developer/{byod,database}`, `content/document-templates`, `forms`, `search` | Admin-only via inline `checkPermission(user.id, 'admin', '*')` or a `requireAdmin` helper. Adding `permissionGate` on top would only allow operators to grant access to non-admin roles via Casbin — useful but not security-critical; deferred. |
| `communications/mail` | Mailbox routes are identity-scoped (operate on the calling user's own mailbox). Broad resource gate would change semantics. |
| `content/page-builder`, `i18n/translations`, `sms`, `storage/cloud` | Per-handler or prefix-scoped guards that would require surgical insertion, not a single `app.use`. Deferred to a structural follow-up. |

### 3. Casbin `g` row (user → role mapping)

`permissionGate` and inline `checkPermission` both delegate to
Casbin's enforcer with the matcher:

```
g(r.sub, p.sub) && (r.obj == p.obj || p.obj == '*') && (r.act == p.act || p.act == '*')
```

For a user to match a `p` policy row (e.g. `('p', 'employee', 'crm', 'read')`),
they must FIRST be mapped to that role via a `g` row:

```sql
INSERT INTO zvd_permissions (ptype, v0, v1, v2)
VALUES ('g', '<user-id>', 'employee', NULL);
```

Migration `077_extension_rbac_defaults.sql` (now folded into the
engine's `001_initial.sql`) seeds `p` rows for the built-in
`employee` and `manager` roles but does NOT map any users to those
roles. **The seed rows have NO effect until operators issue at least
one `g` row.** The Studio Roles UI exposes this mapping. The god role
bypasses all checks (no `g` row needed).

This is the most common operator-side misconfiguration: gate is
strict, policies are seeded, but every non-god user gets 403 because
no `g` rows exist. Surface this in the operator-onboarding flow.

### Mode knob: `EXTENSION_RBAC=strict|permissive`

`strict` (default) — gate denies if no policy matches.
`permissive` — gate becomes audit-mode: it logs every `WOULD DENY`
attempt but lets the request through. Use ONLY during a backfill
pass; flip back to `strict` for production.

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
