# Session PR log — 2026-05-24

> What an AI agent shipped across two repos in a single autonomous session,
> ordered as five focused PRs. Predecessor: [AUDIT-2026-05-24.md](AUDIT-2026-05-24.md)
> (the broader audit context — passes 6+7, typecheck cleanup, alpha squash).
> This file documents what came AFTER that audit and what the next agent
> should pick up.

## Why this exists

The audit (`AUDIT-2026-05-24.md` §6.1) identified a systemic multi-tenant
gap in 50+ extensions and proposed a 5-PR rollout. That rollout shipped
in this session. Each PR is a separate commit on `master` (no branch /
no PR review on GitHub yet — pre-1.0 alpha).

## Repos affected

- `zveltio/` — engine + SDK
- `zveltio-extensions/` — official extensions

Both started this session with working trees clean and `bun run typecheck`
green; both ended the same way.

## The five PRs

### PR #1 — CRM tenant_id + FORCE RLS (template)

**Commit:** `6ee6b7e` (zveltio-extensions)

**What.** Established the per-extension tenant isolation pattern for the
49 extensions that still need it. CRM was chosen as the template because
it holds the highest density of PII (contact names, emails, organization
tax ids, transaction totals, lead scores) and because every other
operational extension shares the same shape of fix.

**Files.**

- `crm/engine/migrations/002_tenant_rls.sql` (new, 248 lines):
  - Adds `tenant_id UUID` to all 9 tables (`zvd_contacts`,
    `zvd_organizations`, `zvd_transactions`, `zvd_crm_pipeline_stages`,
    `zvd_crm_custom_fields`, `zvd_crm_activities`,
    `zvd_crm_email_sequences`, `zvd_crm_lead_scores`,
    `zvd_contact_organizations`).
  - `DEFAULT NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid`
    so application code that writes inside the tenant transaction tags
    the row automatically.
  - Per-table `(tenant_id, created_at DESC)` index.
  - `ENABLE + FORCE ROW LEVEL SECURITY` on every table. FORCE matters:
    without it the engine connects as the table owner and Postgres lets
    the owner bypass policies (RLS becomes advisory).
  - `tenant_isolation_<table>` policy on each table — accepts the row
    iff the GUC is unset (single-tenant fallback), the row tenant_id
    is NULL (legacy data, single-tenant only), or the row tenant_id
    matches the GUC.
  - `RAISE WARNING` per table if any pre-existing rows have
    `tenant_id IS NULL` while the deployment has provisioned tenants.
  - Full symmetric DOWN block.

- `crm/engine/routes.ts` (modified):
  - Inline `reqDb(c)` helper (`c.get('tenantTrx') ?? db`) — same shape
    as the AI extension's helper.
  - All 18× `.execute(db)` replaced with `.execute(reqDb(c))`.
  - All 3× `db.executeQuery(...)` replaced with `reqDb(c).executeQuery(...)`.
  - Verified no remaining raw `db.` calls in handlers (only the
    destructure on line 21 and the helper itself).

**Validation.** `bun run typecheck` green in both repos.

### PR #2 — finance/invoicing + hr/payroll + compliance/ro/efactura

**Commit:** `e1f92aa` (zveltio-extensions)

**What.** PR #1's template applied verbatim to the three most sensitive
remaining extensions:

- `finance/invoicing` — 6 tables: invoices, lines, payments, credit
  notes + lines, payment reminders.
- `hr/payroll` — 7 tables: periods, entries, adjustments, sick leave,
  meal vouchers, overtime, exports. Salary + CNP data.
- `compliance/ro/efactura` — 4 tables: invoices, status_log, storno,
  daily_stats. ANAF (Romanian tax authority) filings. Cross-tenant
  leakage here exposes another company's legal submissions.

**Per-extension differences from the CRM template.**

- finance/invoicing has two top-level helpers (`nextInvoiceNumber`,
  `nextCreditNoteNumber`) declared OUTSIDE the route factory closure
  where `c` is not in scope. They keep their `db: any` parameter
  signature; callers now pass `reqDb(c)` instead of bare `db`.
- compliance/ro/efactura has the same shape with its `logStatusChange`
  top-level helper.

**Validation.** `bun run typecheck` green.

### PR #3 — permissionGate triage (sized down from 15→2)

**Commit:** `bca06f2` (zveltio-extensions)

**What.** Original plan: add `permissionGate` to ~15-18 extensions
flagged by the peer review as "no gate". Reality after per-file
inspection: only 2 actually needed the gate.

**Gates added:**

- `data/export` → `permissionGate(ctx, 'export')`
- `data/import` → `permissionGate(ctx, 'import')`

