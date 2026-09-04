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

**Gap — hidden columns are readable-denied but still writable.**
`ColumnAccess` carries both `hidden` (filtered out of GET responses) and
`readOnly` (rejected on write). `filterWritableFields`
(`lib/tenancy/column-permissions.ts`) consults only `readOnly`. A role denied
*visibility* of a column can therefore still set its value blind. Narrow, but
real: the two sets should either both gate writes, or `hidden` should imply
`readOnly`.

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
