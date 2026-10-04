# Multi-tenancy in Zveltio — how it actually works

> Written for someone who is going to **audit** this code. The goal is not to
> argue that it is sound, but to say exactly what it is — including where it is
> fragile — so that audit time goes to what matters rather than to guesses.
>
> Every claim here is checkable with a command. Where there are numbers, they
> were measured, and the command is beside them.

---

## 0. The summary, if you read one paragraph

One installation serves **many organisations**, hierarchically — corporations
with subsidiaries, institutions with subordinate units. Isolation is **not** at
schema level and not at database level: it is **shared schema + a `tenant_id`
column**, enforced by **Postgres RLS**.

The fact everything else depends on:

> **The role the engine connects as decides whether the policies apply at all.**
> Postgres does not apply RLS to a `SUPERUSER` or `BYPASSRLS` role — **not even
> with `FORCE ROW LEVEL SECURITY`.** A correct installation connects the engine
> as a **plain role**, and then the policies bind the connection directly.

---

## 0.1 The connection role — read this BEFORE judging anything else

This is the easiest thing to get wrong, in both directions. The engine reports
at every boot which of three states it is in (`initRlsEnforcementRole`,
`index.ts`):

| State | Meaning | Log line |
|---|---|---|
| `enforced` | The `zveltio_rls` role exists; every tenant transaction descends into it | `🔒 Tenant RLS enforced via the zveltio_rls role` |
| `native` | No descent role, but the connection is a plain role, so RLS binds it directly | `🔒 Tenant RLS enforced natively — the engine role is bound by RLS` |
| `unavailable` | No descent role **and** the connection bypasses RLS | `❌ … Tenant isolation is NOT enforced` |

The third state is **fatal in production** — `rlsBootFailure()` stops startup
when `NODE_ENV=production`, and the only way out is
`ZVELTIO_ALLOW_UNENFORCED_RLS=1`, set deliberately by an operator. Outside
production it stays a warning, because a development machine on the stock
image's superuser is a normal thing.

**The documented production installation does not use a superuser.**
[`deployment-k8s.md`](deployment-k8s.md) describes it and
`scripts/bootstrap-db-role.sh` performs it: run **once**, as superuser, it
creates the database, creates `zveltio_app` as `NOSUPERUSER NOBYPASSRLS`
(with `CREATEROLE`, for per-extension roles — see below),
installs the untrusted extensions (`vector`, `postgis` — only a superuser can
create those) and pre-creates the `zveltio_rls` role. **After that the engine
never needs a superuser again** — migrations, extension installation and DDL all
run as the owner role.

`docker-compose.yml` already starts Postgres with `POSTGRES_USER=zveltio`, not
`postgres`.

### What does NOT require a superuser, contrary to appearances

Verified in code, because this is exactly the list the judgement rests on:

| Operation | Actual privilege required |
|---|---|
| `SET LOCAL ROLE zveltio_rls` | **Role membership**, not superuser — migrations do `GRANT zveltio_rls TO current_user` |
| `CREATE ROLE` (the three roles) | `CREATEROLE`; wrapped in `DO $$` with graceful degradation so it cannot block an upgrade |
| `CREATE EXTENSION` required by an extension | The engine **detects** what is missing and asks the operator to install it from psql |
| `ALTER SYSTEM` | **Executed nowhere** — it appears only in a comment describing a since-removed denylist |

### So how do you read "the second line of defence"?

- **Correct installation (plain role).** RLS binds the connection **directly**.
  The `SET LOCAL ROLE` descent inside the transaction stays, but it is belt over
  braces.
- **Superuser (stock/dev, or production with the override).** The policies are
  inert on the connection, and the only thing enforcing isolation is the descent
  inside the transaction. **Only in this case** is "what code touches tenant
  data outside the transaction" a security question; otherwise it is a
  performance question.

Measured on a database connected as `postgres`, to make the loss explicit:

```
raw pool, postgres role              : 2 rows — tenant A + tenant B   ← RLS inert
tenant transaction, zveltio_rls role : 1 row  — tenant A             ← RLS applied
```

