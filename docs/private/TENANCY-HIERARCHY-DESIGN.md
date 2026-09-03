# Hierarchical tenancy — implementation plan

*2026-08-26. The four open questions have been answered; this document is now a
plan, not a draft. The facts about the current state are verified in code and in
the database, not inferred.*

---

## 1. What exists today

| Element | State |
|---|---|
| `zv_tenants` | a **flat** list: `id, slug, name, plan, status, max_records, max_storage_gb, max_api_calls_day, max_users, billing_email, trial_ends_at, settings`. **No `parent_id`.** |
| `zv_tenant_users` | `(id, tenant_id, user_id, role, invited_by, joined_at)` — one role per pair, no reach, no validity period |
| the RLS predicate | `zveltio_tenant_scope_ok(row_tenant)` = **plain equality** against the GUC |
| the policies | `FOR ALL`, with **the same predicate in `USING` and in `WITH CHECK`** |
| authorization | Casbin, with the tenant as the **domain** |
| coverage | 29 tables with `tenant_id` in the base, 48 with the extensions |
| global rows | **do not exist**: 17 tables allow `tenant_id` NULL, but `NULL = X` yields NULL, so such a row is invisible to everyone |

The `plan`, `trial_ends_at` and `billing_email` columns say which model was
built: a list of SaaS customers with a subscription.

## 2. Why it is not enough

ANSVSA has 41 county directorates under it. ANSVSA's accounting must see what
the counties have filled in; Buzău and Călărași must not see each other. With
plain equality the second requirement works, **the first cannot** — there is no
notion of "above".

Any corporation with subsidiaries has the same shape. One case, not two.

## 3. The model

Units form a **tree of arbitrary depth**. What is configured is not the tree but
**the reach of each assignment**:

*(person, unit, role, read_scope, valid_from, valid_to)*

| Read scope | Covers |
|---|---|
| `self` | the unit only |
| `subtree` | the unit and everything below it |
| `list` | an explicit set of units |
| `org` | everything |

**Writing has no reach.** *The data belong to the subordinate.* You write only
into your own node, whoever you are. A level above reads and approves; it does
not correct in someone else's place.

### Visibility goes both ways

The rule above leaves two real situations unsolved, so the model also needs the
opposite direction:

- **national reference data** — legislation, the register of authorised units,
  codes: written once at the top, read by every unit below;
- **an inspection carried out by a central team at a subordinate unit** — the
  centre writes it, in its own node, but it is about the subordinate, who must
  see it.

**Downward visibility is opt-in per collection, not automatic.** The centre's
payroll does not become visible to the counties merely because it is higher up.

**Upward visibility is NOT opt-in per collection** — and that is a decision, not
an omission. Upward is already controlled on two axes: `read_scope` per person
(whoever has `subtree` sees below them, whoever has `self` does not) and Casbin
per resource. A third flag would largely duplicate the second axis, and the risk
of three dimensions is not performance, it is **mistaken belief**: somebody
configures one of the three and thinks the data are hidden when they are not.

The "the holding company must not see subsidiary X" case is expressed through
`read_scope = 'list'` — an explicit set instead of a subtree. That is the right
granularity: per person, not per collection.

And the door stays open **for free**: the flag is a literal in the policy, not a
column read per row. If a real case appears requiring "this collection never
goes up, whatever the reach", a second literal is added only in the policies of
the collections that need it — no migration and no cost for the rest. The table
below is the proof: a false literal disappears from the plan.

### Departments do not enter RLS

RLS answers *which units*. Casbin, which already has a domain per unit, answers
*which resources*. "The centre's accounting sees the counties' accounting but not
their HR" is Casbin's job. The two multiplied give the full matrix.

## 4. The schema

```
zv_tenants
  + parent_id      uuid REFERENCES zv_tenants(id)
  + closed_at      timestamptz          -- a unit is NEVER deleted
  + merged_into    uuid REFERENCES zv_tenants(id)
  - plan, trial_ends_at, billing_email, max_api_calls_day
        (the subscription belongs to the instance, not to a subsidiary)

zv_tenant_users            → becomes the assignments table
  + read_scope   text  CHECK (read_scope IN ('self','subtree','list','org'))
  + scope_list   uuid[]                 -- only for read_scope = 'list'
  + valid_from   timestamptz NOT NULL DEFAULT now()
  + valid_to     timestamptz            -- NULL = open-ended

zv_tenant_transfers        → new table
  (id, table_name, record_id, from_tenant, to_tenant, moved_at, moved_by, reason)
```

**The `tenant_id` on the 48 tables is untouched.** No data migration.

