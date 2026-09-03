# Zveltio vs Supabase (features) + engine ↔ extensions boundary audit

> **Written:** 2026-08-21 across four cleanup branches, none of them merged.
> **Landed on master:** 2026-08-22, with §4.2 reimplemented — see the table below.
> **Scope:** a comparison at the level of **features** (not market maturity or team size), plus a code audit following the SaaS → BaaS migration.
> **Sources:** `README.md`, `docs/platform/overview.md`, `docs/private/TECHNICAL-GAPS.md`, `packages/engine/src/routes/index.ts`, `extension-catalog.ts`, the `~/zveltio-extensions` repository (CONTEXT.md for media/import/export).
> **Author's context:** a project developed over a few months by one person plus AI agents — feature volume against Supabase (years plus a team) is not a failure metric; the interest is parity and differentiation on a checklist.

---

## Implementation status

The four branches that produced this document were never merged and fell 66
commits behind. Their work was redone directly on master, and in three places
**the branch's conclusion was changed**, because master had moved in the
meantime:

| Item | What the branch planned | What landed |
|------|------------------------|-------------|
| `/api/media`, `/api/approvals` | delete | already done on master via #318 (410 shims) |
| `/api/export`, `/api/import` | delete | **410 shims** via `goneRoutes`, as with the other three — an old caller gets the replacement path, not a mute 404 |
| Edge: keep `/api/fn`, drop CRUD | — | already on master |
| Harness tests against the dead door | deleted | deleted; `gone-doors` instead gets assertions for export/import |
| `zv_import_logs` ownership | expand + **drop** dead columns, in one migration | **expand** in 048 + **contract as a boot reconciler** (`contractImportLogs`, armed with `ZVELTIO_IMPORT_LOGS_CONTRACT=1`). Not a migration: one runs once and marks itself applied, and the safe moment is not the moment of execution — it is when an operator's rollout has finished, which no SQL can detect. The window is real, verified: `migration-job.yaml` is a Helm `pre-upgrade` hook, so migrations run *before* the Deployment rolls, and the chart anticipates `replicaCount > 2` |
| Catalog orphans | add to the catalog | added; metadata checked against the manifests, zero orphans left |
| Studio broken redirects | **re-add the baked pages** (625 lines) | **delete the two redirect stubs** (40 lines). The branch's direction contradicted SDUI; `[...extPath]` now serves both pages from the extensions' schemas |
| Full SDUI migration | separate epic | see §4.6 — still open |

### Cleanup debt: behavioural tests on the live path — CLOSED 2026-08-23

Closing the duplicate doors `/api/export` and `/api/import` cost four harness
suites, because all of them exercised the engine route that became a 410 shim:

- `import-encrypts-fields` — field encryption on import, hashing on the password column
- `import-lifecycle` — the full lifecycle of an import job
- `export-rls-columns` — export respects RLS policies and column permissions
- the "applies to import too" case in `validation-rules-enforced`

They were testing dead code, so no coverage was lost on anything reachable. The
problem is what was left uncovered: the **live** path — `/ext/data/export` and
`/ext/data/import` — has only the generic contract harness from the extensions
repository (`extensionContract`), which checks boot, schema and a write probe.
No assertion that export respects RLS, none that import encrypts.

They cannot simply be re-pointed in the engine:
`packages/engine/src/testing/app-harness.ts` does not load extensions, and the
tests there that touch `/ext/*` (`ext-body-limit`) deliberately hit a
non-existent path in order to test the middleware.

**Paid** in `zveltio-extensions@4a0a93b`, but not by literal porting. The engine
tests needed Postgres, sessions and real policies; the new ones instrument `ctx`
and check what the route **asks for**, because a database that answers correctly
hides a missing `getRlsFilters` behind an incidentally empty result — exactly
how the original bug survived a green suite.

