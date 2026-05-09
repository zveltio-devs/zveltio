# Extensions audit — alpha.67

> Generated 2026-05-08. Covers all 53 extensions in `zveltio-extensions/`.

## How extensions communicate today

Four mechanisms exist; in practice only the first two are used by more than one extension:

### 1. SQL cross-references (hardest coupling)

The most common form of inter-extension cuplaj: an extension's SQL queries read or join tables owned by another extension. PostgreSQL doesn't enforce this — there are no FK constraints between extension-owned tables — but the extension *will* fail at runtime if the provider isn't installed.

**Real SQL dependencies discovered**:

| Consumer | Provider | Tables read |
|---|---|---|
| `finance/banking` | `finance/invoicing` | `zvd_invoices` |
| `finance/quotes` | `finance/invoicing` | `zvd_invoices`, `zvd_invoice_lines` |
| `hr/leave` | `hr/employees` | `zvd_employees`, `zvd_departments` |
| `hr/payroll` | `hr/employees` | `zvd_employees` |
| `hr/time-tracking` | `hr/employees` + `finance/invoicing` | `zvd_employees`, `zvd_invoices`, `zvd_invoice_lines` |
| `operations/assets` | `finance/accounting` | `zvd_journal_entries`, `zvd_journal_lines` |
| `operations/traceability` | `finance/invoicing` | `zvd_invoice_lines` (via event subscription) |

All seven have been declared in their `manifest.json` `dependencies` field. The topological loader guarantees providers load first.

### 2. Inter-extension service registry — `ctx.services`

Extensions publish services for others to consume. Drupal-style services container.

**Active publishers**:
- `ai` → `ai.providers`, `ai.embed`, `ai.chat`, `ai.triggerEmbedding`, `ai.runBackgroundTask`

**Active consumers**:
- `communications/mail` — uses `ai.providers` for compose/summarise (manifest dep declared)
- `developer/validation` — uses `ai.providers` for natural-language rule generation (manifest dep declared)
- `storage/cloud` — uses `ai.providers` for document indexing (no manifest dep yet — soft optional)
- engine `flow-executor.ts` — `ai.providers` for `ai_decision` step
- engine `flow-scheduler.ts` — `ai.runBackgroundTask` for `ai_task` triggers
- engine `data-quality.ts`, `cloud/document-indexer.ts` — `ai.providers` for analysis

The pattern is solid but only the AI extension currently publishes anything. **Other extensions should publish their primitives** (e.g. `crm.contacts.lookup`, `invoicing.create`, `employees.findByEmail`) for the ecosystem to compose properly.

### 3. Engine event bus — `ctx.events.on`

Soft observation pattern. An extension subscribes to record lifecycle events (`record.created` / `record.updated` / `record.deleted`) and reacts. Events are emitted by the core data layer in [packages/engine/src/routes/data.ts](../packages/engine/src/routes/data.ts:501).

**Active listeners**:
- `ai` — auto-embedding for collections with `ai_search_enabled = true`
- `operations/traceability` — listens for `zvd_invoices` creation, generates dispatches when invoice line has `lot_id` metadata

This is a *soft* dependency: traceability still loads if invoicing isn't active; it just receives no relevant events. Manifest dependency declared anyway because the feature is meaningless without invoicing.

### 4. `extensionRegistry` cross-extension hooks (legacy)

Pre-services pattern. Extensions register named callbacks that the engine calls at scheduled times.

**Active**:
- `storage/cloud` registers a trash-purge handler → flow-scheduler calls it daily at 03:30

This pattern is older than `ctx.services` and arguably should be migrated. For now both coexist.

---

## Siloed extensions (anti-pattern)

The following extensions have their **own private universe of tables** that duplicate concepts already managed by other extensions. This is the biggest architectural debt in the ecosystem:

### Customer / Contact silos

The CRM extension owns `zvd_contacts`, but several extensions ignore it and define their own customer table:

| Extension | Has own customer table | Should use |
|---|---|---|
| `operations/pos` | `zvd_pos_customers` | `zvd_contacts` |
| `ecommerce/store` | (orders link to email/text, no contacts table) | `zvd_contacts` |
| `finance/subscriptions` | `zvd_subscribers` | `zvd_contacts` |
| `finance/invoicing` | `zvd_invoices.client_id TEXT` (no FK) | FK → `zvd_contacts.id` |

### Invoice / Order silos

| Extension | Has own | Should use |
|---|---|---|
| `compliance/ro/efactura` | `zv_efactura_invoices` (full duplicate of invoice data) | Read from `zvd_invoices`, store only ANAF metadata |
| `compliance/ro/saft` | `zvd_saft_*` | Aggregate from `finance/accounting` + `finance/invoicing` |
| `operations/pos` | `zvd_pos_orders` | Could feed into `zvd_invoices` |

### Product silos

| Extension | Has own | Should use |
|---|---|---|
| `ecommerce/store` | `zvd_ec_products`, `zvd_ec_product_variants` | `zvd_products` (from `operations/inventory`) |
| `operations/inventory` | `zvd_products` | (this should be the canonical source) |

### Why this matters

A user installing CRM + Invoicing + e-commerce + POS + Accounting + e-Factura today gets:
- **5 different "customer" identities** for the same person
- **3 different "product" catalogues** that don't sync
- **Invoices that can't be auto-published to ANAF** because efactura doesn't read `zvd_invoices`
- **No unified accounting view** — SAF-T extension would have to be told manually about each transaction

