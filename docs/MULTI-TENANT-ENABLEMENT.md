# Multi-Tenant Enablement — Design

Status: **DECIDED** (Phase B complete). Target: beta.17–19. Author: design pass after beta.16.

## 0. Context & decisions already taken

- Multi-tenant **stays** — it is a first-class platform capability (future managed/SaaS
  hosting). Nothing is cut. `provisionTenantSchema` stays (it also backs Environments).
- **Greenfield**: there are **no installations in the wild to keep compatible**. So we
  build the clean model directly — no compat shims, no default-domain migration of
  legacy policy data, no dual code paths kept "for old installs".
- beta.16 already mounted `tenantMiddleware` on `/ext/*`, so extension + SDUI traffic
  gets tenant context. This design completes the story.

### What's already solid (do not redo)
- Data-layer row isolation: `tenantMiddleware` → `withTenantIsolation` → `SET LOCAL
  "zveltio.current_tenant"` → Postgres RLS (`tenant_id = current_setting(...)`, FORCE RLS).
- `getDb(c,db)` / `reqDb(c,db)` return the per-request `tenantTrx`.
- Tenant-scoped query cache, WS/SSE, environments (schema-per-env via `search_path`).

### The gaps this design closes
1. **Casbin is global** — `r = sub, obj, act`, `g = _, _`; a role applies in every tenant.
2. **Membership unenforced** — `resolveTenantFromRequest` trusts `X-Tenant-Slug`/subdomain
   without checking `zv_tenant_users`.
3. **RLS is opt-in per collection** — not a guaranteed property of tenant-scoped tables.
4. **Extensions query the global pool** — `ctx.db` is captured at load; not the request trx.

---

## 1. Spine: the "always one tenant" model

Single-tenant is **the degenerate case of multi-tenant**, not a separate path.

- Every install creates a **default tenant** at setup (a row in `zv_tenants`, e.g.
  slug `default`). The god/first-admin user is a member of it.
- `tenantMiddleware` **always** resolves a tenant: explicit `X-Tenant-Slug`/subdomain →
  that tenant; otherwise → the **default tenant**. There is no `tenant = null` branch in
  steady state.
- Therefore `zveltio.current_tenant` is **always set**, RLS is **uniform and always
  correct**, and there is no "FORCE RLS returns zero rows because the GUC is unset" trap.
- "Single-tenant" = exactly one row in `zv_tenants`. "Multi-tenant" = more than one. Same
  code, no mode flag.

**Consequence / cost to manage:** every request now runs inside the tenant transaction
(holds a pooled connection). Mitigations in §6.

### Granularity stack (target)
domain/host → **tenant** → **environment** → **role (Casbin domain)** → **row (RLS)** →
**column (column-perms)** → **field/API-key scope**. All keyed off the always-present tenant.

---

## 2. Authorization — Casbin with domains

Move from global RBAC to **RBAC-with-domains**, `dom = tenant_id`.

### Model
```
[request_definition]
r = sub, dom, obj, act
[policy_definition]
p = sub, dom, obj, act
[role_definition]
g = _, _, _            # (user, role, domain)
[policy_effect]
e = some(where (p.eft == allow))
[matchers]
m = g(r.sub, p.sub, r.dom) && (p.dom == r.dom || p.dom == '*') \
    && (r.obj == p.obj || p.obj == '*') && (r.act == p.act || p.act == '*')
```
- `p.dom == '*'` allows **platform-wide** policies (e.g. system defaults) without
  duplicating per tenant. Per-tenant grants use the concrete `tenant_id`.

### API changes
- `checkPermission(userId, tenantId, resource, action)` — tenant becomes a required arg.
  A thin overload `checkPermission(c, resource, action)` reads `c.get('tenant').id` so call
  sites stay terse.
- `getUserRoles(userId, tenantId)` → `getRolesForUser(userId, tenantId)`.
- Role-assignment APIs (`addRoleForUser`, policy CRUD) take a tenant/domain.
- `zvd_permissions`: domain lives in a column (reuse `v0` as `dom` per Casbin domain
  convention, or add an explicit `dom` column — **open decision §8**).

### Caches
- Key god/perm/roles caches by `(userId, tenantId)`; invalidation per `(tenant)` on policy
  CRUD (a per-tenant **policy epoch** counter, `INCR`, beats `SCAN`).
- God-user bypass stays independent of Casbin (already is) → no lock-out risk.

### Call-site sweep
Every `checkPermission(userId, …)` in engine + the 54 extensions must pass tenant. Most
extension handlers have `c` → use the `c`-overload. A validator/lint rule flags the old
3-arg form.

---

## 3. Membership enforcement

After tenant resolution **and** session resolution, enforce that the caller belongs to
the resolved tenant.

- Add a guard that runs once the user is known: if `tenant` is non-default (or always, for
  uniformity) and the user is authenticated, require a `zv_tenant_users` row for
  `(user, tenant)`; else **403**.
- **God / super-admin bypass** (documented) for cross-tenant operators.
- **Placement:** session is resolved per-route today (not a global middleware). Options:
  (a) a lightweight session-resolving middleware that runs after `tenantMiddleware` and
  sets `c.get('user')` once for all routes, then checks membership; or (b) fold the check
  into the existing `requireAuth`/`requireAdmin` guards. **Open decision §8** — (a) is
  cleaner and also lets other middleware use the user.
- The default tenant + single-member install: the god user is a member → no friction.