The export double imitates Postgres in the two respects that decide the answer:
rows come back unfiltered if `applyRlsFilters` did not run, and only projected
columns are returned, because `select(projectable)` is the real defence — a mask
applied afterwards still pulls the bytes out of the database.

Verified by **mutation against the packed bundles**, not by the fact that they
pass: disabling `applyRlsFilters` fails two export tests, widening the
projection two more, removing `maybeEncrypt` fails two import tests, and
removing the `await` from `deserialize` — the exact historical bug — two more.
The bundles were restored afterwards and both integrity hashes match.

Still uncovered: the other two deleted suites (`import-lifecycle`,
`validation-rules-enforced` on the import path) have no replacement. Those were
job cycles and validation rules, not security properties.

The rest of the document (§1–§7) is the analysis that motivated the cleanup and
remains valid as such.

---

## 1. How to read the comparison correctly

Zveltio is not "a weaker Supabase". It has **two layers**:

| Layer | What it is | Honest peer |
|-------|------------|-------------|
| **Engine (BaaS)** | Auth, collections/API, RLS/RBAC, realtime, storage, webhooks, flows, Studio | Supabase / PocketBase |
| **+ extensions (SaaS)** | CRM, POS, finance, mail, RO compliance, HR… | Odoo / HubSpot — **not** Supabase |

Install zero extensions and you compare against Supabase. Enable the marketplace
and you compare against a modular Business OS. Both are supported deployments,
not workarounds.

---

## 2. Feature matrix (BaaS layer)

Lead legend: **Z** = Zveltio ahead · **S** = Supabase ahead · **≈** = parity ·
**≠** = different models (not "better", a different bet)

| Feature | Zveltio | Supabase | Lead | Short note |
|---------|---------|----------|------|------------|
| Auth (email, OAuth, 2FA, magic link) | Better-Auth + passkeys | GoTrue + JWT + Auth Hooks | ≈ | S richer on enterprise SSO / third-party JWT |
| DB API | Dynamic collections + REST/RPC | Postgres + PostgREST, SQL-first | ≠ | Z abstracts the schema; S is native SQL |
| Authorization | Casbin + FORCE RLS tenant + column perms | Postgres RLS on JWT | S* | *Z: per-user RLS on **read**; update/delete still incomplete (README) |
| Realtime | WS + Valkey / LISTEN/NOTIFY | Changes + Broadcast + Presence | S | Presence/Broadcast missing in Z |
| Storage | Local FS by default + S3 | Storage GA + CDN + transforms | ≈/S | Parity self-hosted; S wins on Cloud + DX |
| Edge / Functions | TS on the instance (process/worker) | Deno Edge, global | S | Z = serverless on your own VPS |
| Branching | Schema / env branches | DB branching (mature 2025–26) | ≈ | The "Supabase No" claim in the intro is **out of date** — to be corrected |
| Webhooks | HMAC outbound | DB webhooks + Edge | ≈ | |
| Admin UI | Studio + Client zones | Excellent dashboard | ≠ | Z also targets business UI |
| Automation / Flows | **In core** (DLQ, idempotency) | DIY Edge + webhooks | **Z** | A clear BaaS differentiator |
| Ghost DDL | Zero-downtime alter | Classic migrations | **Z** | |
| BYOD | Introspect an existing Postgres | Not as a product | **Z** | |
| Audit trail | Write audit built in | Logging / DIY | **Z** | |
| Offline sync | CRDT (+ optional Electric) | Not as a core product | **Z** | |
| Multi-tenancy | Primordial (GUC + membership) | RLS DIY per project | **Z** | |
| Single binary / self-host ops | Bun + one process | Multi-service compose | **Z** | |
| Business extensibility | ~57 signed extensions + marketplace | PG extensions + Edge | **Z** | The layer that shifts the category |
| CRM / finance / POS / mail | Extensions | No | **Z** | Not a Supabase gap — a different category |
| Fiscal compliance (RO) | e-Factura, SAF-T, e-Transport | No | **Z** | Operational compliance vs platform compliance |
| Cloud certifications (SOC2/ISO) | Post-1.0 | Yes (cloud) | S | Procurement, not a runtime feature |
| Ecosystem (SDK ubiquity, tutorials) | TS/React/Vue SDK | Market dominant | S | Not a feature; affects adoption |

