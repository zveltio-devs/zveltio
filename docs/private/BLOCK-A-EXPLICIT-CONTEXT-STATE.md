# State — Block A: tenant context becomes explicit

> **Read at the start of every step. Update after every step.**
> Branch: `block-a/explicit-context` · Plan: `MATURITY-REFACTOR-PLAN.md` §Block A.
> Order C → B → F → **A**, chosen by **what happens if we get it wrong**.
> C closed at 3 of 4, B at 4 of 4, F at 3 of 4 plus one cancelled — **none of them
> with the criteria rewritten after the numbers were seen.**

---

## Why it is last, and why it is the most dangerous

It is **the only block that can break isolation silently.** C and B were done
first precisely so that a mistake here becomes noisy instead of invisible:

- a **synchronous** `finally` once emptied the transaction early and left **302
  policies inert, with the tests green**;
- `zveltio_rls` was once left with 11 tables out of 378, and the green came from
  `NODE_ENV=test`.

Both happened in this code. This block walks the same ground.

## The problem, as the plan describes it

`registerCoreRoutes(app, { db: scopedDb, poolDb: db, auth })`. That `scopedDb` is
a `Proxy` whose `get` reads `getCurrentTenantTrx()` **on every property access**.
A `Proxy.get` is **synchronous** — it cannot await opening a transaction. From
there, in a chain: the transaction opens before the handler, is held for the
whole request, pins a pool connection, and at `DB_POOL_MAX` concurrency stalls.

---

## Validation-point criteria — WRITTEN BEFORE MEASURING

1. **The concurrency ceiling has moved, measured at the same `DB_POOL_MAX`** —
   same database, same route, same load. Not "feels faster": p95 at concurrency
   above the pool.
2. **No isolation regression.** The full suite green AND a probe showing that a
   request with no tenant context **cannot** read tenant data.
3. **Any missed site is a compile error**, not a runtime leak — that is the
   difference between this refactor and the two incidents above.
4. **The SDK contract stays valid** for existing extensions, or has a written
   transition period.

**STOP CRITERION, written now:** if **step 1** shows the ceiling **does not
move** — that the time a connection is held for nothing is small against the
request's duration — the block closes there. The remaining steps are not done.
The plan says this explicitly, and it is the only block that was given, in
advance, the right to stop at the first measurement.

**What is NOT a criterion:** elegance. An explicit `db` is more verbose; that is
an argument neither for nor against.

---

## Steps

| # | Step | State | Result |
|---|---|---|---|
| 0 | Read this document | — | (at every step) |
| 1 | **Measure** how long a connection is actually held on a real request, against how long it would be with short transactions | ✅ **DONE** | the ceiling is real; the gain is ~2.3×, **not "it disappears"** |
| 2 | Inventory | ✅ | **89 sites — but the inventory is NOT the fix. See below.** |
| 3 | The explicit accessor, `async`, so TypeScript catches missed sites | TO DO | — |
| 4 | Gate: no query on tenant data outside the transaction | TO DO | — |
| 5 | Migrate the core routes, in batches of ~10, suite green between them | TO DO | — |
| 6 | The SDK contract for extensions, with a transition | TO DO | — |
| 7 | **VALIDATION POINT** | TO DO | — |

---

## The measurement (step 1, 2026-08-30)

Live engine on `:3400`, a 50,000-row collection,
`/api/data/benchrows?limit=25`, real load over HTTP with a god session. Samples
from `pg_stat_activity` during the load.

### The ceiling exists, is exactly at `DB_POOL_MAX`, and above it the service STOPS

| `DB_POOL_MAX` | c | requests | errors | p95 | pool states |
|---:|---:|---:|---:|---:|---|
| 10 | 5 | 2,146 | 0 | 19.6 ms | `idle in transaction×4` |
| 10 | **10** | **10** | **10** | **9,724 ms** | **`idle in transaction×10`, `active×1`** |
| 10 | 15 / 20 / 30 | = c | all | ~11,975 ms | identical |
| 25 | 20 | 2,603 | 0 | 59.6 ms | — |
| 25 | **25** | **25** | **25** | **10,489 ms** | — |