**The first question of any audit** must therefore be: *what role is the
instance I am looking at running as?* A report written against a development
installation on a superuser describes a different system than one written
against a production installation.

---

## 1. The four layers, and what happens if one is forgotten

| # | Layer | Decides | Runs in | If forgotten |
|---|---|---|---|---|
| 1 | **Casbin** | Whether the user may perform the *action* | Engine | **leak** |
| 2 | **RLS policies on `tenant_id`** | *Which rows* the session sees | Postgres | nothing — the database refuses |
| 3 | **Product row rules** | "see only what you created", etc. | Postgres **and** engine | nothing — the database refuses |
| 4 | **Explicit `where tenant_id = …`** | Performance, plus a belt | Engine | usually nothing — layer 2 covers it |

An auditor judging the wrong layer reaches wrong conclusions. The most common:
reporting the absence of layer 4 as a leak, when layer 2 covers it. Or the
reverse — assuming layer 2 covers something that runs outside the transaction,
where it does not apply.

---

## 2. The lifecycle of a request

```
sessionPrefetch        resolves the session ON THE POOL, as the engine role
   ↓
tenantMiddleware       resolves the tenant, opens ONE transaction,
                       descends the role + publishes ten session variables
   ↓
tenantMembership       requires membership for non-default tenants
   ↓
handler                everything runs inside that transaction
```

**Why `sessionPrefetch` is first, and why that is not a detail.** The
`zveltio_rls` role has no read privilege on the Better-Auth tables (`session`,
`account`). A session query inside the transaction answers
`permission denied for table session`, and that refusal **aborts the
transaction**, taking the rest of the request with it. So the session is
resolved beforehand, on the pool, as the engine role.

### Routes that do NOT open a transaction

`TXN_SKIP_PREFIXES` in `middleware/tenant.ts`:

```
/api/health  /api/metrics  /api/auth  /api/openapi
/api/collections  /api/relations  /api/schema  /api/templates
/api/tenants
/api/insights  /api/flows  /api/backup  /api/admin/sql
/api/admin/audit
```

The last four are built on `poolDb`, and that **is not an oversight, it is a
repair**. A request already inside a transaction has reserved one connection; a
handler on `poolDb` asks for a second. At concurrency equal to the pool size,
every request holds one and waits for one, and nothing is ever released:

| `DB_POOL_MAX` | Concurrency | Errors | p95 | Pool states |
|---:|---:|---:|---:|---|
| 10 | 5 | 0 | 19.6 ms | `idle in transaction × 4` |
| 10 | **10** | **10 of 10** | **9,724 ms** | `idle in transaction × 10`, `active × 1` |

<sub>Measured against a live engine on `:3400`, a 50,000-row collection, load
over HTTP; samples from `pg_stat_activity` during the load.</sub>

This is not degradation, it is a stall. Those four filter explicitly through
`tenantOf(c)` — they must, being on the pool — and `backup` and `sql-editor` are
instance-level tools with no tenant scope. The `check:pooldb-txn` gate guards
the list.

`/api/tenants` skips for a different reason: **administering tenants is not work
INSIDE a tenant.** Provisioning writes the tenant row through the pool — it must,
because a tenant that exists only inside an uncommitted transaction cannot be
referenced by anything — and then writes its first environment. Run inside a
tenant transaction, those two writes landed on different connections and the
second failed on a foreign key.

`/api/admin/audit` skips because the instance trail is not a tenant's.
`zv_audit_log.tenant_id` (migration 040) is the writing transaction's tenant, or
NULL for an instance-level event — boot, logins, anything written on the pool.
A writer that knows better names it (`AuditEvent.tenantId` in `lib/audit.ts`):
`/api/tenants` stamps member, invitation and archive events with the tenant they
act on, and a god request on `/api/data/*` is the tenant's; global settings,
roles, extension lifecycle and account deletion pass `null`, written after the
request transaction so the firm the request resolved does not inherit them.
Its policy shows NULL rows only where `zveltio.current_tenant` is empty, and every tenant transaction sets it,
god's included; so the route reads through `withEveryTenant` (every firm
published, no current tenant), behind `requireInstanceAdmin`. Extensions read
their tenant's rows with `ctx.internals.readAuditActivity` (capability
`audit:read`) and count them with the ungated `countAuditActivity`.