### Feature verdict (setting aside "how mature are they")

- **On the BaaS checklist:** Zveltio covers nearly everything a founder
  evaluates on Supabase, plus several things that **do not exist** there (native
  flows, Ghost DDL, BYOD, tenancy-as-product, offline, first-class audit).
- **Where S still wins on concrete features:** Presence/Broadcast, geographic
  edge, write-complete RLS, SQL-first PostgREST, storage transforms/CDN as a
  product.
- **Where Z wins outright:** automation in core, plus a marketplace that turns a
  BaaS into a SaaS on the same auth/RLS/audit.

For one developer over a few months, the feature surface is **unusually
complete** against a greenfield BaaS. The market gap (trust, community,
certifications) is separate from the feature gap — and is solvable with a team
once the product catches on.

---

## 3. What I would build next to attract users

Prioritised on **conversion + wow + unblocking evaluation**, not on another ERP
module.

### P0 — attract and convert (weeks, not months)

1. **Hosted public demo + "Install CRM in one click"**
   The demo code exists; the hosting does not. An evaluator who sees CRM plus
   flows on fake data in 30 seconds beats any feature matrix.
2. **Template → live app in under 2 minutes**
   Templates exist; build the path: `curl install → pick template → Studio open
   on the pipeline`. No mandatory docs.
3. **RLS on update/delete (parity with the security claim)**
   Not "sexy", but the first thing an ex-Supabase user checks. It blocks
   technical trust.
4. **A "Supabase → Zveltio" migrator (schema + auth users stub)**
   `integrations/migrators` exists on disk, uncatalogued. An "import
   PostgREST/schema dump" wizard is a magnet for churn from S.
5. **A public benchmark on identical hardware vs PocketBase/PostgREST**
   One p50/p95 chart on CRUD + realtime. People do not read feature tables; they
   read "is it fast enough?".

### P1 — differentiators that sell themselves

6. **SDUI coverage across the ~57 extensions** (about 26/57 at the time)
   Installing an extension must make UI "appear" with no hardcoded pages in
   Studio. That is the visible BaaS→SaaS promise.
7. **AI schema → collections → permissions → first screen**
   Text-to-schema exists; wire it into onboarding: "describe the business → app".
8. **Briefing / entrepreneur dashboard as the default post-login**
   `briefing.ts` already has the right idea ("who owes me money"). Extend to 3–5
   answers, not engine metrics.
9. **Public marketplace browsing without installing** (website)
   "Replace HubSpot / Zapier / e-Factura" as cards → install CTA.
10. **A clear edge-functions story**
    One path for invoke (`/api/fn`) plus CRUD either only in the extension or
    only in core — today the split is confusing (see §4).

### P2 — nice, after product-market fit

11. Presence/Broadcast on realtime (a checkbox against S).
12. Storage image transforms (or an extension over SeaweedFS/imgproxy).
13. SCIM in the catalog (`auth/scim` exists on disk).
14. Country pack #2 (e.g. IT SDI or DE) — signals that RO is not the end of the
    architecture.
15. Client SDK snippets "copy from Supabase docs" (mental mapping
    `from().select()` → collections).

### What I would **not** do now

- Another finance/HR module before the demo, RLS write, and the duplicate-route
  cleanup.
- SOC2 before three paying design partners exist.
- Obsessive feature parity on Presence — it is not why anyone chooses Zveltio.

---

## 4. Boundary audit: engine ↔ `zveltio-extensions`

