# Zveltio Extension Cookbook

Task-oriented recipes. Every snippet below is modelled on a **real shipped
extension** (linked per recipe) — not pseudocode. For the conceptual reference
(lifecycle, manifest fields, isolation tiers) see
[EXTENSION-DEVELOPER-GUIDE.md](EXTENSION-DEVELOPER-GUIDE.md).

> **The one rule that matters:** query through **`ctx.db`**. It is already scoped
> to the caller's tenant (H-12) — every row you read or write is automatically
> isolated. `ctx.adminDb` crosses tenants and throws unless your manifest declares
> the `db:admin` permission, which is flagged at review + install. If you find
> yourself reaching for `adminDb`, stop and ask why.

---

## 1. Scaffold a new extension

```bash
zveltio extension create my-thing --category business
```

Writes `manifest.json`, `engine/index.ts`, `engine/migrations/`, and
`studio/src/pages/`. Then:

```bash
zveltio extension validate --dir extensions/business/my-thing
zveltio extension pack --dir extensions/business/my-thing   # bundles engine/index.js + integrity hash
```

**Pack after every `engine/*.ts` change.** The engine loads the packed
`engine/index.js` for the bundled code path; CI verifies the bundle hash matches
the manifest (`engineSha256`) but does **not** rebuild it — a stale bundle ships
stale behaviour silently.

---

## 2. Extension anatomy