---

## 3. The ten session variables

All written in **a single round trip**, all `is_local = true`, therefore
transactional:

```sql
set_config('role',                      'zveltio_rls', true)
set_config('zveltio.current_tenant',    <uuid>,        true)
set_config('zveltio.visible_tenants',   <uuid,uuid…>,  true)
set_config('zveltio.ancestor_tenants',  <uuid,uuid…>,  true)
set_config('zveltio.user_id',           <id>,          true)
set_config('zveltio.user_email',        <email>,       true)
set_config('zveltio.user_role',         <role>,        true)
set_config('zveltio.user_roles',        <role,role…>,  true)
set_config('zveltio.actor',             'on' | 'off',  true)
set_config('zveltio.rls_bypass',        'on' | 'off',  true)
```

`role` travels as a variable rather than as a separate `SET LOCAL ROLE` — it is
a GUC like any other, and merging it saves a round trip: **0.230 ms → 0.175 ms**
for per-request preparation. The number is in the comment above the statement in
`lib/tenancy/tenant-manager.ts`.

### Why `zveltio.actor` is a flag of its own

This detail looks redundant and **is not**. A row rule has to distinguish two
situations: a request whose identity has an empty field, and background work
that has no identity at all. They cannot be read from the same setting:

```
after SET LOCAL + COMMIT   →  ''      the setting survives, EMPTIED
on a fresh connection      →  NULL
```

So `current_setting(x, true) IS NULL` means **"first request on a fresh
connection out of the pool"**, not "no identity". A security predicate built on
absence would depend on pool luck and would pass any test run against a cold
pool. `set_config(x, NULL, true)` does not unset either — it also leaves `''`.

**Do not propose "have the guard check for the absence of the GUC".** It was
measured; it does not work.

---

## 4. The policies, exactly as they are in the database

### Tenant isolation

On engine-generated collection tables:

```sql
CREATE POLICY tenant_isolation ON "zvd_<name>"
  USING       (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))
  WITH CHECK  (zveltio_tenant_write_ok(tenant_id));
ALTER TABLE "zvd_<name>" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "zvd_<name>" FORCE ROW LEVEL SECURITY;
```

Extension-owned tables carry the same pair. Many extension migrations write
`zveltio_tenant_scope_ok(tenant_id)` in both clauses; the engine rewrites every
`tenant_isolation_*` policy to the form above after each extension migration
run and again at boot, so the read predicate never stays in `WITH CHECK`.

**`FORCE` is not decorative.** Without it, the table owner bypasses its own
policies.

**The `(SELECT …)` wrapper is not style.** A bare `current_setting()` in a
predicate is evaluated **per row**; wrapped, it becomes an InitPlan and is
evaluated once. Measured: a threefold difference. A predicate without it is a
real regression.

### Read and write are DELIBERATELY different

```
read : tenant_id ∈ zveltio_visible_tenants()   — may be a whole subtree
write: tenant_id  = zveltio.current_tenant     — the own node ONLY
```

A parent with `read_scope = 'subtree'` **reads** its children and **does not
write** into them. That is intentional: consolidation is a read operation. The
data belong to the subordinate, and a level above reads and approves rather than
correcting in someone else's place. Putting the read predicate back into
`WITH CHECK` would let a parent write into a child's rows.

### What a request can see — `zveltio_visible_tenants()`

```sql
CASE
  WHEN zveltio.visible_tenants is set    THEN that list
  WHEN zveltio.current_tenant is set     THEN [that tenant]
  WHEN zveltio.fail_closed_tenant = on   THEN []                 -- no rows
  ELSE [the default tenant]                                      -- fail-OPEN
END
```

**The last branch is the one to ask about.** With no context the predicate
resolves to the default tenant, so code that misses the context reads the
default tenant's data instead of nothing. `ZVELTIO_FAIL_CLOSED_TENANT=1` exists,
but it is **off by default**. That is a choice, not an oversight — but it is the
most attackable choice in the whole model, and an adversarial audit should
attack it first.