This breaks the core promise of "one Business OS for everything your organization runs". A future structural sprint should:
1. Pick canonical owners (CRM = contacts, Invoicing = invoices, Inventory = products).
2. Define `ctx.services` contracts published by canonical owners (`crm.contacts.lookup`, `inventory.products.list`, etc.).
3. Refactor siloed extensions to consume those services and drop their private tables (or migrate data into canonical tables on first install).

This is **not** done in alpha.67. It's documented here so the work is visible.

---

## Studio configuration UI status

For an extension to be usable, the user must be able to configure it from the Studio admin. Studio loads each extension's IIFE bundle from `<ext>/studio/dist/bundle.js` if present.

| Status | Count | Extensions |
|---|---|---|
| **Complete** (vite + src + index.ts + manifest.studio.pages) | 13 | `ai`, `compliance/ro/documents`, `compliance/ro/efactura`, `compliance/ro/etransport`, `compliance/ro/procurement`, `compliance/ro/saft`, `content/page-builder`, `content/pdf-viewer`, `developer/edge-functions`, `geospatial/postgis`, `workflow/approvals`, `workflow/checklists`, `data/import` (TODO verify) |
| **Almost complete** (just got vite added) | 9 | `auth/ldap`, `auth/saml`, `billing`, `communications/mail`, `crm`, `forms`, `operations/traceability`, `search`, `sms` |
| **Partial** (dir exists, no entry) | 2 | `developer/views`, `storage/cloud` |
| **Missing entirely** (no `studio/` directory) | 29 | `analytics/quality`, `compliance/gdpr`, `content/document-templates`, `content/documents`, `content/drafts`, `content/media`, `data/export`, `developer/api-docs`, `developer/byod`, `developer/database`, `developer/graphql`, `developer/validation`, `ecommerce/store`, `finance/accounting`, `finance/banking`, `finance/expenses`, `finance/invoicing`, `finance/quotes`, `finance/subscriptions`, `hr/employees`, `hr/leave`, `hr/payroll`, `hr/time-tracking`, `i18n/translations`, `integrations/api-connector`, `operations/assets`, `operations/inventory`, `operations/pos`, `projects/helpdesk`, `projects/management` |

**Action taken in alpha.67**: added `vite.config.ts` + `studio/package.json` for the 9 "almost complete" extensions. They can now be built with `bun run build` inside their `studio/` directory.

**Action NOT taken**: the 29 "missing entirely" extensions still declare `studio.pages` in their manifest but have no Studio code. When activated, Studio's sidebar will show the nav item, but clicking it routes to the catch-all `/extensions/[...path]/+page.svelte` which renders a placeholder. **This is misleading UX** — the user sees a navigation entry that doesn't go anywhere useful.

**Recommended fix** (separate sprint):
- Either ship Studio bundles for all 29 (large effort: write Svelte pages for each).
- Or set `contributes.studio: false` in the manifests of those that don't have a UI yet, so they don't appear in nav. The engine API surface stays available.

The CRM, Invoicing, HR, Operations extensions absolutely need Studio UI to be usable as a Business OS. Without it, users can't configure or use them — only call their APIs directly.

---

## Manifest dependencies — current state

Ten extensions now declare `dependencies` in their manifest:

```
ai                                — (publishes services; no deps)
communications/mail               → ai
developer/validation              → ai
finance/banking                   → finance/invoicing
finance/quotes                    → finance/invoicing
hr/leave                          → hr/employees
hr/payroll                        → hr/employees
hr/time-tracking                  → hr/employees + finance/invoicing
operations/assets                 → finance/accounting
operations/traceability           → finance/invoicing
```

Topological load ordering (computed automatically by the loader) ensures every provider loads before its consumer, so `ctx.services.get()` and SQL joins succeed.

---

## What a complete extension should ship

For future authors and ongoing cleanup:

```
my-extension/
├── manifest.json              ← name, displayName, contributes, dependencies
├── package.json
├── engine/
│   ├── index.ts               ← default export ZveltioExtension
│   ├── routes/                ← or routes.ts for small extensions
│   │   └── index.ts
│   ├── lib/                   ← helpers (no imports from engine internals)
│   └── migrations/
│       └── 001_init.sql
└── studio/
    ├── package.json           ← scripts: build / dev
    ├── vite.config.ts         ← IIFE bundle config
    └── src/
        ├── index.ts           ← window.__zveltio.registerRoute(...)
        └── pages/
            └── *.svelte
```

The minimum bar: **engine loads + migrations run + Studio bundle builds + at least one configuration page exists in Studio**. Currently 13/53 extensions clear this bar; another 9 are one `bun run build` away.

---

## Summary

| Metric | Value |
|---|---|
| Total extensions | 53 |
| With manifest dependencies declared | 10 |
| Truly siloed (own copies of canonical data) | 8 |
| Studio UI complete | 13 |
| Studio UI missing entirely | 29 |
| Using `ctx.services` for cross-extension calls | 4 |
| Using `ctx.events` for cross-extension reactions | 2 |

**Health score**: the *plumbing* (service registry, topological loader, event bus, manifest deps) is solid. The *content* (which extensions actually publish/consume services and share data) is sparse. The dominant pattern today is "every extension is its own island" — opposite of what a Business OS should be.

The biggest single thing that would change this: **define and publish `ctx.services` contracts from the canonical owners** (CRM, Invoicing, Inventory, Employees), and refactor the siloed extensions to consume them rather than maintain their own copies.
