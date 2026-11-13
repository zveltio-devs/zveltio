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
sandboxed `srcdoc` frame or equivalent). Remote images stay blocked: whether a
reader may load them is not decided (ADR 0042 decision 10). A `file` field holds
stored files by id (`{ id, name, size, type }`, a list of them with
`options.multiple`), never an address: a front end uploads through the file API
and opens a file through a signed URL, both as the user.

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
  `$selection`, `$param`, `$user`, `$today`. One list gives a field and an
  operator once: the data API takes one value per pair (`{"total":{"gt":1,"lt":9}}`
  is two operators on one field and fine; `gt` twice is refused).
- **Buttons** run an action (`action`, `input`, `prompt`, `confirm`, `when`),
  open a view (`navigate`, `params`) or save a form (`save`). A `prompt` asks
  only for inputs that `input` leaves open; naming a bound one is refused. A
  `when` holds of a record, so a toolbar button with one is not drawn (a
  detail's toolbar holds of the record it shows). An action button may add:
  - `busyWhen`: conditions on the same record that hold while the work the
    action started is under way (a job's status: `queued`, `sending`). The
    button is busy, and the front end reads the record again until they no
    longer hold;
  - `files`: the stored files the request hands the action's job (`$files`,
    ADR 0032). `read` is a value of file ids or a `file` field's value (its
    files' ids are handed; an empty one hands nothing), `write` names the one
    file the job may store (`name`, `maxBytes`). The engine checks each file as
    the caller.
- **A detail's `onOpen`** runs an action once for each record the detail
  shows that meets its `when` (marking a message read). Its result is not
  shown; a failure is reported.
- **A form's `submit`** on a collection: an action button saves the record
  first and runs on it as saved (`$record`), so a draft is sent as written.
- **A list's own rows**: `create`, `edit` and `delete` offer the collection's
  generated form to add a record, the same form to change a row, and a delete
  after a confirm, all through the data API as the user.
- **A move or a cell edit** (`move` of a `board`, `timeline` or `tree`; `edit`
  of a `matrix`) is a `Change`: `patch` writes the changed fields through the
  data API as the user (a `matrix` cell with no record creates one), or the
  named action runs with its `input` resolved against `$record` as the record
  *after* the change, so `{ "id": { "$record": "id" }, "to": { "$record": "status" } }`
  is the record and its new column. Without `move` or `edit` nothing moves.
- **Fields** are names; a field object adds only presentation hints
  (`label`, `display`, `tones`, `readOnly`, `fallback`: the field shown while
  this one is empty, e.g. a message's `body_text` for its `body_html`). Type,
  label and editor come from the collection.
- **Every view kind** accepts `title`, `actions` (its toolbar), `id` and
  `fallback` (the view a front end draws when it does not know this kind).
  Only the top of a file carries `spec`; its `id` (`billing.invoices`) is what
  `navigate` and `open` name. Inside a container `id` names a pane, once.
- **An action's result** is an `ActionResult` (`$defs/ActionResult` of the JSON
  Schema), one of:

  | Result | A front end |
  |---|---|
  | `{ "view": "<view id>", "params": { ... } }` | opens that view (`params` optional, literal values, read by `$param`) |
  | `{ "view": { "type": ..., ... } }` | draws the returned view (wizards, computed screens) |
  | `{ "file": "<file id>" }` | hands the caller the stored file |
  | `{ "reveal": "<text>" }` | shows the value once (a key, a secret) |
  | anything else: a scalar, a list, an object without `view`, `file` or `reveal` | values; a form's `recalc` merges an object of them |

  The four forms are closed: `{ "view": "x.y", "extra": 1 }` is not values but
  an invalid result, and a front end reports it instead of guessing.
  `readActionResult` in `@zveltio/sdk/view` checks a result and says which it is.

Validation runs in three places, against the same schema:

| Where | When | What happens to an invalid view |
|---|---|---|
| `zveltio extension validate` | before publishing | an error: `VIEW_INVALID` for the schema, a field and operator twice in one condition list, or a `prompt` naming a bound input; `VIEW_REFERENCE` for a collection or action the extension does not own, a `$selected` with no earlier pane, a pane id used twice, a `navigate`/`open` to no view of the extension, a message key missing from `studio/messages/en.json`, a field (`fields`, `card`, `groupBy`, `location`, `filter`, `sort`, …) its collection file does not declare |
| `zveltio extension pack` | when the bundle is built | the same checks, and a page file that is missing or is not JSON; the pack stops |
| the engine | when it loads the extension | the schema only; the page is not served and the log says why. The references and the cross-key checks above are the CLI's, and the engine's permission rules decide every call at run time |

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
| `readActionResult` | an action's result checked against `ActionResult` (above): `navigate`, `view`, `file`, `reveal`, `values`, or `invalid` |

Every call is the signed-in user's: field lists come from `GET /api/data` (the
fields the caller may read), rows and records from the data API, actions from
`POST /ext/<extension>/actions/<name>`, and a button whose action
`GET /api/actions` does not list for the caller is not drawn. The engine's rules
decide each call; the renderer only asks.

