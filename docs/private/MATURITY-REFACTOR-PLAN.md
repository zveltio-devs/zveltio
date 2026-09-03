# The maturity plan — what I would change if I rebuilt Zveltio

> **Written:** 2026-08-29, after a week of auditing measured against `3.0.0-beta.64`.
> **The owner's premise:** leaving beta is not urgent. Maturity first.
> **The market's shape:** self-hosted, **but not necessarily single-tenant** — see
> the section immediately below. The document's initial premise was wrong.
> **Method:** blocks of 5–7 steps, validation criteria written BEFORE measuring, a
> state document read at the start of every step.
>
> **The rule governing all of them:** a block is allowed to end with "not worth
> it". In the week that produced this document, **four blocks out of five ended
> exactly that way** — and every time the measurement found something better than
> the plan I had in my head.

---

## WORK STATE — updated 2026-08-30

The plan below is what **was** to be done. This is what was done. Each executed
block had its own state document, with its measurements and its validation point.

| Block | State | State document | Delivered by |
|---|---|---|---|
| **C — the gates** | ✅ **CLOSED, 4 of 4** (2026-08-31) | retired | #360, #361, #363, #364 |
| **B — the per-tenant / instance boundary** | ✅ **CLOSED, 4 of 4** | retired | #365, ext#62 |
| **F — indexes following access patterns** | ✅ **CLOSED, 3 of 4 + one cancelled by measurement** | retired | #366 |
| **A — the second reservation** | ✅ **CLOSED** — reads AND writes at zero extra connections | `BLOCK-A-EXPLICIT-CONTEXT-STATE.md` | #367, #387 |
| **G — per-tenant extension activation** | ✅ **CLOSED, 4 of 4** | retired | #368 |
| **D — row conditions** | ✅ **CLOSED with "not worth it", 4 of 4** | retired | — (zero product code) |
| **H — `?as_of=` read everything** | ✅ **CLOSED, 4 of 4** | retired | from D's finding |
| **J — the second line in the database** | ✅ **CLOSED, 4 of 4** (via block K) | `BLOCK-J-DB-SECOND-LINE-STATE.md` | — |
| **K — row rules in the database** | ✅ **CLOSED, 4 of 4** | `BLOCK-K-ROW-RULES-IN-DB-STATE.md` | — |
| **E — owner decisions** | ✅ **DECIDED AND EXECUTED** | retired | — |
| **L — raising biome to 2.5.11** | ✅ **CLOSED** — lint at ZERO warnings, down from 51 | `BLOCK-L-BIOME-UPGRADE-STATE.md` | #397, #400 |
| **M — `hono` in lockstep with the extensions** | ✅ **CLOSED, 7 of 7** — security release, 44 bundles repacked + a new gate | `BLOCK-M-HONO-LOCKSTEP-STATE.md` | #373, #398, #399, ext#73 |

*"Retired" means the block closed and its state document was removed in the
September 2026 documentation cleanup. What each one found is summarised below;
where it changed code, the reason lives in a comment at that code.*

### What each block found, briefly

**C.** The `audit:gates` meta-gate **ran nowhere** — not in CI, not in `prepush`,
and `prepush` is not wired to any hook. Real coverage was **9 gates out of 31**,
not "11/11": 11 was the number of *cases*. **Seven gates were fail-open** —
reporting "clean" with no sibling repository or no database, one of them scanning
a fifth of the corpus. It stays open because 23 gates out of 41 are still not
proved by planting, and the criterion **was not rewritten** to fit.

**B.** The boundary **is derivable from code** — 384 tables, 333 per tenant, 51
instance-level, confronted **362 out of 362** against a fully installed database.
**Nine instance tables are children of per-tenant tables**, isolated only through
a join, with no second line. One real defect fixed: `zv_prompt_templates`. And
`admin-gate-check` was extended to the sibling, where there were **113 unguarded
sites** against zero in the engine.

**F.** The patterns cost **from ten tenants upwards**, not from a thousand: a
field filter with `ORDER BY` takes **46 ms and discards all 300,000 rows** to
return 25 — at 10 tenants and at 100 alike, because it is a plan cliff, not
growth. Explicit equality was **switched off for every authenticated request**.
Both fixed: **12.5 ms → 0.065 ms**, with no regression at a single tenant.

