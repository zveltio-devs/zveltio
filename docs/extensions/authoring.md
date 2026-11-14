# Authoring Zveltio extensions

An extension declares **collections**, **actions** and **jobs**, the
**routes** a non-Zveltio caller needs, and **views** for its pages. The engine
creates and owns the collections, runs the actions and jobs, answers the
routes, and its rules decide who may do what (ADR 0002). This document is the
contract; read it before building one. Task recipes are in
[cookbook.md](cookbook.md), the page format in [ui-model.md](ui-model.md).

## TL;DR

- One folder per extension at `zveltio-extensions/<category>/<name>/`;
  `bunx @zveltio/cli extension create <name>` scaffolds one.
- `manifest.json` declares everything: collections, actions, jobs, routes,
  pages, capabilities (`permissions`) and dependencies.
- Data lives in collections the extension declares in `schema/collections/`.
  No SQL, no migrations, no table of your own: the engine creates them, with
  tenant isolation, grants and the data API (`/api/data/<collection>`).
- Business logic is an **action** (synchronous, as the caller, in the caller's
  transaction) or a **job** (after commit, retried). Both reach data only
  through `host.collections`, the data API with every rule applied.
- An extension carries no authorization logic: no permission checks, no
  invented verbs, no `resources`. The engine's grants, row and column rules
  decide.
- A page is a `zveltio.view/2` document in `studio/schemas/`, drawn by every
  front end. No extension code runs in a browser (ADR 0042).
- `extension pack` bundles `engine/index.js` and records integrity hashes;
  re-pack after every change under `engine/` or `schema/`.

## Folder layout

```
my-extension/
├── manifest.json
├── schema/
│   └── collections/
│       └── tasks.json             # one file per declared collection
├── engine/
│   ├── index.ts                   # default-exports the extension
│   ├── actions.ts                 # actions and jobs
│   └── routes.ts                  # declared route handlers, if any
└── studio/
    ├── schemas/
    │   └── my-extension.json      # a page: a zveltio.view/2 document
    └── messages/
        └── en.json                # keys this extension owns; locales filled from en
```