---

## 4. RLS default-on

> **Prerequisite discovered during implementation (beta.18).** Dynamic collection
> tables (`zvd_<collection>`) are created by `DDLManager` with system columns
> `id, created_at, updated_at, status, created_by, updated_by` — **no `tenant_id`**.
> RLS keys on `tenant_id`, so it cannot isolate user collections until the column
> exists. The real foundation is therefore: **add `tenant_id` as a system column**
> on every collection table, defaulted from the tenant GUC, then FORCE RLS.
>
> Design:
> - Fixed `DEFAULT_TENANT_ID` (sentinel UUID); single-tenant always resolves to it.
> - System column: `tenant_id UUID NOT NULL DEFAULT
>   COALESCE(current_setting('zveltio.current_tenant', true)::uuid, '<default>')`
>   — inserts auto-tag the active tenant; no `dynamicInsert` change, no GUC-unset
>   NOT-NULL violation (falls back to the default tenant).
> - `DDLManager.createTable` adds it to `systemCols` for NEW collections; a boot
>   reconciler `ALTER`s EXISTING `zvd_*` tables (add column + backfill NULL →
>   default tenant) then FORCE RLS + the `tenant_isolation` policy.
> - **Exclude** the tenant-management tables (`zv_tenants`, `zv_tenant_users`,
>   `zv_tenant_usage`, `zv_environments`) — RLS on `zv_tenant_users` would break
>   the membership lookup. Scope the reconciler to the `zvd_*` namespace.

Make tenant isolation a property of the schema, not an admin afterthought.

- A **boot reconciler** ensures `ENABLE + FORCE ROW LEVEL SECURITY` + the `tenant_isolation`
  policy on **every table that has a `tenant_id` column** (core `zvd_*` data tables +
  extension tables that declare `tenant_id`).
- Safe under §1 because the GUC is always set (default tenant). No zero-rows trap.
- Extensions declare tenant-scoping in their manifest/migrations (most already add
  `tenant_id` + RLS per SECURITY.md); the reconciler closes any that forgot.
- Orphan `tenant_id IS NULL` rows: backfill to the default tenant at migration time.

---

## 5. Extension tenant-scoping

- Add `ctx.reqDb(c)` to the SDK `ExtensionContext`: returns `reqDb(c, db)` (the request
  `tenantTrx`) wrapped in the table-restriction proxy. Extensions use it for **all**
  data queries; `ctx.db` remains only for setup/migration (no request context).
- Validator (`@zveltio/sdk/validate`) **warns** on `ctx.db` used in a request handler.
- Migrate the 54 first-party extensions to `ctx.reqDb(c)` incrementally; the boot
  reconciler (§4) makes their tables RLS-safe in the meantime.

---

## 6. Transaction scoping & pool

Always-on tenant transaction is the cost of §1. Contain it:
- Open `withTenantIsolation` **only on routes that touch tenant data** — not health,
  metrics, auth, static `/admin`, or pure-metadata reads. A route can opt in/out via a
  marker, or we wrap `/api/data/*`, `/ext/*` and known data routes, and skip the rest.
- Raise documented `DB_POOL_MAX` guidance for multi-tenant; monitor reserved connections.
- Keep read-only/non-data `/api/*` (e.g. `/api/extensions` list) outside the transaction.

---

## 7. Setup / bootstrap

- First-run / migration creates the **default tenant** and makes the god user a member.
- `resolveTenantFromRequest` falls back to the default tenant when no host/header match.
- Studio "Tenant Isolation" view (later): per-tenant environments, which tables have RLS
  enforced, roles, column-perms — makes granularity legible to operators.

---

## 8. Decisions (locked)

1. **Domain storage in `zvd_permissions`** — **explicit `dom` column** (clearer than
   overloading `v0`; needs a small schema migration).
2. **Membership check placement** — **new thin session-resolving middleware** after
   `tenantMiddleware`: resolves the session once, sets `c.get('user')` for all routes,
   then enforces `zv_tenant_users` membership (god/super-admin bypass).
3. **Transaction scope** — wrap **`/api/data/*` + `/ext/*`** (and other known data
   routes) only; health, metrics, auth, static `/admin`, and pure-metadata reads stay
   outside the tenant transaction.
4. **Platform-wide policies** — **yes**, `p.dom == '*'` for system defaults.
5. **Spine** — **uniform "always a tenant"** (default tenant at setup), not a gated
   multi-tenant mode flag.

---

## 9. Rollout (greenfield — no compat shims)

- **beta.17 — enforcement:** default tenant at setup; membership gate; RLS default-on
  reconciler; transaction scoping. Cross-tenant isolation **CI gate** (two tenants, same
  user with different roles, assert A can't read B via `/api/data` *and* `/ext/*`).
- **beta.18 — granular RBAC:** Casbin domains; `checkPermission(c|userId, tenant, …)`
  sweep across engine + 54 extensions; per-tenant policy epoch caches.
- **beta.19 — extensions:** `ctx.reqDb(c)` + validator warning + migrate the 54.
- Studio "Tenant Isolation" dashboard: when convenient.

## 10. Testing

- CI: provision 2 tenants; same user assigned different roles per tenant; assert isolation
  on data **and** ext routes, and that role grants don't bleed across tenants.
- Single-tenant smoke: default tenant, RLS on, all 54 extensions enable + serve 200.
- Membership: user not in tenant → 403 on both `/api/*` and `/ext/*`.
