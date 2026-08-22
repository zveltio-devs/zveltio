# SDUI schema reference

**Server-Driven UI (SDUI)** is how most extension admin pages ship: a JSON schema
describes the page, the engine inlines it at manifest load, and the Studio host
renders it with trusted generic components — no per-extension Svelte build, no
third-party JS in the admin.

This document is the **field-level reference**. For the authoring workflow (manifest
wiring, sync, CI), see [EXTENSION-DEVELOPER-GUIDE.md §10](./EXTENSION-DEVELOPER-GUIDE.md)
and [EXTENSION-COOKBOOK recipe 7](./EXTENSION-COOKBOOK.md). The TypeScript source of
truth is [`packages/studio/src/lib/sdui/types.ts`](../../packages/studio/src/lib/sdui/types.ts).

---

## Quick start

1. Create `studio/schemas/<page>.json` in your extension repo.
2. Point `manifest.studio.pages[].schema` at it (path relative to `studio/`).
3. Do **not** ship a `studio/pages/+page.svelte` for the same slug.
4. Ensure every schema declares `"sduiSchema": 1` and a non-empty `"title"`.

Minimal list page:

```json
{
  "sduiSchema": 1,
  "title": "widgets.title",
  "resources": [
    {
      "id": "widgets",
      "dataSource": "/ext/my-ext/widgets",
      "dataPath": "data",
      "columns": [
        { "key": "name", "label": "common.col.name" },
        { "key": "created_at", "label": "common.col.created", "type": "date" }
      ]
    }
  ]
}
```

---

## Versioning

| Field | Required | Meaning |
| --- | --- | --- |
| `sduiSchema` | **Yes** (CI) | Major schema version. Host supports **1** today. Higher majors render a friendly error instead of mis-rendering. |
| `sduiSchemaVersion` | Alias | Deprecated synonym for `sduiSchema`; host normalizes it at validate time. |

Host validation: `packages/studio/src/lib/sdui/validate.ts` (`validateSchema`). CI (`bun run check:sdui-schemas`) fails if any manifest-referenced schema omits `sduiSchema` or declares a version above the host maximum.

---

## Archetypes

### `PageSchema` (default)

List + form pages. Top-level keys:

| Key | Required | Description |
| --- | --- | --- |
| `title` | Yes | Page heading — i18n key or literal |
| `subtitle` | No | Muted subheading |
| `resources` | Yes | One resource → single table; many → tabs |
| `newLabel` | No | Header “+ New” button label (opens active resource form) |
| `pageActions` | No | Toolbar actions with no row context |

### `SettingsSchema`

Singleton config pages (`"kind": "settings"`):

| Key | Required | Description |
| --- | --- | --- |
| `kind` | Yes | Must be `"settings"` |
| `title` | Yes | Page heading |
| `dataSource` | Yes | GET endpoint returning one config object |
| `dataPath` | No | Dot-path to config inside response (default: root) |
| `saveEndpoint` | Yes | POST endpoint to persist |
| `info` | No | Read-only rows with copy button; `{ENGINE_URL}` token |
| `sections` / `fields` | No | Form layout (sections group fields) |
| `actions` | No | Extra buttons (e.g. “Test connection”) |

---

## Resource views

Each entry in `resources[]` describes one tab or the sole view.

### Data loading