**G.** `UNIQUE (name)` on `zv_extension_registry` made per-tenant activation
**impossible**, not merely undone — the second row was a duplicate key. And the
listing respected `tenant_id`, so it showed one tenant an extension as absent
while its code was answering. The gate sits on **the handle given to the
extension**, not on the path: `mountStrategy: 'global'` (the default) hands it
the engine's app. Installation took the tenant from a **header**.

**D.** Closed **without a single line of product code**. The whole row-policy
language is **four operators on one field**, combined with AND; in-memory
filtering costs **2.2 ms out of 336** — 0.65%. CASL would cover all four, but it
would add a dependency and would still require the same hand-written translation
to Kysely, in order to replace 70 lines that cannot drift.

**H.** What D found instead: `?as_of=` **read the collection's entire history to
return one page** — 400,000 rows pulled into the process for 25. It now reads
**49**. The gain is memory (~50 MB per request), not time: `total` stayed at
~250 ms and is inherent.

**A.** The concurrency ceiling **is real and is exactly at `DB_POOL_MAX`** — at
`c = pool` the service does not degrade, it stops, with every connection
`idle in transaction` and exactly one active. Verified at pool 10 and at 25.
**But the plan promises too much:** only 56% of the time a connection is held is
spent doing nothing, so short transactions would give roughly **2.3×**, not "the
ceiling disappears". And `DB_POOL_MAX` moves the same ceiling linearly, with no
code change. The block stopped at step 1: the question became an owner's, not an
engineer's.

### What was cancelled, by measurement — and why this list matters

- **C step 6**, extending `check-tenant-table-on-pool` to `lib/`: `lib/` contains
  the identifier `poolDb` **once, in a comment**, against 19 times in `routes/`.
  The gate would catch nothing, ever.
- **F step 6**, the gate on indexes: the rule would catch **220 sites**, most of
  them legitimate foreign-key indexes. A ratchet with no written reasons is
  decoration.

Both closed under the same rule: **a gate whose only output is its own exception
list is worse than no gate.**

### Fixed along the way, outside the blocks

