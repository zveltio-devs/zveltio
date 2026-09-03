# §6 — The 20 tables without a policy, classified

*2026-08-26. The first task required by `TENANCY-HIERARCHY-DESIGN.md` §6. Every
row below has a reason verified in code or proved against a live database, not
inferred.*

---

## How it was measured

Database built in the order given by the extension contract-suite recipe: virgin
database → engine schema (harness) → extension migrations (contract suite,
590/590) → a second engine boot, so the reconcilers run. Result: **382 tables,
315 policies**.

```sql
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r'
  AND EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
  AND NOT EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname='public' AND p.tablename=c.relname);
```

### First correction to the §6 list: 20 → 16 + 4

On a clean installation the gap is **16 tables**, not 20. The four that are
missing — `zvd_pages`, `zvd_views`, `zvd_zones`, `zvd_page_views` — **do not
exist on a clean installation**. They are the *old* tables that `content/pages`
migrates from (the extension's `001_initial.sql` reads them once, as a source,
and writes `zv_pages` / `zv_page_sites`). They appeared in the reference
database §6 was measured against because that database predated the
`content/pages` merge.

They do not enter the migration. They are upgrade residue, not a coverage gap —
and on databases where they do exist, `zvd_pages` / `zvd_views` / `zvd_zones`
are in `reconcileTenantRLS`'s built-in list anyway, so they get a policy at the
first boot after they come into existence.

---

## A. Legitimately cross-tenant — NO policy (11)

The criterion is not "looks administrative". It is: **the question this table
answers is asked before a current tenant exists**, or is asked about all tenants
at once. A policy here is not extra caution, it is a modelling error.

| Table | Why not |
|---|---|
| `zv_tenant_users` | `getUserTenants()` (`tenant-manager.ts:445`) answers "which tenants am I in?" — the question asked *before* choosing a tenant. With a policy, the tenant list at login is empty and nobody can switch. |
| `zv_api_keys` | `validateApiKey()` (`lib/data/auth.ts:96`) looks up **by hash only**; the key is what *establishes* the tenant. The comparison against the requested tenant follows immediately (`auth.ts:119`) and is correct. With a policy, API-key authentication fails entirely. |
| `zv_invitations` | Redeemed **by token, by an unauthenticated caller who is not yet a member anywhere** (`routes/auth.ts:90,123`). `/api/auth` is in `TXN_SKIP_PREFIXES`, so there is no tenant transaction at all. The token *is* the capability. |
| `zv_environments` | `resolveEnvironment()` is called **from inside `tenantMiddleware`, before** `withTenantIsolation` opens the transaction (`middleware/tenant.ts:75`). A policy here breaks tenant resolution — that is, everything. It filters on `tenant_id` explicitly. |
| `zv_tenant_usage` | Written by `tenant-quota.ts:136` on `quotaDb = poolDb ?? db` — the pool, outside the request transaction, by construction. Read in aggregate per instance by `/api/admin/system`. It is the instance's ledger. |
| `zv_extension_registry` | Read at boot (`index.ts:532,561`), with no request in flight. Extensions install per **instance**, not per tenant. |
| `zvd_webhooks` + `zvd_webhook_deliveries` | The comment is in the code itself (`lib/webhooks.ts:120`): *"the dispatcher runs on the GLOBAL pool, not inside the request transaction, so it can't read `current_setting('zveltio.current_tenant')`"*. It filters on the `tenant_id` passed as an argument. With a policy, the dispatcher would see zero rows and **webhooks would stop silently** for every non-default tenant. |
| `zv_dashboards` | `insightsRoutes(poolDb, auth)` (`routes/index.ts:458`) — **on the pool**, deliberately: the route sets its own `SET TRANSACTION READ ONLY` and `statement_timeout`, which have no business applying to the whole request. That is why it filters manually, with `tenantOf(c)`, on every access. |
| `zv_flows` | `flowsRoutes(poolDb, auth)` (`routes/index.ts:482`), plus `flow-scheduler.ts:90`, which opens **its own transaction on `_db`, with no `SET LOCAL ROLE` and no GUC** — it has to see every tenant's due flows, or it cannot run them. |
| `zv_revisions` | `afterWrite` writes the journal **on the pool**, and the code says so (`write-pipeline.ts:411`): *"afterWrite runs on the pool, not the request transaction, so it can't rely on the RLS GUC"*. It sets `tenant_id` explicitly. |

