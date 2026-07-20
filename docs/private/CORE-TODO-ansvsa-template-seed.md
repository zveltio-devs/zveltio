# CORE TODO — Template seed bugs (RLS + table prefix)

> **Audience:** an AI agent with full context over the Zveltio engine.
> **Scope:** changes in `zveltio` core only. Do NOT touch the extensions
> (`zveltio-extensions/compliance/ansvsa`, `.../risk-assessment`) — those are
> already correct.
> **Status: ✅ FIXED + VERIFIED (2026-07-02).** Both fixes applied in
> `templates.ts` and validated end-to-end on the real engine (source boot, fresh
> PG 18.4, **non-superuser** role `zvapp` so FORCE RLS binds): ansvsa install →
> 64 tables; seed → `{seeded:113, pending:0}`; all four sanity counts exact
> (35/12/4/2); FK chain responses→items→sections resolves (4); re-seed idempotent
> (`seeded:0`); crm regression seeds 13 rows with FKs. Tenant resolution comes
> from the request context (`c.get('tenant')`, set by tenantMiddleware before the
> TXN_SKIP branch), falling back to `DEFAULT_TENANT_ID` — no hardcoding. One extra
> fix beyond the two below: inside the seed transaction the table-readiness check
> uses `to_regclass` (non-throwing) — a caught `SELECT count(*)` error would have
> aborted (poisoned) the whole transaction for every later collection.
>
> Original report (kept for history):
> both bugs reproduced & confirmed live (engine run from source on a
> fresh Postgres, `ansvsa` v2 template = 64 collections). Fixes below were
> verified manually then reverted from core so a context-complete agent can apply
> them properly (incl. the multi-tenant tenant resolution).

## Context

Feature under test: **built-in application templates** — `POST
/api/templates/:id/install` (creates collections via DDL queue) followed by
`POST /api/templates/:id/seed` (inserts `sampleData` rows). The "one-click =
working app" promise.

Both bugs live in the **seed** handler of
`packages/engine/src/routes/templates.ts` and affect **ALL templates** (the 5
builtin ones too — crm, invoicing, project, helpdesk, inventory), not just
`ansvsa`. On any install with RLS enabled and ≥1 provisioned tenant, seeding
currently inserts **0 rows**.

Reproduced with: fresh DB, engine from source, install `ansvsa` → all 64
`zvd_ansvsa_*` tables created OK; seed → first failed silently (`seeded:0,
pending:32`), then (after fixing bug 1) `500 — new row violates row-level
security policy for table "zvd_ansvsa_counties"`.

---

## Bug 1 — seed targets the unprefixed table name

**Where:** `templates.ts`, seed handler, ~line 324.

```ts
const tableName = pfx(coll.name);            // e.g. "ansvsa_counties"
...
SELECT count(*)::int AS n FROM ${sql.id(tableName)}   // FROM "ansvsa_counties"
...
const inserted = await dynamicInsert(db, tableName, resolved);
```

**Root cause:** `DDLManager.getTableName()` returns `` `zvd_${collectionName}` ``,
so the physical table is `zvd_<pfx(coll.name)>` (e.g. `zvd_ansvsa_counties`), but
the seed reads/writes the bare collection name. The count query throws
(relation does not exist), gets swallowed by the `.catch(() => { ready = false })`,
and every collection is marked `pending` → **0 rows seeded**, response
`{ seeded: 0, pending: N }`.

**Fix:**

```ts
const tableName = `zvd_${pfx(coll.name)}`;
// or, preferably, reuse the single source of truth:
// const tableName = DDLManager.getTableName(pfx(coll.name));
```

Same `tableName` var feeds both the count check and `dynamicInsert`, so one
change fixes both. **Verified:** with this, all 64 `ansvsa` tables are found and
the flow proceeds to the insert (which then hits bug 2).

---

## Bug 2 — RLS blocks seed inserts (no tenant context)

**Where:** same seed handler — inserts run on the global `db` pool.

**Root cause:** collection tables created by `DDLManager` have **FORCE ROW LEVEL
SECURITY** with a **strict** tenant policy. The `tenant_id` column default is
`COALESCE(current_setting('zveltio.current_tenant', true)::uuid,
'00000000-0000-0000-0000-000000000001')` and the policy requires the row's
`tenant_id` to match the `zveltio.current_tenant` GUC. The seed connection has
**no GUC set**, so with ≥1 row in `zv_tenants` the INSERT is rejected:

```
PostgresError: new row violates row-level security policy for table "zvd_ansvsa_counties"  (42501)
```

(The DDLManager `zvd_*` policy is stricter than the extension RLS template, which
has a `NULLIF(GUC,'') IS NULL OR tenant_id IS NULL OR …` escape and would have
allowed it.)

**Fix:** run the seed inside a transaction that sets the tenant context, and use
that transaction handle for the count checks + `dynamicInsert`:

```ts
await db.transaction().execute(async (trx) => {
  await sql`SELECT set_config('zveltio.current_tenant', ${tenantId}, true)`.execute(trx);
  // ... existing loop, but every `db` → `trx` (count query + dynamicInsert) ...
});
```

`tenantId` must be the **acting admin's tenant** — resolve it the same way the
per-request tenant middleware does (session → membership). For single-tenant
installs it is the default `00000000-0000-0000-0000-000000000001`. Don't
hardcode; thread it from the request/session so multi-tenant installs seed into
the correct tenant.

> Test-only workaround used during verification (do NOT ship): set the GUC as a
> role default so pooled connections carry it —
> `ALTER ROLE zveltio SET "zveltio.current_tenant" = '<tenant>'`. With that, the
> **unmodified** seed route inserted all 113 `ansvsa` rows and FK joins resolved.

---

## Verification checklist (after both fixes)

- [ ] `POST /api/templates/ansvsa/install` → poll: 64 `zvd_ansvsa_*` tables.
- [ ] `POST /api/templates/ansvsa/seed` → `{ success: true, seeded: 113, pending: 0 }`.
- [ ] `SELECT count(*)` sanity: `zvd_ansvsa_unit_types` = 35, `..._checklist_items` = 12,
      `..._checklist_responses` = 4, `..._counties` = 2.
- [ ] FK join resolves: `checklist_responses → checklist_items → checklist_sections`.
- [ ] Re-seed is idempotent (a collection that already has rows is skipped).
- [ ] Regression: re-check the 5 builtin templates (crm/invoicing/project/helpdesk/inventory)
      also seed now — they were broken by the same two bugs.

---

## Optional — extension-provided templates

Templates are currently hardcoded builtins: a static `import ... with { type:
'json' }` + an entry in the `BUILTIN` array in `templates.ts`, and the JSON lives
in `packages/engine/src/templates/builtin/`. The `ansvsa` vertical therefore sits
**inside core**.

`templates.ts` already notes a future `ctx.registerTemplate(manifest)` hook.
Implementing it would let a vertical ship its template from its own extension
(e.g. `compliance/ansvsa`) instead of core, so the ANSVSA template + seed could
move **out of the engine repo** entirely. Nice-to-have, not required for the two
bug fixes above.
