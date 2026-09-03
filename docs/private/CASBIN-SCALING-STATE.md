# State — scaling Casbin authorization

> **Read at the start of every step. Update after every step.**
> Branch: `perf/casbin-scaling` · started from `422377b2` (3.0.0-beta.64)
> Method: blocks of 5–7 steps, with a validation point between blocks.
> The rule governing all of them: **nothing is built before a measurement shows
> it is worth it.** A block is allowed to end with "not worth it".

---

## Why this branch exists

The 27–29 August audit reduced an authorization decision from 364–885 ms to
4.7 ms cold and 0.115 ms warm. That solved **the latency of one check**.

What it did not solve, and what I misclassified as "no longer on the critical
path": **resolution scales with the size of the instance.**

| `p` policies | Cold resolution per (user, tenant) |
|---|---|
| 7,208 | 4.70 ms |
| 23,978 | **9.96 ms** |

The structural cause, measured: **all 23,978 `p` rules have `dom = '*'`.** None
is bound to a tenant. So resolving each user walks the whole instance's
policies — every tenant's collections plus every extension resource. 5,957
distinct resources in the measured instance.

Extrapolated: 100 tenants × 20 collections ⇒ tens of thousands of rules, and
every user's first check inside the TTL window walks all of them.

**That tax grows with the product's success.** The transaction tax (0.19 ms per
request) is constant. For a "multi-tenant Business OS", this is the ceiling that
matters.

---

## Block 1 — MEASUREMENT. No production code is written.

| # | Step | State | Result |
|---|---|---|---|
| 0 | Read this document | — | (at every step) |
| 1 | Controlled scaling bench on its own `zv_casbin` database | ✅ **DONE** | see §The curve |
| 2 | The resolution curve — its shape, not two points | ✅ **DONE** | **linear, slightly super-linear** |
| 3 | Feasibility of `loadFilteredPolicy` with a singleton enforcer shared across tenants | ✅ **DONE** | **NOT feasible** |
| 4 | What would break if `p` rules were domain-bound instead of `dom='*'` | ✅ **DONE** | index: 13–19×, but the premise is false |
| 5 | Growth of `g` rules with users × tenants | ⛔ **CANCELLED** | the premise fell at step 4 |
| 6 | **VALIDATION POINT** | ✅ **DONE** | **BLOCK 2 DOES NOT OPEN** |

### Validation-point criteria (written BEFORE measuring)

Block 2 opens **only if** at least one condition is true:

- The curve is at least linear in the number of policies **and** an identified
  path reduces it to sub-linear or to constant per tenant.
- `loadFilteredPolicy` is feasible without breaking the multi-tenant semantics
  of the singleton enforcer.

If neither is true: **block 2 does not open.** The conclusion is written here and
reported. A measured "not worth it" is a result, not a failure.

### What is NOT touched in block 1

Production code. The RLS policy. The enforcer. Nothing in
`packages/engine/src` beyond throwaway measurement files.

### The curve (steps 1–2, measured 2026-08-29)

The bench imitates the real shape: policies on ROLE, one per (role, resource,
action), all `dom='*'`. In the audited instance: `tenant_member` × 3 actions +
`tenant_viewer` × 1, across 6,161 resources = 24,644 rules.

| Resources | Policies | Resolution (with role) | Resolution (no role) |
|---|---|---|---|
| 1,500 | 6,000 | 3.57 ms | 1.17 ms |
| 3,000 | 12,000 | 7.26 ms | 2.50 ms |
| 6,000 | 24,000 | 16.32 ms | 7.01 ms |
| 12,000 | 48,000 | 28.50 ms | 10.70 ms |
| 24,000 | 96,000 | **62.33 ms** | 26.55 ms |

**16× more policies ⇒ 17.5× more time.** Linear, slightly super-linear.

Extrapolated to 1,000 tenants × 24 collections: **62 ms** for every (user,
tenant) resolution, paid on the first check of each 60 s TTL window.