This is not degradation, it is a stall: at `c = DB_POOL_MAX` every connection is
held `idle in transaction` and **exactly one is working**. The engine refuses
rather than waits (the `pool_busy` guard, from the transaction-boundary work), so
it answers with an error instead of hanging — but it answers with an error.

**The ceiling moves linearly with `DB_POOL_MAX`, and with nothing else.**

### How much of the held time is real work

Twenty samples during a load at c=5, `DB_POOL_MAX=10`:

| | connections |
|---|---:|
| `active` — real work | **2.20** |
| `idle in transaction` — held for nothing | **2.85** |
| **fraction of real work** | **44%** |

### What it means, and why it corrects the plan

The plan says that, with short transactions, **"the concurrency ceiling
disappears, because a connection is held for microseconds, not milliseconds"**.
The measurement does not support that.

56% of the time a connection is held is spent `idle in transaction`. With short
transactions, capacity at the same pool would rise by roughly **1 / 0.44 ≈ 2.3×**
— from c≈10 to c≈23 on a pool of 10. Real, but **not unbounded**, and not
"disappears".

**A reservation about my own figure:** 44% comes from a load below saturation, on
a simple route (a 25-row listing) with a local database. A request doing more
work per call would shift the ratio in either direction. The number is an order
of magnitude, not a promise.

### The cheap alternative, measured alongside

`DB_POOL_MAX` moves the same ceiling, linearly, **with no code change at all**:
from 10 to 25 the ceiling rises from c=10 to c=25. It is bounded by
`max_connections / instances`, and it is precisely the owner decision in
§Block E.

So the question is not "is it worth moving the ceiling" — it is **"is it worth
moving it by 2.3× through the riskiest refactor in the plan, when one line of
configuration moves it linearly"**. That is an owner decision, not an engineering
one, and the block stops here until it is taken.

**The stop criterion did NOT trigger literally** — 56% is not "small". But the
figure is far enough from the plan's promise that I will not open steps 2–7
without the owner seeing the comparison.

## The chosen variant: 3 — configuration now, the refactor when it is no longer enough

The owner chose to raise the ceiling through `DB_POOL_MAX` first, and to leave
Block A for when the raised ceiling stops being enough. The two are not mutually
exclusive, and the first is free.

**And there was nothing to build.** The lever is already exposed, measured and
guarded: `reportConcurrencyCeiling` prints the arithmetic at every boot — what
ceiling you have, what the server allows, how many instances fit — suggests a
value that still leaves room for four instances, and warns when fewer than two
fit. The default is **deliberately not raised**, with the reason written down: a
default is inherited by every installation, including those with several engines
on one Postgres, where 25 each has already exhausted it. Raising it is an
operator decision taken against a `max_connections` they have checked.

I also verified that `scripts/bench-concurrency.ts`, which the guard points at,
**exists** — a recommendation pointing at a non-existent script is exactly the
`dr-drill.sh` class.

### What I did find, and it is real

**The code builds a pool of 25. The public documentation said 10.**

`DEFAULT_DB_POOL_MAX = 25` in `db/index.ts`, but
`docs/platform/configuration.md` documented the default as `10`. An operator
sizing `max_connections` from the documentation budgets 10 per instance and gets
25 — two and a half times more connections than planned. The second instance
fails with *"sorry, too many clients already"*, exactly the warning the boot
guard prints.

It is the **third spelling of the same number**. The first two were already
reconciled, by a test written for exactly this —
`pool-max-single-source.test.ts`, which exists because `initDatabase` built with
`?? 25` while `startup-guards.ts` reasoned with `?? 10`. The test guarded the
code; the copy a **human** reads was left out.

Fixed, and added to that same test — proved by reverting: with `10` in the
documentation it fails, with `25` it passes.

## The small step, done: falling back to the pool becomes visible

The owner's question that produced this step: *"if it escapes the engine and
PgDog, doesn't RLS come in and protect?"* Measured on the same table, with
`FORCE ROW LEVEL SECURITY` and the production policy:

```
raw pool, postgres role              : 2 rows — A+B    ← RLS does NOT protect
tenant transaction, zveltio_rls role : 1 row  — A      ← RLS protects
```

