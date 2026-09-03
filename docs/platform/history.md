# How Zveltio Got Here

The chapters in this documentation describe what the system **is**. This one
explains **why it is shaped that way** — the decisions, the reversals, and the
incidents that produced the current design.

Read it if you are taking over the project, or if you are about to change
something that looks arbitrary. Most things that look arbitrary here are load-
bearing, and this page says which.

> Dates and version numbers are from `CHANGELOG.md`, which is 4,600+ lines —
> grep it, do not read it whole.

---

## 1. Alpha — up to 2026-05-31 (`1.0.0-alpha.1` → `.129`)

`.1`–`.47` exist only in git and were never written up. `.48`–`.129` were
intensive development, and three decisions from that period still govern the
architecture.

**AI was extracted from the engine into an extension** (`alpha.67`,
2026-05-08). The reasoning: AI is not non-negotiable the way Postgres and auth
are, and an organisation that does not want it must be able to install without
it. That extraction forced `ctx.services` into existence — the inter-extension
service registry, Drupal-style — and with it topological loading by dependency.
It is still cited internally as the model for a correct split. The same period
rebranded the product from "BaaS" to "self-hosted Business OS".

**Extensions v2** (`alpha.111` → `beta.1`) replaced fragile runtime `.ts`
loading with a bundled artifact. Incidents `alpha.106`–`110` were almost all
loader regressions, which is what made the case. The result: `engine/index.js`
as the built artifact, manifest v2 with SHA-256 `integrity`, and a CLI that
packs, validates, signs and publishes. **Zero backward compatibility** — there
was deliberately no legacy channel — and all official extensions were migrated
by script.

**Worker isolation** (`alpha.121`–`122`) stopped importing community extensions
into the engine process: a separate process, the `zveltio_worker` database role,
and a SQL allowlist.

---

## 2. Beta, and the version jump (2026-05-31 → June)

`1.0.0-beta.1` declared alpha EOL and the extension model API-stable.

**`3.0.0-beta.1` (2026-06-14) was a renumbering, not a feature release.** Some
npm packages had been published at `2.0.x` by mistake, and a published version
is not recoverable — so the line jumped to `3.0.0` with code identical to
`beta.3`. The rule established then still holds: **published versions are
immutable, and mistakes are fixed by going forward**, never by renumbering. See
[versioning.md](versioning.md).

`beta.2` added marketplace admin roles; `beta.3` added the three publisher tiers
(first-party / verified / community) and made worker isolation mandatory for
community extensions.

---

## 3. Multi-tenancy — the longest arc (beta.18 → present)

**Before (≤ beta.16):** global Casbin, membership unenforced, RLS opt-in, and
extensions running on the global pool. The May 2026 audit found 50+ extensions
with no `tenant_id` and no RLS. The fix applied a `002_tenant_rls.sql` template
to 51 extensions and put `reqDb(c)` everywhere.

**The foundation (beta.18–23)** introduced the model that still holds: **there
is always exactly one tenant.** A default tenant exists, and single-tenant is
the degenerate case rather than a separate mode. Casbin gained domains
(`r = sub, dom, obj, act`), membership became middleware, `tenant_id` became a
system column, and a boot reconciler applies FORCE RLS.

Two hard requirements come from this period, and breaking either silently
disables isolation:

- the database role in tenant transactions must be **non-superuser**, or RLS is
  bypassed;
- session variables must be set with `set_config(..., true)`, not
  `SET LOCAL = $1`.

**The hierarchy (August 2026)** moved the model from a flat list of
customers-with-subscriptions to a **tree of organisational units**. The driving
case was a public-institution deployment with 41 county directorates. It brought
`read_scope` (`self` / `subtree` / `list` / `org`), writes restricted to a
unit's own node, opt-in downward visibility per collection, two predicate
functions (`zveltio_tenant_write_ok` / `zveltio_tenant_scope_ok`), and 315
rewritten policies. The subscription columns (`plan`, `trial_ends_at`) were kept
deliberately.

**Maturing it (August 2026)** produced decisions to *not* change things:
no `loadFilteredPolicy`, no CASL, no Zanzibar. The premise that justified them —
"policies grow with the number of tenants" — was **disproved by measurement**.

