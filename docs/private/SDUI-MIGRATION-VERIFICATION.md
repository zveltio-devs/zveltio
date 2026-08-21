# SDUI migration — verification checklist

**Date:** 2026-08-21  
**Purpose:** Exact record of what was converted so you can review branch-by-branch.

Pattern for every converted extension:
1. Add `studio/schemas/*.json`
2. Point `manifest.studio.pages[0].schema`
3. Delete `studio/pages/+page.svelte` (and empty `pages/`)
4. `extension pack --first-party` (updates `engine/index.js` + integrity)
5. Studio `sync-extensions.ts` removes baked `(admin)/…/+page.svelte`
6. Catch-all `[...extPath]` serves the page when the extension is active

---

## Branches (not pushed)

### A. `feat/sdui-validation` (extensions + zveltio)

| Path | Change |
|------|--------|
| `developer/validation/studio/schemas/validation.json` | **added** |
| `developer/validation/studio/pages/+page.svelte` | **deleted** |
| `developer/validation/engine/routes.ts` | flat `GET/POST/PATCH/DELETE /rules` |
| `developer/validation/CONTEXT.md` | notes |
| Studio `(admin)/developer/validation/+page.svelte` | **deleted** (sync) |

**Verify:** enable extension → `/admin/developer/validation` → create rule → toggle active → delete.  
**Tradeoff:** no AI NL→rule in the form (`POST /generate` still exists).

---

### B. `feat/sdui-api-docs` (extensions + zveltio)

| Path | Change |
|------|--------|
| `developer/api-docs/studio/schemas/api-docs.json` | **added** (3 tabs) |
| `developer/api-docs/studio/pages/+page.svelte` | **deleted** |
| `developer/api-docs/engine/routes.ts` | admin GET changelogs/custom-docs returns drafts |
| `developer/api-docs/CONTEXT.md` | notes |
| Studio `(admin)/developer/api-docs/+page.svelte` | **deleted** |

**Verify:** `/admin/developer/api-docs` → changelog create/publish → custom doc → mint token (reveal once).  
**Tradeoff:** OpenAPI link / visibility toggle not in schema UI.

---

### C. `feat/sdui-crud-batch` (extensions + zveltio) — this batch

Six extensions in one reviewable branch (separate commits recommended if you prefer splitting later).

| Extension | Admin URL | Schema file | Engine delta |
|-----------|-----------|-------------|--------------|
| `compliance/ro/procurement` | `/admin/compliance/ro/procurement` | `schemas/procurement.json` | none (schema only) |
| `analytics/quality` | `/admin/analytics/quality` | `schemas/quality.json` | none |
| `finance/banking` | `/admin/finance/banking` | `schemas/banking.json` | none |
| `operations/pos` | `/admin/pos` | `schemas/pos.json` | none |
| `workflow/approvals` | `/admin/workflow/approvals` | `schemas/approvals.json` | none |
| `workflow/checklists` | `/admin/checklists` | `schemas/checklists.json` | `GET /templates?all=1` embeds `items` |

Studio baked pages removed by sync:
- `(admin)/compliance/ro/procurement/`
- `(admin)/analytics/quality/`
- `(admin)/finance/banking/`
- `(admin)/pos/`
- `(admin)/workflow/approvals/`
- `(admin)/checklists/`

#### Per-extension verify + intentional tradeoffs

**procurement**  
- Tabs: orders / suppliers / budget  
- Orders: approve/receive/delete; create with JSON line-items (not visual line editor)  
- Budget: list + create (no % progress bar)

**quality**  
- Master = scans; detail = issues; New = run scan  
- No 2.5s client poll — refresh/reselect scan after async job finishes

**banking**  
- Accounts CRUD; transactions = master-detail per account  
- **Dropped:** reconciliation matching UI (invoice suggest) — discuss later

**pos**  
- Master = sessions; detail = orders; New = open session; Close = prompt for closing float  
- **Dropped:** dual-panel Z-report layout (closed sessions still listed as masters)

**approvals**  
- Filters: status + my_pending; approve/reject with comment prompt; cancel  
- **Dropped:** step timeline modal / pagination total (API has no `total` yet)

**checklists**  
- Templates with repeatable items; summary tab  
- Soft-delete via existing DELETE route

---

## Quick git commands

```bash
# extensions
cd ~/zveltio-extensions
git log master..feat/sdui-validation --oneline
git log master..feat/sdui-api-docs --oneline
git log master..feat/sdui-crud-batch --oneline
git diff master...feat/sdui-crud-batch --stat

# studio / engine monorepo
cd ~/zveltio
git log master..feat/sdui-validation --oneline
git log master..feat/sdui-api-docs --oneline
git log master..feat/sdui-crud-batch --oneline
```

---

## Still deferred (discuss at end — not in these branches)

| Extension | Why deferred |
|-----------|----------------|
| Tier-3: mail, media, AI, pages, graphql, edge-functions, postgis, dashboard | bespoke UIs |
| `forms` | builder at `/forms/:id` |
| `operations/traceability` | 7 sub-pages |
| `projects/management` | kanban |
| `storage/cloud` | file browser + upload |
| `billing` | plan cards + usage bars |
| `sms` | custom send composer |
| `content/documents` | generate/sign flows |
| `hr/time-tracking` | live timer |
| `projects/helpdesk` | message thread |
| `search` | live search console |
| `i18n/translations` | key×locale matrix |
| `developer/database` | dynamic schema browser |
| `developer/byod` | preview console |

---

## Suggested merge order

1. `feat/sdui-validation`  
2. `feat/sdui-api-docs`  
3. `feat/sdui-crud-batch`  

(Independent; any order works if master is current.)
