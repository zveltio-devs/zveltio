# State — Block J: the second line of defence lives in the database

> **Read at the start of every step. Update after every step.**
> Branch: `block-j/db-second-line`, off master.
> Method: criteria written BEFORE measuring; a block is allowed to close with
> "not worth it". C 4/4, B 4/4, D 4/4 ("not worth it"), E decided, F 3/4, G 4/4,
> H 4/4, A at step 2.

---

## What the owner asked for, in their words

> "The god user has to be in the database too. The first line of defence is the
> engine, and the second has to be RLS in the database. And one more thing:
> **the same must hold for every user**. The engine filters and sets policies,
> but there must also be a guard on the database."

That is two requests, not one, and the second is far larger than the first.

---

## What is true today — measured, not assumed

| | Where it is defended |
|---|---|
| tenant isolation (`tenant_id`) | **in the database too** — `FORCE RLS` policies reading `zveltio_visible_tenants()` from session variables |
| who is god | **engine only** — `user.role = 'god'`, read by `isGodUser`; no policy knows about it |
| the product's row rules (`zvd_rls_policies`) | **engine only** — `applyRlsFilters` adds a `WHERE`; the database does not know the rule exists |

And the way god sees everything today is **by leaving RLS**: the routes that
need it get `poolDb`, and the pool connects as `postgres`, a superuser with
`rolbypassrls`. So the privilege is not expressed — it is a side door.

