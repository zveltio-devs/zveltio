# State — Block K: row rules reach the database

> **Read at the start of every step.** Branch: `block-k/row-rules-in-db`.
> Continues criterion 4, left unmet in Block J, with the form already chosen by
> measurement there.

---

## Why, in numbers

With the rule `created_by eq user_id`, in the case the second line exists for —
**the application forgot the filter**, so the policy is the only guard:

| | application filter present | filter forgotten |
|---|---:|---:|
| no rule in the database (today) | 6.53 ms | **0.068 ms — and it LEAKS** |
| generated policies | 6.17 ms | **0.983 ms** |
| one generic policy, per-row function | 7.61 ms | 13.232 ms |

Generated policies. Measured in Block J, not chosen by preference.

---

## The semantics it must reproduce EXACTLY

From `getRlsFilters`, read line by line. If the generated predicate means
something else, we have not built a second line of defence — we have built a
**second source of truth**, and two sources that disagree are worse than one.

1. **Exemption:** an API key with `rlsBypass === true`, OR the `data:view_all`
   permission (which god holds). Not a comparison against the role name — that
   was already dead code once, for years.
2. **Role match:** `policy.role = '*'`, or the role is among the user's Casbin
   roles (plus their direct role).
3. **An unresolvable value ⇒ the rule is SKIPPED** — fail-open for that rule.
   Not "sees nothing".
4. **Operators:** `eq`, `neq`, `in`, `not_in`. `neq` is `<>`, not
   `IS DISTINCT FROM`: on a NULL field the engine excludes the row, and the
   database must do the same.
5. **Comma splitting only for `static:`**, and only on `in`/`not_in`.
6. Rules combine with **AND**.

---

## Validation-point criteria — WRITTEN IN ADVANCE

1. **A forgotten `WHERE` no longer leaks**, proved by planting: the same query
   that returns someone else's rows today returns zero.
2. **The generated predicate means exactly what the engine's means** — compared
   row by row, across all four operators and all four sources, including the
   cases where the engine SKIPS the rule.
3. **The cost is re-measured** after implementation, on the same data, and
   written down.
4. **A rule the database cannot express is not silently half-enforced:** either
   it is generated whole, or it is not generated at all and it says which and
   why.

**STOP CRITERION:** if the predicate cannot be made to mean the same thing for
some operator or some source, that one is not generated. An almost-correct
policy on a security path is worse than none, because it looks complete.

---

## Steps

| # | Step | State | Result |
|---|---|---|---|
| 0 | Read this document | — | — |
| 1 | Predicate generator + equivalence tests | ✅ | 18 tests, including what it refuses to generate |
| 2 | The engine publishes identity in session variables | ✅ | in the same round trip, zero extra queries |
| 3 | Applying the policy | ✅ | a single point: `invalidateRlsCache` |
| 4 | Planting: a forgotten `WHERE` no longer leaks | ✅ | 10 tests, all with the filter deliberately forgotten |
| 5 | Re-measure the cost | ✅ | **+0.03 ms** on the normal path |
| 6 | **VALIDATION POINT** | ✅ | **4 of 4** |

---

## Shape decisions, taken before writing

- **`AS RESTRICTIVE`**, because permissive policies combine with OR, and row
  rules must add to tenant isolation, not widen it.
- **The exemption is a variable**, not a role check inside the predicate: the
  engine already decides (API key or `data:view_all`) and publishes the result.
- **The column type matters.** `current_setting()` returns text; on an `integer`
  column that is a type error, not a comparison. The type is read at generation
  time and the value is cast into it. For a type that cannot be cast safely, the
  rule is **not generated**, and it says which.

---

## How it looks, briefly

One **RESTRICTIVE** policy per collection, generated from the rules, which
Postgres combines with AND against tenant isolation. Permissive would have
WIDENED what the tenant policy allows — exactly backwards.

The caller's identity is published in the same `set_config` as the tenant
variables — so **zero extra queries**: the middleware already has the session,
and both the roles and the exemption permission come from cache.

**A single synchronisation point:** `invalidateRlsCache`. Every rule change goes
through it — create, update, delete. Hooks placed on the three routes would have
let any other caller write rules the database does not know about — precisely
the failure the policy prevents, reintroduced one caller at a time.

At boot every collection with rules is reconciled: an installation being
upgraded already has rules and no policies, and a function that only protected
collections created from now on would be protecting the ones with no data in
them.

---

## The cost, measured (2026-08-31)

300,000 rows, composite index, rule `created_by eq user_id`, medians of 9 runs
after warm-up.

| | normal path (application adds the filter) | **filter forgotten** |
|---|---:|---:|
| no policy | 0.215 ms | **0.060 ms — and it LEAKS** |
| with the generated policy | **0.245 ms** | **0.775 ms — correct** |

**+0.03 ms on the normal path.** That is the price of the second line, and it is
small because the predicate is sargable: a direct comparison on the column, not
a per-row function (that form measured 13.2 ms in Block J).

### A false number, caught in time

The first measurement gave **5.85 ms** on the normal path — 26× worse. It was
not true: my probe script had inserted the rule **three times**, and the
generator faithfully emitted it three times. The hand-written predicate, with a
single term, gave 0.244 ms.

Two things to take away: nothing in the product prevents two identical rows in
`zvd_rls_policies`, and the generator now **deduplicates**; and a number that
does not reproduce when you write it by hand deserves to be read, not reported.

---

## What it refuses to do, and says which

A rule on a column whose type cannot be safely cast from text — `jsonb`, for
instance — is **not generated**, and the collection and the reason are shouted
at apply time. The rule stays enforced by the engine, the only enforcer, which
is exactly the situation this change ends — so it must not be something you
discover by reading code.

Likewise for: a field that is not an identifier, a non-existent column, an
unknown operator, an empty static list. And a rule it cannot express **does not
take with it** the ones it can.

---

## Validation point — 4 of 4 (2026-08-31)

| # | Criterion | Verdict |
|---|---|---|
| 1 | A forgotten `WHERE` no longer leaks | ✅ 10 tests, all with the filter deliberately forgotten |
| 2 | The predicate means what the engine means | ✅ all operators, all sources, including SKIPPED rules |
| 3 | Cost re-measured and written down | ✅ +0.03 ms, plus the false number explained |
| 4 | An inexpressible rule is not half-enforced | ✅ not generated, and it says which |

**Measured:** harness 952/0, unit 2575/0, `audit:gates` 39/39, typecheck and
lint clean.

This also closes criterion 4, left open in **Block J**.

## Log

| When | Step | What happened |
|---|---|---|
| 2026-08-31 | setup | The semantics of `getRlsFilters` transcribed into six points before a line of generator was written. |
| 2026-08-31 | 5 | 5.85 ms turned out to be an artefact: the rule inserted three times by my own script. The generator now deduplicates. |
| 2026-08-31 | 6 | 4/4. Block J can close too. |
