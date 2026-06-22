# SDUI coverage spike — findings

**Question:** can extension Studio pages be expressed as declarative schema (rendered
by trusted generic host components) instead of compiled-per-extension Svelte —
eliminating the build toolchain, import-map, and third-party-JS-in-admin problems?

**Method:** encoded the three most representative real pages as `PageSchema` (see
`schemas.ts`) and built one ~320-line generic renderer (`SchemaPage.svelte`) reusing
the existing `ExtensionPageShell` / `ExtensionDataPanel` / `ConfirmModal` / `api`.
Live demo at `/admin/sdui-demo`. Vocabulary (`types.ts`) was derived from the pages,
not guessed.

## Per-page coverage

| Page | Original | Declarative coverage | Escapes |
|---|---|---|---|
| `crm/contacts` | 193 lines | **100%** | none |
| `crm` (3-tab dashboard) | 465 lines | **~95%** | per-row delete spinner; optimistic insert (renderer reloads — equivalent) |
| `compliance/ro/etransport` | 305 lines | **~98%** | submit-disable-until-required (trivially addable) |
| `finance/invoicing` | 335 lines | **~92%** | markPaid row-computed body (`total−paid`); per-row busy spinner |
| `finance/accounting` | ~260 lines | **~95%** (analyzed, not encoded) | debit/credit "balanced" validation indicator |
| `communications/mail` | ~600 lines | **Tier-3 (bespoke)** | full email client — but its account-setup / signatures / filters sub-forms ARE declarative |

The two features I feared as escapes — the **repeatable line-item group** and
**computed totals** — turned out to be small generic vocabulary, fully implemented.
Round 2 (invoicing/accounting/mail) confirmed the vocabulary holds: every gap found
was **small and additive**, except mail which is the expected Tier-3 escape.

## Round-2 vocabulary gaps (all small, additive)
Implemented in v2 of the prototype:
- **stat-cards** block (KPI tiles from a `/stats` endpoint) — `ResourceView.stats`
- **two-line cell** (primary + muted sub-text, e.g. client name/email) — `ColumnDef.secondary`

Documented, deferred (each a few lines when productionized):
- conditional cell styling (overdue → red) — `ColumnDef.classWhen`
- action with row-computed body (markPaid `total−paid`) — `ActionDef.body` + tiny expr
- computed *validation* (accounting debit==credit) — `computed[].validWhen`

## Round-3: the "atypical" shapes (charts / wizards / relations)
Probed the three shapes most likely to break a declarative model:
- **Charts** — grep across all extension Studio pages: **zero** real charts (every
  "chart" hit was a lucide *icon*). Not a current need.
- **Multi-step wizards** — **zero** `currentStep`/`wizard`/`stepper` in any page.
- **Foreign-key relation selects** — the one real pattern: **11 of 54 pages** load a
  list from another endpoint to populate a select (e.g. time-entry → project). Added
  `FieldDef.type:'relation'` (loads options lazily from `relation.dataSource`),
  implemented + demoed (`hr/time-tracking` schema). `hr/time-tracking` ≈ 80%; the only
  escape is its live running-timer widget (Tier-2/Tier-3).

So the two shapes most feared (charts, wizards) **don't exist** in the ecosystem, and
the one that does (relations) was a clean additive win. The vocabulary is now ~170
lines of types and covers six diverse pages + the dominant relation pattern.

## Round-4: archetypes & bulk actions (final stress)
- **Settings/config is a distinct 2nd archetype** — a singleton config form (NOT a
  list): GET one config object, sectioned form with **toggle/checkbox + password**
  fields, page-level **Save** + **Test connection** actions. Covers `auth/ldap`,
  `auth/saml`, `integrations/api-connector`, `mail` account setup. Modeled as
  `SettingsSchema` + a 40-line `SettingsPage.svelte`; rendered live. Coverage 100%.
- **Bulk multi-select actions** (row checkboxes + a bulk bar) appear in ~3 pages —
  mostly the Tier-3 heavies (mail, media, ecommerce). An additive `selectable` +
  `bulkActions` on the list archetype when needed; not required for the CRUD majority.

### Conclusion: the ecosystem reduces to **2 declarative archetypes + 1 escape**
1. **list+form** (`PageSchema` → `SchemaPage`) — the CRUD/dashboard majority (~40 ext)
2. **settings** (`SettingsSchema` → `SettingsPage`) — config pages (~6-8 ext)
3. **Tier-3 escape** — genuinely bespoke apps (~10-14 ext): email client, canvas
   builders, node graphs, chat, maps, code editors.

Six schemas now render live at `/admin/sdui-demo` from ~190 lines of types + two small
renderers. Four rounds of adversarial stress added only small, bounded vocabulary — no
wall, no surprise. **Verdict stands: GO, with high confidence.**

## Confirmed Tier-3 (bespoke, need code) — ~10-14 extensions
mail (email client), page-builder (canvas), flows (node graph), ai (chat), geospatial
(map), media (gallery), developer/graphql (playground), developer/edge-functions (code
editor), developer/views (calendar/kanban). Even several of these have declarative
sub-forms (mail settings/signatures/filters) that the Tier-2 slot system can host.

## Vocabulary that covered everything
`PageSchema` → `resources[]` (1 = single, >1 = tabs) → each has `dataSource`,
`search` (server or client), `pagination`, `filters` (enum bar), `columns`
(text/mono/date/currency/badge/join), `rowActions` (conditional `visibleWhen`,
`confirm`, `edit`-kind), and a `form` (fields, sections, `select`, **repeatable**
groups, **computed** sums). ~120 lines of types.

## Ecosystem estimate (54 extensions)
- **Declarative-fit (~40, ~75-80%):** crm, finance/*, hr/*, compliance/*, inventory,
  pos, billing, traceability/*, projects/*, operations/assets, content/documents,
  ecommerce/store, integrations/*, data/import-export, checklists, forms, sms,
  workflow/approvals, auth/ldap+saml, developer/api-docs+database+validation, i18n…
- **Bespoke → Tier-3 escape hatch (~10-14):** page-builder (canvas), flows (node
  graph), ai (chat), geospatial (map), media (gallery), developer/graphql (playground),
  developer/edge-functions (code editor), developer/views (calendar/kanban).

## Verdict: **GO**
The common case (CRUD/forms/dashboards) is ~98% declarative with a small, real
vocabulary, rendered natively by host components (theme + i18n + a11y for free), with
**zero host build toolchain** and a marketplace that ships **data, not code** (no
third-party JS in the admin — the decisive security property the v3 bundle model
lacked). The bespoke minority gets a contained Tier-3 escape hatch (prebuilt bundle
or, for untrusted third-party, an iframe).

## What a production build still needs (not blockers — known scope)
- i18n keys instead of literals (resolver already tries `m[key]()`).
- Field validation + required-submit gating; relation/foreign-key `select` (collection
  lookup); file/image fields; more column types (boolean, tags, link).
- Per-row busy state; optimistic updates; server-driven pagination meta variations.
- Schema delivery: extension ships `studio/pages/*.json`; engine serves it via
  `/api/extensions` (extend the existing `meta`); host route renders `SchemaPage`.
- A JSON-schema validator + versioned `sduiSchema` field for forward-compat.