**A unit is never deleted.** A merger or dissolution means `closed_at` plus
`merged_into`. Otherwise historical rows point at a node that does not exist and
last year's report can no longer be computed.

**A file transfer is journalled.** The row moves, but *the fact of the move*
stays. It is not full temporal ownership — that would require columns on all 48
tables — but it answers "who owned this file in March" and **does not prevent**
moving to the full variant if that proves necessary.

## 5. The predicate

Two functions instead of one, because reading and writing no longer coincide.

```sql
-- WRITE: your own node, that is all. Identical to today's predicate, so the
-- `WITH CHECK` of the existing policies stays correct without modification.
zveltio_tenant_write_ok(row_tenant uuid) →
  row_tenant = current_setting('zveltio.current_tenant')::uuid

-- READ: the visible set, plus the ancestors if the row belongs to a collection
-- marked as inherited downwards.
zveltio_tenant_scope_ok(row_tenant uuid, inherit_down boolean DEFAULT false) →
  row_tenant = ANY(current_setting('zveltio.visible_tenants'))
  OR (inherit_down AND row_tenant = ANY(current_setting('zveltio.ancestor_tenants')))
```

`DEFAULT false` is what makes the migration bearable: **every existing policy
goes on calling the function with one argument** and behaves as before.

GUCs set once per request, so **zero per-row lookups**:

| GUC | Contents |
|---|---|
| `zveltio.current_tenant` | the node I am working in (unchanged — and the `DEFAULT` of the `tenant_id` columns uses it) |
| `zveltio.visible_tenants` | the set I may read |
| `zveltio.ancestor_tenants` | the chain above my node |

### The cost, measured

On a 500,000-row table with 200 units, index on `tenant_id` (2026-08-26,
`EXPLAIN ANALYZE`):