**And nothing enforces a single god.** The requested model ("exactly one per
instance") is defended nowhere: `user.role` accepts `'god'` on any number of
rows.

---

## Why the second request is the hard one

A row rule is a row in `zvd_rls_policies`: one field, one of four operators, one
of four value sources. For the **database** to apply it, it needs the caller's
identity in session variables — that part is cheap. The expensive part is the
shape of the predicate: rules are **dynamic**, an admin changes them at runtime.

Two forms, both with a cost that must be measured, not guessed:

1. **Generated policies** — the engine emits `CREATE POLICY` on every rule
   change. Simple predicate, good plan, but DDL on an administration path and a
   lot of policies to maintain.
2. **One generic policy** that consults `zvd_rls_policies` at query time through
   a function. Zero DDL, but a function per row — and this project has already
   written down the lesson that the shape of an RLS predicate moved a timing
   from 415 to 204 ms.

---

## Validation-point criteria — WRITTEN BEFORE MEASURING

1. **God is expressed in the database, not through a side door.** Proved by
   planting: a request that skips the engine check still cannot read another
   tenant's rows, and a god's request can — without going out over the superuser
   connection.
2. **The plan cost is MEASURED on a populated table**, for both paths: the
   ordinary caller and god. Written in numbers, not adjectives.
3. **One god per instance, enforced by the database.**
4. **Row rules: either enforced in the database at a measured cost, or a written
   reason** why not, naming what would have to change to make it possible.
   "Stays in the engine" is a valid outcome if it is defended with numbers.

**STOP CRITERION:** if the god clause costs the ORDINARY path more than **10%**
of a paginated listing, it does not ship in that form. The cost would be paid by
every request in order to defend a rare case, and that is a bad trade however
elegant the idea.

**What is NOT a criterion:** removing the engine's checks. The first line stays
the first line; this adds a second.

---

## Steps

| # | Step | State | Result |
|---|---|---|---|
| 0 | Read this document | — | (at every step) |
| 1 | **Measure** the cost of the god clause on the existing predicate | ✅ | three forms measured; **the elegant one costs 7×** |
| 2 | Measure the two forms for row rules | ✅ | **13.2 ms against 0.98 ms** — decisive |
| 3 | Decide the form, in writing, from the numbers | ✅ | god: published by the engine; rules: generated policies |
| 4 | God in the database + one god, enforced | ✅ | zero cost on the ordinary path |
| 5 | Row rules — implemented or refused with a reason | ⬜ **REMAINS** | measured and decided, not implemented |
| 6 | **VALIDATION POINT** | ⚠️ **3 of 4** | criterion 4 is unmet, and I am not rewriting it |

---

## Log

| When | Step | What happened |
|---|---|---|
| 2026-08-31 | setup | Criteria fixed BEFORE. A numeric stop criterion (10% on the ordinary path), because the temptation here is to make everyone pay for a rare case. |

---

## Context that must not be rediscovered

- **The shape of the predicate decides the plan.** 415 → 204 ms from the
  wrapper alone, and the scalar form reaches 129. "Policies cannot use the
  index" is FALSE — it was got wrong twice, in opposite directions.
- The engine connects as `postgres` (bypasses RLS) and issues
  `SET LOCAL ROLE zveltio_rls` inside the request transaction. That is where
  policies apply.
- `zveltio_visible_tenants()` reads `zveltio.visible_tenants`, then
  `zveltio.current_tenant`, then `zveltio.fail_closed_tenant`.
- `DEFAULT false` on an overload breaks every policy at runtime — already hit.
- A database per session; `zveltio_test` has a divergent migration chain.

---

## Step 1 — the cost of the god clause, measured (2026-08-31)

Own database, 400,000 rows across two real tenants, composite index
`(tenant_id, created_at DESC)`, paginated listing of 25. Medians of 9 runs.

| Form | Ordinary path |
|---|---:|
| as it is today | **0.060 ms** |
| `OR zveltio_is_god()` in front, in every policy | 0.066 ms |
| `... OR (SELECT zveltio_is_god())` at the end | 0.068 ms |
| **`zveltio_visible_tenants()` taught to expand to all tenants** | **0.434 ms** |

The last is the **elegant** form — one function changed, 300+ policies inherit
it, no migration over policies. **It costs seven times as much.** The cause: the
`ARRAY(SELECT id FROM zv_tenants)` subquery makes the function non-inlineable,
so it is no longer folded once at plan time but genuinely called. Checked also
with the variable read directly, with no nested call: 0.428 ms. The call was not
the problem, the subquery was.

**The stop criterion (10% on a listing) rejects it.** It would have been easy to
ship and hard to notice: 0.37 ms extra on every request of every tenant, to
defend a rare case.

### The chosen form: the engine publishes, the database enforces

It costs **zero**, because it changes nothing on the ordinary path: the engine
was already writing `zveltio.visible_tenants` on every request, in a single
round trip with the other three variables. For a god it writes every tenant.

What this buys: god **no longer leaves** RLS via `poolDb`. Until now their
privilege was expressed nowhere — it was a **side door around** the thing that
expresses privileges, and a handler that forgot its check on that connection
read every tenant's rows with nothing downstream able to notice.

What it does **not** buy, stated plainly: the decision "who is god" stays the
engine's. The database receives an identity assertion, it does not authenticate
it — that is how RLS with application users always works. What changed is that
**the database enforces the boundary**, by the same path as for everyone else.

---

## Step 2 — row rules, measured

Rule: `created_by eq user_id`. Two forms, same data.

| | application adds the filter (normal path) | **application FORGOT the filter** |
|---|---:|---:|
| no rule in the database | 6.53 ms | **0.068 ms — and it LEAKS** |
| generated policies (simple predicate) | 6.17 ms | **0.983 ms** |
| one generic policy, per-row function | 7.61 ms | **13.232 ms** |

The second column is the only one that matters: it is the case the second line
exists for. **The generic function is 13× more expensive exactly there.**
Generated policies are the answer, and on the normal path they cost nothing
(6.17 against 6.53 — below noise).

Today, in that case, the database answers in 0.068 ms **with the wrong rows**.

---

## Step 4 — delivered

- **God published into `zveltio.visible_tenants`**, therefore enforced by the
  policies. Proved by planting: a god sees two tenants through the policy, an
  ordinary user one, a request with no named user — one. And the database is
  asked directly what it considers visible, so the proof is not about the
  handler.
- **One god per instance, enforced by the database** (migration 008, a trigger).
  **Not a unique index**, because that would fail the migration on any
  installation that already has two — and choosing whose role is taken away is
  not a migration's decision. The trigger refuses a second one from now on, and
  installations with several get a warning and keep working.

### Three consequences the invariant brought to light

1. **248 tests failed** on the first run: the harness created a god per file. It
   now demotes the previous one — modelling the product rather than sidestepping
   it.
2. **The recovery flow added a god.** With the invariant, it would have refused
   itself in exactly the situation it exists for. It now **transfers** the role:
   whoever holds a valid, unspent, rotated token takes it, and the audit row
   records it. That is what recovery means.
3. Two suites made their own god assuming there could be several.

---

## Validation point — 3 of 4, the block stays open

| # | Criterion | Verdict |
|---|---|---|
| 1 | God expressed in the database, not through a side door | ✅ proved by planting |
| 2 | Plan cost measured, in numbers | ✅ three forms; the elegant one rejected by its own criterion |
| 3 | One god, enforced by the database | ✅ trigger, with the reason it is not a unique index |
| 4 | Row rules: enforced in the database, or a written reason | ⬜ **measured and decided, NOT IMPLEMENTED** |

**Criterion 4 is unmet and I am not rewriting it to fit** — that is exactly what
I refused to do in Block C. The measurement is done and the form is chosen; what
remains is the work: the engine emitting `CREATE POLICY` from `zvd_rls_policies`
and keeping them in step with the rules, including the caller's role in a
session variable.

**Measured:** harness 942/0, unit 2557/0, typecheck clean, lint clean,
`check-migration-safety` reporting no hazards on 008.

## Log

| When | Step | What happened |
|---|---|---|
| 2026-08-31 | 1 | The elegant form costs 7×. Rejected by the stop criterion written in advance. |
| 2026-08-31 | 2 | The generic function: 13.2 ms against 0.98 ms exactly in the case that matters. |
| 2026-08-31 | 4 | The invariant failed 248 tests and revealed that recovery added a god instead of transferring one. |
| 2026-08-31 | 5–6 | 3/4. Criterion 4 stays unmet, written as such. |
