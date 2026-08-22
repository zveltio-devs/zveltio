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
- [x] Wire `invalidateUserPermCache()` → `invalidateWsUserPermCache()` (+ unit tests)

### A6. Dead cross-tenant helpers (P2)

- [x] Removed `broadcastToAll()` / `broadcastToUser()` (zero callers)

---

## B. Engine core & ops

### B1. Single binary story (P1)

- [x] Implement `packages/engine/scripts/build-binary.ts` (`build:binary` in package.json)
- [x] Wire `gen-worker-source.ts` + `generate-studio-embed.ts` into compile pipeline
- [x] CI gate: embedded studio-dist freshness (`check:studio-embed` + studio workflow)

### B2. Dev / deploy footguns (P2)

- [x] Document `EXTENSIONS_DIR` in dev guide — default `packages/engine/extensions/` can be stale
- [x] Document stale `packages/engine/extensions/` as gitignored install cache (not source)
- [x] Document CORS: Studio dev on `:5173` needs entry in `CORS_ORIGINS`
- [x] Document `VITE_ENGINE_URL` for split Studio dev
- [x] Document `studio:embed` copies to both `packages/engine/studio-dist` and `src/studio-dist` (done in root `package.json`)

### B3. Tenant & RLS (P3 — strategic / breaking)

- [ ] Run engine DB role as non-superuser in production (boot warns today) — **deferred:** installer + migration role split
- [x] **Fail-closed GUC (opt-in):** migration `047` + `ZVELTIO_FAIL_CLOSED_TENANT=1` (`applyFailClosedTenantSetting`). Default remains fail-open-to-default-tenant.
- [ ] **Per-tenant app RLS:** `tenant_id` on `zvd_rls_policies` — **deferred:** when Studio exposes per-tenant RLS editor
- [x] CRM `briefing.ts`: uses tenant-scoped `ctx.db` (`receivables(db)` via `crmRoutes`)

### B4. Missing / broken endpoints (P3)

- [x] `/api/system/status` — N/A; dashboard uses `/api/admin/status` (works)

---

## C. SDUI production (from SPIKE-FINDINGS.md)

Spike verdict: **GO** — ~75–80% of extension pages fit declarative model.

### C1. Schema delivery (P1)

- [x] `embedPageSchemas()` inlines JSON at manifest load; `render: 'schema'` for inline objects
- [x] Generic host route `(admin)/[...extPath]/+page.svelte` renders SDUI pages
- [x] `check:sdui-schemas` CI — all 61 extension schemas require `sduiSchema: 1`
- [x] Wire `getStudioFile` / studio-embed into runtime (disk `studio-dist/` first, embed fallback for binary)
- [x] Host `validateSchema` + version field (`sduiSchema`; alias `sduiSchemaVersion`); column-type + bulkActions shape checks

### C2. Vocabulary gaps (P2)

- [x] i18n keys instead of literals in shipped schemas — developer/validation hardcoded labels fixed; CLI warn remains for new literals
- [x] Field validation + required-submit gating (list forms + detail panel forms)
- [x] `ColumnDef.classWhen` (conditional cell styling)
- [x] `ActionDef.body` row-computed + tiny expression evaluator (`resolveToken` / `{a-b}`)
- [x] `computed[].validWhen` (e.g. accounting debit==credit)
- [x] Column types: `boolean`, `tags`, `link` (+ file field type already in FieldDef)
- [x] Per-row busy state on row actions
- [ ] Server-driven pagination meta variations — **deferred:** no conflicting producers yet
- [x] Bulk `selectable` + `bulkActions` on list archetype

### C3. Extension catalog migration (P2)

| Metric | Count |
|--------|------:|
| SDUI schema files (`studio/schemas/*.json`) | 61 |
| Extensions with `contribute.ts` (Model 2.5) | 3 (crm, ai, finance/invoicing) |
| Tier-3 routes synced to Studio (`+page.svelte` in ext repo) | 0 |
| Tier-3 routes baked in Studio (`routes/(admin)/crm/*`) | 0 (CRM migrated) |

- [x] Migrate CRM tier-3 pages → unified `studio/schemas/crm.json`
- [x] CRM manifest + legacy redirects + SDUI reference doc

### C4. Tier-3 escape (P3)

- [x] Formalize Tier-3 criteria in EXTENSION-AUTHORING.md
- [x] **Marketplace iframe scaffold:** `MarketplaceSandbox.svelte` + postMessage protocol v1 (feature-flagged; not wired into install)

---

## D. Model 2.5 — compile-time slot contributions

### D1–D2 (done)

- [x] Core infra + crm / ai / finance/invoicing slots
- [x] AI `dashboard.hero` + invoicing `dashboard.suggestions`

### D3. UX polish

- [x] ReceivablesCard loading skeleton
- [x] Unit test: `loadExtensionContributions` activate once / unregister on disable (no full page reload)

---

## E. Engine purity / BaaS

- [x] CRM stripped from engine; briefing on `/ext/crm/briefing`
- [ ] Audit remaining Business OS leaks — **ongoing vigilance**
- [x] Extension pack: first-party clears sticky `isolation: worker` unless `--keep-isolation`

---

## G. Testing & CI

- [x] Playwright e2e: CRM dashboard widget smoke (`crm-receivables.spec.ts`; e2e boot + workflow clone extensions)
- [x] Unit: pg_notify payload truncation; WS perm cache TTL + invalidate
- [x] Integration: Valkey multi-instance realtime (`valkey-realtime-multi.integration.test.ts`, skipIf no `VALKEY_URL`)

---

## H. Suggested implementation order

1. ~~A / B1 / C1 / D2 / C3~~
2. ~~C1 embed + C4 Tier-3 docs + CI format~~
3. ~~A4 WS invalidate, E pack isolation, C2 vocab, D3 loader test, G Valkey multi~~
4. ~~Opt-in fail-closed tenant, marketplace iframe scaffold, e2e CRM, hero/suggestions, validation i18n~~
5. **Still strategic:** full non-superuser installer, `zveltio_system` role, per-tenant RLS editor UI, marketplace product wiring beyond scaffold

---

## I. Session log

| Date | Work |
|------|------|
| 2026-08-22 | Checklist created through Model 2.5 rollout, SDUI CRM, docs, CI embed gate. |
| 2026-08-22 | **C1 embed + C4:** `getStudioFile` wired; Tier-3 criteria; briefing ctx.db confirmed. |
| 2026-08-22 | **A4/E/C2/D3/G:** WS perm invalidate; pack sticky-worker fix; SDUI tags/link/bulk/busy/validWhen; contribution loader test; Valkey live multi-instance test. |
| 2026-08-22 | **Toate batch:** fail-closed opt-in (047), MarketplaceSandbox, e2e CRM smoke, AI hero + invoicing suggestions, validation SDUI i18n. |