| Predicate | Rows read | Time | Plan |
|---|---|---|---|
| equality (today's model) | 2,500 | 0.29 ms | Index Only Scan |
| `= ANY`, 3 units | 7,500 | 0.82 ms | Index Only Scan |
| `= ANY`, 42 units | 105,000 | 10.5 ms | Index Only Scan |

**The per-row cost is constant** — 0.116 / 0.109 / 0.100 µs. The size of the set
does not matter; what matters is how many rows are returned. A consolidating
parent node legitimately reads 42 times more rows, and that is the
consolidation, not the mechanism. If it becomes a problem, the remedy is a
materialised aggregate (§9), not tuning the predicate.

The downward-inheritance flag:

| `inherit_down` | Time | Plan |
|---|---|---|
| `false` | 0.77 ms | **the branch disappears from the plan** — identical to the no-flag case |
| `true` | 9.5 ms | `BitmapOr` across two index scans |

**A disabled opt-in costs exactly zero**, because the planner folds the literal
at compile time. Enabled, it is ~7× more expensive per row, but still on the
index and still in milliseconds.

**The scale limit:** for tens or hundreds of units, the set is a small list
resolved once per request. Beyond a few thousand, the correct move is a
materialised path (`ltree`) with prefix matching — **through the same
functions**, so the decision can be deferred at no cost.

## 6. The part with real blast radius

Today's policies are `FOR ALL` with **the same predicate in `USING` and
`WITH CHECK`**. To separate reading from writing, **every tenant policy must be
recreated**, and the template from which policies are created for new extension
tables must change with them.

It is mechanical, but **it must be complete**. The precedent is in the project's
notes: `ensureRlsEnforcementRole` once left the `zveltio_rls` role with 11 tables
out of 378, and nothing flagged it. The migration must count what it touched and
refuse if the number does not match what `pg_policies` declares.

### How mechanical — measured 2026-08-26

On a database with the extensions installed:

- **315 policies on 315 tables** — exactly one per table;
- **all 315 identical**, in every respect: `FOR ALL`, role `public`,
  `PERMISSIVE`, `USING zveltio_tenant_scope_ok(tenant_id)`, and `WITH CHECK`
  **the same predicate**;
- zero tenant policies of any other shape.

So the rewrite is **one template applied 315 times**, and the check is a query:
after the migration, all 315 must have `zveltio_tenant_write_ok` in `WITH CHECK`
and none may still have the old function there. If the number is not 315, the
migration stops.

Of the 315, only **4** come from the engine's baseline; the other 311 are created
by extension migrations. Their template must change together with the migration,
or every extension installed afterwards reintroduces the old shape.

### A gap found along the way, which bears directly on this work

**20 tables have `tenant_id` and NO policy — and RLS is not even enabled**
(`relrowsecurity = false`). On a database without extensions there are 25.

The boot reconciliation (`reconcileTenantRLS`) runs **only over collection
tables** (`zvd_*` from `zvd_collections`, plus `pages`/`views`/`zones`); it does
not touch the engine's `zv_*` tables.

Some are legitimately cross-tenant and **must not** get a policy: the
`zv_tenants` neighbours (`zv_tenant_users`, `zv_tenant_usage`,
`zv_environments`), `zv_api_keys`, `zv_extension_registry`.

Others look like tenant data relying only on application-side filtering:
`zv_dashboards`, `zv_flows`, `zv_invitations`, `zv_record_comments`,
`zv_revisions`, `zv_saved_queries`, plus the checklist scoring tables and
`zvd_page_views` / `zvd_webhooks` / `zvd_webhook_deliveries`.

**I have not checked whether any of these is exploitable** — some may only be
reachable through paths that filter anyway. But it matters directly here: **the
hierarchical predicate will not protect them either.** The first task of the
implementation should be splitting this list into "legitimately cross-tenant"
and "coverage gap", with the reason written beside each.

## 7. Order of work

1. Schema migration (§4). Additive, moves no data.
2. The new functions (§5). `DEFAULT false` means nothing changes yet.
3. Middleware: resolve the assignments → compute the visible set and the
   ancestor chain → set the GUCs.
4. Recreate the policies (§6), with counting and refusal on mismatch.
5. Mark the downward-inherited collections.
6. The test (§8).

## 8. How it is verified

A test that builds the tree in miniature — a root plus two sibling units — and
proves, on real rows:

1. Sibling A does not see sibling B's rows.
2. The root sees both.
3. The root **cannot write** into a sibling's rows.
4. An expired assignment sees nothing.
5. A row from a downward-inherited collection, written at the root, is visible
   from both siblings.
6. A row from an **un**marked collection, written at the root, is **not** visible
   from below.

Point 2 must fail against today's code. That is the proof the model really
changed.

## 9. Explicitly outside the model

- **Aggregate-only visibility** ("I see the total, not the records"). RLS is
  row-level. Solved with views or materialised aggregates. Written here so
  nobody tries to force it into policies.
- **Data residency** — a separate instance, not a reach.
- **Rows with two owners** — one `tenant_id` per row. Real co-ownership would
  need a link table; it is solved through direction (a single owner at the right
  node, visible downwards).

## 10. Rejected approaches, and why

The advice below is what a search for "multi-tenancy BaaS" returns. It is
plausible, widely repeated, and **each item undoes one of the properties in
§3–§5**. Written here because in a year somebody will receive it again and it
will look reasonable.

### "Head office has a role that bypasses RLS"

The usual form: `if (role === 'hq_admin') allowedUnits = []` — an empty list
meaning "no restrictions".

**Why not.** A role that *switches off* enforcement is a role where one mistake
leaks everything. Here head office is `read_scope = 'org'`: still enforced by the
database, still auditable, still visible in the policies. An empty array in code
is a hole; an 'org' reach is a policy. See also §12: `rls_bypass` never becomes
the mechanism for anything.

### "Filter in the query builder / ORM"

The usual form: a middleware injects `WHERE org_unit_id IN (…)` into every
query, on the argument that "even if a third-party developer forgets to filter,
the system filters anyway".

**Why not.** True only if the query goes through that query builder. Zveltio has
57 third-party extensions that write their own SQL and are under no obligation
to go through it. RLS exists precisely so that enforcement does not depend on
the caller's discipline. Enforcement lives in the Postgres policies; the query
builder is ergonomics, not a boundary.

### "Put the active unit in the JWT"

The usual form: `active_org_unit_id` in the token, sold as an optimisation — "no
more querying the users table on every request".

**Why not.** The reach becomes irrevocable until the token expires. You withdraw
an assignment and the bearer continues with the old reach until expiry. One
millisecond per request traded for a revocation window of hours. Assignments are
resolved per request; §4 gives them `valid_from` / `valid_to` precisely so that
revocation is a date, not a retelling.

### "Write the audit asynchronously, after the response"

The usual form: `setImmediate(() => db.insert(auditLog))`, to avoid doubling
latency.

**Why not — and this is measured, not assumed.** A write dispatched after the
response runs on the request's transaction, which is already committed with the
connection returned to the pool. From `data/import/engine/routes.ts`, about
exactly this pattern:

> *"The recovery write went to a closed transaction, its `.catch` discarded the
> error, and a job that died left `status: 'pending'`, `errors: []` and not one
> line anywhere. Measured on a virgin database: an import stayed pending forever
> with no trace, which is how a broken import reads as a slow one."*

If the audit really must come off the critical path, it needs **its own
transaction** (`withTenantIsolation`), not the request's context.

### "Mark global rows with `org_unit_id = NULL`"

**Why not, as stated.** Verified: under an equality predicate, `NULL = X` yields
NULL, so such a row is invisible to everyone, not visible to everyone. Today 17
tables allow NULL and none of them gains anything from it. Downward visibility is
achieved through an owner at an ancestor node plus the flag from §3, not through
the absence of an owner.

### "Partition on `org_unit_id`"

**Why not here.** Good advice for independent tenants with queries touching a
single unit. In a tree, consolidation touches *every* partition — you add
planning cost to exactly the query the model exists for.

### "Transfer between units through a `SECURITY DEFINER` function"

**Why not.** Another bypass, and it contradicts §4: transfers are journalled. A
`SECURITY DEFINER` function is a second access path that appears in no policy.

## 11. Noted separately

All installations run **production environments**. The per-unit `_dev` schemas,
`resolveEnvironment` and `provisionEnvironment` therefore become dead weight that
multiplies with every new unit. A real simplification, with its own blast
radius — to be decided separately, not together with this.

## 12. Federation — designed now, built later

So that the access chain is not rewritten in a year, **the principal is
polymorphic from the start**: person | service | foreign instance. An agreement
with a foreign instance is an assignment like any other, with the same grammar
of reaches and with validity in time — so **a single enforcement point**, not a
second, weaker path.

`zv_api_keys` already has `scopes`, `expires_at`, `allowed_ips` and
`casbin_subject`: half the mechanism. What is missing is the instance's identity
(public key / mTLS) and the transport.

**`rls_bypass` never becomes the mechanism of federation.**

---

## 13. Implementation notes — what turned out otherwise (2026-08-26)

*Added after implementation, on the `feat/tenancy-hierarchy` branch. The plan
above was followed; four of its claims did not survive contact with the
database, and each of them mattered.*

### §5 — `DEFAULT false` would have broken all 315 policies

The plan called for `zveltio_tenant_scope_ok(row_tenant uuid, inherit_down
boolean DEFAULT false)` **beside** the existing one-argument function, so that
old policies would go on calling with one argument. Postgres refuses:

```
ERROR:  function zveltio_tenant_scope_ok(uuid) is not unique
HINT:  Could not choose a best candidate function.
```

A parameter with a default value **enters the candidate set** for a one-argument
call, so the call becomes ambiguous. Not at creation time — **on every query**,
across all 315 policies at once.

Replacing by dropping is not available either: a policy takes a hard dependency
on the function it calls, and `DROP FUNCTION` is refused while the policy exists.

What was done: the one-argument function is **rewritten in place**
(`CREATE OR REPLACE`, same signature), and the two-argument variant **has no
default value**, so it cannot receive a one-argument call and creates no
ambiguity.

### §5 — the cost table measured something other than what the policy runs

The figures in §5 (Index Only Scan, 0.29 ms / 10.5 ms) are real, but they were
measured against a **hand-written** predicate — `tenant_id = ANY (...)`. The
policies call a **row-level boolean function**, which expands into a `CASE`
around the comparison, and Postgres **cannot use an index through a `CASE`**: the
indexed column must appear in an indexable clause at the top level.

Measured on 500,000 rows, 200 units, with the index on `tenant_id` present
throughout:

| Predicate form | Plan | Time |
|---|---|---|
| row-level boolean function (**the form used until now**) | Seq Scan | **249 ms** |
| `tenant_id = ANY (STABLE function returning the set)`, 1 unit | Index Only Scan | 0.28 ms |
| the same, 42 units | Index Only Scan | 10.8 ms |

So **the cost was not the hierarchy's, it was the predicate's shape — from
before this work.** The migration writes the policies in the indexable form:
`USING (tenant_id = ANY (zveltio_visible_tenants()))`. The old-named functions
stay defined over the same sets, because 57 extension migrations write them into
the policies they create and not all of them live in this repository; an
extension installed tomorrow gets a **correct but unindexed** policy, and the
boot reconciler moves it onto the fast form.

It matters more now than before: a parent node legitimately reads 42 times more
rows, so this is exactly the moment a sequential scan stops being cheap.

### A correction to the correction above — the indexable form does not hold AS A POLICY (2026-08-27)

The symptom above is real and important. The mechanism and the remedy are not.

Measured on 500,000 rows of which 2,500 belong to the tenant, with the index
present and `FORCE ROW LEVEL SECURITY` active — so with the policy actually
applied:

| Form, **as a policy** | Plan | Rows scanned |
|---|---|---|
| row-level boolean function (the old form) | Index Only Scan, no `Index Cond` | 500,000 |
| `tenant_id = ANY (zveltio_visible_tenants())` — **the form the migration writes** | **Parallel Seq Scan** | 500,000 |
| the predicate written inline in the policy | no `Index Cond` | 500,000 |
| wrapped in `(SELECT …)` | no `Index Cond` | 500,000 |
| a wrapper function marked `LEAKPROOF` | no `Index Cond` | 500,000 |

The same expressions, **as an ordinary `WHERE`**, behave exactly as the table
above describes: `= ANY(function)` gives a `Bitmap Index Scan` with an
`Index Cond` over 2,500 rows, and the boolean function does not.

**So the difference is not the predicate's shape, it is the fact that it is a
policy.** The planner estimates the security qual as matching everything —
208,333 rows per worker against 2,492 correctly estimated for the same
expression as a `WHERE`. With no estimate, it does not choose the index path.

The 0.28 ms figure in the table above was almost certainly measured **outside
the policy**. It is the same methodological mistake this correction rightly
levels at the initial version of this document — and which it then repeated.

**What does work, verified:** the policy stays, and the query repeats the filter
explicitly. The active policy plus `WHERE tenant_id = current_setting(…)` →
`Index Cond`, 2,500 rows, cost 53 instead of 6,600. RLS remains the guarantee;
the explicit filter is what the planner needs. It can be injected once, in the
request-scoped proxy, for the engine and the extensions alike.

**Consequence for the migration:** the new policy form is semantically correct
and breaks nothing, but **it does not deliver the performance gain invoked as
its justification** — and on `count(*)` it is a worse plan than the old form
(Seq Scan against Index Only Scan). That is not a reason to back out; it is a
reason for the justification not to stay written down wrongly.

### §6 — there are 16 on a clean installation, not 20

The four that are missing — `zvd_pages`, `zvd_views`, `zvd_zones`,
`zvd_page_views` — **do not exist on a clean installation**. They are the old
tables `content/pages` migrates from. The database §6 was measured on predated
the merge. Details and the full classification in
[`TENANCY-COVERAGE-CLASSIFICATION.md`](TENANCY-COVERAGE-CLASSIFICATION.md).

Of the 16, **5 enter the migration** and 11 stay out with a written reason. Most
of the 11 are not "administrative": they are tables whose only reader is a
background worker running **on the pool, with no GUC** — where a policy would
protect nothing and would silently switch the feature off. `zv_flows`,
`zvd_webhooks`, `zv_revisions` and `zv_dashboards` are exactly that, and
`insightsRoutes(poolDb, …)` / `flowsRoutes(poolDb, …)` say so in
`routes/index.ts`.

**One was exploitable**, and §6 had left the question open:
`GET /ext/workflow/checklists/templates/:id/scoring-schemes` read another
tenant's scoring schemes. Proved on real rows, fixed, and now covered by a
policy.

### §6 — "if the number is not 315, the migration stops" is too rigid

315 is what an installation with every extension has. A database with only the
engine has 4. The migration cannot know the number in advance. The equivalent
invariant, checkable on any installation: **the number rewritten = the number
found**, **zero policies left on the old predicate**, and every rewritten one
carries both new predicates. The migration stops if any of these fails.

### A gap found in the reconciler, not in the plan

`reconcileExtensionTenantRLS` filtered tables by the `zv_`/`zvd_` prefix. The 11
`trace_*` tables in `compliance/traceability` have `tenant_id`, declare a
`tenant_isolation_*` policy, and **were skipped at every boot** — so the
guarantee "the host puts every extension table on the host's predicate" was not
true, and nothing said so. The prefix was not what made the operation safe; the
name is still validated as a plain identifier before interpolation.

### What was deliberately NOT done from §4

The four subscription columns (`plan`, `trial_ends_at`, `billing_email`,
`max_api_calls_day`) **were not dropped**. All four are live: `routes/tenants.ts`
accepts and returns them, Studio has a form on `plan`, and `max_api_calls_day`
**is** the quota mechanism in `middleware/tenant-quota.ts` — dropping it is not
tidying, it is switching off per-tenant quotas. The rest of the plan is additive;
this would have been its only destructive part, and nothing else in it requires
it. The precedent for deferring is in the repository: the *contract* half of
migration 048 is a reconciler the operator arms (`contractImportLogs`), not a
migration. An owner decision.