The "no role" case is cheaper but grows the same way — and it is the denial
case, the one an attacker asks for.

**The first half of the validation criterion is met:** the curve is at least
linear. What remains is to show a path that reduces it.

### Step 3 — `loadFilteredPolicy`: not feasible

The Kysely adapter does **not** implement `FilteredAdapter` (no `isFiltered`, no
`loadFilteredPolicy`), and `_enforcer` is a singleton shared across tenants. But
the real obstacle is deeper: **there is no slice to filter by.** All `p` rules
have `dom='*'`, so a domain-filtered load would return all of them.

### Step 4 — the index helps, but only with the data changed

At 48,000 policies:

| | Time | Built once |
|---|---|---|
| A. full scan (today) | 3.405 ms | — |
| B. index on domain | **0.264 ms** | 6.8 ms |
| C. index on (domain, subject) | **0.182 ms** | 13.9 ms |
| D. index on subject, **data unchanged** | **12.096 ms** | 7.3 ms |

D is the verdict that matters: **without changing the data, the index gives
nothing** — `tenant_member` holds 36,000 of 48,000 rules, so splitting by
subject reduces nothing for the common role. B and C only work because I built
them over domain-bound policies.

---

## VALIDATION POINT — verdict: BLOCK 2 DOES NOT OPEN

**The branch's premise is false, and I only discovered it here.**

`zvd_collections` **has no `tenant_id`.** Collections are instance-level,
**shared across tenants** — an installation with 100 tenants and 20 collections
has 20 collections, not 2,000. So the number of policies does **NOT** grow with
the number of tenants. It grows with the number of resources the operator
defines, bounded by what they build, not by how many customers they have.

Which also means domain binding (the only path that cuts the curve) **has
nothing to bind**: there is no per-tenant slice, because the resources are
shared.

### Where the mistake came from: my own pollution

The database I measured on had **167 collections, 163 of them artefacts of my
own tests** (timestamped names). The real `/opt/zveltio` instance has
**3 collections, 79 `p` policies, 23 distinct resources** — roughly 300× fewer.

### Correction to previously reported figures

Recalculated at realistic scales:

| Resources | Policies | `enforce()` — old code | `checkPermission` — new code |
|---|---|---|---|
| **23 (the real instance)** | 92 | **0.930 ms** | 0.351 ms |
| 300 (all extensions) | 1,200 | 7.271 ms | 0.672 ms |
| 1,000 | 4,000 | 23.435 ms | 1.509 ms |
| 6,000 | 24,000 | 142.835 ms | 11.440 ms |

**The "364 ms per decision" figure from the previous audit was measured on the
polluted database.** On a real instance, the old code cost **0.93 ms**. The
"3 req/s with a free account" amplification vector is overstated by the same
factor.

**The fix remains correct and remains useful** — it changes the slope, and at
~300 resources (an installation with every extension) the old code reaches
7.3 ms per denial against 0.67 ms. But it did not fix a production problem that
exists today; it fixed one that appears at a scale real instances have not yet
reached.

### What is done instead

Nothing on this branch. The conclusion is the result.

One action remains, cheap and unrelated to Casbin: **the test suite leaves
collections behind** (163 in a single database). That is not merely untidy — it
produced a false measurement that drove an entire audit. It deserves cleanup in
`afterAll`.

---

## Block 2 — DOES NOT OPEN (see the validation point)

---

## Block 3 — the collections the suite leaves behind

Not hygiene. **A false measurement produced here drove an entire audit** and
reached two reports as "364 ms per authorization decision". The database had 163
collections from tests; the real instance has 3.

