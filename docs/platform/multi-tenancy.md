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
creates the database, creates `zveltio_app` as `NOSUPERUSER NOBYPASSRLS`,
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

On extension-owned tables the equivalent form is
`zveltio_tenant_scope_ok(tenant_id)`.

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
refuses depth beyond **64**. Units are not deleted: `closed_at` + `merged_into`.

A person's reach is `zv_tenant_users.read_scope`, with four values:

| `read_scope` | Sees |
|---|---|
| `self` | Only their own tenant |
| `list` | An explicit list of tenants |
| `subtree` | Their own tenant and everything below it |
| `org` | The whole organisation |

These are **grants, not filters**: someone with both `self` and `subtree` has
`subtree`. The ordering is `REACH_ORDER` in `lib/tenancy/tenant-scope.ts`. It is
resolved **once per request**, as the engine role, before the privilege
descent — because `zv_tenant_users` must be read in order to learn what may be
read.

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
`NOSUPERUSER`, `NOBYPASSRLS`, with grants only on `zvd_*` and an explicit
`REVOKE` on the authentication tables. The tenant is **injected by the host**,
not declared by the worker. Contaminated connections are closed rather than
returned to the pool.

Extensions install their own isolation from a copied `002_tenant_rls.sql`, and
all of those copies were fail-open — no tenant context meant every tenant's rows,
where the engine's own tables meant none. A boot reconciler rewrites every
extension-owned tenant table onto the host predicate, which makes tenant
isolation something the host guarantees rather than something every extension
author has to get right.

---

## 8. What the model is NOT — corrections for frequent assumptions

- **It is not schema-per-tenant.** `provisionTenantSchema` **exists and is
  called** (`routes/tenants.ts`), but a per-tenant schema is not the isolation
  mechanism. "It is dead code" is **wrong**; "it is not the isolation path" is
  right.
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

## 9. Leads already measured as false — do not report them as discoveries

Each has already cost someone time.

- **"RLS policies cannot use the index"** — FALSE. This was got wrong twice, in
  opposite directions. The predicate's shape decides: `= ANY(array)` does not
  drive an ordered scan, explicit equality does. **415 → 204 → 129 ms**, measured.
- **`broadcastSSE` is dead code** — it is not. **"mail iframe XSS"** — false.
- **`session.user.role` is empty** — true, it is not declared in Better-Auth.
  Code relying on it is dead, not dangerous. **But** see §6: a rule on
  `user_role` falls into that case, which was a real defect.
- **Twilio, PostGIS authz** — fixed. **Sessions on user deletion, Valkey,
  webhook DLQ** — closed.
- **"The engine MUST be a superuser"** — FALSE, and it is the mistake the first
  version of this document made. See §0.1: the role descent works through
  membership, and the documented production installation runs as a plain role.
  What is true is that the stock Postgres image connects as a superuser, so an
  unconfigured installation really is in that state — and the engine refuses to
  boot that way in production.

---

## 10. Where the invariants live — as tests, not as documentation

```
tests/harness/row-rules-four-interpreters.test.ts   one rule, four renderings, the whole matrix
tests/unit/rule-operators-single-source.test.ts     each rendering really reads the table
tests/harness/row-rules-in-database.test.ts         rules apply with the WHERE deliberately FORGOTTEN
tests/harness/god-enforced-by-database.test.ts      god passes THROUGH the policies, not around them
tests/harness/second-reservation.test.ts            no request takes a second connection
tests/harness/unique-keys-tenant-scoped.test.ts     no unique key without tenant_id
tests/harness/*tenant-isolation*.test.ts            per table and per route
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

## 11. How to verify what this document says

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

### What is wanted back from an audit

For each finding, mark explicitly:

- **EXECUTED** — I ran this and saw the result; or
- **READ** — I am inferring from code, I did not run it.

Both are useful. Confused with each other, they are not. And **say what you
checked and found sound**, especially from the list in §10 — an audit that
reports only problems does not say how much of the surface was touched.

If something looks wrong but tests cover it, **read the test** before reporting:
the test may be the wrong one, and that is a better finding. It happened twice on
31 August.