The SaaS → BaaS migration is **partial**. Four promotions into core were done
correctly. Five features remain **live duplicates** (engine mounted at `/api/*`
plus an extension at `/ext/*`), and Studio usually consumes only `/ext/*`. This
has already produced security bugs fixed on the dead copy (documented in
CONTEXT.md).

### 4.1 Core promotions — clean (good)

| Feature | Engine | Extension folder |
|---------|--------|------------------|
| insights | `/api/insights` | **deleted** (catalog: promoted) |
| saved-queries | `/api/saved-queries` | **deleted** |
| schema-branches | `/api/schema/branches` | **deleted** |
| backup | `/api/backup` | **deleted** |

### 4.2 HIGH duplicates — to delete from the engine (or to give a single owner)

Studio and the UI call `/ext/…`. The engine still mounts `/api/…` over the same
tables. ~2.5k LOC of dead routes plus tests against the wrong door.

| Feature | Engine (dead for the UI) | Extension (live) | Evidence |
|---------|--------------------------|------------------|----------|
| **Media** | `routes/media.ts` (~784 LOC) → `/api/media` | `content/media` → `/ext/content/media` | CONTEXT: "zero consumers"; security fixes landed on the dead copy first |
| **Approvals** | `routes/approvals.ts` (~663) → `/api/approvals` | `workflow/approvals` → `/ext/workflow/approvals` | Studio: `/ext/workflow/approvals`; the extension additionally has SLA/delegates |
| **Export** | `routes/export.ts` (~171) → `/api/export` | `data/export` → `/ext/data/export` | `ExportActions.svelte` → `/ext/data/export`; CONTEXT: guards on `/api/export` with no consumers |
| **Import** | `routes/import.ts` (~433) → `/api/import` | `data/import` → `/ext/data/import` | **Schema clash** on `zv_import_logs`: `file_format` vs `format`, `error_rows` vs `failed_rows`, `processing` vs `running` — a virgin install 500s until migration 003 |
| **Edge functions CRUD** | `routes/edge-functions.ts` (~480) → `/api/edge-functions` (+ `/api/fn`) | `developer/edge-functions` | Split: invoke on the engine, admin on the extension — one model must be chosen |

**Cleanup ROI #1:** unmount and delete `media.ts`, `approvals.ts`, `export.ts`,
`import.ts` (plus harness tests hitting the dead `/api/*`; update
`api-reference.md`). Keep a single owner per table.

### 4.3 Wrong split / confused ownership (MED–HIGH)

| Problem | Detail |
|---------|--------|
| `zv_import_logs` | Created by both a core migration and the extension, with different vocabularies. The extension has `003_engine_shaped_table.sql` as a band-aid. The owner should be **only the extension** once the engine route is deleted. |
| `zv_pages` + sitemap | The engine serves `/api/sitemap.xml` over tables that `content/pages` conceptually owns. |
| Edge functions | Two CRUD doors; `/api/fn` intentionally on the engine — fine if documented; duplicated CRUD is not. |
| Approvals feature set | Engine = subset; extension = full. Same `zv_approval_*`. |
| Studio hardcoded `/ext/…` | Dozens of Svelte pages in `packages/studio` assume the extension is installed, in parallel with the SDUI catch-all — a leftover of the SaaS-era "everything is in the monolith". |
| `analytics/dashboard`, `auth/scim`, `integrations/migrators` | Present on disk, **missing from** `EXTENSION_CATALOG` — marketplace orphans. |

### 4.4 In the engine, debatable for a "pure" BaaS (MED)

Not necessarily wrong — they are **SaaS-product leftovers** or deliberate bets:

| Route | Why it smells of SaaS | Recommendation |
|-------|-----------------------|----------------|
| `/api/briefing` | "Who owes me money" over core `transactions` | **Keep** as an entrepreneur differentiator — but document it as Business OS, not minimal BaaS |
| `/api/templates` | CRM/invoicing/helpdesk/inventory/ansvsa packs | Fine as seeds; long term, marketplace starters |
| `/api/flows` | Heavy automation in core | **Keep** — it is the moat against Supabase; do not move it to an extension |
| `/api/notifications` | Platform inbox | Core is fine |
| `/api/sql-editor`, ERD | Dev tooling | Core is fine for BaaS admin |