**RLS is real and it works, but it is ARMED by the transaction.** The engine
connects as `postgres` — `rolsuper=true`, `rolbypassrls=true` — and a superuser
always bypasses RLS. The protection comes from `SET LOCAL ROLE zveltio_rls`,
which descends privileges, and that `SET LOCAL` lives exactly in the transaction
that `?? pool` skips. There is no second line of defence there; **it is the same
line.**

That is why "open the transaction later" was never a small change: the mistake
is invisible.

### What was built

A counter in `createRequestScopedDb`, with `ZVELTIO_STRICT_TENANT_SCOPE=1` for
anyone who wants it loud. By default it **changes no production behaviour** — it
ships as a diagnostic, and throwing here on a legitimate boot call would put an
installation on the floor.

Plus `unscoped-fallback.test.ts`: it drives real requests through the real
application and requires the number to stay zero. The second case produces a
fallback **deliberately**, so that a zero cannot be a counter that never moves.

### The first version was too coarse, and the instrument said so itself

On its first run it reported **two fallbacks** in three ordinary requests. They
were not leaks:

| Site | Table |
|---|---|
| `middleware/rate-limit.ts:23` | `zv_rate_limit_configs` |
| `ddl-manager.getCollections` | `zvd_collections` |
| `routes/tenants.ts:80` | `zv_tenants` |

**All three are instance-level** — exactly the classification Block B
established and verified 362/362. A counter that cannot tell a shared table from
a tenant one reports correct code as a leak, and that is how a gate ends up
switched off.

Fixed: the counter now knows the boundary, read from `information_schema` at
boot — after the extension migrations, where tables acquire their `tenant_id`.
**Not a generated list**: the answer is derivable from the database itself, so
there is nothing to go stale.

So Block B did not merely classify the boundary — it made possible the
instrument that defends it at runtime. The order C → B → F → A paid for itself
here.

## The administration model — requested by the owner, 2026-08-30

**One superadmin per instance (`god`), who installs the extensions.
Administrators per tenant, who manage only their own. And when god creates a
tenant, they must be forced to create its administrator too.**

### What it was, measured

`requireInstanceAdmin` = god **OR** an admin of the default tenant. The second
arm is right for most instance operations and wrong for installation: it puts
**new code** on the instance, and an extension's migrations can alter engine
tables — the `ai` extension adds three columns to `zvd_collections`, measured
today. In a holding company, the default tenant is the parent company, so its
administrator would decide what code runs at the subsidiaries.

**Done:** ten operations that change the instance — install, enable, enable-all,
disable, config, uninstall, capability approval, plus the three licence ones —
move from `requireInstanceAdmin` to `isGodUser`. The two **read** routes stay on
admin: seeing what could be installed harms nothing, and withdrawing them would
empty the Studio page.

Consequence, stated rather than discovered: **an instance with no god can no
longer install anything** until `zveltio create-god`. That is the requested
shape, not an oversight.

### Per-tenant activation: it was IMPOSSIBLE, not merely unimplemented

Migration `070` added `zv_extension_registry.tenant_id` with the comment *"NULL =
instance, set = that tenant only"*, plus two indexes, and the marketplace listing
respected it. **But `UNIQUE (name)` on the same table means an extension has
exactly one row** — and `onConflict` is on `name`, so every install overwrites
the tenant. Proved:

```
INSERT ai for tenant-A  → ok
INSERT ai for tenant-B  → ERROR: duplicate key ... Key (name)=(ai) already exists
```

So `tenant_id` could only record **who installed last**. The loader, which
ignored it, happened to have the only correct behaviour — and the listing showed
one tenant an extension as absent while its code ran for everybody.

**Done:** the listing now reports what the runtime does — active if **any** of
its rows is active. The column and indexes stay, with the explanation beside
them.

**What real per-tenant activation would require**, now that it is known: the
unique key widened from `(name)` to `(tenant_id, name)` — the
`005_tenant_scoped_unique_keys` campaign — **plus** per-request gating, because
extensions register their routes and hooks in a single process. It is not a
filter on a load query.

### A tenant can no longer be created without its administrator

