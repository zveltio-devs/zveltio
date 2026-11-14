# Zveltio Extension Cookbook

Task-oriented recipes. Every snippet is modelled on a **shipped extension**
(linked per recipe), not pseudocode. The contract behind them is
[authoring.md](authoring.md); the page format is [ui-model.md](ui-model.md).

> **The one rule that matters:** an extension declares collections and
> actions; the engine creates and owns the collections and its rules decide
> who reads and writes them (ADR 0002). Your code never writes SQL, never
> checks a permission and never opens a table. It reaches data through
> `host.collections`, which is the data API as the caller.

---

## 1. Scaffold a new extension

```bash
zveltio extension create my-thing --category business
```

Writes `manifest.json` (a collection, an action, a page),
`schema/collections/my_thing_items.json`, `engine/index.ts` with the action,
and `studio/schemas/my-thing.json`, a `zveltio.view/2` page. Then:

```bash
zveltio extension pack --dir extensions/business/my-thing      # engine/index.js + integrity hashes
zveltio extension validate --dir extensions/business/my-thing  # manifest, collections, view, messages
```

**Pack after every change under `engine/` or `schema/`.** The engine loads the
packed `engine/index.js` and checks `integrity.engineSha256` and
`integrity.schemaSha256`; a schema file edited after pack refuses the
extension at load. `pack` prints `✓ pack complete` whether or not anything
changed: check the hashes moved.

---

## 2. Extension anatomy