No `studio/dist/`, no per-extension `vite.config.ts` or `package.json`, no
`studio/pages/*.svelte` (code pages and slot widgets are being retired,
ADR 0042; a screen that needs code is a front-end package outside the
extension, see [ui-model.md](ui-model.md#a-screen-that-needs-code)).

## `manifest.json`

```json
{
  "name": "business/tasks",
  "displayName": "Tasks",
  "category": "business",
  "description": "What this extension does, in one sentence.",
  "version": "1.0.0",
  "zveltioMinVersion": "3.0.0-beta.121",
  "package": "@zveltio/ext-tasks",
  "permissions": ["data:write"],
  "collections": ["tasks"],
  "actions": [{ "name": "close", "permission": { "resource": "tasks" },
                "input": { "type": "object", "required": ["id"],
                           "properties": { "id": { "type": "string" } } },
                "reads": ["tasks"], "writes": ["tasks"] }],
  "studio": { "pages": [{ "path": "/admin/tasks", "label": "Tasks", "icon": "Check",
                          "schema": "schemas/tasks.json" }] },
  "contributes": { "engine": true, "studio": true }
}
```

- **`name`** must equal the path slug exactly (e.g. `finance/accounting`). Mismatches fail registry sync.
- **`zveltioMinVersion`** uses naive semver (`major.minor.patch`); pre-release suffixes like `-beta.X` are tolerated. Name the first engine that has every member you use; this document gives the version for each.
- **`permissions`** lists the capabilities the extension uses (`data:write`, `data:system`, `files`, `auth:session`, …); an administrator approves them at install. `defineExtension([...], …)` takes the same list and types `ctx` by it.
- **`peerDependencies`** are **bundled into `engine/index.js`** at pack time, not installed on the target, and must be on the platform allow-list (`PEERDEP_NOT_ALLOWED` otherwise). A dependency that reads its own files at runtime cannot work: `node_modules` does not ship.
- **`contributes.engine: false`** marks an extension with no code: collections and views only.

## Collections — declared, created by the engine

An extension's data lives in collections it declares; the engine creates them.
List them in `manifest.json` and ship one file per name, in the
[schema-as-code](../engine/rfc-schema-as-code.md) collection format (the format
`zveltio schema pull` writes):

```json
"collections": ["tasks"]
```

```json
// schema/collections/tasks.json
{ "name": "tasks", "fields": [{ "name": "title", "type": "text", "required": true }] }
```

- The engine creates them when an instance administrator enables the extension
  (or when it loads with them not yet applied), never at install, and records
  the extension as their owner. Until then a firm cannot activate it.
- A name that already belongs to a collection the extension does not own
  refuses the whole set; nothing is created.
- A later version's additions (a field, a rule, a relation) are applied when it
  is enabled. A type change into the same column type keeps every value: among
  `text`, `textarea`, `richtext`, `email` and `url`, or between `json` and
  `file` (ADR 0047), and a text field → `secret` (ADR 0024). A drop, a rename
  or any other type change is refused for now.
- The instance's own schema export leaves the extension's collections out: they
  belong to its package.
- Their fields, relations and settings are the extension's: an operator's change
  through `/api/collections`, `/api/relations`, Studio or a schema branch
  answers 409. Row rules, column permissions, validation rules and grants an
  operator adds stay: a load adds, changes and removes only the entries the
  extension's own files declared, judged against what its previous apply
  declared.
- Uninstalling keeps them, with their rows and rules. A purge
  (`uninstall?purgeData=true`) drops every collection the extension owns, with
  its junction tables and every rule naming it — grants in every domain, revoked
  defaults, row rules, column permissions, validation — and the operator's own
  fields on it. While an operator's collection holds a key into one of them (an
  m2o), the purge answers 409 naming the field and drops nothing: a purge never
  changes a collection the extension does not own.
- `"defaultGrants": false` in a collection's file withholds it from the default
  role grants, at creation and at every boot: an internal collection only the
  extension's actions and jobs reach. It replaces `sensitiveResources` for
  declared collections, and cannot change after creation yet.
- `"writtenBy": "actions"` on a field, or on the collection (every field, create
  and delete), makes the extension's own actions and jobs the only writers,
  through `host.collections`. Any other write — the data API (single, bulk,
  `PUT`, delete), sync, `ctx.internals.*Record` (GraphQL),
  another extension's action — answers 409 `written_by_actions`, for god and
  API keys too. `ctx.db` and the worker SQL bridge may not write such a
  collection at all, the owner's included. On create a flagged field takes its
  declared default. A delete anywhere whose foreign keys would cascade into a
  flagged collection, or set a flagged field to null, answers the same 409 —
  decided on the key, so such a parent is deleted only by the owner's actions.
  Declare `onDelete: "RESTRICT"` on a flagged key (an m2o defaults to
  `SET NULL`) unless that is what you want.
  A flag on fields only does not stop deleting a whole record: any caller with
  `delete` on the collection still may. Flag the collection when deleting must
  go through an action too. The key is owned structure: an operator cannot set
  or remove it (422), `ctx.DDLManager` cannot change the collection (409), a
  new version's file adds or removes it, and it is in `schemaSha256`. It
  narrows; the action's write still runs as its caller, under the collection's
  permissions, row and column rules.
- A required m2o field's key column is NOT NULL. A relation entry may leave out
  what the engine fills in (`targetField`, `onDelete` `SET NULL`, `onUpdate`
  `CASCADE`, `metadata`) — but a required key cannot be `SET NULL`, written or
  left out: deleting its parent would fail, so the file is refused. Say
  `CASCADE`, `RESTRICT` or `NO ACTION`.
- `"indexes": [{ "fields": ["project_id", "user_id"], "unique": true }]` is a
  unique key over two or more fields, per tenant like a field's own `unique`
  (`UNIQUE (tenant_id, project_id, user_id)`). A repeat answers 409
  `unique_violation`. Only unique indexes are supported; one field's key is its
  `unique` flag.
- `zveltio extension pack` records `integrity.schemaSha256`, a digest of every
  `.json` under `schema/`. Each load recomputes it and refuses the extension
  when a file changed after pack, or when a manifest that declares collections
  has no digest. Re-pack after editing a schema file; a Studio-only extension is
  packed for this alone.
- A Studio-only extension (`contributes.engine: false`) declares collections on
  the same terms.
- A declarative (SDUI) page may name `/api/data/<collection>` and
  `/api/data/<collection>/<id>` for the collections its extension declares, and
  no other core endpoint. The data API authorizes the signed-in user as for any
  other request.

## Actions and jobs — `extension-api v1`

Business logic belongs in **actions** (synchronous, inside the caller's request
transaction) and **jobs** (asynchronous, run after that transaction commits).
Declare both in `manifest.json` and export their implementations from the
extension; the engine refuses an extension whose two lists differ.

```json
"actions": [{
  "name": "markPaid",
  "permission": { "resource": "transactions" },
  "input": { "type": "object", "required": ["id"], "properties": { "id": { "type": "string" } } },
  "reads": ["transactions"], "writes": ["transactions"],
  "enqueues": ["sendReceipt"]
}],
"jobs": [{ "name": "sendReceipt", "input": { "type": "object" }, "retry": { "limit": 3 } }]
```

```ts
import { ActionRefusal, defineExtension, todayIn } from '@zveltio/sdk/extension';

export default defineExtension(['data:write', 'data:system'], {
  name: 'crm', category: 'business', register: async () => {},
  actions: {
    async markPaid(input, host) {
      const { id } = input as { id: string };
      const tx = await host.collections.read('transactions', id);
      if (!tx) throw new ActionRefusal(404, 'transaction_not_found', 'No such transaction.');
      if (tx.status !== 'open') throw new ActionRefusal(409, 'not_open', 'Already settled.');
      // `expect` re-checks the status on the locked row: a concurrent call gets 409.
      await host.collections.update('transactions', id,
        { status: 'paid', paid_date: todayIn(host.timezone) },
        { expect: { status: ['open'] } });
      await host.enqueue('sendReceipt', { id });
      return { id };
    },
  },
  jobs: { async sendReceipt(input, host) { /* network I/O is fine here */ } },
});
```

- `POST /ext/<name>/actions/<action>` runs the action: the caller must hold
  `permission`, and the body must match `input`.
- `GET /api/actions` lists the actions the caller may run, each with its
  `input` schema, so an SDK, a Studio picker or `zveltio mcp` can offer them
  typed. It asks the same check the action route does.
- `permission.resource` names a collection the extension's actions or jobs
  read or write. Once that collection exists, the engine grants
  `tenant_member` `execute` on it (revocable in the role editor), and dropping
  the collection removes the grant. A `resources` entry is still accepted, but
  it is v1 legacy ([v2 candidate 3](v2-candidates.md)).
- `host.collections` is the only data path. It is the data API as the caller
  (a job: as the extension, scoped to its `reads`/`writes`), with permissions,
  RLS, column rules, hooks and audit. No SQL. A refused write throws with the
  data API's status and `code`, and the request fails with it.
- `"*"` in an action's `reads` or `writes` reaches any collection, still only
  as the caller (ADR 0047): a collection the caller holds no grant on is
  refused as the data API refuses it, their row and column rules hold, and
  `ctx.internals.asSystem` does not change who it acts as. `reads: ["*"]`
  grants no write. Install consent shows it as `collections:any:read` /
  `collections:any:write` ("any collection the person running it can
  read/write"); a version that starts listing `"*"` runs without it until an
  administrator approves. A job cannot list `"*"` (the manifest is refused),
  and `"*"` does not widen a route. Engines from the release carrying ADR 0047;
  an older engine reads `"*"` as a collection named `*` and refuses every call.
- `throw new ActionRefusal(status, code, message)` answers the caller with that
  4xx. Any other throw answers 500. Both roll back what the action wrote.
- `host.actions.run(extension, action, input)` runs an action of an extension
  this one depends on (ADR 0014), so its invariant stays in the owner's code
  instead of a copy in another bundle. The calling action lists it in `calls`
  (`"calls": ["finance/invoicing.recordPayment"]`), and that extension must be
  in `dependencies` or `optionalDependencies` (absent, it answers 404). The engine checks the caller holds the called action's
  `permission`, validates `input`, and runs it in the same transaction; its
  writes count as the called extension's, so a `writtenBy: "actions"` field of
  that extension accepts them. A refusal it throws reaches the caller. An action
  run this way cannot run another. Optional member: absent before 3.0.0-beta.94.
- `host.timezone` is the tenant's IANA zone. Use `todayIn(host.timezone)` for
  "today", never `new Date().toISOString().slice(0, 10)`.
- A route has `host.collections` too (ADR 0025): `ctx.host(c).collections`,
  inline and worker-isolated, over the collections the manifest declares
  (`collections`) and those its actions and jobs read or write — `"*"` excepted
  (ADR 0047): an action's wildcard does not widen a route. It acts as the
  caller — the signed-in user, or the `public` role on a public route, which
  reads only — and its writes need `data:write` and carry no action mark.
  In an inline extension, inside `ctx.internals.asSystem(['settings'], fn)`
  (`data:system`, audited) the named collections act as the extension, as a
  job does; the rest stay the caller's. A worker-isolated route has no
  `ctx.internals`, so it always acts as its caller. Work with no caller at all
  (`ctx.internals.withTenantIsolation` of your own, a `perTenant` schedule, a
  listener) is an actor with no identity: a row rule on `user_id`, `user_email`
  or `user_role` keeps no row for it, with `data:system` too (ADR 0040). To
  write a user's row, do it in that user's request (an action, or `asSystem`
  in a route) or in a job that user enqueued. Secrets of a collection the extension owns come back decrypted
  either way.
- An inline route also has `ctx.host(c).files` (ADR 0034, `files` capability):
  `put(name, bytes, { folderId? })` stores a private file of the caller and
  `delete(id)` deletes one, exactly as `/api/storage` would for that user or API
  key (a key needs `$storage` `create` / `delete`), always as the caller, also
  inside `asSystem`. A throw from the route rolls back a put with its bytes; a
  delete's bytes go once the request commits. A public route has no files.
  Absent on a worker-isolated route. Engines from 3.0.0-beta.110.
- A declared public route of an extension holding `auth:session` also has
  `host.identity` (ADR 0039): `signIn({ provider, subject, email, name })`
  signs in the person your provider vouched for — the engine finds or creates
  the account, refuses a disabled one, opens the session, audits it and hands
  back the headers to answer with — and `signInRefused({ provider, identifier,
  reason })` audits a refusal at the provider. The manifest's
  `signInProviders` names each provider and the route that starts it; the
  engine lists them at `GET /api/sign-in/providers`. Engines from
  3.0.0-beta.113. See the developer guide, "Signing a person in".
- A declared route of an extension holding `identity:provision` also has
  `host.identity`'s directory (ADR 0039 decision 9) — a `public` route, or a
  `caller` route whose caller's author administers the tenant (a tenant
  administrator, or an API key one issued; ADR 0045): `provision`,
  `update`, `setActive`, `remove`, `list` and `get` over the accounts the
  extension provisioned in the request's tenant, each keyed by the extension's
  own `subject`; the engine keeps the link, enforces `active`, audits each act
  with the extension as actor, and refuses everything else as not found.
  Engines from 3.0.0-beta.114. See the developer guide, "Provisioning a
  directory".

### Inbound webhooks: a public route enqueues, a job writes

A webhook from a payment provider has no user, so it cannot run an action, and
a collection flagged `writtenBy: "actions"` refuses a route's own write. The
route verifies the signature, stores the raw event, and enqueues a job; the job
writes through `host.collections` (ADR 0018).

```json
"routes": [{ "method": "POST", "path": "/webhooks/stripe", "access": "public", "handler": "stripeWebhook" }],
"jobs": [{
  "name": "applyEvent", "input": { "type": "object" },
  "writes": ["payments"], "fromPublicRoutes": ["/webhooks/stripe"]
}]
```

```ts
export const stripeWebhook: RouteHandler = async (request, { host }) => {
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get('stripe-signature'))) {
    return Response.json({}, { status: 401 });
  }
  await host.enqueue!('applyEvent', JSON.parse(raw));
  return Response.json({ received: true });
};
```

- The route must be one the job names in `fromPublicRoutes`: each entry names
  one declared public route (or a legacy `publicRoutes` entry), without `*`,
  so another public handler cannot queue the job. A `caller` route, a request
  kept from another call, or a call left running after the answer throws.
  [`billing`](https://github.com/zveltio-devs/zveltio-extensions/blob/master/billing/engine/routes.ts)
  is the shipped example (it also claims each event id once).
- The enqueue joins the request transaction: a handler that throws afterwards
  leaves no job. The job runs in the request's tenant.
- Needs `data:system`, as every job does; `input` must match the job's schema.
  The job has no author (`created_by` stays null); its run records
  `enqueuedBy: "ext:<name>:route"`, and each enqueue is audited as
  `extension.job.enqueued` on the same transaction.
- A provider retries and an attacker replays: store the event id, and skip an
  id already stored, before enqueueing.
- The tenant is the request's: `X-Tenant-Slug`, the tenant's subdomain, or the
  default tenant. A provider that calls one URL for every tenant lands in the
  default tenant.
- Optional member: absent before 3.0.0-beta.97.

### Public pages: a public route reads as the `public` role

A public route (a sitemap, a published page) reads with the same members a
session route uses, and reads as the anonymous visitor of `GET /api/data`
(ADR 0017, ADR 0020): the tenant's `public` role, its grants, row rules and
column permissions. The request is charged once to the anonymous read rate
limit; refused, the read throws the 429, which is the route's answer unless
the handler catches it.

```ts
export const sitemap: RouteHandler = async (request, { host }) => {
  const { records } = await host.collections.list('page_publications', { limit: 500 });
  return new Response(toSitemap(records as Row[]), { headers: { 'content-type': 'application/xml' } });
};
```

A refused read throws with the data API's status, which is the route's answer
unless the handler catches it.

- `public` holds nothing until an operator grants it `read` on the collection:
  until then the read answers 403, never rows. The extension cannot grant it.
- It is the visitor's read whoever the visitor is: a signed-in one reads as
  `public` too, never as themselves, and a stale cookie does not refuse it.
- Reads only: a write through `host.collections` throws in a public route. A
  request kept from another call, or a read left running after the answer,
  throws.
- Before 3.0.0-beta.99 both members threw in a public route.

### The v1 contract is frozen

These exports of `@zveltio/sdk/extension` are `extension-api v1`, frozen on
2026-10-19 (3.0.0-beta.84): `ActionHost`, `JobHost`, `HostCollections`,
`UpdateExpect`, `DataApiReadQuery`, `ExtensionAction`, `ExtensionJob`,
`ZveltioExtension.actions`/`jobs`, `ActionRefusal`, `ACTION_REFUSAL`,
`RefusalStatus`, `todayIn`, and the manifest's `actions` and `jobs` blocks.

v1 is stable until v2, which ships before GA. Until then these only grow: a
new optional member, a new host method, a wider union, a new manifest key with
a default. Removing or renaming something, making an argument required or
narrowing a type is a v2 change. When v2 ships, extensions migrate to it and v1
is removed. What v2 should change, and the additive stopgaps v1 grew meanwhile,
are listed in [v2-candidates.md](v2-candidates.md).

The frozen copy is `packages/sdk/extension-api/v1.d.ts`. CI runs
`bun run check:extension-api`, which fails when the live types stop accepting
what that copy promises. Never edit `v1.d.ts` to make the check pass.

## Declared routes

A route exists only for a caller that is not a Zveltio client: an identity
provider, a payment provider's webhook, a crawler (ADR 0039). Whatever a
front end calls is the data API, an action or the file API. Declare each
route and export its handler, a plain function over the web-standard
`Request` and `Response`:

```json
"routes": [{ "method": "POST", "path": "/webhook/stripe", "access": "public", "handler": "stripeWebhook" }]
```

```ts
import type { RouteHandler } from '@zveltio/sdk/extension';

export const stripeWebhook: RouteHandler = async (request, { params, host }) => {
  // host.collections, host.enqueue, host.files as for any route (see above)
  return Response.json({ received: true });
};
```

- `access` is `public` (anyone) or `caller` (the engine authenticates the
  request as usual). The engine owns mounting, path parameters, body limit,
  rate limit and tenant resolution; a path that is not declared does not
  exist, and an anonymous request to one answers 401 (ADR 0047).
- The handler is exported in the extension's `routes` object under the name
  the manifest gives (`routes: { stripeWebhook }`); the two lists must match.
- It works the same inline and worker-isolated. `publicRoutes` is still read
  and deprecated. Engines from 3.0.0-beta.110.

## Pages: views

A page is `manifest.studio.pages[].schema` naming a `zveltio.view/2` document
under `studio/schemas/`. It names collections, fields and actions, never
URLs; Studio, `@zveltio/react` and any other front end draw it, and nothing
is built when the extension is enabled. The format, the kinds and what
`extension validate` checks are in [ui-model.md](ui-model.md). A view's
labels are keys in `studio/messages/en.json`; `common.*` keys come from the
host and are not repeated.

## `engine/index.ts` — the entry point

```ts
import { defineExtension } from '@zveltio/sdk/extension';
import { actions, jobs } from './actions.js';
import { stripeWebhook } from './routes.js';

export default defineExtension(['data:write', 'data:system'], {
  name: 'business/tasks',          // must match manifest.json
  category: 'business',
  actions,
  jobs,
  routes: { stripeWebhook },
  async register() {},             // nothing to mount
});
```

1. Import from `@zveltio/sdk/extension` only (types and `ActionRefusal`,
   `todayIn`, `defineExtension`). Never import engine source or another
   extension: run its action (`host.actions.run`) instead.
2. `name` must equal `manifest.json` `name` exactly.
3. The capability list must equal the manifest's `permissions`
   (`extension validate` compares them).

## Legacy surface (extension-api v1, until v2)

v1 still carries the model this document replaced, so extensions built on it
keep loading. Do not use it in a new extension or a new version: every
first-party extension has been ported off it, and v2 removes it
([v2-candidates.md](v2-candidates.md)).

| Legacy | Use instead |
|---|---|
| `getMigrations()` and SQL with hand-written tenant RLS | declared collections (`schema/collections/`) |
| `register(app, ctx)` mounting Hono routes; `publicRoutes`; `ctx.registerPublicRoute` | the data API, an action, or a declared route |
| `ctx.db`, `ctx.reqDb(c)`, `ctx.DDLManager` | `host.collections` |
| `ctx.checkPermission`, `requireAdmin` helpers, `resources`, invented verbs | the action's `permission`; the engine's grants and rules |
| `ctx.events.on('record.*')` listeners | an action that enqueues a job |
| `ctx.services` | `host.actions.run` with `calls` and a dependency |
| `ctx.internals.*` (first-party only) | the members above; what remains is listed in the developer guide |
| `studio/pages/+page.svelte`, `studio/src/contribute.ts` slot widgets, view/1 (`sduiSchema: 1`) | a `zveltio.view/2` view; code as a front-end package |

The developer guide documents the legacy members for whoever maintains such
an extension.

## How the engine resolves extensions at runtime

Extensions are downloaded as ZIPs from `registry.zveltio.com` and extracted
to `<EXTENSIONS_DIR>/<name>/`. `extension pack` bundles everything the engine
code imports into `engine/index.js` (`engine.bundlePeers: true` is the only
valid configuration), and the loader imports that artifact directly;
`node_modules` is excluded from the published archive. Each load checks
`integrity.engineSha256` and `integrity.schemaSha256` and refuses an
extension whose files changed after pack.

An unbundled extension (a `.ts` entry loaded from disk, the legacy path) still
gets the four core packages provisioned in `<EXTENSIONS_DIR>/node_modules/`
and its `peerDependencies` installed with `bun add` at activation; both need
Bun on `PATH`, which `install/install.sh` handles.

## How pages are served

A view page is inlined into `GET /api/extensions` and drawn by the host at
request time: enabling the extension is enough, nothing is built or copied.
Engine routes and actions are hot-swapped on enable; the browser needs a
refresh to show newly activated pages. `POST /api/marketplace/:name/enable`
never builds; its response keeps `studio_rebuild: "skipped"` and
`studio_pages_prebuilt: true` for compatibility.

Code pages synced into Studio at release are being retired (ADR 0042, slice 8
deletes the bake).