---

## 5. The hierarchy

`zv_tenants.parent_id`, an adjacency list, with an anti-cycle trigger that also
refuses depth beyond **64**. Units are closed, not deleted: `closed_at` +
`merged_into`. Deleting one is an explicit god operation, below.

A person's reach is `zv_tenant_users.read_scope`, with four values:

| `read_scope` | Sees |
|---|---|
| `self` | Only their own tenant |
| `list` | An explicit list of tenants |
| `subtree` | Their own tenant and everything below it |
| `org` | The whole organisation |

These are **grants, not filters**: someone with both `self` and `subtree` has
`subtree`. The ordering is in `zveltio_tenant_reach()` (migration 052). It is
resolved **once per request**, as the engine role, before the privilege
descent — because `zv_tenant_users` must be read in order to learn what may be
read. It costs no extra round trip: the call rides inside the statement that
publishes the GUCs and drops the role, with the role dropped last.

### Archiving and purging a tenant

`DELETE /api/tenants/:id`, god only, `mode` in the query or a JSON body:

- `mode=archive` sets `status = 'deleted'`. Nothing is removed and every request
  for the tenant is refused; `PATCH` back to `active` undoes it. Children are not
  archived with it — the answer lists them under `child_tenants`.
- `mode=purge&confirm=<slug>` is accepted only for an archived tenant with no
  child tenants (and no tenant merged into it). One transaction deletes the
  tenant's rows from every `public` table with a `tenant_id` column — engine,
  extension, collection and BYOD tables alike, junction tables through their
  cascading keys — drops the legacy `tenant_*` schemas older versions created
  for it (`tenant_<slug>`, and each environment's `tenant_<slug>_<env>` that its
  `schema_name` still names; a name another tenant's base or environment schema
  also spells is kept), then the tenant row. Media
  objects are deleted after the commit; a failure there is reported, not fatal.
  The purge owns that transaction: `/api/tenants` opens no request
  transaction, and `purgeTenant` refuses to join one — joined, its every-tenant
  reach and `rls_bypass=on` would outlive it, and a later rollback would bring
  back rows whose media objects were already gone.
  The default tenant can be neither archived nor purged.

The purge publishes every tenant's reach, as `withEveryTenant` does, so FORCE
RLS on a non-superuser owner does not hide the target's rows. It deletes only
`tenant_id = <target>` — never a child's or parent's — and refuses when another
tenant's row references one of the target's rows, since that key's `ON DELETE`
would change or delete it with RLS out of the way.

A purge keeps every `user` row: its members lose the membership and the grants
in its domain, not their account. `delete_users=true` (query or JSON body,
purge only) also deletes, through the same `deleteUser` as `DELETE
/api/users/:id` — sessions, API keys revoked, grants in every domain, a
`user.deleted` audit row — each member left with **no membership in any tenant
and no Casbin rule outside the purged domain**. A membership in an archived
tenant counts (archiving is reversible), and so does any grant: the default
tenant has no membership row, so a grant is what tells its users apart from an
empty account. Never deleted: the requester, god, an instance admin. It runs in
a transaction of its own after the purge's has committed, one savepoint per
user; the answer adds
`users: { deleted: [id], kept: [{ id, reason }], failed: [{ id, error }] }`,
`reason` one of `self`, `god`, `instance_admin`, `other_tenant`, `other_grants`.
A failed user has already lost their sessions and grants and keeps the row.

---

## 6. The TWO things called "RLS" — the largest source of confusion

Both independent audits so far arrived here, by different routes.

| | **Postgres RLS** | **Product row rules** |
|---|---|---|
| What it is | Policies on `tenant_id` | Rows in `zvd_rls_policies` |
| Written by | The engine, at collection creation | The tenant administrator, from the Studio |
| Example | "see only your organisation's rows" | "see only what you created" |
| Enforced by | Postgres | Postgres **and** the engine |

The second is a product layer that **compiles into** RESTRICTIVE Postgres
policies, alongside the engine-side filtering. The generated form:

```sql
CREATE POLICY zv_row_rules ON "zvd_<name>" AS RESTRICTIVE
  USING (<predicate>) WITH CHECK (<predicate>);
```

`RESTRICTIVE` combines with AND over the permissive tenant policy — so it cannot
widen anything, only narrow.

### The same rule is rendered in FOUR places

```
applyRlsFilters        Kysely WHERE, against the live table
buildRowRulePredicate  SQL text, as a RESTRICTIVE policy
matchesRlsFilters      JavaScript, in process, for realtime fan-out
rlsJsonConditions      SQL over jsonb snapshots, for `?as_of=`
```

The history matters to an auditor, because this is the defect class that has
occurred most often here:

- an independent audit found **7 divergences** among the first three; one was a
  leak — `neq` on a NULL column: absent from `/api/data`, **delivered over SSE**;
- the fourth was not compared against anything until 31 August 2026. Added to
  the differential suite, it produced **18 failures out of 56 on unchanged
  code**, twelve of which were the SAME leak, still live on `?as_of=`.

Both are re-checkable:
`bun test packages/engine/src/tests/harness/row-rules-four-interpreters.test.ts`
runs the matrix.

**That is why the four no longer decide anything.** The semantics live in one
place, `lib/tenancy/rule-operators.ts`, and each of the four renders it. The
`check-rule-interpreters` gate fails if a fifth hand-written reading appears.

Two rules from that file are worth reading before reporting anything about them,
because they are counter-intuitive and have been written wrongly more than once:

1. **Comparison is TEXTUAL.** A rule's value is always a string. On an integer
   column the engine sends the string and Postgres converts it, so `code = '5'`
   matches the row where code is 5. `5 === '5'` in JavaScript does not.
2. **A missing value ELIMINATES the row, on every operator, negatives included.**
   `NULL <> 'x'` is NULL, not TRUE, and a `WHERE` discards what it cannot
   confirm. In-memory code reasoning `undefined !== 'x'` **keeps** a row the
   database hides. That was the leak.

### When a rule is withdrawn — per source, not uniformly

`getRlsFilters` skips a rule **only** if the value resolves to `null`:

```
user_id     → user.id             ''  does NOT skip
user_email  → user.email ?? null  absent SKIPS
user_role   → user.role           ''  does NOT skip
static:VAL  → VAL
```

The generated policy must do the same, or the two layers say different things.
It did it wrongly until 31 August: it skipped on any empty setting, so a rule on
`user_role` — meaning **any** rule on role, because Better-Auth does not populate
`session.user.role` — had the engine hiding everything and the policy showing
everything. The policy was more permissive than the engine, on precisely the
layer that exists for the handler that forgot its filters.

### API keys

A key is not known when `tenantMiddleware` publishes identity — it is resolved
in the handler. `validateApiKey` publishes the actor itself, **not its callers**:
there are two callers, and the second (`routes/edge-functions.ts`) used the
result only as a boolean. A key can be exempted from row rules, per key
(`zv_api_keys.rls_bypass`), and the exemption is read from `zveltio.rls_bypass` —
a published decision, not a role-name comparison inside a predicate.

---

## 7. Extensions

Extensions load **at instance level**, in a single process. "Load the extension
only for tenant B" does not exist and is not a finding — per-tenant activation
is a gate at execution time, not a separate load.

`/ext/*` traffic goes through the **same** `tenantMiddleware`. Without it, an
extension handler using `ctx.reqDb(c)` would fall through to the global pool with
no GUC.

Extension code running in a worker uses the `zveltio_worker` role: `NOLOGIN`,
`NOSUPERUSER`, `NOBYPASSRLS`, with DML on the collection tables and, granted
when a worker extension loads, on that extension's own tables — its
`zv_<ext>_*` namespace and the `zvd_*` tables its migrations create — and an
explicit `REVOKE` on the authentication tables. Where the engine may create
roles (a superuser, or `CREATEROLE` with `ADMIN` on `zveltio_worker`), each
worker extension's tables go to a role of its own, a member of `zveltio_worker`,
and the bridge runs that extension's queries as it — so one worker extension
cannot reach another's tables even where the SQL analyzer is wrong. Otherwise
it is one role for every worker extension and the analyzer keeps them apart. The tenant is **injected by the host**,
not declared by the worker. Contaminated connections are closed rather than
returned to the pool.

