# How an extension contributes UI

> Decided 2026-11-12 (ADR 0042, amending ADR 0038). This page is the rule.
> Where today's code still differs, the **Today** column of the migration table
> says so. Read this before you write any screen for an extension.

## The model

Zveltio is built like Lego.

| Piece | What it is | Who owns it |
|---|---|---|
| Core | data, rules, actions, jobs | the engine |
| Wheels | an extension's collections, actions and **views** | the extension |
| Body | a front end over the whole build (Studio, your React app, a mobile app) | whoever builds that front end |
| Colour | theme tokens | the operator |
| Material | framework and design system | whoever builds that front end |

An extension describes **what** its screens show. Each front end decides
**how** they look, in its own framework and components. The same description
serves Studio, a React or Vue front end, a native app and an AI agent (MCP).

## The rules

1. **An extension ships UI as data only.** A view is JSON. No front-end source
   (Svelte, React, ...) and no framed document is part of the extension
   contract.
2. **A view is semantic.** It names collections, fields and actions. It never
   carries a URL, an HTTP verb, a CSS class or an icon library's name. Tone is
   semantic (`danger`, `success`, `muted`). A view names only its own
   extension's collections and actions, or a dependency's action; the engine's
   permission rules decide every call.
3. **A view does not restate the engine.** Forms derive from the collection or
   action schema; field types are the engine's field types. A view adds
   selection, order, grouping and the kind of view.
4. **No logic in a view.** Conditions are `{field, op, value}` with the data
   API's operators, plus a closed set of references (`$record`, `$selected`,
   `$selection`, `$param`, `$user`, `$today`). Anything computed is a server
   field or an action. An action's result is values, a view, a file, a reveal or
   a navigation, so wizards and computed screens are actions that return views.
5. **An extension is fully operable with no UI.** Everything a view does goes
   through declared collections and actions, so an agent, a native app or
   another front end reaches all of it.

## The vocabulary

Small and generic, bound to data:

| View | Shape |
|---|---|
| `list` | rows of a collection: table, cards or feed |
| `form` | create or edit a record or an action's input; line items; singleton |
| `detail` | one record, in panels |
| `board` | records grouped by a field (kanban) |
| `timeline` | records on a time axis (calendar, Gantt) |
| `tree` | records linked to a parent |
| `matrix` | rows × columns of a relation (checklists, grants) |
| `map` | records with a location |
| `stat` | a number or a short series |
| `split`, `tabs` | containers |

A new view kind enters only as a generic shape over collections and actions,
with at least one real consumer. A front end that does not know a view kind
falls back to its generic collection screen; a view may name its own fallback.

Untrusted content is a field renderer's duty: a `richtext` value is untrusted on
display, and every front end sanitises it and shows it without scripts (a
sandboxed `srcdoc` frame or equivalent).

## Writing a view (`view/2`)

The specification is the `@zveltio/sdk/view` package: TypeScript types, a
validator and a builder, all derived from one source,
`packages/sdk/src/view/schema.ts`. The JSON Schema is published as
`@zveltio/sdk/view/schema.json` (`$id`
`https://zveltio.com/schemas/view-2.schema.json`), for editors, other front
ends and anything that generates views.

A view file sets `"spec": "zveltio.view/2"` at its top and is named by a
manifest page, as a `view/1` schema is:

```json
{
  "spec": "zveltio.view/2",
  "type": "list",
  "title": "billing.invoices",
  "collection": "invoices",
  "fields": ["number", "customer_id", { "field": "status", "display": "badge", "tones": { "overdue": "danger" } }],
  "filter": [{ "field": "status", "op": "neq", "value": "draft" }],
  "sort": "-issued_on",
  "rowActions": [{ "action": "pay", "input": { "invoice_id": { "$record": "id" } }, "confirm": "billing.confirm.pay" }]
}
```

Or with the typed builder, which emits the same JSON:

```ts
import { $, view } from '@zveltio/sdk/view';

export default view.document(
  view.list({
    collection: 'invoices',
    fields: ['number', 'customer_id'],
    filter: [$.where('status', 'neq', 'draft')],
    rowActions: [{ action: 'pay', input: { invoice_id: $.record('id') } }],
  }),
);
```

What the specification holds:

- **Names, not addresses.** `collection`, `field` and `action` are names: a
  collection the extension declares, one of its actions, or
  `<dependency>.<action>`. Every object is closed, so a `dataSource`, an
  `endpoint`, a `class` or an `icon` is refused, not ignored.
- **Conditions** are `{ field, op, value }` with the data API's operators
  (`eq`, `neq`, `in`, `null`, ...). A value is a literal or one of the
  references `$record`, `$selected`, `$selection`, `$param`, `$user`,
  `$today`.
- **Buttons** run an action (`action`, `input`, `prompt`, `confirm`, `when`),
  open a view (`navigate`, `params`) or save a form (`save`).
- **Fields** are names; a field object adds only presentation hints
  (`label`, `display`, `tones`, `readOnly`). Type, label and editor come from
  the collection.
- **Every view kind** accepts `title`, `actions` (its toolbar), `id` (inside a
  container) and `fallback` (the view a front end draws when it does not know
  this kind).

Validation runs in three places, against the same schema:

| Where | When | What happens to an invalid view |
|---|---|---|
| `zveltio extension validate` | before publishing | an error (`VIEW_INVALID`; `VIEW_FOREIGN_NAME` for a collection or action the extension does not own) |
| `zveltio extension pack` | when the bundle is built | the pack stops |
| the engine | when it loads the extension | the page is not served; the log says why |

A schema without `spec` is a `view/1` schema and is treated as before.

## A screen that needs code

Some screens cannot be data: a free-form canvas (the page builder), a
third-party widget (a payment form), hardware (a fiscal printer). They are
**front-end packages**, installed at build time by whoever owns the front end.
They sit outside the extension contract: the engine and the extension know
nothing of them, and the extension must still be operable without them (rule 5).

## What is not part of the model

- **Extension code in the browser.** Not in the host page, not as Web
  Components, not as run-time modules.
- **HTML rendered by the engine.** The engine publishes a specification and
  serves data; presentation belongs to front ends.
- **A framed (iframe) document.** Withdrawn. It returns only if the project
  decides on a marketplace where untrusted publishers install UI code at run
  time; ADR 0042 records the preconditions.

## Developer experience

These are part of the contract, because a model nobody likes to write is not
adopted:

- default list, form and detail views generated from a collection, so you write
  only what differs;
- a typed TypeScript builder that emits the JSON;
- a live preview while you write;
- ready renderers for Svelte (Studio), React and Vue in the SDK packages.

## Migration: today vs target

| Topic | Today | Target (ADR 0042) |
|---|---|---|
| Schema format | `sduiSchema: 1` ([sdui.md](../ui/sdui.md)), types in Studio; `view/2` specified and validated (`@zveltio/sdk/view`), not yet drawn | `view/2` only, a shared specification package with JSON Schema, validated by the engine and the CLI |
| Data binding | URLs (`dataSource`, `endpoint`) | names of collections and actions |
| Styling | daisyUI class names, icon names | semantic tones |
| Computed values | arithmetic tokens, templates, `computed` | server fields or actions |
| Code pages (`studio/pages/+page.svelte`, "Tier-3") | 7 pages, synced into Studio at release | views; the page-builder canvas becomes a front-end package |
| Slot widgets (`studio/src/contribute.ts`) | Svelte components | data only |
| Renderers | Studio only | Studio, `sdk-react`, `sdk-vue` |

Until Studio draws `view/2` (ADR 0042 slice 2), a `view/2` page validates but
is not rendered; keep writing `sduiSchema: 1` schemas for screens that must show
today, and do not add
new code pages: a screen you cannot express is a request for a view kind or a
field type.