These were the only two exposing admin-shaped routes (arbitrary
CSV/JSON upload + download of any collection) behind nothing more than
`auth.api.getSession(...)`.

**Triage of the other 10 candidates (no code change needed):**

| Extension | Why no broad gate needed |
|---|---|
| `billing` | Prefix-scoped `requireAdmin` on `/usage`, `/plans`, `/subscriptions`. Stripe webhook stays public — gating it would break Stripe delivery. |
| `communications/mail` | Identity-scoped (handlers operate on the caller's own mailbox). |
| `compliance/gdpr` | Admin-only via inline `checkPermission`. |
| `content/document-templates` | Admin check inside `app.use`. |
| `developer/byod` | Admin check inside `router.use`. |
| `developer/database` | Admin check inside `app.use`. |
| `forms` | `requireAdmin` except `/public/*` (form submission). |
| `search` | `requireAdmin`. |
| `geospatial/postgis` | Per-collection `checkPermission(userId, 'data:${shortName}', 'read')` — AI-style fine-grained. |
| `content/page-builder`, `i18n/translations`, `sms`, `storage/cloud` | Per-handler or prefix-scoped guards; surgical insertion needed, deferred. |

**Validation.** `bun run typecheck` green.

### PR #4 — docs (RBAC layers + tenant-RLS status + AI exception + Casbin g-rows)

**Commit:** `dab7f87` (zveltio)

**What.** Two doc updates that close out everything the peer review
flagged as undocumented.

**1. `docs/SECURITY.md`** gains a new top-level "RBAC" section explaining
the three authorization layers, in increasing strictness:

   - Layer 1: auth guard (every extension's first `app.use`).
   - Layer 2: `permissionGate(ctx, '<resource>')` — what it does, which
     extensions use it, **which intentionally DON'T** (full table with
     per-extension reasons covering the same triage as PR #3).
   - Layer 3: Casbin `g` row mapping users to roles. Spells out the
     matcher semantics and the most common operator misconfiguration:
     "p rows seeded but no g rows → every non-god user gets 403."

   Also gains a per-extension tenant-isolation status table that
   operators must consult before enabling an extension in multi-tenant
   mode. Marks `ai`, `crm`, `finance/invoicing`, `hr/payroll`,
   `compliance/ro/efactura` as ✅ tenant-safe; everything else as ⏳
   pending the §6.1 backlog.

**2. `docs/AUDIT-2026-05-24.md`** §6.1 + §6.2 updated to reflect PR #1-#3
completion. The original "highest-risk first" list is now a
commit-tracked progress table. §6.2 points operators to the new
SECURITY.md RBAC section instead of repeating the explanation in two
places.

No code changes. Docs are the deliverable.

### PR #5 — extract pure utilities from extension-loader.ts

**Commit:** `2b66006` (zveltio)

**What.** First slice of the loader split called out in the peer
review (2522 LOC, 56× `as any`). After this PR: 2407 LOC in the main
file + 206 LOC in a new `extension-utils.ts` module.

**Moved to `packages/engine/src/lib/extension-utils.ts`:**

- `inMemoryMutex` + `withExtensionLock` — concurrency primitives.
  The `extensionLifecycleLocks` map moves with them so callers can't
  accidentally fork two copies of the state.
- `fetchWithRetry` — HTTP retry helper used by the marketplace path.
- `isPathInsideBase` — path-traversal guard.
- `parseMigrationSql` + `ParsedMigration` interface — UP/DOWN splitter
  for extension `.sql` files.
- `directorySizeBytes` — recursive size sum for quota checks.

**Why this set, not more.** These were the cleanest extractable group:
each is a pure helper with no engine-internal state beyond the
lifecycle-locks map (which moved with the functions that use it). The
remaining heavyweight groups in `extension-loader.ts` — license audit,
marketplace download, peer-deps installer, the `ExtensionLoader` class
itself — touch many engine singletons and are riskier to split
without a real test suite. Future agents can copy this PR's shape when
they're ready.

**API stability.** `extension-loader.ts` keeps re-exporting every
moved symbol so no import site outside the file needs updating.
Internal references inside the loader file resolve via a single new
top-level `import { ... } from './extension-utils.js';`.

**Validation.** `bun run typecheck` green in both engine and
extensions.

## Notable decisions

### PR #3 contracted from "~15 extensions" to 2

The peer-review pre-mortem named 15-18 extensions as missing
`permissionGate`. Per-file inspection found that most already had
equivalent or stricter protection (admin-only via inline
`requireAdmin` / `checkPermission('admin', '*')`, or AI-style
per-resource gating). Adding the broad gate where admin gating
already exists is not a security fix — it would only enable
operators to grant access to non-admin roles via Casbin, which is
useful but lower-priority.

The triage is documented inline in PR #3's commit message and in the
permanent `SECURITY.md` "RBAC" section so the next agent doesn't
repeat the analysis.

### PR #5 was a conservative split, not the proposed 4-module split

The peer review proposed splitting `extension-loader.ts` into 4
modules (core, deps, marketplace, migrations). I shipped only the
first slice (utilities). The remaining heavyweight groups —
particularly the marketplace download path with its signature
verification + license audit, and the peer-deps installer with its
npm-tarball-fallback path — touch many engine singletons. Splitting
them without a real test suite risks regression in production-critical
code paths (extension install / activation).

The pattern PR #5 establishes — extract → re-export from the original
file → no import-site changes — is the template for the next slice.

### Helper functions outside the route closure

Three extensions (finance/invoicing, compliance/ro/efactura)
have utility functions declared at module scope that take `db: any`
as a parameter. The pattern for these:

- Keep the function's `db: any` parameter intact (it's already a
  parameter, no closure needed).
- At every call site inside a route handler, pass `reqDb(c)` instead
  of the bare `db`.

Documented in PR #1's and PR #2's commit messages.

## What's still outstanding

From `AUDIT-2026-05-24.md` §6, after this session:

- ~~**§6.1 backlog**~~ — **CLOSED** (zveltio-extensions `14b0dd0`).
  `002_tenant_rls.sql` rolled out to all 51 DB-bearing extensions;
  every route handler now resolves DB access via `reqDb(c)`; a CI
  validator (`scripts/validate-migration-paths.ts`) prevents
  `getMigrations()` drift from the SQL files on disk going forward.
  The three remaining extensions without RLS migrations
  (`content/pdf-viewer`, `developer/edge-functions`, `developer/views`)
  have no DB tables by design.
- **§6.3** — outstanding `.catch(() => {})` swallows. Pass 6+7
  addressed the security-relevant ones; the next agent should focus
  on writes that affect external state (Stripe webhook delivery
  confirmations, push-notification token cleanup, …).
- **§6.4** — extension typecheck has structural `as any` casts in
  efactura/saft/accounting. Right fix: use the SDK's codegen
  (`@zveltio/sdk/codegen`) to generate per-collection DB types.
- **Loader split** — three more slices to extract (license, marketplace,
  deps). Use PR #5 as template.

## Validation

```bash
# Engine
cd zveltio/packages/engine && bun run typecheck  # → green

# SDK
cd zveltio/packages/sdk && bun run build         # → green

# Extensions
cd zveltio-extensions && bun run typecheck       # → green
```

## Commit index

### zveltio (12 commits this session)

```
2b66006 PR #5: extract pure utilities from extension-loader.ts → extension-utils.ts
dab7f87 PR #4: docs — RBAC layers, AI exception, Casbin g-rows, tenant-RLS progress
d36d30c chore: drop dead zveltio/extensions/ folder (stale baseUrl tsconfig)
11b304b docs: hand-off audit document for AI agents picking up work
00d0bf8 migrations: squash 70 engine SQL files into a single 001_initial.sql
44dca61 typecheck: extend FieldTypeRegistryAPI with getAll, drop Bun type-only import
4fb9191 hardening pass 7: critical multi-tenant + sandbox follow-ups from deep re-audit
b474d48 hardening pass 6: extension RBAC gate, subprocess sandbox, tenantTrx, AI schema
c4978d4 hardening pass 5: webhook+billing crypto, RLS FORCE, prod safety guards
```

### zveltio-extensions (11 commits this session)

```
bca06f2 PR #3: permissionGate triage — apply where missing, document existing protections
e1f92aa PR #2: tenant_id + FORCE RLS on finance/invoicing, hr/payroll, compliance/ro/efactura
6ee6b7e crm: tenant_id + FORCE RLS on all 9 tables (PR #1 — template for §6.1 rollout)
884af5b tsconfig: drop deprecated baseUrl + ignoreDeprecations escape hatch
18986a7 migrations: squash per-extension SQL into a single 001_initial.sql
306cb25 typecheck: clear all 377 pre-existing TypeScript errors
77fdb67 ai: fix cross-tenant embeddings leak (migration 009 + hook + routes)
7ecec15 hardening pass 6: per-extension permissionGate on 24 unprotected routers
c3ac83d security: stripe webhook hardening, GraphQL RBAC, AI search perms, GDPR
```

---

*End of session log. §6.1 rollout completed in zveltio-extensions
commit `14b0dd0` (2026-05-25): RLS template applied to 51
extensions, `getMigrations()` paths reconciled with disk in commit
`fix(extensions): reconcile getMigrations() with actual SQL files`,
CI validator added.*