### In React (`@zveltio/react`)

`extensionPages(client)` lists the active extensions' `view/2` pages
(`GET /api/extensions`), each checked against the specification.
`loadView(client, extension, view, scope)` reads what a view shows, and
`ViewRenderer` draws what was read without reading anything itself, so a server
renders the same HTML a browser does. `ExtensionView` joins the two in a
browser: it reads again after a pane selection, a save or an action, and asks
`onNavigate` to open the view a `navigate` button or a `{ view: "<id>" }`
result names.

It draws `list`, `detail`, `form`, `stat`, `split` and `tabs`; any other kind
through `fallbackFor`. It shows what Studio shows as not drawn yet (a collection
form's `lines`, a `stat` other than `count`) and does not yet hold a button's
`busyWhen`; a button's `prompt` and `confirm`
use the browser's own dialogs. It carries no class names but `zv-*` hooks and a
`data-kind` on each view, so styling is the front end's. CI draws every
`view/2` page of the extensions catalogue with it on the server
(`bun run proof:views` in `packages/sdk-react`).

### In Studio

A page whose schema has `"spec": "zveltio.view/2"` is drawn by
`packages/studio/src/lib/view/` (ADR 0042 slice 2); any other schema is `view/1`
and drawn as before.

| Kind | Studio draws |
|---|---|
| `list` | table, `cards` or `feed`; search, paging, selection and bulk actions, row actions, `emphasisWhen`, `create` (the generated form in a dialog), `edit` (the row in that form), `delete` (after a confirm), `open` |
| `form` | the collection's fields (or the action's input) through `SchemaForm`; `record` (a reference or `singleton`), `sections`, `submit` (an action saves first), read-only fields shown as text; a `richtext` field in an editor whose content (stored or pasted) is sanitised first, with remote images blocked while editing; a `file` field as its files, an upload button and a remove per file; on an action form, an input property that is a list of objects is a table of lines (one column per scalar property of a line, an `integer` column takes whole numbers, a line left empty is not sent, at least `minItems` filled lines and every required cell before it runs); a required object or list of scalars has no input and shows a notice, and a button's `prompt` naming one is refused |
| `detail` | its toolbar, the record's fields (a `richtext` one inert in a sandboxed frame, a `file` one as files that open), then its `panels`, all with `$record` set to it; `onOpen` |
| `stat` | `count` (the data API's total for the filter, read again after an action ran) or an action's number: run once per input, only when `GET /api/actions` lists it for the caller, never because another action ran |
| `split`, `tabs` | their views; a pane with an `id` sets `$selected` when a row is clicked |
| `board` | a column per `groupBy` value (its declared choices first, in order, then any other value, then none); `card` fields, else the first default ones; `move` by dragging a card or by its "Move to" menu (ADR 0042 slice 4) |
| `timeline` | one period at a time, with previous, today and next: `day` and `week` as an agenda, `month` (the default) as a calendar, `gantt` as a bar per record over the month; the period is part of the data API filter: with an `end`, what overlaps the period and, asked apart (the data API has no OR) and merged by id, what starts in it with an empty `end`, drawn on its start day; `move` by dropping a record on a day, or by the date in its menu (the keyboard's way), moves it, and its `end`, by whole days |
| `tree` | the records under their `parent`, named by `label`, siblings in `order`; a record whose parent the caller cannot read is a root, and a cycle in the data (A under B under A) is broken at its first record, so every record is drawn once; `move` by dropping a node on another or on the root line, or by its "Move to" menu, never into its own descendants; with `order` too, "Move up" and "Move down" swap the node's `order` with its sibling's, or, when the two are equal or empty, renumber every sibling 0..n-1 in the new order (refused while a page is not read yet); with `patch` that is one bulk update of the data API (at most 500 records, all or nothing: a row the engine refuses refuses the whole move, nothing is renumbered, and the refused rows are named), with an action one run per record, stopping at the first refusal |
| `matrix` | a grid of the `row` and `column` values the records hold (declared choices first); an axis on a relation (`m2o`, `reference`) shows the related records' labels, read by id through the data API as the user, and keeps the id of one the caller cannot read; each cell the `value`, edited in place with `edit` (a checkbox for a boolean) |
| `map` | the records with a `location` as points on a Leaflet map and as a list under it; a point or an entry sets `$selected`. The tiles come from the instance's tile server (`map_tiles` in `GET /api/settings/public`, set by the operator with `ZVELTIO_MAP_TILES`, OpenStreetMap by default; ADR 0043), never from the view; with tiles `off` it draws the list only |
| a kind of a later `view/2` | the view's `fallback`, else the generated list, under a notice |

`board`, `timeline`, `tree`, `matrix` and `map` read the data API a page at a
time at its largest size (500 records). With more, they say how many are shown
of how many and offer "Load more", which reads the next page and appends it;
nothing reads further on its own. A re-read after a write keeps the pages
already read.

Not drawn yet, each with a notice where it appears: a collection form's `lines`
(records of another collection), `recalc` and `autosave`, a list's `realtime`, a `stat` that sums, averages or takes a
minimum or maximum (the data API has no aggregate route; make it a server field
or an action).

**Untrusted rich text in Studio** (`untrusted-html.ts`). A `richtext` value is
sanitised by a DOMPurify instance of its own, with a closed list of tags and
attributes (mail layout: tables, `font`, `center`; no `script`, `iframe`,
`form`, `meta`, `base`, `style`, `svg`, no `on*` attribute) and of URL schemes
(`http(s):`, `mailto:`, `tel:`, `cid:`, `#`); every remote `src`, `srcset`,
`background` and `poster` is moved aside, and a `style` holding a `(` other than
a plain colour function (`rgb()`, `hsla()`, ...) or a `\` is dropped (CSS loads
through `image-set()` or an escaped `url(` too), so opening a message does not
tell its sender. The result is drawn in an `<iframe srcdoc>` with
`sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"` (no
`allow-scripts`: nothing in it runs; the same origin only lets Studio size it)
and a `default-src 'none'` Content-Security-Policy of its own. Links open in a
new tab with no opener. In a list cell the value is its text.

While a button's `busyWhen` holds, Studio reads the page's records again every
three seconds (one timer per page, for at most ten minutes); the button shows
busy until it no longer holds.

A form whose record is read again (after an action, or while `busyWhen`
holds) and is gone says that the action removed it, not that loading failed:
the mail `send` job deletes the draft it sent.

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

The extension ships a view for that screen like any other, with an `id`. That
view is the screen's **fallback**: every front end without the package draws
it. A front end that has the package draws the package instead, chosen by the
view's `id`, and passes it the view's parameters. The package reaches data the
way a view does: the data API and the extension's actions, as the user.

**The example: the page builder** (ADR 0042 slice 7). `content/pages` declares
the page `/admin/pages/builder/:id` with `schemas/builder.json`, a `form` over
`pages` (title, slug, `blocks` as JSON, Save, Publish) whose `id` is
`pages.builder`. Studio carries the canvas in `packages/studio/src/lib/page-builder/`
and lists it in `packages/studio/src/lib/code-screens.ts`:

```ts
export const CODE_SCREENS: Readonly<Record<string, CodeScreen>> = {
  'pages.builder': PageBuilderWorkspace, // gets { params: { id } }
};
```

The extension page host (`routes/(admin)/[...extPath]`) draws a listed screen
in place of the view; without the entry, or in another front end
(`@zveltio/react` draws it in CI), the form is drawn. The package's messages are
Studio's (`pageBuilder.*`), and its test holds it to the extension's block list
and breakpoint keys. Uninstalling the extension removes the page, and so the
screen. The cost is that the canvas ships with Studio's release, not the
extension's.

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
| Schema format | `sduiSchema: 1` ([sdui.md](../ui/sdui.md)), types in Studio; `view/2` specified and validated (`@zveltio/sdk/view`) and drawn by Studio, every kind | `view/2` only, a shared specification package with JSON Schema, validated by the engine and the CLI |
| Data binding | URLs (`dataSource`, `endpoint`) | names of collections and actions |
| Styling | daisyUI class names, icon names | semantic tones |
| Computed values | arithmetic tokens, templates, `computed` | server fields or actions |
| Code pages (`studio/pages/+page.svelte`, "Tier-3") | synced into Studio at release (ai, graphql, storage/cloud); the page builder is a Studio front-end package over the `pages.builder` view | views; screens that need code are front-end packages |
| Slot widgets (`studio/src/contribute.ts`) | Svelte components | data only |
| Renderers | Studio and `@zveltio/react` (the shared runtime is in `@zveltio/sdk/view`) | Studio, `sdk-react`, `sdk-vue` |

Studio draws `view/2` pages (below) and keeps drawing `sduiSchema: 1` schemas
until the codemod (ADR 0042 slice 3). Do not add new code pages: a screen you
cannot express is a request for a view kind or a field type.
