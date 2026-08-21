# Agent handoff — verify SDUI Studio migrations

**Authoring agent finished:** 2026-08-21  
**Your job:** independently verify correctness of local (unpushed) SDUI migrations. Do **not** push. Report pass/fail per extension with evidence.

## Repos (siblings)

| Repo | Path |
|------|------|
| Engine / Studio monorepo | `/home/liviu/zveltio` |
| Extensions | `/home/liviu/zveltio-extensions` |

Canonical checklist already written:  
`/home/liviu/zveltio/docs/private/SDUI-MIGRATION-VERIFICATION.md`  
(on branch `feat/sdui-crud-batch` in zveltio; read it first.)

## What was done (intent)

Migrate extension Studio pages from **baked Svelte** (`studio/pages/+page.svelte` synced into Studio `(admin)/…`) to **declarative SDUI** (`studio/schemas/*.json` + manifest `schema:` pointer). Host renderer:  
`packages/studio/src/routes/(admin)/[...extPath]/+page.svelte`  
requires `pg.render === 'schema'` (engine sets this when inlining the JSON at load — see `packages/engine/src/lib/extensions/manifest-schema.ts`).

## Branches to verify (both repos, same names, NOT pushed)

| Branch | Scope |
|--------|--------|
| `feat/sdui-validation` | `developer/validation` |
| `feat/sdui-api-docs` | `developer/api-docs` |
| `feat/sdui-crud-batch` | procurement, quality, banking, pos, approvals, checklists + verification md |

```bash
# inspect
cd /home/liviu/zveltio-extensions && git log master..feat/sdui-crud-batch --oneline && git diff master...feat/sdui-crud-batch --stat
cd /home/liviu/zveltio && git log master..feat/sdui-crud-batch --oneline && git diff master...feat/sdui-crud-batch --stat
```

## Per-branch expected deltas

### A — `feat/sdui-validation`

**extensions:** schema `developer/validation/studio/schemas/validation.json`; deleted pages svelte; **engine** adds flat `/rules` CRUD in `engine/routes.ts`; pack updated `engine/index.js` + integrity.

**zveltio:** deleted `(admin)/developer/validation/+page.svelte`; `.synced.json` updated.

**Smoke:** `/admin/developer/validation` — list/create/delete rules; active toggle.  
**Known tradeoff:** AI `POST /generate` not in UI.

### B — `feat/sdui-api-docs`

**extensions:** `studio/schemas/api-docs.json` (changelogs / custom / tokens); deleted svelte; admin GET changelogs+custom-docs return drafts; pack.

**zveltio:** deleted `(admin)/developer/api-docs/+page.svelte`.

**Smoke:** create changelog, publish; custom doc; mint token (reveal `plaintext_token`).  
**Tradeoff:** no OpenAPI link / visibility settings in schema UI.

### C — `feat/sdui-crud-batch`

| Ext | Schema | Admin URL | Engine change? |
|-----|--------|-----------|----------------|
| `compliance/ro/procurement` | `schemas/procurement.json` | `/admin/compliance/ro/procurement` | no |
| `analytics/quality` | `schemas/quality.json` | `/admin/analytics/quality` | no |
| `finance/banking` | `schemas/banking.json` | `/admin/finance/banking` | no |
| `operations/pos` | `schemas/pos.json` | `/admin/pos` | no |
| `workflow/approvals` | `schemas/approvals.json` | `/admin/workflow/approvals` | no |
| `workflow/checklists` | `schemas/checklists.json` | `/admin/checklists` | yes: `GET /templates?all=1` embeds `items` |

**zveltio:** deleted baked routes for those six + `docs/private/SDUI-MIGRATION-VERIFICATION.md`.

**Tradeoffs to confirm are intentional, not bugs:**
- procurement: order line items as JSON textarea (not visual repeatable editor)
- quality: no client-side scan poll
- banking: no reconciliation tab
- pos: no dual Z-report panel layout
- approvals: no step-timeline modal; no server `total` for pagination
- checklists: soft-delete via existing DELETE

## Verification protocol (do this)

1. **Static consistency (each branch, each converted ext)**  
   - Manifest has `"schema": "schemas/….json"`.  
   - Schema file exists; `sduiSchema` + `resources[]` (or settings).  
   - `studio/pages/+page.svelte` gone (unless multi-page ext — none of these should keep root page).  
   - Studio baked `(admin)/<slug>/+page.svelte` gone on matching zveltio branch.  
   - Every `dataSource` / form `endpoint` / rowAction `endpoint` in the schema exists in that extension’s `engine/routes*.ts` (or intentional new route).  
   - Response `dataPath` matches real JSON keys (`data`, `orders`, `templates`, `requests`, etc.).

2. **Integrity**  
   - For packed exts: `manifest.integrity.sourceSha256` matches current sources (or re-run pack and confirm no unexpected drift).  
   - CLI: `bun /home/liviu/zveltio/packages/cli/dist/index.js extension pack --dir . --first-party` only if you need to re-check hashes.

3. **Runtime smoke (if env available)**  
   - Checkout matching branches in both repos.  
   - Enable each extension.  
   - Open admin URL → page must render via SDUI host (not 404).  
   - Exercise New + one row action per resource.

4. **Do not treat as failures**  
   - Deferred extensions (mail, media, AI, forms, traceability, kanban, storage, billing, sms, documents, time-tracking, helpdesk, search, i18n, database, byod) — listed in verification md; out of scope.  
   - i18n keys that fall back to literals.  
   - Missing features explicitly listed as tradeoffs above.

## Report format (return to user)

```
## Verdict
- feat/sdui-validation: PASS|FAIL|PARTIAL — …
- feat/sdui-api-docs: …
- feat/sdui-crud-batch: … (per extension)

## Issues found
- [severity] ext — file:line — problem — suggested fix

## Evidence
- commands run + key findings
```

## Host / SDUI references

- Catch-all: `packages/studio/src/routes/(admin)/[...extPath]/+page.svelte`
- Types: `packages/studio/src/lib/sdui/types.ts`
- Renderer: `packages/studio/src/lib/sdui/SchemaPage.svelte`
- Sync: `packages/studio/scripts/sync-extensions.ts`
- Spike context: `packages/studio/src/lib/sdui/SPIKE-FINDINGS.md`
