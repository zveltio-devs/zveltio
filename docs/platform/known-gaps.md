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

**Gap — a backup schedule's `retention_count` is accepted, stored and shown,
and enforced by nothing.** `POST /api/backup/schedules` validates and persists
`retention_count` (`zv_backup_schedules.retention_count`, default 7) and
`PATCH` lets it be edited; `GET /schedules` returns it. No code anywhere reads
the column. The only pruning that exists — `cleanupOldBackups`, a hardcoded
top-20-by-`created_at`, global across every schedule — is now called from
`runScheduledBackup` (`lib/backup/run-scheduled-backup.ts`) after a completed
dump, having previously run only from the one-off `POST /api/backup` button; a
firing cron schedule or a manual trigger no longer accumulates rows in
`zv_backups` and files under `BACKUP_DIR` without limit (measured live before
the fix: 5 successful scheduled runs left 5 rows and 5 files, uncapped).
Giving a schedule's own `retention_count` effect needs `zv_backups` to carry a
`schedule_id` it does not have today, so backups from different schedules (or
the ad-hoc button) can be told apart before pruning — a migration and an
insert-path change wider than `lib/backup/`, logged rather than built here.
Reviewed 2026-09-13, section B10.

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

**E08 closed 2026-09-12 — last file, `private-docs.yml`, verified clean.** The
gate it runs, `scripts/check-private-docs-untracked.ts`, was measured against
both failure modes it names in its own comment, not just read: force-adding a
file under `docs/private/` (`git add -f`) made the gate fail with the correct
file list, and removing the `docs/private/` line from `.gitignore` made it
fail with the correct "not ignored" message. Both reverted after. The
"`CI checks each repository in its own job`" claim in the script's docstring
is real — `zveltio-extensions` carries its own `.github/workflows/private-docs.yml`
running the same script against itself, not a second invocation from here.
`git ls-files`'s exit code is not checked (only its stdout), so a root that
does not exist reports a misleading "not ignored" message instead of "root
missing" — but the only roots this workflow ever passes are `.` in each
repository, which always exist, so this is not reachable from CI input; not
logged as a gap. The `import { $ } from 'bun'` in the script is unused (it
explains in a comment why it switched to `Bun.spawnSync` and never removed
the import) — a lint nit, too trivial to log.

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

**Predicted and disproved (2).** `invalidateGodCache` returns early when there is
no shared cache, which would leave the in-process god memo answering `true` for a
demoted god — the exact failure `invalidatePermissionCache`'s comment warns about.
It does not: the early return sits *after* `clearLocalPermissionCache(userId)`,
whose per-user branch deletes `_localGod`. The first reading used a window that
had cut off the function's first line.

**Verified clean — the recovery endpoint.** `POST /api/permissions/bootstrap`
hands out the god role without a session and is registered *before* the route
file's blanket guard, which is deliberate and conditioned: `RECOVERY_TOKEN` of at
least 32 characters (403 when unset), constant-time comparison, single use by
token fingerprint stored in `zv_settings`, the spent-check placed **after** the
match so a refusal cannot reveal whether a recovery has ever happened, every
refusal written to the audit log, and its own rate-limit bucket so an unrelated
burst cannot lock recovery out.

**Predicted and disproved, recorded so it is not re-derived.** `checkPermission`
files every resource no policy mentions under one cache key, and computes the
answer with the real name — so a stale policy-object index could cache one
resource's *allow* under the shared unknown key. It cannot: every policy write
reaches the database through the Casbin adapter, which drops the memo and the
index on each call *"whichever route or boot task called it"*, and the routes
clear the shared cache as well. Two independent defences.

### A02 — the middleware chain (2026-09-05, closed 17/17)

Five of seventeen files. The escalation this chain carried is fixed and on
master; what follows is what else the reading found.

**Gap — a preview token is bound to no tenant.** `previewEnvMiddleware` selects
on `preview_token` alone, with no tenant predicate, and `zv_schema_branches`
carries **no `tenant_id`, no row-level security and no policy** — measured. So the
token is a bearer credential belonging to nobody in particular, and presenting it
sets `SET LOCAL search_path` to that branch's schema for the request while the
tenant GUC still names whoever presented it.

Not verified, and it decides the severity: whether that yields a cross-tenant
read depends on the branch schema's own tables. No branch schema existed in the
verification database — and every non-public schema that does exist carries no
RLS at all, which is not reassuring but is not the same measurement.

**Gap (low) — a 0-byte `middleware/url-validator.ts`.** Tracked by git, imported
by nothing, sitting beside the real SSRF guard at `lib/security/url-validator.ts`.
Someone grepping `middleware/` for it finds a file and concludes the middleware
exists.

**Verified clean — the `/ext/*` gate cannot be walked around by path shape.**
The gate applies on `path.startsWith('/ext/')`, which is the classic place a
bypass hides. Seven forms were tried — `//ext/`, `/ext//`, `/EXT/`, `/ext/./`,
`/ext/x/../`, and percent-encoded `/%65xt/`. Hono normalises and decodes *before*
middleware runs: every form that reached the handler was seen by the gate with the
correct prefix, and the forms the gate did not see returned 404 without reaching
anything.

**For the owner, not filed as a defect.** `tenantMembershipMiddleware` skips the
membership check entirely for the default tenant, and a request with no slug
resolves to it. That is correct for the single-tenant model the comment cites. It
is worth a decision for the hierarchical multi-tenant market this product targets,
where the root tenant holds a real organisation's data and every authenticated
user of every subordinate unit can reach it by sending no header at all.

#### The remaining twelve files (2026-09-05)

Two security controls in this chain did not do what they said. Both are fixed
with a test that discriminates, each in its own pull request.