An inline extension's `ctx.db` statement inside a tenant transaction runs as
that extension's own role, set before the statement and restored after it
(`lib/extensions/ext-db-role.ts`). It is `NOSUPERUSER`, `NOBYPASSRLS`, cannot
create objects, holds DML on that extension's own tables and
`EXTENSION_TABLE_GRANTS` only, and inherits from `zveltio_ext` what every
extension shares: the non-engine `zvd_*` tables and `USAGE` on the schema —
never `user` or a credential table. So SQL the extension SQL analyzer misreads
still cannot reach `zv_api_keys`, `zvd_permissions`, the tenants, or another
extension's tables. A table belongs to the extension with the longest matching
`zv_<ext>_` prefix: `a` does not own `zv_a_b_*` once `a/b` is installed. Role
names are `zveltio_ext_<name>_<hash>` (`zveltio_extb_…` for the `BYPASSRLS`
twin, `zveltio_wrk_…` for a worker extension), the hash covering the database
name, so two databases on one cluster never share one. Disabling an extension
revokes everything its roles hold; uninstalling drops them.
`scripts/bootstrap-db-role.sh` gives the engine role `CREATEROLE` and `ADMIN` on
`zveltio_ext` and `zveltio_worker` for exactly this — on PostgreSQL 18
`CREATEROLE` reaches only roles held with `ADMIN`, so it cannot grant
`zveltio_rls`, any `pg_*` role, `SUPERUSER`, `BYPASSRLS` or `CREATEDB`. Where the
engine may not create roles every inline extension shares `zveltio_ext` itself,
only the analyzer keeps one extension out of another's tables, and boot logs
one warning saying so. Outside a tenant
transaction (boot, cron, listeners) and through `ctx.adminDb`, each statement runs
in a short transaction of its own under the twin with the engine role's RLS
reach: the extension role plus `BYPASSRLS` (created only when the engine role is
a superuser or `BYPASSRLS`; `zveltio_ext_bypass` on the shared layout) or the
plain extension role. So background code sees the tenants it saw before, and nothing more of
the engine. Inside a joined `ctx.db.transaction()`,
`setAccessMode('read only')` makes that savepoint read-only.

None of the restricted roles (`zveltio_rls`, `zveltio_ext`, `zveltio_worker`,
`zveltio_flow_reader`) may create temporary objects. Postgres gives
`TEMPORARY` to `PUBLIC`, and a temp table is searched before `public` and
outlives the role window on a pooled connection, so one statement an analyzer
missed could plant a table the engine's next query on that connection reads or
writes as the engine role. At every boot the engine grants `TEMPORARY` to its
own role and revokes it from `PUBLIC` (`lib/tenancy/temp-privilege.ts`). That
needs the database owner — which `scripts/bootstrap-db-role.sh` makes the
engine role — or a superuser. On a database the engine does not own, the boot
log says so; run, as the owner:

```sql
GRANT TEMPORARY ON DATABASE <db> TO <engine role>;
REVOKE TEMPORARY ON DATABASE <db> FROM PUBLIC;
```

Until then the worker bridge discards temp objects before it returns a
connection to the pool. Other login roles on the same database (reporting,
backup) lose `TEMPORARY` too; grant it back to them by name if they need it.

A boot reconciler rewrites every extension-owned tenant table onto the host
predicate, which makes tenant isolation something the host guarantees rather
than something every extension author has to get right.

---

## 8. What the model is NOT — corrections for frequent assumptions

- **It is not schema-per-tenant, nor schema-per-environment.** Creating a
  tenant or an environment makes no `tenant_<slug>` or `tenant_<slug>_<env>`
  schema any more: nothing ever read one (no route, no `search_path`), and the
  request no longer carries a `tenantSchema`. An environment is a row in
  `zv_environments` whose `schema_name` is NULL (since migration 043; the API's
  `schema` field is kept and answers `null`). Installs from before keep their
  schemas, untouched, until the tenant is purged. The schema that is used,
  through `search_path`, is a schema branch's preview (`branch_*`,
  `middleware/preview-env.ts`).
