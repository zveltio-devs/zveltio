# Known Gaps

The honest list of what is unfinished, rough, or deliberately deferred.

This document exists so that nobody re-discovers a known problem and reports it
as news, and so that nobody assumes a feature works because it appears in a
list somewhere. It replaces the accumulated `audit/` reports: those rounds have
been remediated and re-verified, and what survived verification is written here.

**Last verified against the working tree on 2026-09-02.** Every entry below was
re-checked in source at that date, not carried forward from a report.

---

## How to read this

| Marker | Meaning |
|---|---|
| **Gap** | A real defect or missing capability. Reproducible. |
| **Deferred** | A deliberate decision to not build something yet, with the trigger that would change it. |
| **By design** | Behaviour that reads as a bug and is not. Listed because it keeps being reported. |

---

## 1. Engine

**Deferred — extension migrations run *after* the engine starts serving.**
An extension issuing `ALTER TABLE` on a core table about a second after boot
invalidates prepared statements held on the pool; this is the historical source
of `0A000` errors surfacing as `25P02` inside a transaction. Diagnosed and
understood; the remedy (block boot on extension migrations, or drain and rebuild
the pool afterwards) has not been chosen.

**By design — several `/api/*` routes return 410 Gone.** `/api/approvals`,
`/api/export`, `/api/import`, `/api/media`, `/api/briefing` and
`/api/edge-functions` moved into extensions. The 410 carries a forwarding
address deliberately, so an old client learns what happened.

---

## 2. Multi-tenancy and security

**By design — the engine's own database role bypasses RLS.** Enforcement is
`SET LOCAL ROLE zveltio_rls` plus a per-transaction GUC, applied by
`withTenantIsolation`. See [multi-tenancy.md](multi-tenancy.md) and
[security.md](security.md) §2 before reporting this.

**Gap — `CORS_ORIGINS` unset is accepted in production.** `CORS_ORIGINS=*` is
refused by the startup guards; leaving it entirely unset is not. The two cases
deserve the same treatment.

**Gap — engine migrations still run as the database owner.** DDL is
allowlisted, but the execution path remains owner-privileged. Reducing this
without breaking `CREATE EXTENSION` is the open part.

**By design — `media/` and `public/` storage prefixes are served unsigned.**
Every other key under `/files/*` requires a valid signature.

