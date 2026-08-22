# Zveltio — Implementation Checklist

> **Created:** 2026-08-22 · **Status:** living document  
> **Purpose:** Single checklist for bugs, hardening, SDUI production, Model 2.5 rollout, and dev footguns.  
> Mark items `[x]` when done; add commit SHA inline.

**Legend:** P0 = ship blocker · P1 = fix soon · P2 = next sprint · P3 = backlog/strategic

---

## A. Realtime & WebSocket (verified bugs)

### A1. pg_notify bus (P1)

- [x] **Payload guard:** omit `data` when encoded JSON exceeds ~7900 bytes
- [x] **Parametrized notify:** Kysely `$1` binding via `notify(channel, payload)`
- [x] **LISTEN reconnect:** `scheduleListenReconnect` on subscription loss / publish failure
- [x] **Health probe:** `bus.isHealthy()` — no hardcoded `ok = true` for pg-notify
- [x] **Unit tests** for payload truncation and parameterized publish

### A2. Valkey realtime bus (P2)

- [x] Add `.on('error')` on subscriber + publisher ioredis connections
- [x] Reuse retryStrategy aligned with `cache.ts`
- [x] Confirm write path `.catch()` — DB write unaffected (unchanged)

### A3. Valkey cache client (P2)

- [x] Add `.on('error')` on `initCache()` Redis instance

### A4. WebSocket permissions (P2)

- [x] WS subscribe cache TTL 60s (`WS_PERM_CACHE_TTL_MS`)
- [ ] Wire `invalidateUserPermCache()` to clear active WS permission caches (deferred — TTL sufficient for now)

### A6. Dead cross-tenant helpers (P2)

- [x] Removed `broadcastToAll()` / `broadcastToUser()` (zero callers)

---

## B. Engine core & ops

### B1. Single binary story (P1)

- [x] Implement `packages/engine/scripts/build-binary.ts` (`build:binary` in package.json)
- [x] Wire `gen-worker-source.ts` + `generate-studio-embed.ts` into compile pipeline
- [ ] CI gate: embedded studio-dist freshness

### B2. Dev / deploy footguns (P2)

- [x] Document `EXTENSIONS_DIR` in dev guide — default `packages/engine/extensions/` can be stale
- [x] Document stale `packages/engine/extensions/` as gitignored install cache (not source)
- [x] Document CORS: Studio dev on `:5173` needs entry in `CORS_ORIGINS`
- [x] Document `VITE_ENGINE_URL` for split Studio dev
- [x] Document `studio:embed` copies to both `packages/engine/studio-dist` and `src/studio-dist` (done in root `package.json`)

### B3. Tenant & RLS (P3 — strategic)

- [ ] Run engine DB role as non-superuser in production (boot warns today)
- [ ] **Fail-closed GUC:** consider `zveltio_tenant_scope_ok` → false when GUC unset (breaking; needs `zveltio_system` role for migrations)
- [ ] **Per-tenant app RLS:** add `tenant_id` to `zvd_rls_policies` + scope cache keys when Studio exposes per-tenant RLS editor
- [ ] CRM `briefing.ts`: use tenant-scoped `ctx.db` instead of global pool

### B4. Missing / broken endpoints (P3)

- [ ] `/api/system/status` returns 404 — dashboard shows "Could not load system status"

---

## C. SDUI production (from SPIKE-FINDINGS.md)

Spike verdict: **GO** — ~75–80% of extension pages fit declarative model.

### C1. Schema delivery (P1)

- [x] `embedPageSchemas()` inlines JSON at manifest load; `render: 'schema'` for inline objects
- [x] Generic host route `(admin)/[...extPath]/+page.svelte` renders SDUI pages
- [x] `check:sdui-schemas` CI — all 61 extension schemas require `sduiSchema: 1`
- [ ] Wire `getStudioFile` / studio-embed into runtime (Docker still serves external `studio-dist/`)
- [ ] JSON Schema validator + versioned `sduiSchemaVersion` field on pages

### C2. Vocabulary gaps (P2)

- [ ] i18n keys instead of literals in shipped schemas
- [ ] Field validation + required-submit gating
- [ ] `ColumnDef.classWhen` (conditional cell styling)
- [ ] `ActionDef.body` row-computed + tiny expression evaluator
- [ ] `computed[].validWhen` (e.g. accounting debit==credit)
- [ ] File/image fields; boolean, tags, link column types
- [ ] Per-row busy state; optimistic updates
- [ ] Server-driven pagination meta variations
- [ ] Bulk `selectable` + `bulkActions` on list archetype

### C3. Extension catalog migration (P2)

Current state (2026-08-22):

| Metric | Count |
|--------|------:|
| SDUI schema files (`studio/schemas/*.json`) | 61 |
| Extensions with `contribute.ts` (Model 2.5) | 3 (crm, ai, finance/invoicing) |
| Tier-3 routes synced to Studio (`+page.svelte` in ext repo) | 0 |
| Tier-3 routes baked in Studio (`routes/(admin)/crm/*`) | 0 (CRM migrated) |

- [x] Migrate CRM tier-3 pages → unified `studio/schemas/crm.json` (contacts / orgs / deals tabs)
- [x] CRM manifest: `"schema": "schemas/crm.json"` at `/admin/crm` (no tier-3 fallback)
- [x] Remove synced CRM `studio/pages/` + baked `(admin)/crm/*` routes
- [x] Legacy `/admin/crm/{contacts,organizations,transactions}` → `/admin/crm?tab=…` redirect
- [ ] Document SDUI schema reference (public dev guide)