**Fixed (#447) — the rate limit could be switched off by a header.**
`X-Forwarded-For` was always pattern-checked before it was believed; `X-Real-IP`
was read verbatim under `TRUSTED_PROXY` and used as the bucket key. Measured
against a limit of two: a client sending a different junk `X-Real-IP` per request
answered 200 five times, because every distinct string is its own bucket. Not a
weaker limit — the absence of one. The middleware's own warning to operators
named only `X-Forwarded-For`, so following it literally left the hole open.

**Fixed (#447) — `MAX_STORE_SIZE` bounded nothing and cost everything.** The
fallback limiter's sweep drops only expired entries, so the size trigger deleted
exactly what the timer would have deleted anyway. What it did do was run a
full-map scan on *every* request once the store passed 5 000 live entries.
Measured, one request per unique identifier: 0.0081 ms/request at 5 000 rising to
2.1 ms at 80 000, flat at 0.006 ms after the fix. Heap was never the issue
(~20 MB at 100 000), so the comment named the wrong risk. This is the no-cache
path — the default shape of a small self-hosted install.

**Fixed (#448) — one percent-encoded letter walked past every demo-mode rule.**
The gate matched on `new URL(c.req.url).pathname` while the router matched on
Hono's decoded path. `POST /api/admin/%73ql` ran the SQL editor;
`POST /api/b%61ckup` took a database dump. On a demo instance — public sign-up,
visitors given room to explore — that list *is* the boundary. The existing suite
was green throughout because it handed the middleware a literal
`{ req: { url, method } }`, an object with no `req.path`: it measured the pattern
list, not the gate.

Worth keeping side by side: `tenant.ts` asks the same question about the same
kind of list and answers it correctly, matching `TXN_SKIP_PREFIXES` against
`c.req.path`. Same directory, same decision, two answers.

**Gap — the audit trail records an IP the caller chooses.** `god-audit.ts` and
`request-log.ts` both take `x-forwarded-for` / `x-real-ip` with no
`TRUSTED_PROXY` check and no validation, and write the result to `zv_audit_log`
and `zv_request_logs`. `rate-limit.ts` refuses to trust exactly those headers
without the flag, in the same directory. The god audit is the accountability
mechanism for the one role that bypasses every permission check, and the IP it
records can be set by whoever is being audited. (`tracing.ts` does the same for
`net.peer.ip`, which is telemetry and matters less.) Not yet fixed — the change
belongs on top of #447, which touches the resolver these three should share.

**Gap — a tenant's daily quota is not enforced without a cache.**
`tenantQuota` returns `next()` when `getCache()` is null, so on an install with
no Valkey the quota does not exist. The header says "uses a Redis counter as the
fast path", which reads as an optimisation; the effect is absence, not
degradation. Same install shape as the rate-limit fallback above.

**Gap in a gate — `check-tenant-table-on-pool` stops at `routes/`.** Its own
documentation explains why it does not scan `lib/`: there the unscoped handle is
spelled `db`, so the gate would catch nothing or drown. That reasoning does not
apply to `middleware/`, which holds three pool queries and names the handle
`poolDb` twice. Measured with the gate's own regex and its own table list: one of
the three touches a tenant-scoped table (`zv_tenant_usage`).

It is correct today — the write sets `tenant_id` explicitly. But note what
extending the directory alone would achieve: that one call site is reached
through an alias, `const quotaDb = poolDb ?? db`, which the gate's regex does not
match. The gate would gain a directory and still report clean over the only case
in it.

**Low — the worker host hands extensions an undecoded path.**
`lib/worker-extension-host.ts:646` computes a worker route's path as
`new URL(c.req.raw.url).pathname.replace('/ext/<name>', '')`. With the extension
name percent-encoded, the replace does not match and the worker receives the
whole path instead of the suffix. Not an escalation — the extension 404s — but it
is the same disagreement between what the host routed and what the consumer sees.

**Verified clean, with the measurement.**

- `TXN_SKIP_PREFIXES` is a `startsWith` list, so a mount could skip the tenant
  transaction by accident. Checked all 37 registered mounts: the only one that
  matches without a segment boundary is `/api/openapi.json` under `/api/openapi`,
  which is intended.
- The four schema routers skip the transaction on the stated grounds that they
  touch instance-level metadata. Confirmed against a live catalogue:
  `zvd_collections` and `zvd_relations` carry no `tenant_id` at all.
- `enrich-denial` names up to three people who can grant access. It scopes to the
  current domain, but deliberately includes grants held at `*`, so on a
  multi-tenant install an instance-wide admin's name is offered to users of every
  tenant. Names only, capped at three, and the trade-off is written down in
  `denial.ts` — recorded here because it is a disclosure decision, not an
  accident.

### A03 — error surface, health, API description (2026-09-13, closed 9/9)

**Fixed — `GET /api/health/:subsystem` gave any authenticated member the
reconnaissance `/api/health/deep` is gated to keep from them.** `/deep`
requires `requireInstanceAdmin` and its own comment says why: it "enumerates
every subsystem an operator runs — database, cache, object storage, message
bus, each extension's own probe — with its failure text," which is
reconnaissance an ordinary member has no use for. `/:subsystem`, ten lines
below, checked only `requireAuth` — any session at all — and answers the
identical per-subsystem data one name at a time (`database`, `storage`,
`extensions`, any `ext:<name>:<check>`), including extension failure text.
Measured live: a freshly signed-up, non-admin member got `403` from `/deep`
and `200` from `/database`, `/storage` and `/extensions` individually. Fixed
by adding the same `requireAdmin` gate to `/:subsystem` in
`routes/health.ts`; the existing harness suite only ever drove this route
with a god session, so it could not have caught the gap (class 13 shape —
the test exercised the path near the guard, not the guard). Added
`GET /api/health/deep → 403 for an authenticated non-admin member` and the
`/:subsystem` equivalent to `health-routes.test.ts`, both against a real
`createMemberSession`; reverting the fix makes the new `/:subsystem` case
fail (`403` expected, `200` received) while the pre-existing cases stay
green. `routes/openapi.ts`'s spec for this path corrected to say "instance
admin required" and gained a `403` response entry, matching what `/deep`'s
entry already said.

**Verified clean — `mapPgError`'s class-16 shape does not repeat here.**
`problem.ts:162-163` checks both `err.code` and `String(err.errno)` for
`22P02` (Bun.SQL puts the SQLSTATE in `errno`, not `code`), and
`problem-invalid-parameter.test.ts` pins both the Bun.SQL and node-pg shapes
plus a control case that an unrelated error stays a 500. This is the file
the campaign document names as already knowing the trap.

**Verified clean — no leaked internals in the unified error envelope.**
`problemOnError`'s catch-all never surfaces a thrown error's own message
(`problem-envelope.test.ts` pins that a thrown `Error('internal secret
detail...')` never reaches the response body); `HTTPException` messages are
surfaced deliberately because they are developer-set at the throw site, not
driver/DB text. `GET /api/health` (public) carries no engine/schema/runtime
detail — pinned by the integration suite.

**Verified clean — BYOD introspection's platform-table denylist-that-isn't.**
`isPlatformTable` enumerates Better-Auth's unprefixed tables (`user`,
`session`, `account`, `verification`, `twoFactor`, `passkey`) in addition to
the four prefixes, case-insensitively.
`introspection-covers-engine-tables.test.ts` reads every `CREATE TABLE` out
of the actual migrations and fails if any of them is not refused — an
enumeration that rots is caught by CI, not by the next audit.

**Not done — the OpenAPI spec's own production admin-gate
(`isTenantAdmin`, prod-only) has no test at any effort level.** The harness
always runs `NODE_ENV=test`, so `openapi.test.ts` never exercises the
`inProd` branch. Standing up the branch live requires a production-config
boot (Valkey, etc. — `assertProductionConfig` in `startup-guards.ts`, a
different section's file), which this session did not do. The code mirrors
`health.ts`'s already-measured pattern (`getSession` → role check → 401/403)
closely enough to be plausible, but "reads correct" is exactly the standard
this campaign rejects — flagging rather than closing it.

**Verified clean, with the measurement — `getNextDocumentNumber`'s counter
increment is a single atomic `UPDATE ... RETURNING`,** not a read-then-write;
`doc-generator.test.ts` pins both the found-row and no-row-returned paths.
`renderTemplate` HTML-escapes every substituted value before it reaches
generated HTML/PDF; pinned against a `<script>` payload.

**Logged, not fixed — `lib/utils.ts:generateId` has a modulo bias.**
`randomValues[i] % chars.length` over a 256-value byte and a 62-character
alphabet is not uniform (characters 0-39 are ~1/256 more likely than 40-61).
Not a defect against this function's actual use (IDs, not secrets — no test
claims uniformity), so left as-is rather than swapped for rejection sampling
inside this section; noted in case a caller ever treats this as
security-relevant randomness.

**T01 note — `routes/gone.ts` has no dedicated test file.** Read in full: a
23-line `app.all('*')` that always throws a `problem('gone', 410, ...)`. No
defect found; small enough that a missing test is a coverage gap, not a risk,
so left for the T01 pass rather than added here.

files read in full: `packages/engine/src/lib/doc-generator.ts`,
`packages/engine/src/lib/health-registry.ts`,
`packages/engine/src/lib/introspection.ts`, `packages/engine/src/lib/problem.ts`,
`packages/engine/src/lib/utils.ts`, `packages/engine/src/lib/version-checker.ts`,
`packages/engine/src/routes/gone.ts`, `packages/engine/src/routes/health.ts`,
`packages/engine/src/routes/openapi.ts`.

### A06 — permissions, roles, column access (2026-09-05, closed 5/5)

Five defects, all repaired with a test that discriminates. Three of them are the
same shape: a privilege that was taken away in memory and left in the database or
the cache, so the removal looked like it worked until the next reload.

**Fixed (#451) — revoking a role never reached the table.** The Casbin adapter
compared `v0..v3` whatever the rule carried; a `g` grant has three values, so the
fourth comparison became `v3 = NULL` and the DELETE removed nothing. Measured:
demote an owner to member, restart, they are an owner again — and the effect rule
is `some(allow)`, so the widest surviving grant wins. Four routes revoke this way.

**Fixed (#455) — the same adapter ignored `fieldIndex`.** Casbin uses it to ask
"every `g` rule whose SECOND column is this role", which is how a role is taken
back from everyone holding it; the adapter deleted `v0 = role` instead. Visible
consequence: deleting a custom role left every holder's assignment behind, so
recreating a role with the same name silently restored its old membership.

**Fixed (#452) — a demoted god kept a full RPC bypass for five minutes.**
`invalidateGodCache` dropped `god:<id>` and left `urole:<id>`, which holds the
same fact under another name; `resolveUserRole` kept answering `god`, and
`routes/rpc.ts` turns that string into an unconditional allow. Its only caller is
the recovery flow, whose premise is that the previous holder has lost control.

**Fixed (#453) — the roles cache signature did not bind its key.** So an entry
written for one tenant verified under another tenant's key. The user id was
bound, so it never crossed between people — it crossed between tenants, under the
very threat model (cache write access) those HMACs exist for.

**Fixed (#454) — circular inheritance was refused only two roles deep.** A
three-role loop was accepted, and every role in it silently acquired the others'
permissions while the inheritance tree showed three ordinary edges.

**Gap (low) — an ordering that carries meaning and does not say so.** In
`routes/permissions.ts` the admin gate is `app.use('*')` registered *after* the
`/bootstrap` route, which is what keeps recovery reachable without a session.
Correct and deliberate; nothing in the file says the order is load-bearing.
Moving the middleware up would gate recovery behind the login nobody can perform.

**For the owner — #451 stops the leak, it does not clean up.** Any instance that
ever revoked or demoted a role still holds those rows, and they are live at every
boot. A report comparing `zv_tenant_users.role` against the `g` grants per tenant
would name exactly who holds more than the interface says. That is a migration
and an owner decision, which is why no pull request carries it.

**Method note.** The inventory of revocation call sites first came back as three
because the grep carried `grep -v "permissions.ts:"` — meant to drop the file
being read, `lib/tenancy/permissions.ts`, and it also dropped
`routes/permissions.ts`, a different file with the same basename. The fix covers
that site either way; the count was wrong for a day. In a tree where the same
basename lives in two directories, filtering on the basename hides the thing
being looked for.

### A07 — authentication and identity (2026-09-05, closed 7/7)

**Gap — the extension sandbox has a second door, and it is wide open.** The
table allowlist wraps Kysely's query-builder entry points. A raw `sql` template
does not go through them: it asks the handle for its executor and calls
`executeQuery` on that. Measured through the real proxy, with an extension
holding no grants at all:

    selectFrom('session')                    refused
    selectFrom('zv_api_keys')                refused
    sql`SELECT token FROM session`           READ
    sql`SELECT id FROM zv_api_keys`          READ
    sql`SELECT token FROM zv_invitations`    READ
    sql`UPDATE "user" SET role='god'`        accepted

`session.token` is a live bearer credential for any account including the god
user; the last line is self-promotion. The comment in `extension-context.ts`
documents the measurement that closed the builder path — this is the other one.
It affects in-process extensions, which is every first-party one; worker
extensions go through `assertWorkerSqlAllowed`.

**The fix is written and measured, and is not filed as a pull request, because
the hole is load-bearing.** Guarding `getExecutor` (not `executeQuery` — measured;
a guard on the handle's own method sits beside the path rather than on it) and
delegating to `assertWorkerSqlAllowed` refuses all four lines above while every
legitimate shape still passes: builder queries, granted tables, CTEs, interpolated
`sql` fragments.

Running that policy over all 1170 raw statements the first-party extensions ship
says what closing it costs — **18 extensions**, and not by accident:

| extension | tables outside its own namespace |
|---|---|
| `auth/saml` | `session`, `user` — deletes other sessions on SSO login |
| `auth/ldap` | `session`, `user`, `zv_audit_log` |
| `auth/scim` | `account`, `session`, `user`, `zv_tenants`, `zv_tenant_users` |
| `compliance/gdpr` | `account`, `session`, `twofactor`, `user`, `zv_api_keys`, `zv_audit_log`, `zv_notifications` — right to erasure |
| `storage/cloud`, `ai` | `user` |
| `analytics/dashboard` | `user`, `zv_audit_log`, `zv_settings`, `zv_tenant_users`, `pg_class` |
| `communications/mail` | `zv_settings` |
| `developer/database`, `integrations/migrators`, `geospatial/postgis`, `content/pages` | `information_schema.*`, `pg_*` — schema browsing and migration |

They use raw SQL *because* the builder path refuses them. So this is not a repair,
it is a decision: which of these get an explicit grant, under which capability,
and whether catalogue reads become a capability of their own. That decision is the
owner's, and the code change should land with it rather than before it.

**Gap — invitation tokens are stored in plaintext.** `zv_invitations.token` holds
the 32 random bytes the invitation email carries, and the table has no RLS and no
policy while carrying a `tenant_id` (measured). `zveltio_rls` holds SELECT on it.
The same codebase hashes password-reset and e-mail-verification tokens, and the
recovery token, with the argument written at `verification: storeIdentifier` —
"the token itself, readable by anything that can read one table". The argument
applies here and was not applied. Not reachable through the API today: there is no
endpoint that lists invitations, only lookup by token. Hashing them at rest
invalidates invitations already in flight unless a second column carries the
transition, which is why it is written down rather than changed.

**Low — the legacy scrypt path compares by `!==`.** `verifyPassword` compares the
derived key against the stored one with a plain string comparison, while the
recovery token in `routes/permissions.ts` uses a constant-time helper and the
signed caches use `timingSafeEqual`. The attacker supplies the password, not the
digest, so there is no practical oracle here — recorded because the file is
careful about exactly this everywhere else, and the path is scheduled for removal
anyway.

**Verified clean.**

- Account creation has one chokepoint, and it is the right one: a `before` hook on
  the `user` insert rather than a URL pattern, so magic-link and OAuth are covered
  by construction. The two legitimate in-process paths announce themselves through
  an AsyncLocalStorage flag, and `withAuthorizedUserCreation` is **not** exposed to
  extensions.
- `createBetterAuthSession` — "log anyone in" — is reachable from extensions, and
  is gated behind the `auth:session` capability the manifest must declare.
- `hashApiKey` is HMAC under `BETTER_AUTH_SECRET`, single-sited, with the dead
  `SECRET_KEY` fallback already removed.

**Fixed (#461) — changing a global role deleted every tenant membership.**
`PATCH /api/users/:id` reset Casbin roles with no domain, so setting somebody's
`user.role` to `member` also stripped their `tenant_owner` in one firm and their
`tenant_member` in another, with an audit line recording only `new_role`. It was
invisible until #451 and #455 made the adapter's DELETE reach the table: a repair
that changed the blast radius of a route it did not touch. Recorded that way on
purpose — it is the second-order cost of the three revocation fixes, and the kind
of thing a campaign should be able to say about itself.

**Fixed (#460) — the production guard missed the setting that rewrites emailed
links.** An unset `BETTER_AUTH_URL` fails nothing; `baseURL` falls back to
`http://localhost:<port>` and every absolute URL is built from it, including the
link in a password-reset mail. The send succeeds, the link is well formed, the
account stays locked out.

**Low — `keyring.ts` states a principle it does not follow once.**
`decryptWithKeyring` picks the key from the envelope rather than the caller's
word for it, which is what stops a wrong keyring name producing a confusing
failure — except for the `enc:v1:` envelope, where it uses the caller's argument.
No consequence today, because nothing writes a field envelope under the mail
keyring. The exception is simply unstated.

**From the extensions session, verified here, and not this repository's to fix:**
SAML SSO is non-functional in both flows. `auth/saml` passes node-saml's 4.x
`validateInResponseTo: 'ifPresent'` while the installed version is 3.1.2, where
that option is coerced with `options.validateInResponseTo || false` and tested for
truth — so any truthy value means "always require", and an IdP-initiated response
has no `InResponseTo` by construction. Confirmed against the installed dependency
independently of their test. The SP-initiated flow fails separately because the
extension builds a fresh SAML instance per request and the in-memory cache holding
the request id is not shared between `/login` and `/callback`.

### A16 — tenant and admin routes (2026-09-06, closed 5/5)

The section asks two questions — a guard on every route, an audit entry on every
privileged write — and both were measured rather than read for.

**Fixed (#463) — the tenant surface wrote no audit trail at all.**
`routes/tenants.ts` held no `auditLog` call in 453 lines that create firms,
suspend them, grant `tenant_owner` inside one and take it away again. Across the
whole privileged surface, writes with no audit entry went from **11 of 29 to 4**,
and the four left are not privileged writes.

**Verified clean — every route on this surface refuses an anonymous caller.**
All 59, driven anonymously against the real app rather than read: 401 or 403
throughout. Worth doing live: the `admin/*` sub-routers rely on a `use('*')`
registered in `adminRoutes` before they are mounted, and a middleware registered
after a route does not apply to it — the demo-mode defect earlier the same day
was exactly that shape.

**Gap (low) — validation runs before authorization on `routes/tenants.ts`.**
Driven as an ordinary authenticated member:

    POST /api/tenants, empty body   → 400, with the schema's complaint
    POST /api/tenants, valid body   → 403

So the guard is sound; it simply runs second. An unauthorized member can map the
request schema of privileged endpoints by probing them, and five routes answer
something other than 401/403/404 for that reason. Not an escalation, and not
repaired here: the fix touches six handlers, and `GET /api/tenants/me` is
deliberately member-accessible, so a blanket mount-level guard is not the shape.
Recorded because the surface has two guard shapes — `adminRoutes` guards at the
mount, `tenants.ts` inside each handler — and the next handler added to the
second shape is the one that will do work before its check.

#### The last two files (2026-09-06)

**Fixed (#468) — a revocation that revoked nothing answered "done".** Both API-key
surfaces are twins with the same body, and both returned `{ success: true }`
whatever the scoped UPDATE matched. Measured: revoking a random UUID answered
200. On a revocation that is the dangerous direction — an administrator who
believes a leaked credential is dead stops looking for it — and the audit entry
was written either way, so the trail carried revocations that had not happened.
The tenant predicate is unchanged and the same 404 covers "not yours" and "does
not exist", so nothing new is disclosed about another firm's ids.

**Fixed (#468) — the request-log total described a different list.** `GET
/api/admin/logs` filtered the rows and counted the whole table, so a filter by
`status=500` answered `total: 40000` beside three rows. The path filter also
reached a LIKE pattern unescaped while `routes/users.ts` escapes its own search
with the helper that exists for it.

**A test of mine that was wrong, and what showed it.**
`rls-role-credential-grants.test.ts` asserted that `zveltio_rls` holds nothing
outside `zv_`/`zvd_` except `user`. Extension tables are not all prefixed —
`operations/traceability` alone creates sixteen `trace_*` tables, and roughly a
third of extension tables are named after the feature rather than the folder.
Those grants are correct; an extension cannot read its own data without them. The
rule therefore failed on any install carrying such an extension and passed here
only because the verification database had none. **A test that turns green on the
absence of an extension is not testing the property it names.** Narrowed to the
one that does not move: the role every tenant transaction drops into holds
nothing on a credential table.

**Verified clean, with the measurement.**

- API keys are minted through the shared `hashApiKey` on both surfaces, listed
  and revoked under a tenant predicate, and every write is audited. A key issued
  in one firm and sent with another firm's slug is refused, with root-tenant keys
  acting anywhere as a documented decision.
- `POST /explain` is disabled in production, builds a fixed statement shape and
  passes identifiers through `sql.table`/`sql.ref` — not an arbitrary-SQL surface.
- `/logs` and `/slow-queries` read tables with no `tenant_id`, and both are
  instance-admin only, which is consistent.

### A property every error path in the engine depends on (2026-09-05)

Measured on `withTenantIsolation`, the primitive every `/api/*` and `/ext/*`
request runs inside:

    handler writes, then RETURNS an error   → the write is COMMITTED
    handler writes, then THROWS             → the write is rolled back

So `return c.json({ error: … }, 400)` is not an undo. A handler that has already
written something and then answers that the request failed leaves that write
behind. Only a throw unwinds the transaction.

This came from the extensions session, where it was not hypothetical: a SAML
callback claimed an assertion id for replay protection, then hit a `!email` check
that answered 400 by returning. The id stayed claimed. An identity provider with
a misconfigured attribute mapping burned the assertion, the operator fixed the
mapping, and the user retrying the same assertion was told it had already been
used — a replay guard turned into a lockout, curable only by waiting for the
provider to mint a new assertion. Worse than the defect it was added to prevent.

**No engine instance is claimed here, and the reason is worth recording.** A
static sweep over all 248 route handlers found 24 with a write followed by an
error return, but reading them showed the dominant shape is harmless — `const row
= await db.updateTable(…).returningAll().executeTakeFirst(); if (!row) return
404`, where the update matched nothing and there is nothing to roll back — and at
least one flagged handler (`collections.ts POST /:name/fields`) has all of its
error returns *before* any write. The instrument is too coarse to convert into a
list, so it produced candidates and not findings.

What the property does change is how to read every future handler in this
campaign. `check:atomic-writes` asks whether several writes belong in one
transaction; this asks something different and narrower — whether a single
completed write survives an answer that says the request failed. Where a handler
takes an irreversible action (claiming a token, consuming a nonce, spending a
quota) before it has finished validating, a `return` is the wrong verb.

### A17 — the audit writer, settings, templates, RPC (2026-09-05, closed 7/7)

**Fixed (#466), four of them.**

*Exporting the security record left no mark on it.* `GET /api/admin/audit/export`
hands out up to 50 000 audit rows and was the one privileged action writing
nothing down. `export.executed` already existed in the event union with no writer
anywhere, engine or extensions, so a reviewer filtering for it concluded no
export had ever happened.

*A failed RPC handed the caller the database's own words.* Measured:
`duplicate key value violates unique constraint "zvd_rpc_secretish_email_key"` —
the table, the constraint and therefore the column, to whoever may call the
function, and `required_role` can be `member`.

*Instance settings changed with no trace.* `routes/settings.ts` held no audit
call at all, in a file whose writable set includes `registration_enabled` — the
flag deciding whether anyone on the internet may create an account — under a
comment reading "Feature toggles (non-security)".

*Every data-quality scan ran in the root tenant.* `runQualityScan` defaulted
`tenantId` to `DEFAULT_TENANT_ID` and its only production caller passes four
arguments, so a scan triggered from any firm read the ROOT tenant's rows and
handed back issues carrying root's record ids and field values. Thirty existing
tests passed *because* of that default: they encoded the defect.

**The pattern behind three of the day's findings, and it is in the schema too.**

Absence of a tenant resolving to the root tenant has now been found three times
in code in a single day — `requireInstanceAdmin` reading a missing store as root,
an unresolvable tenant slug served without one, and the scan above. Measured
against the catalogue, it is also the house style at the schema level:

    tenant_id columns with a default                            30
    …whose default resolves to the root tenant when the GUC is
      absent or empty                                           30
    …of those, NOT NULL, so the default actually decides        16

The default is `COALESCE(NULLIF(current_setting('zveltio.current_tenant', true),
''), '<root>'::uuid)` — the empty-string case was thought about, and root was
chosen as the answer. That is deliberate, and it interacts badly with something
already recorded here: **a GUC survives as `''` after `SET LOCAL` + `COMMIT`, so
the absence of a tenant is not detectable at the point of insert.** Any INSERT on
a connection whose GUC has lapsed is attributed to the root tenant, silently and
without error.

Not filed as a defect and not changed: thirty column defaults is a migration and
a product decision about what an unattributed row should be. Recorded because the
same shape keeps producing defects one layer up, and because "it fails closed"
is not what this does — it fails into the tenant that holds the instance's own
data.

**Verified clean, with the measurement.**

- `zv_audit_log` has no `tenant_id` and no RLS, and only an instance admin reads
  it — consistent. Worth a decision for the hierarchical model: a firm's own
  administrators cannot see their own audit trail at all.
- `zv_settings` is `PRIMARY KEY (key)` with no tenant column. All four engine
  writers are instance-level by nature and every write path is behind
  `requireInstanceAdmin`; the public read route sits before the guard
  deliberately and is double-protected by an `is_public` flag **and** a
  whitelist.
- `zvd_rpc_functions` is an instance-level whitelist, writable only by an
  instance admin. RPC bodies execute on `reqDb(c)`, so the caller's isolation
  applies to operator-authored SQL.
- `routes/templates.ts` reads its body twice — once validated, once raw — and
  uses the raw one. Probed with five prefixes including
  `a"; DROP TABLE zv_tenants; --`: all four invalid forms answered 400, because
  `zValidator` refuses them before the handler runs. A smell, not a defect; it
  becomes one the day someone removes the validator.
- `lib/system-collections.ts` declares `session` with a `token` field as a
  browsable collection. `/api/data/session` answers 404 even to a god session and
  the listing is admin-only, so nothing is exposed — but the file reads as though
  session tokens were browsable, which is worth knowing before someone wires the
  data route to it.
### E01 — the gates themselves (2026-09-05, closed)

The section's bar is stated in its own focus line: *plant a violation in each; a
gate that does not fail on it is not a gate.* Measured against
`scripts/audit-gates.ts` rather than assumed — every gate E01 lists is exercised
by a case there, checked by matching the section's file list against the
meta-gate's `gate:` and `covers:` entries. **Nothing uncovered.**

**Fixed (#467) — one gate could not be proved on any machine where it mattered.**
The plant path for `check-studio-embed-freshness` is
`packages/studio/dist/.zveltio-studio-version`, a build artefact present wherever
anyone has built the Studio. The collision rule skipped the case there, so the
gate was proved only on a fresh checkout — the one environment in which a stale
embed cannot happen. A `replace` mode now stands in for the file and restores it
byte for byte, and creates then removes one when there is none. 44 of 44 gates
prove themselves in a normal run, where it was 43 with one permanently unproved.

The first attempt at that fix inverted the hole rather than closing it: it
required the file, so CI — a fresh checkout — skipped the case instead, and a
skip is fatal there. Both halves, or the case is decoration on one machine or the
other.

**A false report of mine, worth recording because the meta-gate predicted it.**
My first run said `❌ decoration, not a gate: check-insert-schema-match`. It is
not: that gate builds the real schema and needs a database, and I had run without
`TEST_DATABASE_URL`. The comment on that case says a missing database makes it
"fail loudly as decoration, which is the right direction to fail in" — so the
meta-gate was behaving as designed and my invocation was the fault. With a
database, 43/43 before the fix and 44/44 after.

**What remains, and it is not this section's bar.** The gates are proved to catch
a planted violation; most still have no unit test of their own, which is the T01
backlog's "a case per gate, not per repair". Two known misses in
`check-jsonb-binding` — a `JSON.stringify` reaching the column through a local
variable, and the raw-value case its own header declines to claim — were recorded
on 2026-09-04 and are unchanged.

### A decision to revisit, not a defect to fix (2026-09-05)

`ctx.db.transaction()` on an extension's handle joins the request's transaction
rather than opening one. The builder it returns accepts `setIsolationLevel` and
`setAccessMode` and **ignores both**, returning itself so the chain an extension
would naturally write keeps working.

Neither can be honoured here by construction: a transaction's isolation level and
access mode are fixed when it begins, and this joins one already open. So an
extension writing `.setAccessMode('read only')` gets a read-write transaction and
no error, and one relying on `setIsolationLevel('serializable')` for a
read-modify-write gets the default and the race it explicitly asked not to have.

**Reported as a defect and withdrawn as one.** The behaviour is pinned by a test —
`extension-db-transaction-join.test.ts`, "accepts the builder chain an extension
would write" — so it is a deliberate trade: not crashing on the natural Kysely
chain, at the cost of a setting quietly meaning nothing. Making it throw was
written, tested and reverted, because reversing a pinned decision on a reviewer's
own judgement is not a repair.

Recorded so the trade is visible where the other findings are. Nothing in the 56
first-party extensions calls either method today — measured — so the cost is
entirely in the future, and the choice belongs to whoever owns the extension
contract.

---

### A09 — the base schema, read against a live database (2026-09-06, closed 1/1)

One file, 4,212 lines: 77 `CREATE TABLE`s and 49 folded migrations. Read end to
end and measured against a database built from it, which is the only way three
of these were visible.

**Gap (high) — `zveltio_worker` is granted nothing on any collection created
after install.** The 043 stanza grants the worker role DML on the `zvd_` tables
that exist when the migration runs, and says of the rest: *"New ones are granted
at create time; see `grantWorkerSqlAccess()` beside `grantFlowReaderSelect()`."*
`grantWorkerSqlAccess` does not exist in either repository. `DDLManager` calls
`grantFlowReaderSelect` and nothing else (`ddl-manager.ts:460`), and
`ALTER DEFAULT PRIVILEGES` names `zveltio_rls` alone, so there is no second
route either. Measured:

    has_table_privilege('zveltio_worker', <new zvd_ table>, 'SELECT')  → false
    SET LOCAL ROLE zveltio_worker; SELECT … → permission denied for table

The bridge in `worker-extension-host.ts` falls back to `zveltio_rls` when
`SET LOCAL ROLE` *throws* — but the role exists, so the `SET` succeeds and the
query is what fails. A worker-isolated extension therefore breaks on exactly the
collections it exists to serve, and only on installs where the collection was
created after the migration ran, which is every real install. The `flow_reader`
half of the same design is correct and was verified alongside it; the asymmetry
is what makes this invisible to reading. Repair belongs in A13
(`ddl-manager.ts`), with a harness test that creates a collection and asserts the
grant — the existing role tests pass with the defect in place.

**Gap (medium) — the baseline's `-- DOWN` neither completes nor cleans up.**
Executed against a database built by its own UP. It aborts at
`DROP ROLE IF EXISTS zveltio_worker` ("role cannot be dropped because some
objects depend on it — privileges for schema public"). Driven past that, six
statements fail on dependent objects (`zvd_panel_cache`→`zv_panels`,
`zv_panels`→`zv_dashboards`, `zv_flow_dlq`→`zv_flows`,
`zv_tenant_transfers`→`zv_tenants`, `zv_flows`→`user`) and **26 of the 72 tables
are left standing**, along with both remaining roles and the
`zveltio_tenant_scope_ok` overloads. Everything the folded-in later migrations
created — `zv_flow_dlq`, `zv_invitations`, `zv_erd_layouts`, the backup trio, the
`zvd_` insights set, `zvd_column_permissions`, `zvd_push_tokens`,
`zvd_rls_policies`, `zvd_rpc_functions`, `zv_request_logs`, `zv_audit_log`,
`zv_roles` — has no `DROP` at all. This was unreachable until yesterday:
`rollbackMigration` listed `migrations/sql/` unconditionally and failed in every
compiled binary (repaired in #471). Not repaired here, and not repairable here:
001 is a shipped migration whose checksum is verified at every boot, and editing
it reports a mismatch on every existing install — the reason the squash exists.
A later migration, or a rollback path that does not depend on this DOWN, is an
owner call.

**Gap (low) — one index exists twice.** `idx_zv_revisions_lookup` (041 stanza) is
byte-identical to `idx_zv_revisions_record` (004 stanza): both
`btree (collection, record_id, created_at DESC)`. `zv_revisions` carries seven
indexes on a live install, two of them the same index, on the table every record
write appends to. Same shipped-checksum constraint; a `DROP INDEX` belongs in a
new migration.

**Verified clean, with the measurement.**

- **Unique keys carry `tenant_id`,** with two deliberate exceptions out of 21
  tenant-scoped tables: `zv_api_keys.key_hash` and `zv_invitations.token`. Both
  are credential lookups reached *before* tenant resolution, so global uniqueness
  is the correct shape and the file says so.
- **Every table with a `tenant_id` has an index leading on it** — no exceptions.
- **The root-tenant default was measured again, not changed:** 21 `tenant_id`
  columns, 17 carrying the `COALESCE(NULLIF(current_setting(…),''), root)`
  default, 6 `NOT NULL`. Absence of a tenant context resolves to the root tenant.
  Recorded as an owner decision (see A04/A08), not repaired.
- **RLS in this file is small and deliberate:** 4 `ENABLE`, 4 `FORCE`, 3
  policies. Live, six tables carry RLS — three forced (`zv_edge_functions`,
  `zv_edge_function_logs`, `zvd_insight_saved_queries`) and four enabled without
  `FORCE` (`session`, `account`, `verification`, `twoFactor`), which is the 044
  design: the owner connection stays unbound so Better-Auth keeps working, and
  every other role sees zero rows with no policy present. Every other table's
  isolation is installed at boot by the reconciler, not here.
- `zv_encrypted_fields` is never created on a fresh install — its guard tests for
  `zv_collections` where the table is `zvd_collections` — and nothing reads it.
  Already recorded in migration 011; noted here only so the next reader does not
  re-find it.
- Gates: `check:schema`, `check:schema-snapshot`, `check:table-owners`,
  `check:raw-sql`, `sql:backticks`, `sql:numeric-arith`, `sql:jsonb`,
  `catch:fabricated` all pass, and `check-migration-safety.ts` reports nothing to
  check — it skips 001 by design, which is correct and worth knowing: this file
  has never been linted by that gate.

### A10 — schema types and the incremental migrations (2026-09-06, closed 11/11)

Ten migrations and `schema.ts`, read against a database built from the whole
chain. The three properties this section exists to check are clean; everything
found is at a seam no gate looks at.

**Gap (high) — the engine holds the third `ON CONFLICT` that the ai extension's
migration said there were only two of.** `lib/cloud/document-indexer.ts` upserts
into `zvd_ai_embeddings` with `ON CONFLICT (collection, record_id, field)`. The
extension's migration 006 replaced that unique constraint with
`UNIQUE (tenant_id, collection, record_id, field)` during the tenant-unique-keys
campaign, and its own comment states: *"The `ON CONFLICT` clauses move with the
constraints. There are two, both in this extension."* Reproduced on a live table
— the engine's exact statement, before and after the swap:

    before ai/006 → INSERT 0 1
    after  ai/006 → ERROR: there is no unique or exclusion constraint
                    matching the ON CONFLICT specification   (42P10)

The call site wraps it in `catch { console.error }`, so cloud document indexing
stops working silently on any install carrying `ai` at 006 or later. `zvd_ai_embeddings`
exists only when that extension is installed, which is also what supplies the
embedding provider, so the guard above the statement is sound — the constraint is
what moved. Neither `schema-drift-check.ts` nor `check-insert-schema-match.ts`
inspects an inference target, so both gates pass with this live. The repair is the
tenant column in the target (and in the insert), plus a check that pins inference
targets against `pg_constraint` the way the insert gate pins column lists.

**Gap (medium) — deleting a record comment is quadratic.**
`zv_record_comments.parent_id` is a self-referencing FK with `ON DELETE CASCADE`
and no index, so every delete runs
`DELETE FROM ONLY zv_record_comments WHERE $1 = parent_id` as a sequential scan.
Found by accident, cleaning up a 200,000-row seed, and then measured on 195,000
rows:

    5 000 deletes, no index on parent_id     61.5 s
    5 000 deletes, with index on parent_id    0.083 s

740×, and it grows with the table. The catalogue says 22 FKs in the schema have
no index on their referencing column, but the other 21 point at `"user"` and are
paid only when a user row is deleted; this one fires in ordinary use. The column
is declared in `001_initial.sql`, so the index belongs in a new migration.

**Gap (medium) — the batched unwrap migrations are not batched.** 009, 010 and
011 each loop 5,000 rows at a time, and 009 gives the reason: *"this table grows
without bound and one `UPDATE` over all of it would hold row locks for the length
of a full rewrite. 5 000 rows at a time, committed per batch by the loop."*
Nothing is committed per batch. The runner wraps each migration in one
transaction unless the file carries `-- NO TRANSACTION` — none of the three does —
and a PL/pgSQL `DO` block cannot `COMMIT` inside an outer transaction anyway.
Measured: 12,000 seeded rows, three batches, **one** distinct `xmin` afterwards.
The locks are held for the whole run exactly as an unbatched `UPDATE` would hold
them, which is the one thing the shape was chosen to avoid.

**Gap (low) — 004's `-- DOWN` cannot run.**
`DROP FUNCTION zveltio_visible_tenants()` is refused: every policy the migration
rewrote depends on it. Same class as the A09 finding on 001's DOWN, reachable for
the same reason (#471). It would also leave `zveltio_tenant_scope_ok` defined over
a function that no longer exists, since a SQL function body carries no dependency.

**Gap (low) — 25 declared tables that no engine migration creates.** `DbSchema`
types the ten `zv_mail_*`, six `zv_ai_*`/`zvd_ai_*`, the four retired
`zvd_portal_*`/`zvd_collection_views`, `zv_ddl_jobs` (dropped by 001) and
`zv_webhooks`/`zv_webhook_deliveries` (the live tables are `zvd_*`). Kysely then
certifies a query against a table that is not there — the precedent is
`zv_flow_dlq`, which 001 records as exactly this shape. Only one such query
exists today, and it is the first finding above. Two comments drifted with them:
`lib/data/ddl-queue.ts` says `zv_ddl_jobs` "is preserved for historical queries"
where 001 drops it, and `routes/webhooks.ts` says "`zv_webhooks` carries
`tenant_id` and a policy" where the live table is `zvd_webhooks` and carries no
policy at all.

**Verified clean, with the measurement.**

- **`schema.ts` against the real columns: 0 drift.** 90 declared tables, 72 live,
  and of the 65 that exist not one declares a column the database does not have.
- **0 `bigint`/`numeric` columns typed as anything but `PgNumeric` or `string`**,
  and **0 columns declared `Generated`/optional that are `NOT NULL` with no
  default** — the two type traps the file's own header documents.
- **003 and 005 hold on a real plan, not in their comments.** 200,000 rows, as the
  product runs it: `InitPlan 1`, `Parallel Seq Scan`, `Workers Planned: 2`,
  22 ms. Every function an RLS policy depends on still reports
  `proparallel = 's'`, so the `CREATE OR REPLACE` chain 004 warns about did not
  undo 003.
- **The policy rewrite both 004 and 005 assert really happened:** all five
  policies on a fresh engine database carry
  `tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[])` with
  `zveltio_tenant_write_ok(tenant_id)`, and none is left on the old combined
  predicate.
- 002 (passkey), 006 (`account.issuer` + backfill, with a `RAISE EXCEPTION` if any
  credential row is left NULL), 007 (`NULLS NOT DISTINCT` per-tenant unique) and
  008 (one-god trigger) each land as described; 31 harness tests over them pass.

### A12 — the data read path (2026-09-07, closed 9/9)

Nine files, 1,795 lines: filter parsing, the query-result cache, the keyset and
offset list paths, response shaping, the time-travel count, the virtual-source
adapter and the GraphQL loader helpers. One defect repaired here; the rest are
logged below.

**Repaired (medium) — a cursor holding the JSON literal `null` answered 500.**
`decodeCursor` documents that a malformed cursor returns `null` so the list
handler falls back to offset paging, and every malformed shape took that path
except one. `JSON.parse` succeeds on every JSON literal, not only on objects, so
a payload of `null` never reached the `catch`; the guard below it then read
`.id` off `null` and threw a `TypeError` out of a pure parsing function, which
`routes/data.ts` — which wraps the handler in nothing — turned into a 500 on
input the client fully controls. Measured at the HTTP boundary, one collection,
five payloads:

    ?cursor=Im5vcGUi   ("nope")  → 200      ?cursor=W10       ([])     → 200
    ?cursor=MTIz       (123)     → 200      ?cursor=dHJ1ZQ    (true)   → 200
    ?cursor=bnVsbA     (null)    → 500

The neighbouring case in the same file is the reason this is worth naming.
Twenty-five lines above, `parseFilters` carries an explicit guard for the
identical shape, with a comment saying why — *"guard before destructuring or it
throws a TypeError (→ a 500 on a malformed-but-plausible filter)"*. The same
author, the same file, the same failure mode, one function apart: class 14's
proximity variant, where the file that gets one case right is where nobody looks
for the case it gets wrong.

**And the fuzz suite that could not have caught it.**
`query-parse.property.test.ts` asserts `decodeCursor` *never throws on arbitrary
strings*, over 600 generated cases, and was green throughout. Its generators are
`fc.string()` and `fc.base64String()`, which produce a string that base64-decodes
to valid JSON only by accident and never produced the six bytes encoding `null`.
The invariant was exactly right and the generator could not reach it. Repaired by
moving the encoding inside the generator (`fc.constantFrom('null', 'true', '0',
'"str"', '[]', …).map(b64)` plus `fc.jsonValue()`); with the guard removed the
suite now fails in 25 runs, so the assertion is load-bearing.

**Gap (medium) — the cursor path reproduces the cost it exists to avoid.**
`handlers/list.ts:334-344` builds the keyset predicate in the `OR` form,
`(sort < v) OR (sort = v AND id < id)`, under a comment that says the cursor
path *"avoids OFFSET cost on large tables"*. Postgres cannot turn that form into
an index seek: it scans from the top of the index and discards every row before
the cursor. Measured, 200 000 rows, on the index dynamic tables actually get
(`idx_<table>_created_at` on `(created_at DESC)`), paging at offset 100 000:

    OR form (shipped)            Filter, Rows Removed by Filter: 100001   11,449 ms
    row-comparison `(a,b) < (x,y)`  Index Cond, Rows Removed by Filter: 1   0,069 ms

166x, and the gap grows with page depth, which is the property the cursor path
was added to remove. With a composite `(created_at DESC, id DESC)` the row form
reaches 0,031 ms, but that index is not needed for the repair — the seek already
happens on the shipped one. Not repaired here: it rewrites the SQL of the
hottest read path, both order branches, over a runtime-resolved `sql.ref(sortField)`
whose column type is not known at build time, and that wants its own session with
a deep-page correctness fixture rather than a ride-along on a parser fix.

**Gap (low) — `createCollectionLoader` reports "no such row" for a failed query.**
`graphql-dataloader.ts:29` catches everything and returns `keys.map(() => null)`,
so a permission error, a dropped column or an aborted transaction is
indistinguishable from a row that does not exist, and GraphQL renders it as a
null field rather than an error. The batch is one statement, so in Postgres the
failure also poisons the surrounding transaction and resurfaces later somewhere
unrelated — the pattern known-gaps §2 already describes. Keep the fallback if a
500 is not wanted, but log the failure with the table name. The exports here are
extension-facing (`ctx.internals`), not dead: the engine mounts no GraphQL route,
so `checkQueryDepth` / `checkQueryWidth` are advisory helpers an extension has to
call, and whether the shipped GraphQL extension calls them is a question for the
sibling repository.

**Gap (low) — the virtual-source filter loop drops the filters it cannot parse,
silently.** `handlers/list.ts:231` destructures `Object.entries(value)[0]`
without the guard `parseFilters` has for the same shape, so `?filter={"a":{}}`
throws inside the loop; the `catch` at 237 is annotated *"invalid JSON — skip"*
and swallows it. The filters parsed before the throw are kept and the rest are
dropped, so the caller receives a **broader** result set than they asked for,
with a 200 and no indication. Same class as the repaired defect, on the path that
does not reach a database.

**Observation, not a defect — `virtualCreate` ignores `list_endpoint`.**
`virtual-collection-adapter.ts:261` POSTs to `config.source_url` directly while
`virtualList` GETs `source_url + list_endpoint`. For any virtual source
configured with a `list_endpoint`, reads and creates address different URLs.
That may well be intended — create and list are not obliged to share a path —
but nothing in the file says so, and the asymmetry is invisible at the call site.
Belongs to whoever owns the write path (A11), noted here because it was read here.

**Checked and found sound**, so that the next reader can tell "safe" from "not
looked at": the query-result cache key namespaces the tenant outside the hash and
hashes `user.id`, and an API key's identity is the synthetic `apikey:<uuid>`, so
neither a tenant switch nor an auth-type switch collides on a key; the
time-travel count key serialises the resolved row rules, so a changed rule lands
on a different key by construction; column access is applied on the time-travel
and virtual paths as well as the live one; `applyExpand` gates the second
collection on both `checkPermission` and the target's row policies; and the
cursor branch runs filters through the same `buildCondition` and the same
`queryAlterRegistry.applyAll` as the offset branch, so neither RLS nor an
extension's narrowing is bypassed by adding `?cursor=`.

### B05 — manifest, catalog, dependencies, extension migrations (2026-09-13, closed 9/9)

Nine files: the manifest v2 Zod schema + studio-page embedding, the versioned
extension catalogue, the single-slot extension registry, the peerDependency
installer + npm allow-list, the core-dep provisioner, and the extension
migration runner's table-ownership guard. Two defects repaired here, both
found by measuring the guard rather than reading it — per the campaign's own
rule, neither would have been found by reading.

**Repaired (high) — `ALTER TABLE ONLY <table>` bypassed the migration
table-ownership guard.** `assertMigrationTablesAllowed` in
`migration-runner.ts` refuses an extension migration that `ALTER`s or `DROP`s
an engine table it does not own — the one door left unlocked after worker
isolation, since migrations run as the database owner, in the main thread,
before `load.ts` picks inline vs. worker. Its regex required the table name
immediately after an optional `IF EXISTS`, with no allowance for the `ONLY`
keyword Postgres permits there (`ALTER TABLE [IF EXISTS] [ONLY] name`).
Measured directly: given `ALTER TABLE ONLY zv_migrations DROP COLUMN
down_sql;`, `(\w+)` captured `"ONLY"` — a string that is never an engine
table — so the guard checked whether `"only"` was protected (never true)
instead of the real target and let the statement through unexamined. Fixed by
adding `(?:ONLY\s+)?` between the `IF EXISTS` clause and the table name;
verified with the standard revert-confirm-restore cycle and two new
regression tests in `migration-table-guard.test.ts`. No twin: grepped the
whole tree for the same regex shape, only one copy exists.

**Repaired (high, found already in progress) — an unvalidated peerDependency
name let a package's "already installed?" filesystem check answer wrongly.**
`npm-install.ts` resolves each declared peer to a directory under the
extensions `node_modules` and asks `existsSync` before deciding what to
install. An unvalidated name containing a path separator (e.g. `"../pwn"`)
resolved to a directory that always exists — an ancestor of that
`node_modules` — so the peer was silently marked "already installed" and
skipped, which meant that when it was the extension's only declared peer, the
function returned before either the name-shape check or the platform
allow-list further down ever ran for it. Fixed by validating every declared
peer's name against `SAFE_PACKAGE_NAME` before any path is derived from it,
unconditionally, ahead of the existence check. Verified the same way: the
guard neutered, the named regression test failing (2/8), restored, 8/8.

**Gap (medium, logged not fixed) — the extension migration runner still has
no general DDL safety linter.** `assertMigrationTablesAllowed` answers one
question only — does this migration touch a table the extension does not
own — and answers it well now. It says nothing about locking DDL without a
timeout, a type change that rewrites a large table, a missing
`CONCURRENTLY`, or any of the classes `check-migration-safety.ts` (squawk)
catches for the engine's own migrations. That gate does not run over
extension SQL at all. Out of scope for a narrow repair — it is a new gate,
not a fix to an existing one — and belongs with E01 (gates) or as its own
follow-up, not folded into this session's table-guard fix.

**Checked and found sound**, so the next reader can tell "safe" from "not
looked at": `ManifestSchema`'s `capabilityContract`/`permissions` fields
reject unknown capabilities rather than accepting free-form strings (the
exact class of defect §3 elsewhere in this document names for a different
field); `embedPageSchemas`' `join(extDir, 'studio', p.schema)` takes its path
segment from the extension's own manifest, authored by the same party as the
extension's code, so it adds no capability beyond what an in-process
extension already has; `getExtensionCatalog`'s override path
(`ZVELTIO_CATALOG_PATH` / `<extDir>/catalog.json`) fails closed to the
bundled catalogue on a malformed file, with a warning, rather than silently
serving an empty list; `extension-deps.ts`'s core-package tarball fetch
targets a hardcoded four-package list (never extension-supplied), so it
carries no injection surface comparable to the peer-install path; and
`withExtensionLock`'s advisory-lock design (xact-scoped, not session-scoped)
matches the documented beta.25 incident write-up in `extension-utils.ts` —
nothing here contradicts it.

### A14 — field types, validation, field encryption (2026-09-12, closed 6/6)

Six files, 2,161 lines: the core field-type registry (`field-types/index.ts`),
DDL/default rendering and the crypto/conversion/numeric/validation helpers it
leans on. One defect repaired here; the rest is what was checked and found
sound.

**Repaired (medium) — `FIELD_ENCRYPTION_KEY` rotation without a restart did
not work, contradicting the comment that says it does.** `field-crypto.ts`
reads the env var lazily on purpose ("lets an operator rotate the key without
a restart"), but `getKey()` cached the imported `CryptoKey` unconditionally on
first use (`if (_key) return _key;`) and never rechecked the env var. Measured:
encrypt under key A, rotate `FIELD_ENCRYPTION_KEY` to key B with no process
restart, encrypt again — the second ciphertext still decrypts only under raw
key A, not key B. Invisible from inside the module, because the same stale key
also decrypts anything it just encrypted with itself; the test added
(`field-crypto-key-rotation.test.ts`) decrypts independently with WebCrypto
using the *second* key's raw hex to tell the two apart. Fixed by caching the
key together with the hex string that produced it and re-importing when the
env var no longer matches. Reverted the fix and confirmed the named test fails
before it and passes after.

Twin check: `lib/security/keyring.ts` (out of section) reads its three named
keys per call with no `_key`-style cache and gets rotation right already — its
own comment points back at field-crypto "for the why" without having copied
the caching bug. Nothing else in `src/lib`/`src/routes` caches a `CryptoKey`
across calls.

**Blocked (one check only) — `sql:numeric-arith` cannot run to a real pass
here.** The gate needs `amount`/`tax_amount`/`total_amount` columns that come
from `finance/invoicing`'s extension migration. Booting a scratch engine
against this section's database with `ZVELTIO_EXTENSIONS_PATH` set loaded
`crm`, `forms`, `billing`, `sms` but not `finance` — the loader only resolves
one path segment per extension id, and `finance` is a namespace directory
(`finance/invoicing`, `finance/quotes`), not `finance/engine/index.js`. Getting
this extension loaded is a loader-configuration question outside this
section's files; the gate reports its own reason for failing rather than a
false pass, which is the property that matters. `check:raw-sql`,
`sql:backticks` and `catch:fabricated` all ran clean against this section.

**Checked and found sound**: `renderSqlDefault` (field-type-registry.ts) quotes
every non-numeric, non-boolean, non-whitelisted default and doubles embedded
quotes — the injection this function used to have is closed and the allowlist
of bare SQL expressions is exact; `field-type-conversions.ts`'s `resolveConversion`
never emits a conversion for the relation types and always routes a
caller-supplied column name through a quoted identifier; the `password` field
type's `isPasswordHash` matches every algorithm `Bun.password.hash` can
produce (argon2id today), not the old bcrypt-only prefix, so a re-submitted
hash is never re-hashed; `validation-engine.ts`'s expression evaluator rejects
`__proto__`/`constructor`/`prototype` tokens and, independently, refuses any
variable name other than `value` after parsing — either check alone would
still leave the other; and `getRuleGroups`'s `to_regclass` probe (not a
`SELECT ... FROM` on a possibly-missing table) cannot raise `42P01`, so a
missing `zvd_validation_rule_groups` table never aborts the caller's
transaction, verified against a live database.

### A01 — boot, app assembly, middleware order (2026-09-12, closed 9/9)

Nine files: `api-types.ts`, `index.ts`, `lib/service-registry.ts`,
`lib/startup-guards.ts`, `routes/index.ts`, three `.d.ts` fixtures, and
`version.ts`. One defect repaired.

**Repaired (medium) — most real traffic was invisible to the request-count
and Prometheus metrics.** `buildHonoApp()`'s counting `app.use('*', ...)`
middleware sat directly above the `/metrics` route, registered AFTER
`registerCoreRoutes()` had already mounted the entire `/api/*` + `/ext/*`
surface and after the plain `/health` route. Hono composes matched handlers
in registration order: a route that returns without calling `next()` never
reaches a `next()`-based middleware registered later for the same path.
Measured live (own scratch engine, own database): hitting `/api/health`,
`/api/settings` and `/api/extensions` left `zveltio_requests_total` and
`http_requests_total` completely unchanged, while a request that fell
through to the `/api/*` 404 guard (registered after the old middleware
position) was counted every time. In effect, almost the entire product's
real traffic was blind to the counters the ops dashboards read — only 404s,
the SPA fallback, and self-scrapes of `/metrics` were ever counted. The
middleware's own skip-list (`/metrics`, `/health`, `/api/health/ready`) reads
as though the author believed every other path reached this code, including
`/api/extensions`, named in the very same comment as traffic that should
count; it never did, for a reason unrelated to that list. Fixed by moving the
middleware to before `registerCoreRoutes()` so it wraps every route; verified
live before/after and with a new discriminating harness test
(`request-metrics-coverage.test.ts` — fails without the fix, passes with it).

**Checked and found sound, so the next reader can tell "safe" from "not
looked at":** the documented middleware order (trailing-slash redirect →
logger → problem envelope → body limits → CORS → session prefetch → tenant
middleware → tenant membership → extension auth gate → extension rate limit
→ routes) matches what actually executes, and `registerCoreRoutes()`'s own
internal ordering (tracing, demo-mode, auth-specific rate limits, tenant
quota, god-audit, request-log, preview-env, all before any `app.route()`
call in that function) does not repeat the class this section's one defect
belongs to. `_createAppForTests()` deliberately runs a reduced boot sequence
(documented in its own header) and does not populate `_tenantScopedTables`
or run the extension/grant-reconciliation steps `bootstrap()` runs after the
parallel block — that only disarms an opt-in diagnostic counter
(`ZVELTIO_STRICT_TENANT_SCOPE=1`), not RLS enforcement itself, and no test in
the tree currently exercises that counter either way. Graceful shutdown
(`cronRunner.stop()`, awaited `realtimeBus().stop()`, `_server?.stop()`) —
flagged incomplete by the earlier AUDIT.md pass — is present and correct in
the current tree; that TODO is stale. `productionGuardViolations` and its
tests were read and cross-checked against every guard it names — all four
(`ZVELTIO_EXT_AUTH_GATE`, `VALKEY_URL`, `CORS_ORIGINS`, `BETTER_AUTH_URL`)
fire on the case they document and none on the cases they explicitly accept.

**Not chased — cosmetic doc drift, not behaviour.** `routes/index.ts`'s
header comment still lists `/api/ai/*` as a core route; AI moved to the `ai`
extension. Left alone as a one-line documentation fix outside repair scope.

**T01 leftovers.** No dedicated test exercises `injectCspNonce`, the
static-file directory-traversal guard in `serveStaticFile`, or
`trailingSlashRedirect`; all three were read line-by-line without finding a
defect, but nothing in the suite would catch a regression in them.
### A15 — collection, relation and revision routes (2026-09-12, closed 5/5)

Five files, 2,184 lines: `routes/collections.ts`, `routes/erd-layout.ts`,
`routes/relations.ts`, `routes/revisions.ts`, `routes/schema-branches.ts` —
the routes that change user schema at runtime, and revision revert. Two
defects repaired here; the rest is what was checked and found sound.

**Repaired (high) — `PATCH /:name/fields/:field` answered 200 success on an
invalid `new_type`, leaving the field silently unchanged.** The type-change
branch validated inside `await db.transaction().execute(async (trx) => {
... })` and did `return c.json({ error: ... }, 400)` on failure. That
`return` is captured by the transaction callback's own promise — discarded
by `.execute()` — not by the outer route handler, which falls through
unconditionally to `return c.json({ success: true, field: ..., actions: []
})` right after the `await`. Measured: `PATCH .../fields/contact` with
`new_type: "not_a_real_type"` and with `new_type: "m2o"` (relation
conversion, rejected by `resolveConversion`) both answered `200
{"success":true,...}` with the column's type unchanged in both metadata and
`information_schema`. `collections-patch-type.test.ts` only exercised the
valid-conversion path, so nothing caught it. Fixed by throwing instead of
returning — the existing outer `catch` already turns a thrown `Error` into
the intended 400 with the same message. Reverted and confirmed the two named
tests fail before the fix and pass after; the pre-existing valid-conversion
test in the same file was unaffected by the revert or the fix.

Twin check: `relations.ts`'s two `db.transaction().execute(...)` helpers
(`addFieldToCollection`, `removeFieldFromCollection`) do not return early
with an HTTP response from inside the callback — the only instance of this
shape in the section was the one fixed.

**Repaired (high) — `zv_schema_branches.changes` was written with a bare
`JSON.stringify(...)` instead of `toJsonb()` (`lib/jsonb.ts`), the exact
double-encoding class that column already exists to prevent.** `changes` is
a jsonb ARRAY column; `POST /:id/changes` did `SET changes =
${JSON.stringify([...currentChanges, newChange])}`, which stores a jsonb
STRING whose text is the array's JSON rather than the array. Measured: after
one `POST /:id/changes` call, `SELECT changes ...` came back as a JS string
(`typeof === 'string'`, `Array.isArray === false`). `POST /:id/merge` reads
that value as `branch.changes || []` with no defensive parse and does `for
(const change of changes)` — over a string, that iterates individual
characters, so `change.type` is always `undefined`, nothing matches the
`add_collection`/`add_field`/`remove_field` branches, and the loop finishes
with `applied: []` and `errors: []`. The branch is then marked `status:
'merged'` regardless, so a queued schema change is silently dropped and the
merge reports "0 changes. 0 errors." as if there had been nothing queued.
Fixed the writer with `toJsonb()`, and added a `parseChanges()` helper used
on all three reads of the column (`POST /changes`, `POST /merge`, `GET
/diff`) so a branch already written the broken way — no migration exists for
this — recovers instead of continuing to no-op. Reverted and confirmed the
named test fails (asserts `Array.isArray` and that the queued change to a
nonexistent collection surfaces as a real merge error) before the fix and
passes after.

**Gate found fail-open on the exact pattern above.** `sql:jsonb`
(`scripts/check-jsonb-binding.ts`) exists specifically to catch
`JSON.stringify(v)` bound to a jsonb column, and reported `0 site(s)` with
the bug both present and fixed — verified directly by reverting the fix and
re-running the gate. Its own header says why: it parses the Kysely
`insertInto(...).values({...})` / `updateTable(...).set({...})` object-literal
shape, and `schema-branches.ts` writes `changes` through a raw `sql` tagged
template, a shape the gate does not look at. `scripts/check-jsonb-binding.ts`
is outside this section — logging rather than widening it, since I can't
verify what else the gate's scope decision was resting on. `db/dynamic.ts`
and `lib/audit.ts` both bind jsonb correctly through the raw-`sql` path
already (`${JSON.stringify(v)}::text::jsonb`), so the miss is specific to
this one call site's absence of that suffix, not to raw `sql` templates in
general.

**Logged, not fixed (out of section) — two more sites match the same wrong
shape `${JSON.stringify(v)}::jsonb` (stringify-then-cast, which `lib/jsonb.ts`
documents as still wrong: the driver has already encoded the parameter as
JSON, so the cast re-wraps a jsonb string rather than parsing one) — found by
the `sql:jsonb` gate-scope grep above, not executed/measured this session:**
- `routes/saved-queries.ts:438` (`INSERT ... VALUES (..., ${JSON.stringify(data.config)}::jsonb, ...)`, `zv_saved_queries.config` is jsonb) and `:537` (`updates.config = JSON.stringify(data.config)`, later passed to a `.set()`).
- `lib/flows/flow-executor.ts:523` and `:614` (`zv_flow_runs.trigger_data` / `.output`, both jsonb).

**Checked and found sound.** `erd-layout.ts`: user-scoped by `user_id` inside
`db.transaction().execute()` with no early return from the callback;
`DELETE /` already carries a prior fix for the `numDeletedRows` always-0n
trap (comment in place, counts from `.returning().length`). `relations.ts`:
FK direction (source vs. target table) matches the create-time direction on
delete for m2o/o2m/m2m; the two internal transaction helpers return nothing
from inside `.execute()`. `revisions.ts`: revert strips
`id/created_at/updated_at/tenant_id/search_vector/embedding/created_by`
before writing, and `updated_by` travels as a call argument rather than
through the payload so `RESERVED` can't silently drop it; tenant filter
present on every query. `schema-branches.ts`'s `POST /:id/review` already
carries a prior fix (comment in place) for a `.catch(() => {})` that used to
swallow the review-insert failure independently of the status update.
`rowCountOrAssumeLarge` fails toward the safe (online, Ghost DDL) path on an
unknown count, per its own comment and confirmed by the merge test above
(nonexistent table → `Infinity` → Ghost DDL attempted, not a blind
`ALTER TABLE`).

**Noted, not a defect.** `POST /:id/merge` marks `status: 'merged'`
unconditionally, even when every queued change fails (`errors.length ===
changes.length`) — there's no retry path once that happens. This is a
behavior/contract question (should a fully-failed merge stay `open` for
retry?) rather than a clear bug with an unambiguous correct answer, so it's
noted here rather than repaired; changing it changes what callers can
observe about `/merge`'s contract.

### B04 — marketplace, download, signature, trust (2026-09-13, closed 7/7)

Seven files, ~2,200 lines: capability consent (`consent.ts`), license-key and
license-audit helpers, the marketplace HTTP surface (install / enable /
disable / uninstall / config / license / approve-capabilities / per-firm
activation), the registry download-and-extract client, revocation checking,
and Ed25519 signature verification with its trusted-key list.

**Repaired (medium) — the test that pins "signatures required by default"
tested its own copy of the gate, not the shipped one.**
`signature-required-default.test.ts` declared a local
`function signaturesRequired() { return process.env[KEY] !== 'false' }`
instead of importing anything from `extension-download.ts`, where the real
gate lives inline inside `verifyArchiveSignature` (not exported). Flipping the
real gate to `=== 'true'` — the exact historical regression this file's own
docstring describes — left all 5 of its tests green. Fixed by exporting the
gate as `signaturesRequired()` from `extension-download.ts` and having the
test import and call it; re-broke the real function and confirmed 2/5 tests
now fail, then reverted. The actual shipped behaviour was never unprotected —
`extension-download-package.test.ts`'s "refuses an unsigned archive by
DEFAULT" test drives the real `downloadExtension` and would have caught a
regression — but the file that claims to own the default pinned nothing.

**Repaired (low) — `getLicenseKey` swallowed a failed settings read with no
log at all.** Class-2 shape: `catch { return undefined; }`, no `console.warn`,
so a transient DB hiccup during a paid extension's download silently sends no
`Authorization` header and the registry's 401 is the only trace. Added a
`console.warn` naming the extension and the underlying error; behaviour
(swallow and return `undefined`) is unchanged and intentional — a licensing
lookup failing must not block the request — only the silence is fixed.

**Repaired (medium) — no test refused a god-gated mutation route to an
authenticated-but-not-god user.** `install`, `enable`, `disable`, `uninstall`,
`config`, `approve-capabilities`, the two license routes and
`admin/license/rotate` all guard on `requireGod`, which is correct in the
code. But every existing test either has no session (401, tests the "no
session" arm only) or authenticates as `u-god` — including the harness file
(`marketplace.test.ts`), which says outright in its own docstring that it
"drives every route as a god user" because its purpose is handler-body
coverage, not authorisation. Confirmed the gap by forcing `requireGod` to
`return true` for any session: the existing 34 unit tests and the two harness
files (94 tests total) all stayed green. Added one test authenticating as a
non-god, non-admin user and asserting 401 on all nine routes; re-broke
`requireGod` and confirmed the new test fails, then reverted. `setActivation`
(the per-firm `activate`/`deactivate` pair, gated on `isTenantAdmin` rather
than `requireGod`) already has this coverage in
`ext-activation-boundary.test.ts:233` and was not touched.

**Checked and found sound:** revocation fails OPEN on an unreachable registry
(air-gapped installs boot) but a list already fetched keeps refusing after the
registry drops — verified live via the load-path tests, which go through
`loadExtensionFromDir` rather than `checkRevoked` directly; the failed-fetch
cooldown (60s) means an unreachable registry costs one dial, not one per
extension, counted directly rather than timed; archive digest pinning refuses
a re-publish under an existing version even when the registry's own declared
hash and signature both agree with the new bytes (the scenario the two-layer
check can't see on its own); the zip-slip/symlink guard walks the staged tree
before adopting it; `setActivation` resolves the tenant from
`tenantMiddleware`'s result, never the `x-tenant-id` header, closing the
specific cross-tenant toggle this codebase has had before; `approve-capabilities`
refuses to grant anything not currently declared in the on-disk manifest, and
requires the caller to name the exact set rather than "whatever it asks for
now"; the consent intersection (`resolveCapabilities`) drops a capability the
extension stopped declaring and grandfathers only a `null` (never-recorded)
grant, not an explicit empty one; `BUILTIN_KEYS`' hex pubkey round-trips to 32
bytes and matches what `signature-required-default.test.ts` pins as always
present.
### B01 — extension loading and lifecycle (2026-09-13, closed 7/7)

Seven files, 2,129 lines: `extension-loader.ts`, `load.ts`, `load-phases.ts`,
`activation.ts`, `lifecycle.ts`, `discovery.ts`, `extension-paths.ts`. Two
defects repaired, both on the same feature; the rest checked and found sound.

**Repaired (high) — dev-reload dropped the extension instead of reloading
it.** `POST /__zveltio_dev_reload` → `reloadExtensionFromDisk` cleared
`loader.loaded`/`loader.modules` for the named extension and then called
`triggerReload`, on the assumption that the resulting rebuild would re-import
it. It does not: `buildHonoApp` (`index.ts`) only *re-registers* extensions
still present in `loader.loaded`, via the cached module — it never calls
`loadExtension` for anything missing. Deleting the entry first therefore
guaranteed the rebuild would skip it. Measured live (scratch engine, :3200,
`ZVELTIO_EXTENSION_DEV_RELOAD=1`): loaded a fixture extension, hit
`/__zveltio_dev_reload`, and its route went from 200 to 404 with the endpoint
itself reporting `{"ok":false,"error":"extension failed to load — check
engine logs"}` — with no load ever attempted, so there was nothing in the
logs to check. `dev-reload.test.ts`'s "clears module state ... triggers
reload" test passed throughout by hand-simulating the rebuild re-adding the
extension to `loaded` (`onReload: async () => { deps.loaded.add('forms') }`)
— exactly what the real callback does not do; class 13, a test that passes
for the wrong reason. Fixed by having `reloadExtensionFromDisk` call
`loadDynamic` (the same helper the enable-extension route already uses) to
actually re-import onto the live `app` before triggering the rebuild;
`registerDevEndpoints`/`reloadExtensionFromDisk`'s signatures now take `app`
to make that possible. Regression test added (edits the fixture between two
loads and asserts the second sees the edit), reverted (fails at the named
assertion, "Expected: 2, Received: 1" — not a syntax break), reapplied.

**Repaired (high) — the dev-reload cache-buster does not bust anything.**
Fixing the above surfaced a second, independent defect in the same feature.
`load.ts`'s unbundled-import branch appends `?v=<timestamp>` to the import
URL "to force a fresh read of edited source" (comment, pre-existing). It
doesn't: Bun's dynamic `import()` caches by resolved pathname and ignores
query strings and fragments — verified directly (`bun 1.3.14`, outside this
codebase): two `import()` calls against the same file with different `?v=`
or `#` suffixes both returned the *first* call's module, even after the file
was rewritten in between. So even with the first fix applied, live
measurement showed the reload endpoint answering `{"ok":true}` while the
route kept serving the pre-edit response (`v:1` after editing to `v:2`) —
reported success that did not happen, worse than the original failure
because it now looks like it worked. A distinct resolved *path* does bust
the cache (also verified live). Fixed by copying the entry file to a
dot-prefixed sibling in the same directory (same folder, so relative imports
and the `node_modules` walk-up the neighbouring comment already documents
still resolve identically) with a unique per-load suffix, importing that,
and deleting it immediately after — with a sweep for a leftover copy from an
interrupted previous reload before adding a new one. Re-verified live after
the fix: edit → reload (`{"ok":true}`) → route serves the new code, twice in
a row, no leftover files. Regression test added (asserts a second
`loadExtensionFromDir` call picks up an edited entry file and leaves no
`zveltio-dev-reload` artefact behind), reverted (fails at the named
assertion), reapplied. No twin found — grepped the engine tree for the same
`?v=` / cache-busted-import-URL shape; this was the only site.

**Checked and found sound.** `activation.ts`'s per-tenant/per-firm gate
(`extensionActivationGate`, `activationMiddlewareFor`, `guardHandler`,
`guardEventHandler`, `guardScheduleHandler`) fails OPEN on a database error
(deliberate — activation is a preference, not an authorization decision, and
every downstream authz check still runs) and fails CLOSED (404, same as an
uninstalled extension) when the DB answers `is_enabled = false`; the
in-flight map correctly collapses a concurrent-cold-cache burst into one
query per tenant per extension, so it does not reproduce the
`DB_POOL_MAX`/second-connection shape from the transaction-boundary
incident. `unloadExtension` (`lifecycle.ts`) does stop a worker-isolated
extension's `Bun.Worker` and does drop its `/ext/*` public-route exemptions
before returning — both are past fixes (per their own comments) that this
session re-confirmed are still wired, not regressions to re-report.
`topoSortExtensions` (`discovery.ts`) continues loading a dependent whose
declared dependency is outside the planned set (logs a warning, does not
skip it) — the function's own top-of-file JSDoc says "the dependent
extension is skipped", which is stale relative to the code and the warning
text it emits; noted here as a doc-only mismatch, not a behaviour defect.
`enforcePublisherTier` (`load-phases.ts`) is hoisted above the WASM/worker
runtime branch (2026-09 fix, per its own comment) so a community-tier
manifest cannot dodge the worker-isolation requirement by declaring
`runtime: "wasm"`; confirmed the gate still runs for that branch by reading
the call order, not just the comment.

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