The whole contract (see [`crm/engine/index.ts`](https://github.com/zveltio-devs/zveltio-extensions/blob/master/crm/engine/index.ts)):

```ts
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';

const extension: ZveltioExtension = {
  name: 'business/my-thing',       // must match the manifest name
  category: 'business',
  mountStrategy: 'subapp',         // routes mount under /ext/business/my-thing

  getMigrations() {
    return [
      join(import.meta.dir, 'migrations/001_initial.sql'),
      join(import.meta.dir, 'migrations/002_tenant_rls.sql'),
    ];
  },

  async register(app, ctx) {
    // mount routes, subscribe to events, publish services — all here
  },
};

export default extension;
```

---

## 3. Add an API route

`register()` hands you a Hono sub-app. Everything you mount lands under
`/ext/<name>/`.

```ts
async register(app, ctx) {
  app.get('/widgets', async (c) => {
    const session = await ctx.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const rows = await ctx.db.selectFrom('zvd_widgets').selectAll().execute();
    return c.json({ widgets: rows });   // tenant-scoped automatically
  });
}
```

Guard writes with a permission check:

```ts
if (!(await ctx.checkPermission(session.user.id, 'widgets', 'create'))) {
  return c.json({ error: 'Forbidden' }, 403);
}
```

---

## 4. Add a migration (and keep tenant isolation)

Two files, always in this order — schema, then RLS:

`migrations/001_initial.sql`
```sql
CREATE TABLE IF NOT EXISTS zvd_widgets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`migrations/002_tenant_rls.sql` — the canonical pattern every extension uses:
```sql
ALTER TABLE zvd_widgets ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE zvd_widgets
  ALTER COLUMN tenant_id
  SET DEFAULT NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid;
CREATE INDEX IF NOT EXISTS idx_zvd_widgets_tenant ON zvd_widgets (tenant_id);
```

> `current_setting(guc, true)` returns `''` — **not NULL** — for a set-but-blank
> GUC. Without the `NULLIF`, `''::uuid` throws on every insert made outside a
> tenant context. This exact bug took down the whole data plane once.

Register both in `getMigrations()`. Migrations run once, in array order, when the
extension is enabled.

---

## 5. React to record changes (e.g. email on insert)

```ts
async register(app, ctx) {
  ctx.events.on('record.created', async ({ collection, id, record, tenantId }: any) => {
    if (collection !== 'zvd_orders') return;          // always filter first
    try {
      const mail = ctx.services.get('mail.send');      // optional dependency
      if (mail) await mail({ to: record.email, subject: `Order ${id}`, body: '…' });
    } catch {
      /* never let a side-effect break the write that triggered it */
    }
  });
}
```

Available: `record.created`, `record.updated`, `record.deleted`. Payload:
`{ collection, id, record, tenantId }`. Modelled on
[`operations/traceability`](https://github.com/zveltio-devs/zveltio-extensions/blob/master/operations/traceability/engine/index.ts)
and `ai`.

**Gotcha:** `record.before*` hooks only fire on single-row, WHERE-by-id writes.
A bulk update skips them — the engine logs a warning saying so. If you need
per-row semantics on bulk, pre-fetch the ids and loop.

---

## 6. Share data with other extensions (services)

Don't duplicate another extension's tables — consume its service.

**Publish** (from [`crm`](https://github.com/zveltio-devs/zveltio-extensions/blob/master/crm/engine/index.ts)):
```ts
ctx.services.register('crm.contacts.findByEmail', async (email: string) => {
  const r = await sql<any>`SELECT * FROM zvd_contacts WHERE email = ${email} LIMIT 1`
    .execute(ctx.db);
  return r.rows[0] ?? null;
});
```

**Consume** — always treat it as optional; the provider may not be installed:
```ts
const lookup = ctx.services.get('crm.contacts.findByEmail');
const contact = lookup ? await lookup(email) : null;
```

Services are unregistered automatically when your extension unloads.

---

## 7. Add an admin page without writing Svelte (SDUI)

Declarative pages are **data**, rendered by the Studio host — no per-extension
Studio build. Drop a schema in `studio/schemas/widgets.json`
(modelled on [`content/drafts`](https://github.com/zveltio-devs/zveltio-extensions/blob/master/content/drafts/studio/schemas/drafts.json)):

```json
{
  "sduiSchema": 1,
  "title": "widgets.title",
  "subtitle": "widgets.subtitle",
  "resources": [
    {
      "id": "widgets",
      "dataSource": "/ext/business/my-thing/widgets",
      "dataPath": "widgets",
      "columns": [
        { "key": "name", "label": "common.col.name" },
        { "key": "created_at", "label": "common.col.created", "type": "date" }
      ]
    }
  ]
}
```

`dataSource` is your route; `dataPath` is the key inside its JSON response
(`{ "widgets": [...] }` → `"widgets"`). Labels are i18n keys. CI's runtime probe
boots a real engine and asserts every `dataPath` actually resolves — a typo here
fails the build rather than shipping an empty table.

---

## 8. Expose a public (unauthenticated) route

Extension routes sit behind auth by default. Opt a specific one out:

```ts
ctx.registerPublicRoute({
  method: 'GET',
  path: '/share/:token',                 // absolute path on the global app
  handler: async (c) => {
    const row = await ctx.db.selectFrom('zvd_shares')
      .selectAll().where('token', '=', c.req.param('token')).executeTakeFirst();
    return row ? c.json(row) : c.json({ error: 'Not found' }, 404);
  },
});
```

Public means **the whole internet**. Validate the token, return only what that
token grants, and never echo internal ids you didn't intend to share.

---

## 9. Test an extension

`@zveltio/sdk/testing` gives you the seams — no live services needed:

```ts
import { createTestContext, mockDb } from '@zveltio/sdk/testing';
import extension from '../engine/index.js';
import { Hono } from 'hono';

const app = new Hono();
// mockDb presets are keyed by the QUERY CHAIN (suffix match), not the table name.
const ctx = createTestContext({
  db: mockDb({
    'selectFrom.zvd_widgets.selectAll.execute': [{ id: '1', name: 'a' }],
  }),
});
await extension.register(app, ctx);

const res = await app.request('/widgets');
expect(res.status).toBe(200);
```

Also available: `mockAuth`, `mockEventBus`, `mockServiceRegistry`, and
`withTestDb` for a real Postgres when you need one.

---

## 10. Publish to the registry

```bash
zveltio extension validate --dir <dir>   # manifest + schema + migration checks
zveltio extension pack --dir <dir>       # bundle + integrity hash
zveltio extension publish --dir <dir>    # validate, archive, sign, upload
```

The engine installs extensions from **registry.zveltio.com**, never from a repo
checkout. Publishing is what makes an extension installable.

**Isolation tier matters** (MARKETPLACE-POLICY.md §2): first-party/verified may run
inline; community extensions must declare `engine.isolation: "worker"`. Declare it
early — it changes how you're allowed to touch the process.

---

## Common mistakes

| Symptom | Cause |
| --- | --- |
| Your change doesn't take effect | Stale `engine/index.js` — re-run `zveltio extension pack`. |
| Every insert throws `invalid input syntax for type uuid: ""` | Missing `NULLIF(...)` in the tenant_id default (recipe 4). |
| SDUI table renders empty | `dataPath` doesn't match your response key (recipe 7). |
| Rows from other tenants appear | You used `ctx.adminDb`. Use `ctx.db`. |
| Typecheck explodes on `.execute(db)` | Your repo's kysely drifted from the engine's — pin them equal. |