**A reservation on the last four.** `zv_dashboards`, `zv_flows`, `zv_revisions`
and the webhook pair are *legitimately cross-tenant at their background
writer/reader*, not in principle. A policy would be right as a model and wrong
in execution: `zveltio_tenant_scope_ok` with no GUC falls back to the default
tenant, so it would silently cut off exactly the non-default tenants. They are
marked "not now" with a written condition, not closed: they get covered when the
background caller moves onto `withTenantIsolation`, which is a piece of work
with its own scope. `zv_revisions` is the most unpleasant case — the `INSERT`
carries `.catch(...console.error)`, so a policy added today would make the audit
journal fail *into a log line*, not into an error.

One detail belonging to §6: `content/drafts/engine/routes.ts:366` has a
`COUNT(*)` on `zv_revisions` **with no tenant filter** (draft version
numbering). It does not leak content, but it counts another tenant's rows — to
be fixed separately, at the source.

---

## B. Genuine coverage gap — ENTER the migration (5)

The criterion: **every existing access already carries a tenant filter or ought
to**, nothing reads them without context, and the missing policy is an
oversight.

| Table | Why yes |
|---|---|
| `zv_checklist_scoring_schemes` | See the proof below. **Demonstrated leak.** |
| `zv_checklist_scheme_weights` | Same omission, same migration. |
| `zv_checklist_scores` | Same omission. Holds an inspection's score and `snapshot`. |
| `zv_record_comments` | All 4 accesses are in `routes/revisions.ts`, on `db` (so inside the tenant transaction), all already carrying `tenant_id = ${tenantId(c)}`. The policy is strictly defence in depth, with no regression risk. |
| `zv_saved_queries` | All 8 accesses are in `routes/saved-queries.ts`, on `db`, all already filtered. Likewise. |

### Why the three scoring tables — the exact mechanism

`workflow/checklists/engine/migrations/002_tenant_rls.sql` enumerates a **fixed
list** of five tables and gives them policies. `004_scoring_schemes.sql` adds
**three more** tables with `tenant_id`, two migrations later, and does only
`GRANT ... TO zveltio_rls` — no `ENABLE ROW LEVEL SECURITY`, no policy.

`reconcileExtensionTenantRLS` cannot save them: by construction it adopts only
tables that *already declare* a `tenant_isolation_*` policy. A table that never
had one is invisible to it.

### The proof — no longer "unverified"

§6 said: *"I have not checked whether any of these is exploitable."* One is. Run
against the live database, under the `zveltio_rls` role — exactly the role a
request takes:

```
=== tenant B reads the PROTECTED parent (zv_checklist_templates) ===
 rows_b_can_see
----------------
              0

=== tenant B reads the UNPROTECTED child — the route's query, verbatim ===
      name       |       description        |              tenant_id
-----------------+--------------------------+--------------------------------------
 A secret scheme | A confidential threshold | 11111111-1111-1111-1111-111111111111
```

The route is `GET /ext/workflow/checklists/templates/:id/scoring-schemes`
(`routes.ts:1013`): it queries `zv_checklist_scoring_schemes` directly, by
`template_id` **taken from the URL**, without going through
`zv_checklist_templates` first. Its sibling, `POST` on the same path
(`routes.ts:1045`), *does* have the guard — it looks the template up first, and
the template is protected, so it 404s on a foreign id. So this is not a
decision, it is an omission in one of two twin routes.

Any user authenticated in tenant B, holding a template UUID from tenant A, reads
the name, description and pass threshold of tenant A's scoring schemes.

---

## C. What this means for the main task

Both numbers in §6 change, and must change in the plan:

- policies to recreate stay at **315** — none of the above were among them;
- the migration **adds 5 new policies**, so the §6 check becomes "**320** tenant
  policies, all with `zveltio_tenant_write_ok` in `WITH CHECK`", not 315. The
  migration stops if the number does not match.

The four in §A carrying a reservation (`zv_dashboards`, `zv_flows`,
`zv_revisions`, `zvd_webhooks` + `zvd_webhook_deliveries`) stay out of the
migration **with a written reason**, not by forgetting. They are the natural
entry point for the transaction-boundary work — which is exactly about who runs
on the pool and who runs inside the request transaction.
