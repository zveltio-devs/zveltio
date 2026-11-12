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
  (`eq`, `neq`, `in`, `null`, ...); `in` and `not_in` take a list, `null` and
  `not_null` take no value. A value is a literal or one of the references
  `$record`, `$selected` (an earlier pane of the enclosing `split`),
  `$selection`, `$param`, `$user`, `$today`.
- **Buttons** run an action (`action`, `input`, `prompt`, `confirm`, `when`),
  open a view (`navigate`, `params`) or save a form (`save`).
- **Fields** are names; a field object adds only presentation hints
  (`label`, `display`, `tones`, `readOnly`). Type, label and editor come from
  the collection.
- **Every view kind** accepts `title`, `actions` (its toolbar), `id` and
  `fallback` (the view a front end draws when it does not know this kind).
  Only the top of a file carries `spec`; its `id` (`billing.invoices`) is what
  `navigate` and `open` name. Inside a container `id` names a pane, once.

Validation runs in three places, against the same schema:

| Where | When | What happens to an invalid view |
|---|---|---|
| `zveltio extension validate` | before publishing | an error: `VIEW_INVALID` for the schema; `VIEW_REFERENCE` for a collection or action the extension does not own, a `$selected` with no earlier pane, a pane id used twice, a `navigate`/`open` to no view of the extension, a message key missing from `studio/messages/en.json` |
| `zveltio extension pack` | when the bundle is built | the same checks, and a page file that is missing or is not JSON; the pack stops |
| the engine | when it loads the extension | the schema only; the page is not served and the log says why. The references are the CLI's, and the engine's permission rules decide every call at run time |

A schema without `spec` is a `view/1` schema and is treated as before.

## How a front end draws a view

What every renderer does the same way is plain TypeScript in
`@zveltio/sdk/view` (`runtime.ts`), so a React or Vue front end draws a view
and only draws it:

| Function | Does |
|---|---|
| `resolveValue`, `resolveInput` | fill `$record`, `$selected`, `$selection`, `$param`, `$user`, `$today`; unresolved while a pane has no selection |
| `toFilter`, `toSort` | a view's conditions and sort as the data API's JSON `filter`, `sort` and `order` |
| `matches` | whether a row meets a `when` or `emphasisWhen` |
| `defaultFields`, `defaultView`, `viewFields` | the generated default list, form and detail of a collection: no system or computed field, a list at most eight columns, a form without read-only ones |
| `fallbackFor` | what to draw for a kind the front end does not draw: the view's `fallback`, else the generated list of its collection |
| `actionPath` | `POST /ext/<extension>/actions/<name>`, or the dependency's for `<dependency>.<action>` |
| `readActionResult` | an action's result: `{ view: "<id>", params }` opens that view, `{ view: { type, ... } }` draws the returned view, `{ file: "<id>" }` hands over a stored file, `{ reveal: "<text>" }` shows a value once, anything else is values |

Every call is the signed-in user's: field lists come from `GET /api/data` (the
fields the caller may read), rows and records from the data API, actions from
`POST /ext/<extension>/actions/<name>`, and a button whose action
`GET /api/actions` does not list for the caller is not drawn. The engine's rules
decide each call; the renderer only asks.

### In Studio

A page whose schema has `"spec": "zveltio.view/2"` is drawn by
`packages/studio/src/lib/view/` (ADR 0042 slice 2); any other schema is `view/1`
and drawn as before.

| Kind | Studio draws |
|---|---|
| `list` | table, `cards` or `feed`; search, paging, selection and bulk actions, row actions, `emphasisWhen`, `create` (the generated form in a dialog), `open` |
| `form` | the collection's fields (or the action's input) through `SchemaForm`; `record` (a reference or `singleton`), `sections`, `submit`, read-only fields shown as text |
| `detail` | the record's fields, then its `panels` with `$record` set to it |
| `stat` | `count` (the data API's total for the filter) or an action's number |
| `split`, `tabs` | their views; a pane with an `id` sets `$selected` when a row is clicked |
| `board`, `timeline`, `map`, `tree`, `matrix` | not yet (ADR 0042 slice 4): the view's `fallback`, else the generated list, under a notice |

Not drawn yet, each with a notice where it appears: a form's `lines`, `recalc`
and `autosave`, a list's `realtime`, a `stat` that sums, averages or takes a
minimum or maximum (the data API has no aggregate route; make it a server field
or an action). A `richtext` value is shown as text, never as HTML.

A row's `open` and a `navigate` go to the extension's page whose view file has
that `id`; the page path's `:name` segments are filled from the parameters and
the rest go in the query, and `$param` reads both. `open` passes the row as
`id`.

**Live preview.** *Developer → View preview* (`/admin/developer/views`) takes a
`view/2` document, shows the specification's issues as you type, and draws it
with the same renderer, on your own data and permissions. Name the extension to
run its actions.

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
| Schema format | `sduiSchema: 1` ([sdui.md](../ui/sdui.md)), types in Studio; `view/2` specified and validated (`@zveltio/sdk/view`) and drawn by Studio; `board`, `timeline`, `map`, `tree`, `matrix` fall back to a list | `view/2` only, a shared specification package with JSON Schema, validated by the engine and the CLI |
| Data binding | URLs (`dataSource`, `endpoint`) | names of collections and actions |
| Styling | daisyUI class names, icon names | semantic tones |
| Computed values | arithmetic tokens, templates, `computed` | server fields or actions |
| Code pages (`studio/pages/+page.svelte`, "Tier-3") | 7 pages, synced into Studio at release | views; the page-builder canvas becomes a front-end package |
| Slot widgets (`studio/src/contribute.ts`) | Svelte components | data only |
| Renderers | Studio only (the shared runtime is in `@zveltio/sdk/view`) | Studio, `sdk-react`, `sdk-vue` |

Studio draws `view/2` pages (below) and keeps drawing `sduiSchema: 1` schemas
until the codemod (ADR 0042 slice 3). Do not add new code pages: a screen you
cannot express is a request for a view kind or a field type.