The whole of [`crm`](https://github.com/zveltio-devs/zveltio-extensions/blob/master/crm):

```
crm/
├── manifest.json                 # collections, actions, the page
├── schema/collections/
│   ├── contacts.json             # the engine creates and owns each one
│   ├── organizations.json
│   └── transactions.json
├── engine/
│   ├── index.ts                  # default-exports the extension
│   └── actions.ts                # business logic
└── studio/
    ├── schemas/crm.json          # the page: a zveltio.view/2 document
    └── messages/en.json          # the keys the page owns
```

```ts
// engine/index.ts
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { crmActions } from './actions.js';

const extension: ZveltioExtension = {
  name: 'crm',              // must match the manifest name
  category: 'business',
  mountStrategy: 'subapp',
  actions: crmActions,
  async register() {},      // nothing to mount: the engine serves the collections
};

export default extension;
```

---

## 3. Store data: declare a collection

List it in the manifest and ship one file in the
[schema-as-code](../engine/rfc-schema-as-code.md) format:

```json
"collections": ["widgets"]
```

```json
// schema/collections/widgets.json
{
  "name": "widgets",
  "fields": [
    { "name": "name", "type": "text", "required": true },
    { "name": "status", "type": "enum", "defaultValue": "draft",
      "options": { "values": ["draft", "active"] } }
  ]
}
```

When an administrator enables the extension the engine creates the table with
its tenant isolation, grants and data API routes (`/api/data/widgets`).
Studio, the SDKs and your page all read and write it there, under the
collection's permissions, row and column rules. No migration, no RLS policy,
no route. Field types, relations, `unique`, `indexes`, `defaultGrants` and
`writtenBy` are in [authoring.md](authoring.md#collections--declared-created-by-the-engine).

---

## 4. Enforce a business rule: an action

A rule a form could get around (only an open transaction can be paid) is an
action, not a field edit. From
[`crm/engine/actions.ts`](https://github.com/zveltio-devs/zveltio-extensions/blob/master/crm/engine/actions.ts):

```json
"actions": [{
  "name": "markPaid",
  "permission": { "resource": "transactions" },
  "input": { "type": "object", "required": ["id"], "additionalProperties": false,
             "properties": { "id": { "type": "string", "format": "uuid" } } },
  "reads": ["transactions"], "writes": ["transactions"]
}]
```

```ts
import { ActionRefusal, type ExtensionAction, todayIn } from '@zveltio/sdk/extension';

const markPaid: ExtensionAction = async (input, host) => {
  const { id } = input as { id: string };
  const tx = await host.collections.read('transactions', id);
  if (!tx) throw new ActionRefusal(404, 'transaction_not_found', 'No such transaction.');
  if (tx.status !== 'draft' && tx.status !== 'pending') {
    throw new ActionRefusal(409, 'transaction_not_open', 'Already settled.');
  }
  // `expect` re-checks the status on the locked row: a concurrent call gets 409.
  return host.collections.update(
    'transactions', id,
    { status: 'completed', paid_date: todayIn(host.timezone) },
    { expect: { status: ['draft', 'pending'] } },
  );
};
```

`POST /ext/crm/actions/markPaid` runs it. The engine checks the caller holds
`execute` on `transactions` and that the body matches `input`, then runs it
as the caller, in the request transaction. `ActionRefusal` answers that 4xx;
any other throw answers 500; both roll back. To make the action the only way
to write a field, flag it `"writtenBy": "actions"` in the collection file.

---

## 5. Do slow work after the write (email, PDF, a remote call)

An action runs inside the caller's transaction, so it does no network I/O.
It enqueues a **job**, which runs after the transaction commits and retries:

```json
"actions": [{ "name": "markPaid", "...": "...", "enqueues": ["sendReceipt"] }],
"jobs": [{ "name": "sendReceipt", "input": { "type": "object" },
           "reads": ["transactions"], "retry": { "limit": 3 } }]
```

```ts
actions: {
  async markPaid(input, host) {
    // ... the write, as in recipe 4 ...
    await host.enqueue('sendReceipt', { id });
  },
},
jobs: {
  async sendReceipt(input, host) {
    const tx = await host.collections.read('transactions', (input as { id: string }).id);
    // network I/O is fine here
  },
},
```

The enqueue joins the action's transaction: a refused action leaves no job.
A job needs `data:system` and acts as the extension, over the collections its
`reads`/`writes` name. Modelled on
[`communications/mail`](https://github.com/zveltio-devs/zveltio-extensions/blob/master/communications/mail)
(the `send` job).

---

## 6. Use another extension's logic

Don't copy another extension's rule, and don't write its collections: run its
action. Name the extension in `dependencies` (or `optionalDependencies`) and
the action in `calls`:

```json
"dependencies": [{ "name": "finance/invoicing", "minVersion": "2.0.0" }],
"actions": [{ "name": "settle", "...": "...", "calls": ["finance/invoicing.recordPayment"] }]
```

```ts
await host.actions.run('finance/invoicing', 'recordPayment', { invoice_id, amount });
```

The engine checks the caller holds the called action's permission, validates
its input and runs it in the same transaction. An absent optional dependency
answers 404. Reading another extension's collection needs no code at all: list
it in `reads`, and the caller's grants decide.

---

## 7. Add an admin page: a view

The page is data, drawn by Studio, `@zveltio/react` or any other front end
(ADR 0042). Point the manifest page at it and write a `zveltio.view/2`
document, modelled on
[`crm/studio/schemas/crm.json`](https://github.com/zveltio-devs/zveltio-extensions/blob/master/crm/studio/schemas/crm.json):

```json
"studio": { "pages": [{ "path": "/admin/crm", "label": "CRM", "icon": "Users",
                         "schema": "schemas/crm.json" }] }
```

```json
{
  "spec": "zveltio.view/2",
  "id": "crm.transactions",
  "title": "crm.title",
  "type": "list",
  "collection": "transactions",
  "fields": [
    { "field": "number", "label": "crm.col.number" },
    { "field": "status", "label": "crm.col.status" },
    { "field": "created_at", "label": "common.added" }
  ],
  "sort": "-created_at",
  "search": true,
  "create": true,
  "edit": true,
  "rowActions": [{
    "action": "markPaid", "label": "crm.action.markPaid",
    "input": { "id": { "$record": "id" } },
    "when": [{ "field": "status", "op": "in", "value": ["draft", "pending"] }]
  }]
}
```

Names, not addresses: a collection the extension declares, its fields, its
actions. `extension validate` refuses a field the collection does not have,
an action the extension does not declare and a label key missing from
`studio/messages/en.json` (`common.*` keys come from the host). Kinds beyond
`list` (`detail`, `form`, `split`, `tabs`, `board`, `map`, …) are in
[ui-model.md](ui-model.md). No Svelte, no build.

---

## 8. Expose a public route

Most extensions need none: an operator grants the `public` role `read` on a
collection and `GET /api/data/<collection>` serves it (ADR 0017). A route is
for a response the data API cannot give, like a sitemap. Declare it and
export a plain function, as
[`content/pages`](https://github.com/zveltio-devs/zveltio-extensions/blob/master/content/pages/engine/sitemap.ts)
does:

```json
"routes": [{ "method": "GET", "path": "/sitemap.xml", "access": "public", "handler": "sitemap" }]
```

```ts
import type { RouteHandler } from '@zveltio/sdk/extension';

export const sitemap: RouteHandler = async (request, { host }) => {
  const { records } = await host.collections.list('page_publications', { limit: 500 });
  return new Response(toSitemap(records), { headers: { 'content-type': 'application/xml' } });
};
```

```ts
// engine/index.ts
routes: { sitemap },
```

On a `public` route `host.collections` reads as the tenant's `public` role and
cannot write: until an operator grants `public` read on the collection, the
read is refused, never rows. Public means **the whole internet**: return only
what the grant allows. An inbound webhook is a public route that enqueues a
job; see [authoring.md](authoring.md#inbound-webhooks-a-public-route-enqueues-a-job-writes).

---

## 9. Test an action

An action is a function of `(input, host)`. Hand it a host whose
`collections` you control:

```ts
import { expect, it } from 'bun:test';
import { ActionRefusal } from '@zveltio/sdk/extension';
import { crmActions } from './actions.js';

const host = (row: Record<string, unknown> | null) => ({
  timezone: 'UTC',
  collections: {
    read: async () => row,
    update: async (_c: string, id: string, patch: object) => ({ id, ...patch }),
  },
}) as never;

it('refuses a settled transaction', async () => {
  const run = crmActions.markPaid({ id: 't1' }, host({ id: 't1', status: 'completed' }));
  await expect(run).rejects.toBeInstanceOf(ActionRefusal);
});
```

This tests your logic. The engine's part (the permission, the input schema,
row rules, the `expect` lock) needs a real engine: first-party extensions run
`testing/ext-harness.ts` in `zveltio-extensions` against the packed bundle and
Postgres.

---

## 10. Publish to the registry

```bash
zveltio extension validate --dir <dir>   # manifest, collections, view, messages
zveltio extension pack --dir <dir>       # bundle + integrity hashes
zveltio extension publish --dir <dir>    # validate, archive, sign, upload
```

The engine installs extensions from **registry.zveltio.com**, never from a repo
checkout. Community extensions run worker-isolated (`engine.isolation:
"worker"`, set by `pack`; [marketplace-policy.md](marketplace-policy.md) §2);
actions and `host.collections` work the same there.

---

## Common mistakes

| Symptom | Cause |
| --- | --- |
| Your change doesn't take effect | Stale `engine/index.js`: re-run `zveltio extension pack`. |
| The extension refuses to load after a schema edit | `schemaSha256` no longer matches `schema/`: re-pack. |
| An action answers 403 | The caller lacks `execute` on the action's `permission.resource`, or `host.collections` was refused as the data API refuses that caller. |
| Writing a field answers 409 `written_by_actions` | The field or collection is `writtenBy: "actions"`: only your actions and jobs write it. |
| `validate` fails `VIEW_REFERENCE` | The view names a field, action or view the extension does not declare. |
| An operator's edit to your collection answers 409 | Its fields belong to your package: change the collection file and ship a new version. |