| # | Step | State | Result |
|---|---|---|---|
| 0 | Read the document | — | (at every step) |
| 1 | Measure: how many collections a full run leaves, on a clean database | ✅ **DONE** | **5 collections + 2 ghost tables per run** |
| 2 | Identify the guilty files | ✅ **DONE** | 5 files, two of them mine |
| 3 | Fix the cleanup | ✅ **DONE** | shared helper `dropTestCollection` |
| 4 | Gate | ✅ **DONE** | `check:test-leftovers`, proved by planting |
| 5 | Verify on a clean database | ✅ **DONE** (corrected) | **the first pass missed a file** — see §The correction |
| 6 | **VALIDATION POINT** | ✅ **PASSED** | both criteria met |

### What was found (steps 1–3)

A full run left **5 collections** — so the 163 accumulated over ~30 runs during
the audit. The cause, in every case: the tests dropped the **table** but left
the row in `zvd_collections`.

| File | What it left |
|---|---|
| `collections.test.ts` | a second collection with an inline-generated name — nothing could name it again to drop it |
| `ddl-tenant-default-guard.test.ts` | the row |
| `revisions-tenant-isolation.test.ts` | the row |
| `data-list-count-mode.test.ts` (mine) | the row |
| `ghost-ddl-orphan-sweep.test.ts` (mine) | the row |
| `ghost-ddl-alter-column` / `-execute` | the post-swap copy, because it deliberately cancels the timer |
| `ghost-ddl-rename-column` | **the same copy — missed on the first pass, see §The correction** |

Fixed with a shared helper, `dropTestCollection(db, name)`, which drops **both**
the table **and** the row. The two ghost-DDL ones use `sweepGhostOrphans(db)` —
so the test cleans up with exactly the code path production uses, not with a
second copy of it.

### The gate

