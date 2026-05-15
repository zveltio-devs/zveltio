# Zveltio Extension Developer Guide

> **Audience**: developers building extensions for the Zveltio Business OS.
>
> **Companion documents**:
> - [`EXTENSION-AUTHORING.md`](EXTENSION-AUTHORING.md) — contract reference (the
>   *what*).
> - [`REFACTORING-V1-PLAN.md`](REFACTORING-V1-PLAN.md) — platform roadmap (some
>   features described here land in v1.0).
>
> Sections marked **(v1.0)** describe APIs landing in the v1.0 sprint. Sections
> marked **(today)** describe what works in alpha.80. If you are starting an
> extension now, you can mix both — APIs are additive.

---

## Table of contents

1. [Mental model](#1-mental-model)
2. [Quick start](#2-quick-start)
3. [Anatomy of an extension](#3-anatomy-of-an-extension)
4. [The manifest](#4-the-manifest)
5. [Writing engine code](#5-writing-engine-code)
6. [Database access & migrations](#6-database-access--migrations)
7. [Hooks: pre-write, post-write, query-alter, entity-access](#7-hooks-pre-write-post-write-query-alter-entity-access)
8. [Services: publishing and consuming](#8-services-publishing-and-consuming)
9. [Cron jobs](#9-cron-jobs)
10. [Studio: pages, field types, form alters, slots](#10-studio-pages-field-types-form-alters-slots)
11. [Testing](#11-testing)
12. [Local development loop](#12-local-development-loop)
13. [Publishing](#13-publishing)
14. [Best practices & anti-patterns](#14-best-practices--anti-patterns)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Mental model

A Zveltio extension is a **plugin to a running engine process**. The engine
loads your code dynamically at startup (or on enable), calls your `register()`
function once, and hands you a context object (`ctx`) for accessing the
database, events, services, and DDL.

You are **not** writing a standalone server. You contribute routes, hooks,
field types, Studio pages, and scheduled jobs. The engine owns the HTTP
lifecycle, authentication, transactions, and observability.

The closest analogy is a **Drupal module**, but with TypeScript, native Bun
performance, and modern frontend (Svelte 5).

### Three contract surfaces

| Surface | What you contribute | API |
|---|---|---|
| **engine/** | Backend logic: routes, hooks, services, cron | `ZveltioExtension` from `@zveltio/sdk/extension` |
| **studio/** | Admin UI: pages, fields, form alters, slots | `@zveltio/sdk/studio` |
| **client/** | End-user UI components (published as separate npm) | published as `@yourorg/zveltio-ext-X` |

Any subset is valid. A backup extension may have only `engine/`. A custom
widget extension may have only `studio/`.

---

## 2. Quick start

### Prerequisites

- Bun 1.3+
- A running Zveltio engine (local or remote) with admin access
- `@zveltio/cli` installed: `bun add -g @zveltio/cli`

### Create a new extension

```bash
cd zveltio-extensions/
zveltio extension create my-feature --category content
# scaffolds at zveltio-extensions/content/my-feature/
```

What gets generated:
```
content/my-feature/
├── manifest.json
├── engine/
│   ├── index.ts
│   └── migrations/
│       └── 001_init.sql
├── studio/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── index.ts
│       └── pages/
│           └── MainPage.svelte
└── engine/tests/                    # (v1.0)
    └── example.test.ts              # (v1.0)
```

### Run in development

```bash
cd content/my-feature/
zveltio extension dev
# (v1.0) — watches both engine/ and studio/ with hot-reload
```

Open `http://localhost:3000/admin/my-feature` to see your Studio page.

---

## 3. Anatomy of an extension

```
<category>/<name>/
├── manifest.json          # metadata, dependencies, contributions
├── engine/
│   ├── index.ts           # default-exports ZveltioExtension
│   ├── routes.ts          # Hono route handlers (or split as you like)
│   ├── services.ts        # things you publish for other extensions
│   ├── hooks.ts           # pre/post-write event handlers
│   ├── lib/               # internal helpers
│   ├── migrations/
│   │   ├── 001_init.sql
│   │   └── 002_add_indexes.sql
│   └── tests/             # bun test, integration via withTestDb()
├── studio/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── index.ts       # registers routes, fields, form alters, slots
│       ├── pages/         # Svelte 5 pages
│       └── components/    # reusable components
└── client/                # (optional) end-user UI npm package
    └── ...
```

### Naming rules

- Folder path under `zveltio-extensions/` becomes the canonical extension
  name. `content/my-feature/` ↔ `manifest.name = "content/my-feature"`.
- The folder name (last segment) is what shows in URLs:
  `/ext/my-feature/...` (v1.0) or `/api/my-feature/...` (today).
- Tables your extension owns: `zv_<flat_name>_*` where `flat_name` is the
  full name with `/` replaced by `_`. So `content/my-feature` owns tables like
  `zv_content_my_feature_items`.

---

## 4. The manifest

Minimal valid manifest:

```json
{
  "name": "content/my-feature",
  "displayName": "My Feature",
  "category": "content",
  "description": "What this extension does, in one sentence.",
  "version": "1.0.0",
  "zveltioMinVersion": "1.0.0",
  "package": "@yourorg/zveltio-ext-my-feature",
  "permissions": ["database"],
  "contributes": {
    "engine": true,
    "studio": true
  }
}
```

### All fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Must match folder path. |
| `displayName` | string | yes | Shown in marketplace + Studio nav. |
| `category` | string | yes | One of: `auth`, `content`, `crm`, `finance`, `hr`, `operations`, `developer`, `compliance`, `communications`, `analytics`, `geospatial`, `ai`, `integrations`, `i18n`, `workflow`, `storage`, `ecommerce`, `projects`. |
| `description` | string | yes | One sentence. |
| `version` | semver | yes | Enforced strict semver. |
| `zveltioMinVersion` | semver | yes | Smallest engine version that works. |
| `zveltioMaxVersion` | semver | no | Optional upper bound. |
| `package` | string | yes | npm package name (if publishing client/). |
| `author` | string | no | "Your Name <email>". |
| `homepage` | string | no | URL. |
| `permissions` | string[] | no | Declarative — `database`, `settings`, `network`, `filesystem`. Used in marketplace UI. |
| `peerDependencies` | object | no | npm packages auto-installed. |
| `dependencies` | object[] | no | `[{ name: "other/extension", minVersion: "1.0.0" }]`. |
| `contributes.engine` | bool | no | `false` for UI-only extensions. |
| `contributes.studio` | bool | no | |
| `contributes.client` | bool | no | |
| `contributes.fieldTypes` | string[] | no | List of field type IDs registered. |
| `contributes.stepTypes` | string[] | no | For workflow steps. |
| `contributes.schedules` | string[] | no | Names of cron schedules declared. (v1.0) |
| `quotas.bundleSizeKbMax` | number | no | Default 50000. (v1.0) |
| `quotas.nodeModulesSizeMbMax` | number | no | Default 200. (v1.0) |
| `quotas.migrationsMax` | number | no | Default 100. (v1.0) |
| `signature` | object | no | Filled by `zveltio extension publish`. Do not edit by hand. (v1.0) |

---

## 5. Writing engine code

### The entry point

```typescript
// engine/index.ts
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { DB } from './.zveltio/db';  // (v1.0) generated by `zveltio extension types`
import { join } from 'path';
import { myFeatureRoutes } from './routes.js';
import { registerHooks } from './hooks.js';
import { registerServices } from './services.js';

const extension: ZveltioExtension<DB> = {
  name: 'content/my-feature',
  category: 'content',

  getMigrations() {
    return [
      join(import.meta.dir, 'migrations/001_init.sql'),
      join(import.meta.dir, 'migrations/002_add_indexes.sql'),
    ];
  },

  async register(app, ctx) {
    app.route('/items', myFeatureRoutes(ctx));
    registerHooks(ctx);
    registerServices(ctx);
  },

  schedules() {                     // (v1.0)
    return [{
      name: 'cleanup-stale',
      cron: '0 3 * * *',
      handler: async (ctx) => { /* ... */ },
    }];
  },

  async cleanup() {
    // Called on disable. Close connections, clear timers, etc.
  },
};

export default extension;
```

Key facts:

- `register()` is called **once per activation**. Do not register the same
  handler twice.
- `app` is a Hono router. (v1.0) it is a sub-app mounted under
  `/ext/<your-name>`. Today it is the main app — use unique paths.
- `ctx.db` is a `Kysely<DB>` (v1.0) or `any` (today).
- `cleanup()` is optional but recommended for any extension that holds
  resources (timers, sockets, file handles).

### Routes with Hono

```typescript
// engine/routes.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ExtensionContext } from '@zveltio/sdk/extension';

const ItemSchema = z.object({
  name: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

export function myFeatureRoutes(ctx: ExtensionContext) {
  const router = new Hono();

  router.get('/', async (c) => {
    const items = await ctx.db
      .selectFrom('zv_content_my_feature_items')
      .selectAll()
      .execute();
    return c.json({ items });
  });

  router.post('/', zValidator('json', ItemSchema), async (c) => {
    const data = c.req.valid('json');
    const row = await ctx.db
      .insertInto('zv_content_my_feature_items')
      .values({ ...data, created_at: new Date() })
      .returningAll()
      .executeTakeFirstOrThrow();
    return c.json({ item: row }, 201);
  });

  return router;
}
```

### Authentication

Every route handler receives `c.get('user')` with the authenticated user, or
nothing if the route is public. Mark routes public explicitly:

```typescript
router.get('/public-stats', { auth: false }, async (c) => { /* ... */ });
```

By default, all routes require auth. For admin-only:

```typescript
router.use('*', async (c, next) => {
  const user = c.get('user');
  if (!user.roles.includes('admin')) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return next();
});
```

For fine-grained per-record authorization, use [`entityAccess`](#hook_entity_access)
hooks instead of inline checks.

---

## 6. Database access & migrations

### Writing migrations

Migrations are plain SQL files numbered sequentially. Each file is one
migration. The engine wraps each file in a transaction.

```sql
-- migrations/001_init.sql

CREATE TABLE zv_content_my_feature_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_my_feature_items_name ON zv_content_my_feature_items (name);

-- DOWN
DROP TABLE IF EXISTS zv_content_my_feature_items;
```

The `-- DOWN` marker separates the UP and DOWN sections. The UP runs on
install; the DOWN runs on full uninstall (with `purgeData=true`) (v1.0).

### Table naming rules

| Prefix | Purpose | Who owns |
|---|---|---|
| `zv_<extname>_*` | Internal extension tables | Your extension only |
| `zvd_*` | User-facing data tables (collections) | All extensions can read; writes via DDLManager |
| `zv_*` (other prefixes) | System tables | Engine only — extensions **cannot** access |

The extension context proxy enforces this at runtime: `ctx.db.selectFrom('zv_secrets')`
throws.

### Reading user collections (`zvd_*`)

User data tables are accessible by any extension. Use `ctx.queryAlter` (v1.0)
to attach filters globally rather than inline.

### Modifying schema at runtime (DDL Manager)

If your extension creates user-facing collections dynamically (like
`forms`), use the DDL Manager:

```typescript
// (v1.0) import { DDLManager } from '@zveltio/sdk/ddl';
// (today) const { DDLManager } = await import('@zveltio/engine-ddl');

await ctx.DDLManager.createCollection({
  name: 'zvd_my_thing',
  fields: [
    { name: 'id', type: 'uuid', primary: true },
    { name: 'title', type: 'text', required: true },
  ],
});
```

This bypasses the static migration system — it creates tables on demand based
on user input. Necessary for any extension where the schema is user-defined.

### Generating types from migrations (v1.0)

```bash
zveltio extension types
```

Generates `.zveltio/db.d.ts` from your migrations. Add to `.gitignore`. Re-run
after every migration edit.

---

## 7. Hooks: pre-write, post-write, query-alter, entity-access

Hooks let you intercept and modify engine behavior. They are the most
powerful primitive in the extension contract.

### Pre-write hooks

Reject or transform writes **before** they hit the database. Use
`ctx.events.onBefore(...)` (note: **`onBefore`**, not `on` — pre-hooks are a
separate API because they are async and share a mutable payload).

```typescript
// engine/hooks.ts
import type { ExtensionContext } from '@zveltio/sdk/extension';

export function registerHooks(ctx: ExtensionContext) {
  ctx.events.onBefore('record.beforeInsert', async (e) => {
    if (e.collection !== 'contacts') return;

    // Reject
    if (typeof e.data.email !== 'string' || !e.data.email.includes('@')) {
      e.abort('Invalid email');
    }

    // Transform — subsequent hooks AND the data layer see the patched values
    e.mutate({
      email: (e.data.email as string).toLowerCase().trim(),
      created_via: 'api',
    });
  });

  ctx.events.onBefore('record.beforeUpdate', async (e) => {
    if (e.collection !== 'contacts') return;
    e.mutate({ updated_at: new Date().toISOString() });
  });

  ctx.events.onBefore('record.beforeDelete', async (e) => {
    if (e.collection !== 'contacts') return;
    // beforeDelete payload exposes the existing row via `e.record` and only
    // supports abort (no mutate — there's nothing to transform on a delete).
    if (e.record.protected) {
      e.abort('Cannot delete a protected contact');
    }
  });
}
```

Key semantics:
- Handlers run **sequentially in registration order** (extensions register
  hooks during `register()`, which runs in topological dependency order).
- `mutate(patch)` shallow-merges into the in-flight payload — for `beforeInsert`
  it targets `data`; for `beforeUpdate` it targets `patch`. Subsequent handlers
  see the merged result.
- `abort(reason)` throws `AbortHookError`. The data layer catches it and
  returns HTTP 422 `{ code: 'EXT_HOOK_ABORTED', reason }`. No row is written.
- A handler that throws anything other than `AbortHookError` becomes a 500.
- **Scope today**: single-record `POST/PUT/PATCH/DELETE /:collection[/:id]`
  are hooked. **Bulk endpoints** (`/:collection/bulk`) do not yet invoke
  pre-hooks — tracked as S2-02. Plan accordingly if your extension relies on
  bulk routes.

### Post-write hooks (today + v1.0)

React after the write committed.

```typescript
ctx.events.on('record.created', async (e) => {
  if (e.table === 'zvd_orders') {
    await sendOrderConfirmation(e.data);
  }
});
```

Failure in a post-write handler **does not** roll back the write. Use this
for side effects only (emails, webhooks, search indexing).

### Query alter

Attach `WHERE` clauses to queries against a table — globally, without
modifying any route handler.

```typescript
ctx.queryAlter.register({
  table: 'zvd_contacts',
  alter(qb, user) {
    if (user.isGod) return qb;
    return qb.where('tenant_id', '=', user.tenantId);
  },
});
```

Use cases:
- Tenant isolation.
- Soft-delete filtering (hide rows where `deleted_at IS NOT NULL`).
- GDPR / column-level redaction.

Ownership + lifecycle:
- Each `register({...})` call is automatically tagged with your extension's
  name. When your extension is disabled or hot-reloaded, all your alters
  are removed by the loader — you do not call `unregisterAll()` yourself
  unless you explicitly want to retract an alter at runtime.
- Multiple extensions can register alters for the same table; they chain
  in registration order.

**Scope today**:
- Applied to: single-record `GET /:collection/:id`, and the before-row reads
  inside PUT/PATCH/DELETE single-record handlers. This means a row hidden by
  your alter cannot be updated or deleted by guessing its ID.
- **NOT yet applied to** the main list endpoint `GET /:collection`
  (`dynamicSelect` uses raw SQL — full migration is a follow-up). Plan
  accordingly if your alter is the sole tenant-isolation mechanism: until
  the list endpoint is wired, also enforce isolation via RLS / Casbin /
  `getRlsFilters` for list responses.
- UPDATE / DELETE Kysely calls (the actual mutation step) don't yet receive
  the alter — they trust the `id` lookup which IS alter-filtered, so the
  net effect is the same in practice.

### Entity access

Per-record authorization beyond role-based. Use this when the access
decision depends on the row itself (owner, status, time of day) rather
than just the user's role.

```typescript
ctx.entityAccess.register({
  table: 'zvd_payroll',
  async check(record, user, op) {
    // op: 'view' | 'update' | 'delete'
    if (user.roles.includes('hr')) return 'allow';
    if (op === 'view' && record.user_id === user.id) return 'allow';
    return 'deny';
  },
});
```

Semantics:
- Any extension's `'deny'` blocks access (first deny wins, short-circuits).
- Default is `'allow'` — if no extension registers a check for a table,
  the standard role/RLS chain remains in charge.
- Checks may be async; the data layer awaits them.
- Cleanup on unload is automatic (scoped registration).

HTTP behavior in single-record routes:
- `GET /:collection/:id` returns **404** on deny (hides existence).
- `PUT/PATCH/DELETE /:collection/:id` returns **403** on deny (the
  client already knows the row exists from prior context).

**Scope today**:
- Enforced at single-record `GET`, `PUT`, `PATCH`, `DELETE`. Not yet at
  list endpoints — for filtering large lists, prefer `queryAlter`
  (cheaper, runs in SQL). Use `entityAccess` for the precise per-row
  gate on single-record operations.

---

## 8. Services: publishing and consuming

Inter-extension function calls. Drupal's services container.

### Publishing

```typescript
// engine/services.ts
export function registerServices(ctx: ExtensionContext) {
  ctx.services.register('contacts.lookup', async (email: string) => {
    return ctx.db
      .selectFrom('zvd_contacts')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();
  });

  ctx.services.register('contacts.search', async (query: string, limit = 20) => {
    return ctx.db
      .selectFrom('zvd_contacts')
      .selectAll()
      .where('name', 'ilike', `%${query}%`)
      .limit(limit)
      .execute();
  });
}
```

### Consuming

```typescript
// In another extension
const contact = await ctx.services.get('contacts.lookup')?.('jane@example.com');
if (!contact) return c.json({ error: 'Not found' }, 404);
```

### Best practices

- **Declare dependencies in manifest.** If you call `contacts.lookup`,
  add `{ "name": "crm/contacts", "minVersion": "1.0.0" }` to
  `dependencies`. The loader sorts topologically.
- **Use `services.get(name)` defensively** — it can return undefined if the
  provider is disabled. Handle gracefully or fail loudly.
- **Versioning**: when you change a service signature, bump your extension's
  `version` (major) and update consumers.

---

## 9. Cron jobs

Declare scheduled tasks directly on your extension. The engine's cron
runner picks them up after `register()` returns and polls every 30 s.

```typescript
const ext: ZveltioExtension<DB> = {
  name: 'communications/mail',
  category: 'communications',
  async register(app, ctx) { /* ... */ },
  schedules() {
    return [
      {
        name: 'send-daily-digest',
        // Specify ONE timing field:
        at: { hour: 8, minute: 0 },           // daily at 08:00 (server timezone)
        // intervalMs: 6 * 60 * 60 * 1000,    // …or every 6 hours
        retry: { maxAttempts: 3, backoffMs: 5000 },
        async handler(ctx, runId) {
          const recipients = await ctx.db.selectFrom('zvd_users')
            .selectAll()
            .where('digest_enabled', '=', true)
            .execute();

          for (const user of recipients) {
            await ctx.services.get('mail.send')?.({
              to: user.email,
              template: 'daily-digest',
              data: { /* ... */ },
            });
          }
        },
      },
    ];
  },
};
```

Timing options (pick ONE per schedule):
- **`intervalMs`** — re-runs every N milliseconds.
- **`at: { hour, minute }`** — runs once a day at HH:MM (server's local
  timezone).
- **`cron: 'expr'`** — reserved for cron-expression support. **Not yet
  supported** — schedules using it are logged as skipped at register
  time. Use `intervalMs` or `at` instead.

Retry policy:
- `retry.maxAttempts` (default 1): how many total attempts per fired run.
- `retry.backoffMs` (default 1000): delay between attempts.
- Intermediate failures → row in `zv_extension_schedule_runs` with
  `status='failed'`. Final failure → `status='dlq'` (admin can replay).

Persistence:
- Every fired run inserts a row in `zv_extension_schedule_runs`:
  `started_at`, `finished_at`, `status`, `attempt`, `error_message`. Query
  this table to audit / debug.

**Scope today** (deliberately limited):
- **Single-engine only.** Multiple engine replicas will each run the same
  schedule — distributed coordination is a follow-up.
- **`singleton: true`** on a schedule is accepted in the type but not yet
  enforced cross-instance.
- **OTel `trace_id`** is reserved in the table but the runner does not yet
  emit it.

Hot-reload:
- On `extension dev`, edited schedules are re-registered automatically when
  the extension reloads. The old entries are dropped first to avoid
  duplicates.

---

## 10. Studio: pages, field types, form alters, slots

### Pages

```typescript
// studio/src/index.ts
import { registerRoute } from '@zveltio/sdk/studio';
import MainPage from './pages/MainPage.svelte';
import DetailPage from './pages/DetailPage.svelte';

registerRoute({
  path: 'my-feature',
  component: MainPage,
  label: 'My Feature',
  icon: 'Layers',
  category: 'content',
});

registerRoute({
  path: 'my-feature/:id',
  component: DetailPage,
});
```

### Pages access engine API

```svelte
<!-- studio/src/pages/MainPage.svelte -->
<script lang="ts">
  import { useApi } from '@zveltio/sdk/studio';
  const api = useApi();

  let items = $state<any[]>([]);
  $effect(() => {
    api.get('/ext/my-feature/').then((r) => items = r.items);
  });
</script>

{#each items as item}
  <div>{item.name}</div>
{/each}
```

### Custom field types

```typescript
import { registerFieldType } from '@zveltio/sdk/studio';
import ColorPickerEditor from './fields/ColorPickerEditor.svelte';
import ColorPickerDisplay from './fields/ColorPickerDisplay.svelte';

registerFieldType({
  id: 'my-feature/color',
  label: 'Color',
  editor: ColorPickerEditor,
  display: ColorPickerDisplay,
  defaultValue: '#000000',
});
```

### Form alters (v1.0)

Modify built-in or other extensions' forms.

```typescript
import { registerFormAlter } from '@zveltio/sdk/studio';

registerFormAlter('core:user-edit', (form) => {
  form.addField({
    after: 'email',
    name: 'preferred_language',
    type: 'select',
    options: ['en', 'ro', 'fr'],
    label: 'Preferred language',
  });
  form.hideField('legacy_pin');
  form.addValidator('phone', (value) => {
    return value.startsWith('+') ? null : 'Must start with +';
  });
});
```

Well-known form IDs (incomplete list):
- `core:user-edit`
- `core:user-create`
- `core:collection-create`
- `core:collection-edit`
- `collection:<table>:edit` — generated per user collection

### Slots (v1.0)

Inject components into existing Studio pages.

```typescript
import { registerSlot } from '@zveltio/sdk/studio';
import RevenueWidget from './widgets/RevenueWidget.svelte';

registerSlot('dashboard.widgets', {
  component: RevenueWidget,
  priority: 10,
  visible: (ctx) => ctx.user.roles.includes('finance'),
});
```

Well-known slots:
- `dashboard.widgets`
- `collection-detail.header`
- `user-profile.sections`
- `settings.tabs`
- `sidebar.bottom`

---

## 11. Testing (v1.0)

### Unit tests

```typescript
// engine/tests/services.test.ts
import { test, expect } from 'bun:test';
import { createTestContext } from '@zveltio/sdk/testing';
import { registerServices } from '../services';

test('contacts.lookup returns the matching contact', async () => {
  const ctx = createTestContext({
    db: {
      selectFrom: () => ({ /* mock query builder */ }),
    },
  });

  registerServices(ctx);
  const lookup = ctx.services.get('contacts.lookup')!;
  const result = await lookup('jane@example.com');
  expect(result?.email).toBe('jane@example.com');
});
```

### Integration tests

```typescript
// engine/tests/routes.integration.test.ts
import { test, expect } from 'bun:test';
import { createTestApp, withTestDb } from '@zveltio/sdk/testing';
import extension from '../index';

test('POST /items creates an item', async () => {
  await withTestDb(async (db) => {
    const app = createTestApp(extension, { db });
    const res = await app.request('/ext/my-feature/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(res.status).toBe(201);
  });
});
```

`withTestDb` starts a fresh Postgres via testcontainers, runs your migrations,
yields the database, then rolls back.

### Running tests

```bash
bun test           # all tests
bun test --watch   # watch mode
bun test routes    # only files matching "routes"
```

---

## 12. Local development loop

### The `dev` command (v1.0)

```bash
cd zveltio-extensions/content/my-feature/
zveltio extension dev
```

This runs:
1. `bun --watch engine/index.ts` — restarts engine module on engine code
   change, signals `POST /__zveltio_dev_reload` to reload extension.
2. `cd studio && bun run dev` — Vite watch on Studio components.
3. HMR signaling between the two so a Studio component referencing new engine
   types picks up changes.

### Today's workaround (alpha.80)

Until `dev` is complete, the manual loop:

```bash
# Terminal 1: engine
cd packages/engine
bun --watch src/index.ts

# Terminal 2: Studio
cd packages/studio
bun run dev

# Terminal 3: extension Studio
cd zveltio-extensions/content/my-feature/studio
bun run dev
```

Symlink your extension into the engine's extensions directory if needed.

### Debugging

- Engine logs to stdout with OTel trace IDs. Match a trace across services in
  Grafana / Jaeger (if observability stack is up).
- Studio runs in the browser — open devtools. The `window.__zveltio_debug`
  object exposes the loaded extension list.
- Set `EXT_LOG_LEVEL=debug` for verbose extension loader output.

---

## 13. Publishing

### Pre-publish checklist

1. Run `zveltio extension validate` — must exit 0.
2. Bump `manifest.version` per semver.
3. Run tests: `bun test`.
4. Update your `README.md` and `CHANGELOG.md`.

### Publishing (v1.0)

```bash
zveltio extension publish
```

What happens:
1. Validates manifest + builds.
2. Generates ed25519 keypair at `~/.zveltio/keys/` if missing.
3. Tar-gzips the extension (excluding `node_modules`, `.zveltio`, `.git`,
   `dist`).
4. Signs the archive.
5. Uploads to `registry.zveltio.com` with your API token.

You need a developer account at `https://developer.zveltio.com` to get an API
token. First publish requires reviewing the auto-generated keypair (back it
up).

### Version policy

- **Patch**: bug fixes, no API change. Auto-approved.
- **Minor**: backwards-compatible additions. Auto-approved.
- **Major**: breaking changes. Manual review.

Republishing the same version is forbidden.

---

## 14. Best practices & anti-patterns

### Do

- **Declare manifest dependencies.** If you call another extension's service,
  list it. Topological load order saves headaches.
- **Use `ctx.db` (Kysely)** — types, parameter binding, refactoring safety.
- **Wrap your routes in a sub-router** before mounting, so `app.route(...)` is
  clean.
- **Use `cleanup()`** for any resource you hold.
- **Generate types** with `zveltio extension types` after every migration.
- **Use `ctx.services.get()` defensively** — providers may be disabled.
- **Write integration tests** for every route. Unit tests for hooks.
- **Bump version** before publishing.

### Don't

- **Don't use raw `sql\`...\``** unless you absolutely must. Kysely is type-safe;
  raw SQL is not, and it bypasses query-alter hooks.
- **Don't write to `zv_*` system tables.** The proxy blocks Kysely calls; raw
  SQL would work but is forbidden. Future engine versions will WASM-sandbox
  this.
- **Don't store secrets in `manifest.json`.** It is shipped to every installer.
  Use `zv_settings` (encrypted at rest).
- **Don't share state across `register()` calls.** It is called once but may
  be called again on hot-reload. Use `ctx`, not module-level globals.
- **Don't block the event loop.** Long sync work belongs in a cron job or
  background task.
- **Don't `setInterval`.** Use `schedules()` instead — observable, cancellable,
  singleton-safe.
- **Don't bundle Hono/Zod/Kysely.** They are shimmed by the engine — bundling
  them duplicates code and breaks identity checks. List them as
  `peerDependencies`.
- **Don't depend on `EXTENSIONS_DIR` paths.** Use `import.meta.dir` for files
  inside your extension.
- **Don't write Studio code that touches `window.__zveltio` directly.** Use
  `@zveltio/sdk/studio` imports (v1.0).

---

## 15. Troubleshooting

### "Extension failed to load: cannot find module 'X'"

Cause: a `peerDependency` you forgot to declare, or the engine's shim list
doesn't include the package.

Fix: add the package to `manifest.peerDependencies`. Re-install via the
marketplace UI or `POST /api/marketplace/<name>/install`.

### "Migration failed: relation already exists"

Cause: a previous install partially applied migrations and `zv_migrations`
doesn't reflect it.

Fix: in v1.0, transactional migrations prevent this. Today (alpha.80),
manually delete the offending table and try again, or `purgeData=true` on
uninstall.

### "Route returns 404 after enable"

Cause: Hono matcher was already built when your extension loaded; route
registration was deferred.

Fix: trigger a reload — `POST /api/marketplace/reload` (admin only). In
v1.0, sub-app mounting fixes this automatically.

### "ctx.db.selectFrom('zv_secrets') throws Forbidden"

Working as intended. Your extension cannot read system tables. If you genuinely
need cross-extension access to user tables, request it through a service
provided by the table owner.

### "Studio page is blank"

- Check the browser console for errors.
- Verify the Studio bundle built: look for `studio/dist/bundle.js`.
- Verify the registration succeeded: `console.log` in `studio/src/index.ts`
  and check it runs.

### "My event handler doesn't fire"

- Confirm the event name (typo check).
- Confirm the route triggering the event uses `writeWithHooks` (v1.0) — in
  alpha.80, only some routes emit events.
- Confirm your extension is enabled (`GET /api/marketplace`).

### "Schedule didn't run"

(v1.0)
- Check `zv_extension_schedule_runs` for entries with your schedule name.
- If `status='failed'`, check `error_message`.
- If no entries: confirm the schedule registered (logs at startup) and the
  cron expression is valid.

### Performance: my extension slows down requests

- Move synchronous work to a cron job.
- Profile with OTel traces — find the slow span.
- Check for N+1 queries — use `.execute()` for batches, not loops.
- Use Valkey for caching (`ctx.cache`).

---

## Appendix: minimal reference card

```typescript
// engine/index.ts
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { DB } from './.zveltio/db';

const ext: ZveltioExtension<DB> = {
  name: '<category>/<name>',
  category: '<category>',
  getMigrations() { return [/* paths */]; },
  async register(app, ctx) {
    // Routes
    app.get('/x', async (c) => c.json({ ok: true }));
    // Hooks
    ctx.events.on('record.beforeInsert', async (e) => { /* ... */ });
    // Services
    ctx.services.register('my.thing', async () => { /* ... */ });
    // Query alters
    ctx.queryAlter.register({ table: 'zvd_x', alter: (qb, u) => qb });
    // Entity access
    ctx.entityAccess.register({ table: 'zvd_x', check: async () => 'allow' });
  },
  schedules() {
    return [{ name: 'x', cron: '*/5 * * * *', handler: async () => {} }];
  },
  async cleanup() { /* ... */ },
};

export default ext;
```

```typescript
// studio/src/index.ts
import {
  registerRoute, registerFieldType, registerFormAlter, registerSlot,
  useApi, useAuth,
} from '@zveltio/sdk/studio';
import MainPage from './pages/MainPage.svelte';

registerRoute({ path: 'x', component: MainPage, label: 'X', icon: 'Box' });
registerFormAlter('core:user-edit', (form) => form.addField({ /* ... */ }));
registerSlot('dashboard.widgets', { component: MyWidget, priority: 5 });
```

---

*End of guide. Last updated: 2026-05-15.*