- **It is not database-per-tenant.**
- **`enableRLS` and `applyTenantRLS` are not dead duplicates** — both are called,
  from different places (`routes/tenants.ts`, `lib/data/ddl-queue.ts`). They now
  emit the same predicate; they did not always, and that divergence was a real
  finding.
- **`tenantDbMiddleware` really is defined and unmounted**
  (`middleware/tenant-guard.ts`). That observation is correct.
- **The header is `x-tenant-slug`**, not `x-tenant-id`. An `x-tenant-id` used as
  a source of truth **is** a defect; one was found and fixed in extension
  installation.
- **God is not checked by role name inside a predicate.** It was, it was dead
  code, and it is a permission now (`data:view_all`). A comparison against
  `'god'` in a predicate would be a real regression — but check it, do not assume
  it.
- **Collection tables have no foreign key on `tenant_id`.** Correct, and
  deliberate.
- **`zv_mail_oauth_states` has a primary key on `state` with no `tenant_id`.**
  Legitimate: it is an anti-CSRF nonce, and the OAuth provider returns only that,
  without knowing the tenant. The row carries `tenant_id` and the table has
  `FORCE RLS`.

---

## 9. Where the invariants live — as tests, not as documentation

```
tests/harness/row-rules-four-interpreters.test.ts   one rule, four renderings, the whole matrix
tests/unit/rule-operators-single-source.test.ts     each rendering really reads the table
tests/harness/row-rules-in-database.test.ts         rules apply with the WHERE deliberately FORGOTTEN
tests/harness/god-enforced-by-database.test.ts      god passes THROUGH the policies, not around them
tests/harness/second-reservation.test.ts            no request takes a second connection
tests/harness/unique-keys-tenant-scoped.test.ts     no unique key without tenant_id
tests/harness/*tenant-isolation*.test.ts            per table and per route
tests/harness/tenant-isolation-doors.test.ts        every door, in one table — see tenant-isolation.md
tests/harness/tenant-purge.test.ts                  a purge leaves no row of the tenant, and every other tenant's
tests/harness/tenant-purge-users.test.ts            delete_users removes only the members left with nothing
```

The claims worth trying to break:

1. A request from tenant A cannot read and cannot write tenant B's rows —
   **not even if the handler forgets its filters entirely**.
2. There is **exactly one** `god` per instance, and it sees across tenants
   **through** the policies, not by stepping outside them.
3. A row rule means **exactly the same thing** in all four renderings.
4. A request holds **one** connection.
5. An extension disabled for tenant B **does not act** for B, on any of the paths
   by which it can act.
6. What cannot be expressed in the database is **not half-enforced** — either
   fully or not at all, and it says which.

---

## 10. How to verify what this document says

```bash
DB=zv_$(date +%H%M)
psql -U postgres -h localhost -d postgres -c "CREATE DATABASE $DB"
psql -U postgres -h localhost -d $DB -c "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS vector;"

export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/$DB
export ZVELTIO_REGISTRATION_ENABLED=1     # without it, ~240 tests fail for an unrelated reason

bun test packages/engine/src/tests/harness
bun run audit:gates                        # every gate, proved by planting a violation
```

**A VIRGIN database, created in the current session.** This is not hygiene, it is
the condition for the numbers to mean anything. Measured, on the same code
revision:

| Database | Result | Duration |
|---|---|---|
| Used, 10,933 accumulated users | 907 pass / **108 fail** | 783 s |
| Created that morning | 1025 pass / **0 fail** | **58 s** |

The 108 are mass `403`s on the data routes — **they look exactly like an
authorization regression**. They were not. The second signal is as good: thirteen
times slower.

And **before any long run**: `pgrep -af "bun test packages"`. A run left over
from an earlier session holds the database and corrupts everything measured after
it, without saying anything.