Current state: [multi-tenancy.md](multi-tenancy.md).

---

## 4. The positioning reversal (beta.31 → beta.32, 2026-07-16/17)

[ADR 0001](../adr/0001-frontend-surfaces-and-portable-render-contract.md) — the
only ADR in the repository — fixes three frontend surfaces: admin at `/admin`,
app and public at `/`, and a future bring-your-own surface, with a versioned
portable render contract and permission filtering that is strictly server-side.

**It was revised the same day it was written**, and the revision is the part
worth knowing. The original premise — "public-first CMS, WordPress-like, with a
seeded public homepage" — was wrong. Zveltio is **app- and intranet-first**:
`/` is a login/sign-up landing by default, a public page is opt-in, the page
builder is not installed by default, and self-registration is off by default.

The revised ADR is the source of truth. The `beta.31` changelog entry is not.

---

## 5. Hardening toward stable (beta.30, July 2026 → present)

**`beta.30` was the security release**: 29 tenant-isolation and IDOR fixes,
Hardening Wave 9 complete (H-01…H-16), RFC 9457 `problem+json` errors
throughout, tenant-scoped `ctx.db` for extensions — and the first fully green
master in CI.

**The god-file split (H-04…H-08)** took `extension-loader.ts` from 1,773 lines
to under 500, `data.ts` from 1,734 to 63, and `admin.ts` from 1,347 to 244.
`lib/` was reorganised into eight sealed subsystems with barrel files, held
there by the `import-boundaries` gate.

**The engine↔extension boundary migration (August 2026)** promoted four
capabilities cleanly into core — insights, saved queries, schema branches,
backup — and deleted dead duplicates behind 410 shims. The reason that mattered:
**security bugs had been fixed on the dead copy**, which is the worst possible
place to fix them.

**SDUI (August 2026)** turned extension Studio pages into declarative JSON
schemas rendered by a generic host. 61 schemas were migrated and the baked
Svelte pages deleted. The spike verdict was that 75–80% of pages fit the
declarative model; compile-time slots cover much of the rest.

**Migrations were squashed** from 70 engine SQL files into `001_initial.sql`
(2026-05-24), with a checksum chain (`assertChainCompatible`) added around
`beta.42`. The squash later broke the upgrade path — see the lesson in
[operations.md](operations.md#7-upgrades).

**Performance:** Casbin authorization went from a reported 364–885 ms per
decision to roughly 0.1 ms. The original figure was never real — see below.

---

## 6. The lesson that produced the working method

In late August 2026, a week of measurements was taken against a database
polluted by the leftovers of its own test runs — 163 ghost collections. It
produced "364 ms per Casbin decision", which was **false**, and which was cited
in two reports before anyone re-measured. The real number was **0.93 ms**.

Nothing about that week was careless in an obvious way. The measurements were
real, the method was consistent, and the number was wrong by a factor of nearly
400. That is where the current rules come from:

1. **Every number has a measurement behind it.** Measure before building, and
   write the success criteria *before* implementing — not after seeing results.
2. **A CI gate is proved by planting a failure in it.** At audit, 9 of 31 gates
   had ever been proved. Seven were fail-open — green against an empty corpus —
   and were repaired to fail closed. The meta-gate `check-gate-coverage` exists
   because of this.
3. **A ✅ means somebody wrote code, not that somebody ran it.** `dr-drill.sh`
   was cited as evidence for two months while being dead on its first command.
4. **Disproved conclusions are corrected inline, not deleted.** The correction
   date matters more than the creation date; a document that quietly drops a
   wrong claim teaches nobody.

These are not aspirations. They are why
[development.md](development.md#2-tests) tells you to use a fresh database per
session, and why [security.md](security.md#3-verification-traps) lists the green
signals that have lied.

---

## 7. Where the durable knowledge actually lives

Not here. This page is context, not reference.

The most reliable record in this codebase is **the comment at the line that
fixes a bug**, explaining which failure that line prevents. That convention is
why nineteen audit reports and twenty-five handoff documents could be retired in
September 2026 without losing what they knew: the findings had already been
written where they would be read.

When you fix something surprising, write the surprise down next to the fix. It
outlives every document in this directory.