`admin_user_email` was validated as an **email format**, never as an existing
user. A typo produced a tenant with no membership and no Casbin role — and a
**201** saying it had worked. The route's comment described exactly this as the
failure to avoid:

> *"A tenant row with no membership is a tenant NOBODY can reach… only an
> instance admin querying the table directly would ever find out it exists."*

The intent was written down; the code did the opposite.

**Fixed**, with a trap along the way worth keeping: the first version returned a
value from the transaction, so **the tenant stayed written** — `return` from a
transaction COMMITS, exactly the lesson of the atomic-writes campaign. The test
caught it because it checks the table, not just the status code. It now throws,
so it rolls back.

## What is NOT touched

- **The RLS policy, the predicate's shape, the boundary classification.** B and F
  closed those.
- **The engine's connection role.** Measured and decided not to change.
- **The tenant hierarchy.** Separate work, uncommitted.

---

## Log

| When | Step | What happened |
|---|---|---|
| 2026-08-30 | model | Extension installation moves to **god** (10 operations); reading stays on admin. **Per-tenant activation was IMPOSSIBLE** — `UNIQUE (name)` on the registry, proved; the listing now tells the truth. **A tenant can no longer be created without its administrator** — `admin_user_email` was only format-validated. The first fix left the tenant written (`return` from a transaction commits); fixed by throwing. |
| 2026-08-30 | small step | Measured that **RLS does not protect on the fallback path**: the engine is a superuser, `rolbypassrls=true`; 2 rows on the raw pool against 1 inside the transaction. Counter + strict mode + a test over real requests. **The first version reported 2 fallbacks that were correct code** on instance tables — fixed using Block B's boundary, read from `information_schema` at boot. |
| 2026-08-30 | decision | Variant 3 chosen by the owner: configuration now, refactor later. **Nothing to build** — the lever is already exposed and guarded by `reportConcurrencyCeiling`, and the script it points at exists. **But the public documentation said `10` where the code builds `25`** — the third spelling of a number whose first two had already been reconciled by a test. Fixed and added to that test, proved by reverting. |
| 2026-08-30 | 1 | **The ceiling is real and exactly at `DB_POOL_MAX`** — at c=pool the service stalls, with every connection `idle in transaction` and one active; verified at pool 10 and 25. **But only 56% of the held time is wasted**, so short transactions would give ~2.3×, not "the ceiling disappears" as the plan says. `DB_POOL_MAX` moves the same ceiling linearly, with no code. **The block stops at step 1 pending the owner's decision.** |
| 2026-08-30 | setup | Document written, criteria fixed BEFORE measuring. Step 1 has the declared right to close the block. |

---

## Context that must not be rediscovered

- **The reference measurement that already exists:** `/api/insights` stalled at
  `c = DB_POOL_MAX` — 10 connections `idle in transaction`, 0 `active`. Fixed by
  moving the routes onto `poolDb`. So that path is already out of the
  transaction; this block is about the rest.
- **Do not stop engines with `pkill -f`** — use the PID. `/opt/zveltio` (`:3000`)
  and other people's sessions run on the same machine. My port is `:3400`.
- **The reference database:** engine schema + the **UP halves** of the extension
  migrations (`awk '/^-- DOWN[[:space:]]*$/{exit}'`). 81 migrations have a DOWN
  section; `psql -f` on the whole file creates the tables and then drops them,
  with `rc=0`.
- **Env without which the tests lie:** `ZVELTIO_REGISTRATION_ENABLED=1`,
  `FIELD_ENCRYPTION_KEY=<64 hex>`, `TEST_PORT`, `TEST_DATABASE_URL`, on separate
  lines.

---

## Step 2 — the inventory, and why the plan was measuring the wrong thing (2026-08-30)

The inventory the step asked for exists: **89 sites** — 46 `reqDb(`, 18
`c.get('tenantTrx')`, 9 `getCurrentTenantTrx()`, 16 `?? db` fallbacks. That would
be the refactor.

Before starting it, I measured **what actually happens during the time the
connection is held**, because the plan says the transaction is held too long.

### It is not held long

Temporary instrumentation on the transaction boundary, real load over HTTP:

| | total in transaction | to the first query | after the last | queries |
|---|---:|---:|---:|---:|
| warm listing | **1.59 ms** | 0.39 ms | 0.05 ms | 9 |
| cold listing | 10.39 ms | 1.32 ms | 0.10 ms | 34 |

**There is almost nothing to cut at the edges.** A 1.6 ms transaction does not
explain a ceiling.

### What it actually is: **the second reservation**

A single request, with no concurrency at all:

```
DB_POOL_MAX=1   GET /api/data/spanrows?limit=25   → no response, 8.85 s, cut off
DB_POOL_MAX=2   the same request                  → 200 in 62 ms
```

**One request needs two connections at once.** It holds one for the tenant
transaction and asks the pool for another — `checkAccess`, `getColumnAccess`,
`DDLManager.getCollection`, `getVirtualConfig`: six sites in `list.ts` alone, all
on `db`, meaning on the pool. They are there for a real reason: inside the
transaction the session runs as `zveltio_rls`, which cannot read what they need.

**This explains exactly the shape of the step-1 measurement**, which is otherwise
strange: the collapse is at `c = pool`, not at `c = pool / 2`. Below the ceiling
there is always a free connection that can serve the second request; **at the
ceiling every connection is held by a transaction whose owner is waiting for a
second one that can never come.** That is why you see
`idle in transaction × 10, active × 1` — and why the service stops rather than
slows.

### What it means for the block

The plan proposed a refactor across 89 sites in order to shorten the
transactions. **The measurement says the transactions are not the problem.** The
fix is different and smaller: **a request must not ask the pool for a second
connection while it holds one.** Either the metadata is read BEFORE opening the
transaction — the pattern already exists in the code, `sessionPrefetch` does
exactly this, with a comment explaining why — or the `zveltio_rls` role is
granted read access on the metadata tables, so the reads fit inside the
transaction.

### The detector that lied — and what one that does not looks like

The first form of the check started the engine with `DB_POOL_MAX=1` and declared
guilty any route that did not answer. It named ten. **The same ten then answered
200, still at pool 1, on an engine started by hand with the same environment** —
because between probes the engine's background writes hold the single
connection, and a request that needs only its own transaction still times out
waiting for it.

The check was measuring the engine's chatter, not the property. And, worse, **it
went on naming routes after they had been fixed** — the worst thing a gate can
do. It was thrown away.

What remains counts the property where it happens: the pool driver counts every
connection taken **while the request already holds the transaction**, and the
tenant middleware reports the number in the `x-zveltio-extra-connections`
header. Nothing depends on timing, on saturation, or on what the engine does in
the background. It lives in the harness, in process, as a test —
`second-reservation.test.ts`.

### The fixes, and what they brought to light

`scripts/check-second-reservation.ts` starts the engine with `DB_POOL_MAX=1` and
asks every route the one thing that cannot be argued with: **can you answer with
a single connection?**

| Answer | Do not answer |
|---|---|
| `/api/health`, `/api/collections`, `/api/me`, `/api/dashboards` | `/api/webhooks`, `/api/saved-queries`, `/api/notifications`, `/api/revisions`, `/api/flows`, `/api/settings`, `/api/users`, `/api/api-keys`, `/api/tenants`, `/api/audit` |

**10 out of 14.** Four routes are already on the right side, so the pattern is
achievable — it is not an architectural limit.

It is a **ratchet, not a gate**: the list may shrink, never grow. Proved in both
directions by planting (removing a route from the threshold ⇒ rc=1).

---

## What comes next in Block A

Steps 3–6 of the plan (explicit accessor, gate, route migration, SDK contract)
**are no longer the right shape for the work.** What remains, in the order it can
be verified:

1. For each of the 10 routes, move the metadata read before the transaction
   **or** into it — and lower the threshold with each one.
2. `DB_POOL_MAX` raised to 40 (delivered in Block E) **does not fix this** — it
   moves the ceiling from 25 to 40 simultaneous requests, but a request still
   asks for two connections.

## Log

| When | Step | What happened |
|---|---|---|
| 2026-08-30 | 2 | The requested inventory exists (89 sites), but the measurement showed it is not the fix: the transaction is held 1.59 ms, and a request needs TWO connections. A ratchet with 10 routes, proved by planting. |