The `routes/index.ts` header still lists `/api/ai/*` as "core" although AI was
correctly moved into an extension — **docs drift** (LOW).

### 4.5 Correct split (the example to follow)

| Pattern | Status |
|---------|--------|
| **AI** | Routes in `zveltio-extensions/ai`; the engine no longer mounts `/api/ai` |
| **GraphQL, drafts, documents, GDPR, mail, quality UI** | Extension only |
| **data-quality engine** | `lib/data-quality.ts` in core as a **capability** (`runQualityScan` via extension internals); UI and routes in `analytics/quality` — fine |
| **Auth, collections, data, RLS, storage, webhooks, tenants, realtime, sync** | Legitimately core |

### 4.6 Recommended cleanup order

1. **Delete the dead `/api` copies:** media, approvals, export, import (plus
   tests and OpenAPI).
2. **Edge functions:** choose (A) CRUD + invoke all in core, Studio UI in the
   extension; or (B) everything in the extension, with the engine keeping only
   invoke at `/api/fn`.
3. **Import table:** after (1), simplify the extension's migrations; one column
   vocabulary.
4. **Catalog:** add or archive `analytics/dashboard`, `auth/scim`,
   `integrations/migrators`.
5. **Studio:** reduce the hardcoded pages duplicating the extensions' `studio/`
   (media and approvals already noted as near-identical).
6. **Update** the intro's branching claim and the header comments in
   `routes/index.ts`.

---

## 5. Extension inventory on disk (`~/zveltio-extensions`)

57 packages with a `manifest.json` (approximately):

```
ai
analytics/dashboard*   analytics/quality
auth/ldap  auth/saml  auth/scim*
billing
communications/mail
compliance/gdpr  compliance/ro/{documents,efactura,etransport,procurement,saft}
content/{documents,document-templates,drafts,media,pages,pdf-viewer}
crm
data/{export,import}
developer/{api-docs,byod,database,edge-functions,graphql,validation}
ecommerce/store
finance/{accounting,banking,expenses,invoicing,quotes,subscriptions}
forms
geospatial/postgis
hr/{employees,leave,payroll,time-tracking}
i18n/translations
integrations/{api-connector,migrators*}
operations/{assets,inventory,pos,traceability}
projects/{helpdesk,management}
search
sms
storage/cloud
workflow/{approvals,checklists}
```

`*` = on disk, absent from `EXTENSION_CATALOG` at the time of the audit.

---

## 6. Executive conclusion

1. **Features vs Supabase:** on BaaS you are competitive and differentiated
   (flows, Ghost DDL, BYOD, tenancy, audit, offline). The real feature gaps are
   RLS write, realtime Presence and global edge — not "half the product is
   missing".
2. **Attracting users:** hosted demo + one-click template + a Supabase migrator
   + a benchmark + RLS write + SDUI across the extensions. That sells; the 58th
   ERP module does not.
3. **Post-migration code:** the insights/saved-queries/schema-branches/backup
   promotions are clean. **The large debt** is the five duplicates —
   media/approvals/export/import/edge-functions — already documented as "zero
   consumers" and a cause of false confidence. Deleting them is the cheapest
   architectural-credibility win available.

---

## 7. Quick references

- Engine mounts: `packages/engine/src/routes/index.ts`
- Catalog: `packages/engine/src/lib/extensions/extension-catalog.ts`
- Duplicate docs:
  - `~/zveltio-extensions/content/media/CONTEXT.md`
  - `~/zveltio-extensions/data/import/CONTEXT.md`
  - `~/zveltio-extensions/data/export/CONTEXT.md`
- Trust/GTM gaps: `docs/private/TECHNICAL-GAPS.md`