`check:test-leftovers` looks for collections with a timestamp suffix (so a real
operator's collection is not mistaken for residue) and for `_zv_old_*` /
`_zv_changelog_*` tables. **Proved by planting, not by reading:** with a planted
collection it fails; on a clean database it passes. In CI, immediately after the
harness suite.

### The correction (2026-08-29, after CI failed)

**Step 5 was reported as "zero leftovers" and was not.** CI failed on the very
gate this block added:

```
ghost table _zv_changelog_zvd_hgren_1788004596261
ghost table _zv_old_zvd_hgren_1788004596261
```

`hgren_` comes from `ghost-ddl-rename-column.test.ts` — the **third** file
calling `GhostDDL.execute`, beside the two that were fixed. It had not been
touched, so the post-swap copy and its changelog survived:
`DROP TABLE ... CASCADE` on the source table does not touch them, they are
separate tables.

**Not a CI condition.** It reproduces locally in 1.2 s, on a clean database,
running the file alone. The step-5 verification simply did not cover this file —
it was not a different environment, it was missing coverage.

The class of mistake is the one written in the header of
`check-raw-sql-identifiers.ts`: *enumerating names is the mistake; the pattern is
what to match*. The fix enumerated the ghost-ddl files it remembered, not the
ones that call `GhostDDL.execute`. The correct enumeration has nine files; the
four remaining `harness/` ones without a sweep (`multi-ddl`, `changelog-update`,
`changelog-delete`, `changelog-live`) **leave nothing** — verified against the
full suite, not assumed, because they do not cancel the cleanup timer.

Measured in both directions, on two separate clean databases:

| | Result |
|---|---|
| without the fix, `ghost-ddl-rename-column` alone | 2 ghost tables, gate fails |
| with the fix, full suite (865 pass, 0 fail) | **zero collections, zero ghosts**, gate passes |

A second fix in the same round: `dropTestCollection` interpolated a quoted
identifier into a `sql.raw` without a guard, which `check:raw-sql` caught. It now
has `SAFE_NAME` — a test giving an unwritable name gets an error, not broken SQL.

### Validation-point criteria (written IN ADVANCE)

- A full harness run on a clean database leaves **zero** collections and zero
  orphaned `zvd_*` tables.
- The gate fails on a test that leaves a collection behind (proved by planting,
  not by reading).

If the gate cannot be made to fail on a planted violation, it is not committed —
an unproven gate is decoration, and we have just spent a week demonstrating that.

---

## Log

| When | Step | What happened |
|---|---|---|
| 2026-08-29 | setup | Branch created from `422377b2`. State document written. Block 1 defined with validation criteria fixed before measuring. |
| 2026-08-29 | 1–2 | Bench on its own `zv_casbin` database, five measurement points. The curve is linear: 6,000 → 96,000 policies moves resolution from 3.57 to 62.33 ms. The first half of the criterion is met. |
| 2026-08-29 | 3 | `loadFilteredPolicy` is not feasible: the adapter does not implement the interface, the enforcer is shared, and there is no slice to filter because `dom='*'`. |
| 2026-08-29 | 4 | The index gives 13–19× **only** over domain-bound policies. Without changing the data: nothing. |
| 2026-08-29 | 3.5 correction | **Step 5 was wrong.** CI failed on this block's own gate: `ghost-ddl-rename-column` — the third file calling `GhostDDL.execute` — had not been touched. It reproduces locally in 1.2 s, so it was not a different environment, it was missing coverage. Fixed with `sweepGhostOrphans`; the full enumeration has 9 files, the rest verified clean. Plus the `SAFE_NAME` guard in `dropTestCollection`, required by `check:raw-sql`. |
| 2026-08-29 | **VALIDATION** | **Block 2 does NOT open.** `zvd_collections` has no `tenant_id` — collections are shared, so policies do NOT grow with tenants. The measurement database had 163 collections from tests; the real instance has 3. The 364 ms figure from the previous audit was a pollution artefact; the real one is 0.93 ms. |

---

## Context that must not be rediscovered

- **The environment:** isolated worktree `/home/liviu/zveltio-audit-ba/zveltio`,
  own database `zv_audit_ba`, port `:3400`. Taken by others: `:3000`, `:3200`,
  `:3201`, `:3300`.
- **Env without which the tests lie:** `ZVELTIO_REGISTRATION_ENABLED=1`,
  `FIELD_ENCRYPTION_KEY=<64 hex>`, `TEST_PORT`, `TEST_DATABASE_URL` **on a
  separate line** (`export A=1 B=$A` expands `$A` before assignment).
- **Do not contaminate the measurement database.** `pg_stat_statements` adds
  `rows`, `calls` and `wal_*` columns in `public` and widens the numeric gate's
  corpus.
- **CI ≠ local.** Four times in the previous audit a test passed locally and
  failed in CI: the `unit` suite runs without a database; the suite shares the
  process, so an earlier file can leave a cache behind; the first row in `user`
  may be the god account, and `checkPermission` short-circuits before the memo.
- **Casbin:** the model is `r = sub, dom, obj, act`; `dom` is the tenant. Objects
  are compared by **plain equality**, without `keyMatch`.
  `getImplicitRolesForUser` is trustworthy; `getImplicitPermissionsForUser` is
  **NOT** — it filters on an exact domain and returns zero for a `tenant_admin`,
  because the `p` rules have `dom='*'`.

---

## Block 4 — the engine's role: is today's architecture the right one?

Measured: the engine connects as `postgres` (`rolsuper=t`, `rolbypassrls=t`).
On a table with `FORCE ROW LEVEL SECURITY` enabled, that role sees **306,360
rows across 63 tenants**; `zveltio_rls` sees 100,360 from one. Superusers are
never bound by RLS.

So **user requests are isolated** (`withTenantIsolation` descends the role), and
**everything else is not**: background jobs, reconcilers, audit, backup.

### The architectural question, not just a configuration one

Today **every request descends its own privileges**. The default is "unbounded
until someone restricts it". Three variants to compare:

- **Zero — today.** Superuser pool + `SET LOCAL ROLE` per request.
- **A — plain role + explicit elevation.** The engine runs restricted; whatever
  needs a global view elevates explicitly. Inverts the default.
- **B — two pools.** One connected AS the restricted role for requests, one
  privileged for background work and DDL. The connection's identity carries the
  privilege, so `SET LOCAL ROLE` leaves the hot path and the default becomes
  safe by construction.

| # | Step | State | Result |
|---|---|---|---|
| 0 | Read the document | — | (at every step) |
| 1 | Inventory | ✅ **DONE** | 111 tables with `tenant_id`; ~14 sites in `lib/` |
| 2 | Classification | ✅ **DONE** | background work **structurally** needs a global view |
| 3 | The cost of `SET LOCAL ROLE` | ✅ **DONE** | 0.055 ms — and it can be had **without** an architecture change |
| 4 | Feasibility of B | ✅ **DONE** | possible, but does not reduce exposure |
| 5 | What breaks | ⛔ **CANCELLED** | the verdict was settled at step 2 |
| 6 | **VALIDATION POINT** | ✅ **DONE** | **the role does NOT change** |

### Steps 1–2 — the inventory, and why classification decides everything

111 tables carry `tenant_id`. In `lib/`, ~14 sites touch them outside the
transaction. But the number is not what matters; **their nature is.**

- `repairUnsignedWebhooksAtBoot` reads **every** tenant's webhooks.
- `flow-executor` looks up a flow's `tenant_id` **in order to learn** which
  tenant it runs in.
- The boot reconcilers walk every tenant's tables.

Background work that operates *between* tenants must, by definition, see between
tenants. A restricted role would not make them unsafe — it would make them
**blind**.

### Step 3 — the performance gain does not require the change

| | Time per request |
|---|---|
| Today: `SET LOCAL ROLE` as a separate statement | 0.230 ms |
| Variant B: the role comes with the connection | 0.181 ms |
| **The role set in the same `set_config`** | **0.175 ms** |

The third is **faster than B** and requires no architectural change. Verified as
equivalent, not merely faster: `set_config('role','zveltio_rls',true)` gives
`current_user = zveltio_rls` and RLS applies — one tenant visible, exactly as
with `SET LOCAL ROLE`. The superuser sees 63.

---

## VALIDATION POINT — verdict: the engine's role does NOT change

**Criterion 1 fails.** The places needing a global view are not a small,
closable set — they are the entire background layer, by design.

**Criterion 2 fails on substance.** Variant B is technically feasible (DDL goes
through pg-boss, so through the privileged pool), but it **does not reduce
exposure**: the background pool would stay privileged, and that is exactly where
unbounded access lives. B would make only the request path safe by construction,
and that path is already safe through the explicit role descent. And its measured
gain is smaller than the free one.

### What comes out of the block anyway

1. **A free, verified gain:** the role moved into the existing `set_config` —
   **0.055 ms per request, 24% of the preparation cost**, one line, zero risk.
2. ⛔ **DISPROVED 2026-08-29 — the recommendation below cannot be done.** In
   `lib/` the unbounded handle is called `db`, the same as a transaction:
   measured, `lib/` contains the identifier `poolDb` **once, in a comment**,
   against 19 times in `routes/`. A gate extended there would catch nothing,
   ever — and it had already been tried and reverted. The original text is kept
   below so it is not re-proposed.

   ~~**The exposure closes better at build time:**~~ extending the
   `check-tenant-table-on-pool` gate to `lib/`, with an explicit list of
   motivated exceptions for background work that legitimately needs a global
   view. Catches the same class without risking blinding anything.

**What is NOT done:** changing the engine's connection role.

### Validation-point criteria (written IN ADVANCE)

A change is recommended **only if**:
- The number of places legitimately needing a global view is small and
  enumerable (under ~10), **and** each can be given an explicit path.
- **Or** variant B proves feasible without breaking DDL.

If many legitimate places emerge: **the role does not change.** The exposure
closes better case by case — and then the recommendation is extending the
`check-tenant-table-on-pool` gate to `lib/`, which catches the same class at
build time without risking blinding anything.