- **`0A000 cached plan must not change result type`** — failed the integration
  lane on roughly 2 runs in 3. The cause, found with a DDL event trigger:
  **extension migrations run after the engine has opened its pool**, and the `ai`
  extension alters `zvd_collections` 1.3 s after startup. Fixed by recycling the
  pool (#362).

---

## The market's shape — corrected by the owner, 2026-08-29

This document was written assuming the typical installation is self-hosted **with
a single tenant**, and drew conclusions from there about what is worth
optimising. The premise is wrong.

**Self-hosted, but not necessarily single-tenant.** Corporations made up of
several companies. Public institutions with other public institutions under them.
That is, exactly the **hierarchical** shape — a node reading across its subtree —
not a collection of mutually foreign tenants.

**The requirement that follows, in the owner's words:** multi-tenancy must not
penalise performance **either** for a single tenant **or** for several. It is not
a choice between the two cases; it is both, simultaneously.

What changes in this document: the argument "with a single tenant a full scan
*is* the right plan, so per-tenant indexing does not pay" stays true **for that
case**, but no longer justifies the absence of a block about indexes — because
that case is no longer the only one. Hence **Block F**.

What does NOT change: nothing in the "what is NOT in the plan" list. Every entry
there was rejected for a reason other than market size, and the two that touch
tenants (domain-bound policies, `loadFilteredPolicy`) fall because **the
resources are shared across tenants**, which this correction does not touch.

---

## The working method — mandatory, not recommended

This is not ceremony. It is the procedure that produced this document, and the
reason four blocks out of five closed with "not worth it" **before** any code was
written.

### 1. A state document that travels with the task

One file holding the work's current state. **Read at the start of every step**
and **updated after every step** — not at the end of the block, not "when there
is something to say".

It must contain:

- **Why the block exists** — with the numbers that justified it, not the
  intention
- **A step table**, each with a state (`TO DO` / `IN PROGRESS` / `DONE` /
  `CANCELLED`) and its result
- **The validation-point criteria, written BEFORE measuring** — so they cannot be
  adjusted once the numbers are visible. This is the centre of the method.
- **What is NOT touched in the block** — explicitly
- **A log**, one line per step
- **Context that must not be rediscovered** — environment, variables, traps.
  Without it, whoever picks the work up next loses a day redoing what is already
  known.

Live example: `CASBIN-SCALING-STATE.md`.

### 2. Decomposition into blocks of 5–7 steps

No more. A twelve-step block is a plan that has not thought about where it might
be wrong. Step 0 of every block is always "read the state document".

A block's first step **measures**, it does not build. If the measurement does not
confirm the premise, the block closes there and the remaining steps are not done.
That happened four times in one week.

### 3. A validation point between blocks

The next block **does not open** unless the criteria written in advance are met.
A measured "not worth it" is a result, not a failure — it is written in the
document and reported.

Three rules that separate real validation from a formality:

- **Criteria are written before measuring.** Afterwards they are not criteria,
  they are justifications.
- **A gate not proved by planting is decoration.** You plant the violation it
  claims to catch and check that it fails. `audit-gates.ts` does this for all of
  them.
- **Verify in their environment, not yours.** In that week, four changes passed
  locally and failed in CI — the `unit` suite runs without a database, the
  process is shared between files, and the first row in `user` may be the god
  account.

### The trap that cost the most

**A dirty database does not give you a red test. It gives you a credible, false
number.**

The suite left five collections per run. Thirty runs produced a database in which
authorization measured 364 ms per decision. That figure reached two written
reports before anyone asked how many collections a real installation has. The
answer was three, and the real cost 0.93 ms.

Before any measurement that produces a reportable number: **check what kind of
database you are measuring on.**

---

## What is NOT in the plan, and why

This comes first, because this list cost more to discover than the one below.

| Idea | Why not |
|---|---|
| Switching RLS off on single-tenant installations | Gain: 0.19 ms/request. Loss: defence in depth — and if the "single tenant" detection is wrong once, isolation is not slower, it is **absent**. |
| Casbin's `loadFilteredPolicy` | There is no slice to filter: all `p` rules have `dom='*'`. The adapter does not even implement the interface. |
| Domain-bound Casbin policies | Collections **have no `tenant_id`** — they are shared across tenants. There is nothing per-tenant to bind. |
| The engine on a NOSUPERUSER role | Background work **structurally** needs a global view: `repairUnsignedWebhooksAtBoot` reads every tenant's webhooks; `flow-executor` looks up a flow's `tenant_id` in order to learn which tenant it runs in. A restricted role would not make them unsafe — it would make them **blind**. |
| Replacing Casbin with CASL | Your permissions are **runtime-editable data** (`zv_roles`, an admin screen, granting without a deploy). That is Casbin's central strength. CASL defines abilities **in code**; you would be rewriting the policy store. Also `dom` is first-class in Casbin and non-existent in CASL, and 55+ extensions depend on `permissionGate` as an API. |
| Zanzibar/SpiceDB | The right model at Google's scale, but it is an **external service** — directly contradicting self-hosted simplicity, which is your selling argument. |
| Two pools (restricted for requests, privileged for background) | Feasible, but does not reduce exposure: the background pool stays privileged, and that is where unbounded access lives. And the gain (0.181 ms) is smaller than the one obtained for free by moving the role into `set_config` (0.175 ms). |

---

## Block A — tenant context becomes explicit

**The most valuable change in this document, and the riskiest.**

### The problem, measured

`registerCoreRoutes(app, { db: scopedDb, poolDb: db, auth })`. That `scopedDb` is
a `Proxy` whose `get` reads `getCurrentTenantTrx()` **on every property access**.
Extensions get the same pattern through `createRestrictedDb`.

A `Proxy.get` is **synchronous**. It cannot await opening a transaction. From
that follow, in a chain:

- the transaction must be opened **before** the handler, so it is held for the
  whole request
- being held for the whole request, it **pins a pool connection** from BEGIN to
  response
- hence the concurrency ceiling: at `DB_POOL_MAX=25`, `p95` jumps to seconds
  above c≈30 on the data path
- and making the transaction lazy is **impossible** without breaking the
  extension SDK's public contract: any `db.selectFrom(...)` before the open would
  silently fall onto the unisolated pool, across the whole engine and all 55+
  extensions at once

### What I would do

Every handler receives a handle **already bound to the tenant**, as an explicit
argument. More verbose. In exchange:

- the transaction can be short (per query or per group), not per request
- "I forgot the context" becomes a **compile error**, not a silent leak
- the concurrency ceiling disappears, because a connection is held for
  microseconds, not milliseconds

### Steps

| # | Step | Exit criterion |
|---|---|---|
| 1 | Measure how long a connection is actually held on a real request, against how long it would be with short transactions | the number, not an estimate |
| 2 | Inventory the 43 `reqDb` sites + 2 `?? db` + all extension code on `ctx.db` | a complete list |
| 3 | Design the explicit accessor — `async`, so TypeScript catches any missed site | a prototype on 3 routes |
| 4 | The gate guarding the refactor: no query on tenant data outside the transaction | **proved by planting** |
| 5 | Migrate the core routes, in batches of ~10, with the suite green between them | green at every batch |
| 6 | The SDK contract for extensions: `ctx.db` gets an explicit form, with a transition period | 57/57 extensions pass |
| 7 | **VALIDATION** — did the ceiling actually move? | measured, not assumed |

**Stop criterion:** if step 1 shows the ceiling does not move, the block closes
there. The remaining steps are not done.

**Warning from history:** a **synchronous** `finally` once emptied the
transaction early and left 302 policies inert, with the tests green. This
refactor walks exactly the same ground.

---

## Block B — the boundary between "per tenant" and "instance-level" becomes visible

### The problem

`zvd_collections` **has no `tenant_id`** — collections are shared. Likewise
`zvd_relations`, `zvd_rls_policies`, `zvd_permissions`, `zvd_push_tokens`. But
`zvd_webhooks` **does**. The prefix says nothing.

**It fooled me personally.** I wrote a gate assuming `zvd_` meant "tenant-bound",
which reported three findings, all of them correct code. And I built an entire
branch's premise on the idea that policies grow with the number of tenants —
false, for exactly the same reason.

Of 111 tables with `tenant_id`, **16 core ones have no RLS at all** — their
isolation is only in code. It is tested, so it is not a leak. But on collection
tables a forgotten `where` is caught by RLS; on those 16 it is an immediate leak,
with no second line.

### Steps

| # | Step | Exit criterion |
|---|---|---|
| 1 | Classify all 111 plus the instance tables, in a machine-readable table | a file, not a wiki |
| 2 | Make the classification derivable from code — a separate schema, a prefix, or a declaration | a single source |
| 3 | Gate: a new table must declare which side it is on | proved by planting |
| 4 | The 16 core ones: decide for each — RLS, or a written reason why not | zero undecided |
| 5 | **VALIDATION** — can anyone add a table without declaring its side? | no |

---

## Block C — the gates, before code

### Why it is a separate block

The most valuable things found in the 27–29 August audit **were not bugs**. They
were gates that checked nothing:

- `check-numeric-string-arithmetic` exited 0 in **four distinct ways**
- the CI job running it was the only one that did not clone the sibling
  repository
- the suite left **5 collections per run**; 30 runs produced a database in which
  a measurement reported authorization at 364 ms when reality was 0.93 ms

The last is the one that matters: **a missing gate does not give you a red test.
It gives you a credible, false number**, which ends up in two written reports.

### Steps

| # | Step | Exit criterion |
|---|---|---|
| 1 | Every gate enters `audit-gates.ts` — plant the violation, see whether it fails | 100% coverage, 11/11 today |
| 2 | No gate may exit 0 when it cannot check | fail-closed everywhere |
| 3 | Every gate declares what it needs; CI gives it exactly that | no silent skips |
| 4 | A gate over the gates: a new one with no case in the meta-gate is not committed | proved by planting |
| 5 | ~~`check-tenant-table-on-pool` extended to `lib/`~~ | ⛔ **CANCELLED 2026-08-29, measured** |
| 6 | **VALIDATION** — is there any gate that passes on a planted violation? | zero |

**Step 5 closed with "not worth it".** It came from block 4 of
`CASBIN-SCALING-STATE.md`, but it had already been tried and reverted, and the
reason is written in the gate's header: in `lib/` the unbounded handle is called
`db`, the same as a transaction. Measured: `lib/` contains the identifier
`poolDb` **once, in a comment**; `routes/` 19 times. The extended gate could
catch nothing, ever — the first attempt delivered exactly that, plus four
"motivated exceptions" for impossible violations.

The exposure is real, but it needs a **runtime** assertion (a query on a tenant
table with no tenant GUC, under `NODE_ENV=test`), not a build gate. That is a
separate design, not an extension.

---

## Block D — the row-conditions layer

### An observation, not a firm plan

`getRlsFilters()` translates rules into query conditions — hand-written. That is
exactly what **CASL** does well, with patterns and translation to a query.

I am not proposing changing the authorization engine — Casbin remains the right
choice. But the **row conditions** part is a separable piece where a mature
library might pay. It deserves a measurement block, not a decision now.

Note one thing found: on the *time travel* path, the filters are applied **in
memory** (`matchesRlsFilters`), not in SQL. A rule that hides rows costs the
whole set read before filtering.

---

## Block E — owner decisions, not engineering ones

1. **The catalog in the engine.** `extension-catalog.ts`: 749 lines, 60 entries,
   4 runtime importers, Romania-specific text. The argument for moving it out is
   clean. The counter-argument is your market's: isolated installations must be
   able to see what they can install. **Proposed compromise:** the catalog stays,
   but as **versioned shipped data**, not as TypeScript source compiled into the
   engine.
2. **`KNOWN_EXTENSION_RESOURCES`.** Already reduced to a safety net; the
   reconciliation reads the manifests. What remains is deciding whether the list
   still has a purpose.
3. **`DB_POOL_MAX`.** The default is 25. Raising it to 40 moves `p95` from
   seconds to 214 ms at c=30 — but it trades per-instance concurrency against the
   number of instances that fit in `max_connections`. A deployment tuning, an
   owner decision.

---

## Block F — indexes follow access patterns, not columns

### Why it exists

Advice from outside, confirmed by our own measurements: *design the schema after
who asks for which data, and every access pattern gets its own index.* Of three
external recommendations, the only one touching something this plan did not
cover.

The mechanism is already proved in the repository, on **one** pattern —
`57913f41`, measured on 300,000 rows and 63 tenants:

| | Time | Rows discarded to return 25 |
|---|---|---|
| the policy alone | 1.94 ms | 6,408 |
| the policy + explicit equality, index `(tenant_id, created_at DESC)` | **0.08 ms** | 0 |

The cause is structural and does not go away: the predicate is
`tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[])`, and an `= ANY`
over an array the planner cannot see until execution **cannot drive an ordered
index scan**. The form is not a mistake — **the hierarchy requires it**, because
a subtree read does not reduce to a scalar equality. So the tension is permanent:
the hierarchy needs the array, the array kills the ordered scan, and explicit
equality beside the policy is the only thing that reconciles them.

The cost grows with the number of tenants in the table. At the market shape
described above — a holding company with subsidiaries, an institution with
subordinate units — that is not a theoretical scale.

### The finding that opens the block — measured 2026-08-29

**Explicit equality is not applied for any authenticated request.**

`setSingleTenantScope(scope === null)` (`tenant-manager.ts:867`) — but
`resolveTenantScope` **never returns `null`**: it returns an object on every
branch, including `{ visible: [tenantId] }` for `read_scope='self'`. And `userId`
is passed for any request with a session (`middleware/tenant.ts:144`).

A probe on a tenant **without** a hierarchy, a user with `read_scope='self'`, the
default:

```
without userId (API key / background):  equality on 0000...0001
with userId    (authenticated request): NULL — no equality
```

The fast path is active exactly for the traffic that does not need it, and
inactive for the traffic that does. **It is not the hierarchy that costs the
optimisation — it is authentication.**

`tenant-scope-filter.test.ts` cannot catch this: it deliberately accepts both
outcomes (`seen === null || seen === ROOT`), so it stays green in both worlds.

### The remaining patterns — read, not measured

Creating a collection today creates:

| Access pattern | Index | Prefixed with `tenant_id`? |
|---|---|---|
| `ORDER BY created_at DESC` | `(tenant_id, created_at DESC)` | ✅ #358 |
| filter on `status` | `(status)` | ❌ |
| filter on a user-indexed field | `("<field>")` | ❌ |
| search | GIN on `search_vector` | ❌ |

And `reconcileExtensionTenantRLS` creates only `(tenant_id)`, without the
composite that `applyTenantRLS` creates beside it — the same asymmetry fixed in
#336, one level deeper, on the extensions' tables.

**This table is derived by reading.** The repository has two wrong detours on
exactly this predicate, and an audit-by-reading missed a real leak two days ago.
Step 1 measures; it does not confirm the list above.

### Steps

| # | Step | Exit criterion |
|---|---|---|
| 1 | Measure every pattern in the table with the policy APPLIED, at 1 / 10 / 100 tenants | numbers, not the list above |
| 2 | **The threshold:** from how many tenants does each pattern start to cost? Below the threshold, the pattern leaves the block | a written number for each |
| 3 | Make `singleTenant` mean "the reach is exactly this tenant", not "no scope object came out" | a test that DISTINGUISHES, not one that accepts both |
| 4 | Explicit equality on the extensions' path, or a written reason why not | decided, not omitted |
| 5 | The missing composite in `reconcileExtensionTenantRLS` | symmetry with `applyTenantRLS` |
| 6 | Gate: a new index on a tenant table declares the pattern it serves | proved by planting |
| 7 | **VALIDATION** — did the ceiling move at **both** ends: one tenant and N tenants? | measured, both |

**Stop criterion:** if step 2 shows that no pattern costs below a thousand
tenants, the block closes there and only step 3 remains — which is a one-line
correction plus a test, and is done anyway.

**What is NOT touched:** the shape of the RLS predicate. It has changed three
times, most recently in `005_rls_initplan_predicate.sql`, and is now the right
one. The block adds equalities and indexes **beside** the policy; an equality can
only narrow the set the policy permits, never widen it, so the security surface
is unchanged and RLS goes on deciding.

---

## The recommended order

**1. Block C — the gates.** First, although it is the least spectacular. Block A
walks the ground where a synchronous `finally` once left 302 policies inert
**with the tests green**. You do not start without the net. Without C, a
regression from A is invisible.

**2. Block B — the per-tenant / instance boundary.** Cheap, and its ambiguity has
already produced two wrong conclusions of mine in a single week: a gate reporting
correct code as a violation, and an entire branch's false premise. It must come
before A, because A moves exactly the code that depends on this distinction.

**3. Block F — indexes on access patterns.** After B, because B is what says
which tables are per tenant — that is, on which a composite index makes sense.
Before A, because A moves exactly the code that decides a request's reach, and
F's step 3 corrects it first.

**4. Block A — explicit context.** Last, with all the time in the world, and with
the declared freedom to stop at step 1 if the measurement does not confirm that
the ceiling moves.

**D and E at any time** — they block nothing and are blocked by nothing.

### Why this order and not the order of value

A is the most valuable and it is last. Not out of caution: because it is the only
one that can break isolation silently. C and B cost little and turn a possible
mistake in A from a silent one into a noisy one. The order is chosen by **what
happens if we get it wrong**, not by what we gain if we succeed.

---

## What validates this plan as honest

Every claim here has a number or a test behind it, and those that do not are
marked as observations. The "what is NOT in the plan" list is longer than the
to-do list, because the week that produced it was largely a list of good ideas
that did not survive measurement — including three of mine that had already
reached written reports before being disproved.

### Block G — per-tenant extension activation (2026-08-30) — **4/4**

God installs on the instance; the tenant's admin decides whether it acts for
them. The second half was not merely undone, it was **impossible**:
`UNIQUE (name)` on `zv_extension_registry` gave an extension a single row, so
`tenant_id` could only record who installed last. Migration `007` opens it with
`UNIQUE NULLS NOT DISTINCT (tenant_id, name)`.

**The gate does not sit on the path, it sits on the handle.**
`mountStrategy: 'global'` — the default — hands the extension the engine's app; a
gate on `/ext/*` would have guarded nothing. Two things it covers only partially:
cron and `app.route()`.