**By design — worker isolation is a guard-rail, not a sandbox.** It is a
separate process with a restricted SQL allowlist, a reserved connection with a
statement timeout, and a database role with no grants on the Better-Auth tables.
It has not been adversarially tested. Treat untrusted community extensions
accordingly. WASM isolation exists as an option and is
[deliberately deferred](#4-deliberate-deferrals) as the default.

---

## 3. Official extensions

Verified in `../zveltio-extensions` on 2026-09-02.

**Gap — `crm` ships five pipeline tables with no routes.**
`zvd_crm_pipeline_stages` and its siblings are created and tenant-scoped by
migration `002_tenant_rls.sql`; `crm/engine/routes.ts` contains zero handlers
for them. The feature is schema-only.

**Gap — `forms` advertises a `file` field type it cannot accept.**
The field-type enum includes `'file'`, but submission is parsed with
`c.req.json()` — there is no multipart path, so a file field can never receive
a file.

**Gap — `hr/time-tracking` numbers invoices with `COUNT(*) + 1`.**
`'INV-' || to_char(NOW(),'YYYYMMDD') || '-' || LPAD((SELECT COUNT(*)+1 FROM zvd_invoices)...)`.
Two invoices created in the same transaction window collide, and deleting an
invoice reuses a number.

**Gap — `auth/scim` has no Groups CRUD.** `/Groups` answers with an empty list
rather than 501, which is arguably worse: a provisioning client reads it as
"this tenant has no groups" instead of "unsupported".

**Gap — `projects/helpdesk` Studio and API disagree on field names.** The
Studio form sends `subject`/`body`; the API expects `title`/`content`.

---

## 3a. The gates themselves

Read file by file on 2026-09-04 (campaign section E01, the twelve tenancy/SQL
gates). Seven defects were repaired in that session and pinned by
`packages/engine/src/tests/harness/gate-planted-variants.test.ts`; what follows
is what was left. Each was found by planting a violation and watching the gate
stay green — none of it is visible by reading the regex.

**Gap — `check-tenant-table-on-pool` judges an empty set.** It matches the
literal `poolDb.` under `routes/`, and measured on 2026-09-04 there are **zero**
such sites: all four pool-backed routers receive the raw pool under the parameter
name `db` (`app.route('/api/insights', insightsRoutes(poolDb, auth))` is
`function insightsRoutes(db: Database)` inside), so every query in them is spelled
`db.selectFrom(…)`. The gate has never judged one of the sites it exists for. Its
success line now prints the reach so the emptiness is visible, but closing the
hole means teaching it to resolve the alias — which would start failing on
production code (`insights.ts` queries `zv_dashboards`, `zv_panels` and
`zvd_insight_saved_queries` on the pool; spot-checked handlers do filter
`tenant_id` by hand, as the design requires). That is a decision about the
routers, not a repair to the gate.

**Gap — `check-atomic-writes` is silenced by any `.transaction(` in the slice.**
The check is `if (/\.transaction\s*\(/.test(part)) continue`, so a handler that
opens a transaction for an audit-log write and then does two unwrapped writes
beside it is skipped entirely. Planted and confirmed. The file's own header
argues that separating this properly needs a parser rather than a regex, and that
remains true — but the escape is not among the two blind spots it documents.

**Gap — `check-tenant-boundary` credits any `ARRAY[…]` in a file that also
creates a `tenant_isolation` policy.** 24 tables get their "policed" status only
through that path, and the array need not be an RLS loop — a list of table names
used for index maintenance in the same file would do. Verified rather than
assumed: the gate's whole classification was compared against
`pg_class.relrowsecurity` on a full engine+54-extension install, and it is
**exactly right — 0 divergences in either direction** across 333 tenant-scoped
tables. The heuristic is currently telling the truth; it is the *reason* it does
so that is fragile.

**Gap — `bun run audit:gates` cannot run in a checkout that has built the
Studio.** The pre-flight refuses when a `create` probe path already exists, and
`packages/studio/dist/.zveltio-studio-version` is an ordinary local build
artifact — so the meta-gate aborts before planting anything. CI is unaffected
(nothing has built the Studio there yet). Reported as fixed on `master` after
this checkout's base: a colliding path now skips that one case instead of
aborting the run.

**Gap — `check-jsonb-binding` cannot see a `JSON.stringify` behind a variable.**
Widened on 2026-09-04 to catch it behind a ternary — which is how the one live
defect it then found was written — but a value assigned to a local first, and the
raw-value case its own header already declines to claim, both need type inference
rather than a wider regex. A clean run is not proof; use `toJsonb` and the
question does not arise.

**Gap — the local `zveltio-extensions` checkout drifts silently.** Every
sibling-scanning gate reads whatever is on disk, so a checkout behind
`origin/master` reports failures that do not exist on master — measured at 8
commits behind on 2026-09-04, producing 45 phantom `jsonb-binding` sites. The
gates cannot tell staleness from a defect, and neither can a reader of their
output. Pull the sibling before trusting any local gate run.

**Gap — a harness test that writes falls back to whatever `.env` names.**
`process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL`, plus Bun's
auto-loading of the nearest `.env`, means the database a writing test connects to
depends on the directory it was launched from: `zveltio_test` from
`packages/engine`, and **`zv_dev` — the development database — from the repo
root**. Three harness files share the pattern (`pool-autosize`,
`gate-numeric-arith-fails-closed`, `jsonb-notification-binding`) and the last two
INSERT rows. A test that writes should refuse to run without an explicit test URL
rather than quietly pick one; `skipIf` on an absent variable is the wrong shape
here, because the variable is rarely absent — it is merely wrong.

**Gap — six of the thirteen gates have no test of their own.** Only
`check-numeric-string-arithmetic` had one before 2026-09-04;
`gate-planted-variants.test.ts` now covers seven more, but each pins the specific
variant that was repaired rather than the gate as a whole. The remaining six —
`check-atomic-writes`, `check-duplicate-table-creators`,
`check-insert-schema-match`, `check-raw-sql-identifiers`,
`check-tenant-boundary`'s ARRAY path and `check-numeric-string-arithmetic`'s
detector half — are still proved only by the planting harness, which means that
when it cannot run, nothing checks that they still bite.

**Open question, for whoever reviews the read path — row rules do not reach
virtual collections.** `lib/data/handlers/list.ts` serves the virtual branch and
`return`s from it well before the "RLS injection" block, so a virtual collection
gets column permissions and no row filtering. Found while establishing that
`virtual-collection-adapter.ts` is not a hand-written copy of the rule
interpreter (it is not — it renders the caller's own `?filter=` for a third-party
API). Not verified against intent; it may well be the only thing that can be done
when the rows come from someone else's database. It looks identical either way,
which is the reason it is written down.

### E02 — authorisation, audit and structure gates (2026-09-04)

Read file by file, eleven files. Nothing was repaired in that session: every
finding below is a gate's own regex or scope, and repairing eight gates in the
session that found them would land eight unreviewed changes at once. Each was
found by **planting** the shape and watching the gate stay green — twenty plants
in all. Each is currently **unexercised**: the offending spelling appears zero
times in the engine and zero times in the sibling, verified per finding. These
are holes in a guarantee, not live violations.

**Gap — the meta-gate proves existence, not coverage.** `audit-gates.ts` plants
ONE shape per gate. Six of the gates it certifies fail a second shape, listed
below. It already knows the class — `check-raw-sql-identifiers` carries a second
case named `(multi-line call)` — so the lesson was learned once and never
generalised. This is the finding the other seven are instances of, and the reason
"43/44 gates caught their violation" is a weaker statement than it reads as.

**Gap — `route-collision-check` reports the same success over a third of its
corpus.** `walkRouteFiles` swallows a missing directory, so with no sibling it
scans **37 files instead of 112** and prints an identical `✅ No route-ordering
collisions`, exit 0. Nothing in the output distinguishes them. It is the one
sibling-reading gate in this section that does not call `requireSibling`.

**Gap — `check-ambient-authority` cannot see `Bun.env`.** It scans for
`process.env`. `Bun.env` hands an in-process extension the same
`DATABASE_URL` / `BETTER_AUTH_SECRET` / `FIELD_ENCRYPTION_KEY` the gate's own
header names, and the runtime is Bun — `AGENTS.md` tells contributors to prefer
Bun APIs. Its success line says "no extension reads process.env", which is true
and misleading. `node:fs` and `process.env` are both caught; only the Bun
spelling is not.

**Gap — `check-gate-coverage` misses gates not invoked as `bun run`.** It parses
workflows for `bun run X`. Four steps use `bun scripts/X.ts` instead; three are
generators, but `packages/studio/scripts/check-contributions-registry.ts` calls
`process.exit(1)` from `studio.yml`, has no planted case, and appears in neither
`not_a_gate` nor `uncovered`. An unproven gate of exactly the kind this ratchet
exists to catch, invisible for two compounding reasons: the invocation form, and
the assumption that gates live in the root `scripts/`.

**Gap — a commented-out `auditLog` satisfies the audit requirement.**
`audit-inventory.ts` tests `/\bauditLog\s*\(/` against the raw handler slice
with no comment stripping. Planted: with both calls in `sql-editor.ts` deleted
the regression check fails correctly; with both **commented out** it passes,
reporting "24 mandatory handlers audited". A false negative on a compliance
artifact, which is the dangerous direction. `check-env-documented`, in this same
section, strips comments before scanning — the technique is known here.

**Gap — `admin-gate-check` is defeated by the repo's own formatter.** The scan is
line by line, so `checkPermission(u, 'admin', '*')` wrapped across lines — which
Biome's 100-character width will do inside any longer expression — is invisible.
Double quotes escape it too. Both planted, both exit 0.

**Gap — `check-fabricated-success` sees one spelling of the same catch.**
`LOOKBACK = 4` lines from the query call, and the value must be an inline arrow.
The same `.catch(() => [])` five lines below the `.execute()`, or extracted to a
named fallback (`.catch(emptyList)`), is invisible. Extracting a repeated
fallback into a named function is ordinary refactoring, which is what makes the
second shape more than theoretical.

**Gap — `check-env-documented` matches only `process.env.X`.** `Bun.env.X` and
`const { X } = process.env` are invisible. Lower severity than its
ambient-authority twin: this one measures documentation completeness, not access.

### E04 — coverage, ratchet and release gates (2026-09-04)

Four files, finishing the section E04 opened. Nothing repaired here either.

**Gap — `RELEASE_GATE_SKIP_NETWORK=1` turns three checks into ticks.**
`required CI green`, `latest soak green` and `no open P0 issues` return
`ok: true` with the detail `skipped (offline)`, print as **✓**, and the summary
reads `all 7 checks passed` having verified four. The detail is honest; the tick
and the total are not. `audit-gates.ts`, in this repository, already solved the
same problem the other way — a skipped case is listed separately, repeated in the
summary and fatal in CI.

**Corrected the same day, while reading E08:** `RELEASE_GATE_SKIP_NETWORK` is
set nowhere in `.github/` or `package.json`, and `release.yml` runs the gate with
`GH_TOKEN`. So this is the shape of the escape hatch, not a live gap in the
pipeline — it was written up before that was checked.

**Gap — the release gate's coverage check never measures.** `checkCoverage()`
reads `measured` and `target` out of `quality-gates/coverage-baseline.json` and
compares them **to each other**. Both are hand-maintained in that one file, whose
own notes record the recorded number going stale three times (2026-08-19,
08-23, 09-03) — each time discovered because a pull request paid for it. So the
check that gates a stable cut can pass on a number nobody has re-measured since
the last drift.

**Gap — the campaign's own generator does not validate what it is told.**
`review-inventory.ts` builds `reviewed` as a flat set of every path in every
session's `files`, so a session's declared `section` is never enforced against
them. Planted: an `A05` file recorded under an `E02` session left A05 reading
**1/7 with "last session —"** — a section partly reviewed by nobody. A path in
no section, or one that does not exist, is accepted in silence. The coverage
number this campaign rests on accepts input it cannot check. Found by
self-review, which is the weakest kind: it should be re-read by another session.

**Gap (low) — `merge-coverage.ts` assumes the lcov and the tree agree.**
`nonExecutableLines()` reads today's source to decide which lines of a report are
non-executable, with nothing checking that the report was produced from that
source. A missing file fails conservatively — nothing is dropped, so coverage
reads low. A *changed* file does not: line numbers shift under the filter and the
error can go either way.

### E08 — what CI actually runs (2026-09-04)

Twenty-one files. The section's question was which gate runs, on which event, and
which job is allowed to fail. The answer is mostly reassuring and was measured,
not read: **44 of the 56 gate scripts run in a `pull_request` workflow**; the two
that do not are release-time (`release-gate`, `sync-engine-version`); the ten
referenced by no workflow are one-shots, probes and codemods, none of them gates.
The E01-era state — "9 gates of 31" — is gone.

**Gap — E2E never runs on a pull request.** `e2e.yml` triggers on
`push: branches: [master]` and `workflow_dispatch`. A pull request can break every
Playwright spec and merge green; the signal arrives afterwards, on master, where
it is a bisect rather than a review comment.

**Gap — two workflows install without `--frozen-lockfile`.** `build.yml` and
`e2e.yml` run a bare `bun install`, so the job that validates `bun run build` and
the browser suite may resolve dependency versions the lockfile does not pin —
they are the two least likely to be reproducible. Every other workflow passes the
flag; `dependabot-lockfile.yml` omits it legitimately, since rewriting the
lockfile is its purpose.

**Gap — a release can finish green with the extension registry a version behind.**
`sync-extensions` is `continue-on-error: true` and its only action is a
fire-and-forget `createDispatchEvent` to the extensions repository. Nothing checks
that the dispatch arrived or that the downstream sync ran, and the failure renders
neutral rather than red. The trade is right — an infra flake must not lose a
release, and beta.9 was lost exactly that way — but the detection is missing.

**Gap (low) — `bunx` in two workflows.** `client.yml:47` and `studio.yml:54` call
`bunx svelte-kit sync`. This repository's rule is `bun x`, and `bunx` is absent
from the Bun install the documentation describes — E04 logged the same defect in
`suppress-existing-any.ts`, where it threw ENOENT. `e2e.yml` uses `bun x` in three
places, so this is an incomplete fix, and it means those two steps cannot be
reproduced locally on a machine set up as documented.

**Gap (low) — a step named "Smoke test auth endpoint" cannot fail.** It contains
only `curl` calls that echo their output, two of them with `|| true`, and asserts
nothing. Someone reading the log sees a smoke test that passed. In the same file
`bun audit` is named "Report all advisories (informational)" and paired with a
gating step — the repository already knows how to name a diagnostic.

**Verified clean, recorded so nobody re-derives it.** `bun audit || true` and the
coverage `|| true` are report-then-gate *pairs*: the enforcing step sits directly
above each. The three `continue-on-error: true` jobs in `release.yml` are
post-release side effects, each with its reason written down. Dependabot covers
both `npm` and `github-actions`, and all fourteen actions are SHA-pinned.
`dependabot-lockfile.yml` combines `pull_request_target`, `contents: write` and a
checkout of the PR head — a shape that is usually a vulnerability — and is
correctly guarded: the job-level actor check admits only Dependabot, and Bun runs
no lifecycle scripts by default (no `trustedDependencies` is declared).
`release-gate` is wired so that `publish-release` needs it. The sibling clone
resolves a paired branch of the same name before falling back to master.

### A04 — tenancy core (2026-09-04, partial)

Four of five files read; `tenant-manager.ts` is only partly read and the section
stays open. Everything below was produced by probing, not by reading.

**Gap — an unknown `x-tenant-slug` takes the request out of tenant isolation.**
`resolveTenantFromRequest` returns `getTenantBySlug(slug)` directly for the header
branch, so a slug that does not exist yields `null`, and `tenantMiddleware`'s
`else` runs the request with no tenant and no transaction. The subdomain branch
twelve lines below handles precisely this case, and says why: *"null silently
disables the tenant GUC, which breaks RLS in the worst possible way (empty reads
+ 500 writes)"*. Priority 1 — the path the Studio uses on every request — never
got the same fallback.

Proven with the engine's own instrument: `/api/webhooks` with a real slug reports
**0** unscoped fallbacks; with `x-tenant-slug: no-such-tenant-anywhere` it returns
**200 and 1 unscoped fallback**, meaning the handler ran on the pool rather than
inside the tenant transaction.

**A suspended tenant takes the same path, and that is the realistic trigger.**
`getTenantBySlug` filters `status = 'active'`, so a suspended tenant's slug also
returns `null`. Measured: `/api/webhooks` with a suspended tenant's slug returns
**200 with 1 unscoped fallback** — not the `403 Tenant account is suspended` the
middleware has for exactly this case. That 403, at `middleware/tenant.ts:134`, is
unreachable through the slug path, because the lookup feeding it already filtered
the row out. Suspending a tenant is an ordinary administrative action — non-payment,
offboarding — and it does not refuse those requests; it moves them out of tenant
isolation and answers 200.

The consequence is route-dependent, and it was measured rather than assumed. With
two tenants seeded, the bogus slug returned **only the default tenant's row** —
`tenantId(c)` falls back to `DEFAULT_TENANT_ID`, so a handler that adds its own
`tenant_id` predicate contains the damage to the default tenant. A handler relying
on RLS alone would run as the engine's own role, which in the recommended
`enforced` deployment is the privileged one. So: proven loss of isolation,
unproven leak, and which of the two you get depends on the handler.

**Gap — `ZVELTIO_FAIL_CLOSED_TENANT=1` can boot without being applied.**
`applyFailClosedTenantSetting` wraps its whole body in `try/catch → console.warn`.
Measured: a non-owner role gets `ERROR: must be owner of database` from
`ALTER DATABASE … SET`, and that error lands in the same catch as the harmless
`current_database()` probe. An operator who explicitly asked for contextless
queries to see zero rows can therefore start an engine where they do not.

The repository already holds the right standard three hundred lines away: an
unenforceable `zveltio_rls` role is **fatal in production**, with an explicit
`ZVELTIO_ALLOW_UNENFORCED_RLS` override, and the comment there says exactly why a
warning is the wrong instrument — *"it scrolls past during a deploy"*. The
existing unit test pins only the probe failure, not the `ALTER` failure.

**Gap (low) — `encodeTenantSet([])` and `encodeTenantSet(null)` are the same
string.** Both produce `''`, which the predicate reads as "no set published" and
answers with the equality fallback. The only paths reaching `[]` are an `org`
reach and the god branch over an empty `zv_tenants`, so the effect is a narrowing
to the own unit — the safe direction — but the two states cannot be told apart in
the GUC.

**Gap — the schema-per-tenant machinery is vestigial, and it looks like isolation.**
`provisionTenantSchema` creates `tenant_<slug>` with its own
`zvd_collections` / `zvd_relations` / `zvd_permissions` every time a tenant is
created, and **nothing in the data layer reads them**. `tenantSchema` is set by
the middleware and consumed by no data route; no `search_path` is set for these
schemas (the preview-environment middleware sets one for *branch* schemas, a
different feature). Forty-five of them had accumulated in a single test database.

Its one apparent consumer is the proof that the path has never run:
`runQualityScan` accepts a `tenantSchema` and builds
`` `${schema}.zvd_${collection}` ``, which reaches `sql.id()` as one dotted
string. Measured — `SELECT … FROM "probe_sch.t"` answers *relation does not
exist*, while `"probe_sch"."t"` works — so the parameter cannot do what it says,
and it is exposed to extensions through `ctx.internals`.

The cost is not the dead code. An operator who inspects the database and finds a
schema per tenant will reasonably conclude that tenant data is separated by
schema. It is not: isolation is row-level, in `public`. Fixing this is an owner
decision rather than a patch — either the machinery goes, or it is wired up and
the identifier bug fixed.

**Gap (low) — the extension reconciler drops a policy before creating its
replacement.** `DROP POLICY` and `CREATE POLICY` run as two statements on the
pool rather than one transaction, so between them the table has RLS enabled and
no policy. That is the fail-closed direction — a non-owner sees zero rows — but
live traffic on that table reads empty for the duration rather than reading
correctly.

**Verified clean, and worth recording because it is the answer to the question
this campaign keeps asking.** `unscoped-fallback.test.ts` carries a **positive
control**: a second test that produces a fallback on purpose and asserts the
counter moved. Planting an empty tenant-scoped table set makes that test fail, so
a zero in the first test cannot be a counter that never ran. Predicted a hole
here; the code defended itself.

### A05 — RLS policies and row rules (2026-09-04)

Seven files. Nothing repaired; every finding is measured.

**Gap — the same rule means different things on the realtime path.**
`rule-operators.ts` exists because one rule was interpreted in four places and
drifted; its header records the last instance as *"a leak — `neq` against a NULL
column: absent from `/api/data`, delivered over SSE"*. The same shape is still
there, with a different cause. Comparison is textual — `String(a) === String(b)`
— which is right for SQL and for the JSONB snapshots, and wrong for realtime,
where the record comes straight from the write pipeline and a `timestamptz` is a
JavaScript `Date`. Measured:

    rule "created_at neq static:<iso>" — meant to HIDE rows
      SQL / as_of (string)  keep = false   row hidden, as intended
      realtime  (Date)      keep = true    row DELIVERED over SSE

Numerics do the same: `score neq static:5.0` hides in SQL and delivers on
realtime. `eq` under-delivers, `neq` over-delivers — and `neq` is the operator
you reach for to hide something. The file unified the *decisions*; the four
appliers still receive different *types*.

**Gap — a subscription that cannot resolve its policies gets none.**
`routes/realtime.ts:488` reads `getRlsFilters(...).catch(() => [])` and
`getColumnAccess(...).catch(() => null)`. Empty filters mean no row policy;
`null` columns mean no masking, because line 293 sends the raw record when
`access?.columns` is falsy. Three lines below sits the comment *"a masked field
must not arrive over SSE just because it arrived as an event rather than as a
response"* — the intent is explicit and the error path contradicts it.
`catch:fabricated` reports zero sites here: its window is four lines from a query
call and these are not query calls. That is the E02 finding about the gate's
scope, now with a live instance on a security path.

**Gap — the row-rule predicate leaves its own optimisation on the floor.**
`valueExpr` defines a `guc()` helper that produces the InitPlan form
`(SELECT current_setting(…))`, with a comment measuring it at 0,769 ms against
0,257 ms and noting *"The row-rule generator was written without it"*. The helper
has **zero call sites**. The bypass and actor guards are wrapped; the value
comparison — the one compared against the column, and therefore the one that
decides whether an index can be used — is emitted bare. Measured independently on
50 000 rows:

    bare current_setting(...)          Bitmap Heap Scan   cost 60.19
    (SELECT current_setting(...))      Index Only Scan    cost  2.51

**Gap (low) — an unknown value source fails open where an unknown operator fails
closed.** `resolveValue` returns `null` for a source it does not know and the
caller does `continue`, with the comment *"fail-open for this policy"*. In the
same file, an unknown *operator* refuses the query outright. The admin route's
Zod refine closes this at the API boundary — it was added after a rule stored as
`user.id` resolved to nothing — so what remains is defence in depth, and a
residue question for rows written before that refine landed. `user_email` also
resolves to `null` when the session object carries no email.

**Gap (low) — `assertEnforceable` skips its own check.** It returns early for
`collection === '*'` and for a collection whose table does not exist yet, so a
policy can be stored in exactly the state the read path then fails open on.

**Gap (low) — only the literal string `'deny'` denies.** `entity-access` treats
anything else as allow, including the `boolean` an extension author would
naturally return from `record.ownerId === user.id`. The extensions repository
compiles with `strict: false`, so that is not caught by the author's own
typecheck. A *throwing* check does fail closed. Unexercised today — no extension
registers one, and the test harness stub's `register()` is a no-op, so an
extension cannot test one either.

**Gap — `prepush` reformats the tree it is checking, and root `package.json` is
in no section.** The chain is documented as the local contract for a pushable
tree; `check:schema` runs `bun run format` in **write** mode before the later
`format:check`, so an unformatted commit is silently repaired in the working tree
and the chain passes on the repaired state. Measured while closing this section:
`prepush` reported OK, the commit that was then pushed failed `format:check`, and
only CI would have caught it. Separately, root `package.json` — which defines the
prepush chain and every gate's entry point — matches no section's file pattern,
so it is outside the campaign entirely.

**Verified clean.** `signed-cache.ts` binds the HMAC to namespace and key, uses
`timingSafeEqual` behind a length check, and decodes a tampered entry to `null`
so the caller asks the database. `loadPolicies` falls through to the database on
any cache failure. The admin route refuses an unknown `filter_value_source` at
the boundary.

### A06 — permissions, roles, column access (2026-09-04, partial)

The escalation this section found is fixed and shipped as its own change; what
follows is what was left.

**Gap — column masking is bypassed by a hardcoded role name, and it names the
wrong role.** `getColumnAccess` opens with
`if (role === 'admin' || role === 'superadmin') return { hidden: new Set(), … }`.
Measured against every value the schema permits on `"user".role`
(`001_initial.sql:1160` allows `god`, `admin`, `manager`, `member`):

    role='member'      salary hidden      correct
    role='admin'       nothing hidden     full bypass
    role='god'         salary hidden      the most privileged role IS masked

So the bypass names a role that is not the top one and omits the one that is. A
user set to `admin` sees every hidden column, with no policy row expressing it
and no way to revoke it short of editing code — which is exactly what
`getRlsFilters` removed, and its comment says why: *"a string comparison against
a role name is invisible, unauditable and impossible to revoke."* `superadmin` is
a dead branch: not in the CHECK constraint, and absent from the rest of the
product.

**Gap (low) — `resource-grants.ts` cites a gate that does not exist.** Its header
names `scripts/check-extension-resources.ts` twice as the build-time check that
fails when a `permissionGate` call uses an undeclared resource. There is no such
script, and nothing in `scripts/` scans `permissionGate` calls. It is named as one
of the two compensating controls for the owner decision of 2026-08-30 that removed
the frozen `KNOWN_EXTENSION_RESOURCES` list. The other control is real —
`listKnownResources` collects installed extensions that declare nothing and names
them at boot — so the stated minimum is half-met.

**Predicted and disproved, recorded so it is not re-derived.** `checkPermission`
files every resource no policy mentions under one cache key, and computes the
answer with the real name — so a stale policy-object index could cache one
resource's *allow* under the shared unknown key. It cannot: every policy write
reaches the database through the Casbin adapter, which drops the memo and the
index on each call *"whichever route or boot task called it"*, and the routes
clear the shared cache as well. Two independent defences.

---

## 4. Deliberate deferrals

| Deferred | Why | What would change it |
|---|---|---|
| **WASM as the default extension runtime** | Process isolation is cheaper and already shipped. WASM ≠ Rust — the cost is an ABI surface, not a language. | A tenant being able to upload extension code. |
| **Cloud / hosted offering** | Target market is self-hosted first: companies and public institutions on their own hardware. | A deliberate market decision, not an engineering one. |
| **SOC 2 / ISO 27001 certification** | No customer has required it yet. | A customer requiring it. |
| **Multi-region replication** | The deployment shape is one organisation, one site. | Demand from a genuinely distributed institution. |
| **A third form helper in Studio** | `SchemaForm` covers dynamic schemas, hand-rolled covers small forms. A middle layer would be used twice. | See [../ui/patterns.md](../ui/patterns.md). |

---

## 5. Roadmap, not gaps

Longer-range work — performance regression testing in CI, N+1 detection,
migration tools from other SaaS products, partner programme, community presence
— is tracked in [`../private/TECHNICAL-GAPS.md`](../private/TECHNICAL-GAPS.md),
which carries priorities and status per item. That file is a roadmap; this one
is a defect list. Do not merge them.

---

## 6. Keeping this list honest

When you fix something here, delete the entry in the same commit that fixes it.
When you find something new, add it here rather than opening a document of its
own — the previous convention produced nineteen audit reports whose findings had
to be re-verified against source before any of them could be trusted.

The verification traps in [security.md](security.md) §3 apply to this list too:
a green test proves nothing if the module has no non-test importer, and
`RETURNING *` will happily echo a column the database dropped.