### C4. Tier-3 escape (P3 — ~10–14 extensions)

Keep compile-time Svelte at release for: mail, page-builder, flows, ai chat, geospatial map, media gallery, graphql playground, edge-functions editor, views calendar/kanban.

- [ ] Formalize Tier-3 criteria in EXTENSION-AUTHORING.md
- [ ] **Future marketplace untrusted UI:** iframe sandbox + postMessage — **not** runtime Web Components in admin (Shadow DOM ≠ security)

---

## D. Model 2.5 — compile-time slot contributions

Infrastructure merged (PR #322); CRM pilot merged (PR #58).

### D1. Core infra (done)

- [x] `studio/src/contribute.ts` sync path
- [x] `$lib/ext/.contributions.generated.ts` registry
- [x] `loadExtensionContributions()` + owner-aware register/unregister
- [x] `contributes.slots[]` in manifest
- [x] CI `check-contributions-registry.ts`
- [x] Docs Model 2.5 section

### D2. Rollout to official extensions (P2)

Slot audit (core hosts in Studio):

| Slot | Host | Status |
|------|------|--------|
| `dashboard.widgets` | `(admin)/+page.svelte` | **crm**, **finance/invoicing** |
| `dashboard.hero` | dashboard | — |
| `dashboard.suggestions` | dashboard | — |
| `topbar.center` / `topbar.right` | `(admin)/+layout.svelte` | **ai** (center) |
| `topbar.left` | layout | — |
| `sidebar.bottom` | Sidebar | — |
| `settings.tabs` | settings | — |
| `page.assist` | layout `<main>` | — |

- [x] Audit slots (table above)
- [x] **crm** — `ReceivablesCard` → `dashboard.widgets`
- [x] **ai** — `AiPromptBar` → `topbar.center`
- [x] **finance/invoicing** — `OverdueInvoicesCard` → `dashboard.widgets`
- [x] Declare `contributes.slots` in each manifest (crm, ai, finance/invoicing)
- [ ] More official extensions (hero/suggestions slots — backlog)
- [x] Community note: slot widgets require Studio rebuild (`sync-extensions` + release)

### D3. UX polish (P3)

- [ ] ReceivablesCard loading skeleton (avoid empty dashboard for 2–3s)
- [ ] Integration test: enable extension → contribution appears without manual refresh

---

## E. Engine purity / BaaS (mostly done)

- [x] CRM stripped from engine schema
- [x] Briefing moved to `/ext/crm/briefing`
- [x] `/api/briefing` removed from core
- [ ] Audit remaining Business OS leaks (ongoing vigilance)
- [ ] Extension pack should not silently flip `isolation: worker` on first-party extensions without opt-in

---

## F. UI architecture decisions (reference — not immediate work)

| Tier | Mechanism | Audience |
|------|-----------|----------|
| 1 | SDUI JSON | ~80% pages, zero JS |
| 2 | Model 2.5 `contribute.ts` | Official slot widgets |
| 3 | Tier-3 Svelte at release | Official complex apps |
| 4 | iframe sandbox | Future untrusted marketplace |

- **No SQLite fallback** — Postgres-first; simplify via installer/Docker
- **No runtime third-party JS** in admin — doctrine in `types.ts`

---

## G. Testing & CI

- [ ] Playwright e2e: CRM dashboard widget smoke (blocked locally: missing `libatk` for Chromium)
- [x] Unit: pg_notify payload truncation
- [x] Unit: WS permission cache TTL
- [ ] Integration: multi-instance realtime with Valkey

---

## H. Suggested implementation order

1. ~~**This session:** A1 (pg_notify) + A6 + A4 TTL + A2/A3 error handlers~~
2. ~~**Next:** B1 `build:binary`, C1 schema CI check~~
3. **Now:** D2 Model 2.5 rollout, C3 SDUI schema reference doc
4. **Backlog:** B3 tenant fail-closed, C4 tier-3, marketplace iframe, B1 CI gate

---

## I. Session log

| Date | Work |
|------|------|
| 2026-08-22 | Checklist created. Local smoke: Model 2.5 CRM widget OK. Fixes: `studio:embed`, CORS, `studio-dist/`. |
| 2026-08-22 | **A1–A4, A6 implemented:** pg_notify trim/reconnect/param notify, health `isHealthy()`, ioredis error handlers, WS perm TTL, removed `broadcastToAll`. |
| 2026-08-22 | **B1 + C1:** `build:binary` compiles `dist/zveltio`; fixed studio-embed dir check; `check:sdui-schemas` passes (3 ext JSON fixed). |
| 2026-08-22 | **B2:** Dev footguns documented in CONTRIBUTING, EXTENSION-DEVELOPER-GUIDE §12, installation, CONFIGURATION, `.env.example`. |
| 2026-08-22 | **C3 CRM:** Removed `studio/pages/`; SDUI host at `/admin/crm`; legacy tab redirects + `?tab=` in SchemaPage. |
| 2026-08-22 | **D2:** Model 2.5 — ai `topbar.center`, finance/invoicing `dashboard.widgets`; slot audit in checklist. |
