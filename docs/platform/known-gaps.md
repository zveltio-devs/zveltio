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

**Gap — `CREATE POLICY` interpolates the table name with a bare quote wrap.**
`lib/tenancy/tenant-manager.ts` builds `const t = `"${table}"`` and interpolates
it into DDL. Every sibling statement in the same file uses `sql.id()`. Not
currently exploitable — the names come from the Postgres catalogue, not from a
request — but it is the one statement of the set that would be injectable if
that ever changed.

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