| Key | Description |
| --- | --- |
| `id` | Stable resource id (used for tab state / `?tab=` URLs) |
| `label` | Tab label (omit when only one resource) |
| `icon` | Lucide icon name for the tab |
| `dataSource` | GET endpoint for the list (optional when using `layout: "builder"`) |
| `dataPath` | Dot-path to the array in the response (`"data"`, `"items"`, …) |
| `totalPath` | Dot-path to total count for pagination (`"meta.total"`) |
| `search` | See [Search](#search) |
| `pagination` | `{ "limit": 25 }` |
| `filters` | Enum tabs, date, or date range filters |
| `stats` | KPI tiles above the table — see [Stats](#stats) |

### Layouts

| `layout` | Use when |
| --- | --- |
| *(omit)* / `"table"` | Standard data table (default) |
| `"cards"` | Responsive card grid — set `card: { title, badge?, subtitle? }` |
| `"checklist"` | Selector + toggle catalog saved as id[] — set `checklist: { … }` |
| `"builder"` | Meta fields + ordered item collection — set `builder: { … }` |
| `"detail"` | Single record with panels — set `detail: { … }` |

**Master-detail:** set `master: { dataSource, titleKey, … }` on a resource; its
`dataSource` becomes the detail table with `{masterId}` tokens in URLs.

### Columns

`columns[]` entries:

| Key | Description |
| --- | --- |
| `key` | Dot-path into row object |
| `label` | Column header |
| `type` | `text` · `mono` · `date` · `currency` · `badge` · `relation` · `boolean` |
| `secondary` | Muted second line (dot-path) |
| `join` | `{ "keys": ["a", "b"], "sep": " → " }` |
| `template` | Computed text with `{field}` / `{ENGINE_URL}` tokens |
| `badge` | `{ "colors": { "active": "badge-success" }, "labels": { … } }` |
| `currency` | `{ "codeKey": "currency" }` or `{ "code": "RON" }` |
| `relation` | Resolve id → label from another endpoint |
| `classWhen` | Conditional CSS — `{ "field", "equals"?, "in"?, "class" }[]` |
| `editable` | Inline PATCH on change — `{ endpoint, field?, method?, options? }` |

### Row and page actions

`rowActions[]` / `pageActions[]` / `detailActions[]`:

| Key | Description |
| --- | --- |
| `id` | Stable action id |
| `label` / `icon` | Button label and Lucide icon |
| `variant` | DaisyUI modifier (e.g. `"text-error"`) |
| `kind` | `call` · `edit` · `download` · `navigate` · `open` · `preview` |
| `method` | `POST` · `PATCH` · `DELETE` |
| `endpoint` | URL template — `{id}` and `{field}` substituted from row |
| `href` | Studio path for `kind: "navigate"` |
| `visibleWhen` | `{ "field", "equals"?, "in"? }` |
| `confirm` | Confirm dialog message (i18n key or literal) |
| `body` | Request body map with `{field}` tokens; `{a-b}` subtracts |
| `prompt` | Dialog with extra fields merged into `body` before call |
| `preview` | Two-step: preview POST → confirm POST |

### Forms

`form` on a resource (create/edit modal):

| Key | Description |
| --- | --- |
| `endpoint` | POST create; PATCH `{id}` on edit |
| `submit` | `{ "kind": "download" }` or `{ "kind": "upload" }` for non-JSON submits |
| `fields` / `sections` | Field definitions |
| `repeatable` | Line-item group (escape hatch) |
| `computed` | Derived fields (e.g. sum of line weights) |
| `reveal` | Show secret once after create (API tokens) |
| `preview` | Simulate before create |

---

## Field definitions

Used in forms, builder meta, checklist, and action prompts.

| `type` | Renders as |
| --- | --- |
| `text` | Single-line input (default) |
| `email` / `tel` | Typed inputs |
| `number` / `date` | Typed inputs |
| `select` | Dropdown — requires `options[]` |
| `relation` | Foreign-key picker — requires `relation.dataSource` + `labelKey` |
| `boolean` | Toggle |
| `password` | Masked input |
| `textarea` | Multi-line — optional `rows` |
| `file` | File input — optional `accept` |
| `json` | JSON editor |

Common keys: `name`, `label`, `required`, `colSpan` (1|2), `default`, `placeholder`,
`mono`, `visibleWhen`, `relation.autofill`, `lookup` (POST side-field → map into siblings).

---

## Search

```json
"search": { "fields": ["name", "email"], "placeholder": "common.search" }
```

Server-side search — send a query param:

```json
"search": { "param": "q", "placeholder": "common.search" }
```

---

## Filters

```json
"filters": [
  {
    "param": "status",
    "type": "tabs",
    "options": [
      { "value": "", "label": "common.all" },
      { "value": "open", "label": "status.open" }
    ]
  }
]
```

Date range (list waits until both filled when `"required": true`):

```json
{
  "type": "dateRange",
  "fromParam": "from",
  "toParam": "to",
  "label": "reports.range"
}
```

---

## Stats

KPI row above a table:

```json
"stats": {
  "dataSource": "/ext/finance/invoicing/invoices/stats",
  "dataPath": "stats",
  "cards": [
    { "label": "invoicing.stat.outstanding", "key": "outstanding", "format": "currency", "color": "text-warning" },
    { "label": "invoicing.stat.overdue", "key": "overdue_count", "format": "number" }
  ]
}
```

---

## Template tokens

| Token | Substituted with |
| --- | --- |
| `{id}` | Row primary key |
| `{field}` | Any row key (dot paths supported where noted) |
| `{a-b}` | Arithmetic subtract in `body` values |
| `{masterId}` | Selected master row id |
| `{ENGINE_URL}` | Current engine origin (settings info rows, column templates) |

---

## i18n

Every string slot accepts either:

1. A **Paraglide message key** (resolved via `m[key]()`), or
2. A **literal** (shown as-is — fine for prototypes, warned in `validate`).

Multi-tab pages often use `?tab=<resource.id>` in the URL (e.g. CRM contacts/orgs/deals).

---

## Delivery and rendering

1. Extension manifest declares `"schema": "schemas/foo.json"`.
2. Engine `embedPageSchemas()` inlines JSON into `/api/extensions` at load.
3. Studio catch-all `(admin)/[...extPath]` loads the schema and renders via
   `SchemaPage` / `SettingsPage`.
4. Invalid or future-major schemas show an error panel — never a white screen.

---

## CI and validation

| Check | Command | What it catches |
| --- | --- | --- |
| Schema header | `bun run check:sdui-schemas` | Missing `sduiSchema`, missing `title`, version too high |
| API contract | `bun run scripts/check-sdui-contract.ts <extDir>` | `dataSource` / form endpoints that 404 or reject payloads |
| Studio version | `bun run check:studio-embed` | Stale or unstamped `studio-dist` vs package version |

Run locally before opening a PR:

```bash
bun run studio:build
bun run check:studio-embed
bun run check:sdui-schemas
bun run scripts/check-sdui-contract.ts ../zveltio-extensions
```

---

## When not to use SDUI

Use **Tier-3 Svelte pages** (`studio/pages/+page.svelte`) for editors, canvases,
maps, kanban, live chat, file browsers, and other UIs the vocabulary cannot express.
See [EXTENSION-AUTHORING.md](./EXTENSION-AUTHORING.md) for tier guidance.

For **dashboard slot widgets** (Model 2.5), ship `studio/src/contribute.ts` +
Svelte components — schemas alone cannot mount into host slots.

---

## Examples in the wild

Browse [`zveltio-extensions`](https://github.com/zveltio-devs/zveltio-extensions)
under `*/studio/schemas/` — CRM (`crm.json` multi-tab), invoicing, auth LDAP/SAML,
e-Transport, HACCP detail layouts, and dashboard checklist matrices are all
declarative.
