# Zveltio Extension Developer Guide

> **Audience**: developers building extensions for the Zveltio Business OS.
>
> **Companion documents**:
> - [`EXTENSION-COOKBOOK.md`](EXTENSION-COOKBOOK.md) — **task-oriented recipes**
>   ("how do I send an email on insert?", "how do I add an admin page without
>   writing Svelte?"). Start here if you learn by doing; this guide is the
>   reference behind it.
> - [`EXTENSION-AUTHORING.md`](EXTENSION-AUTHORING.md) — contract reference (the
>   *what*).
> - [`REFACTORING-V1-PLAN.md`](REFACTORING-V1-PLAN.md) — platform roadmap (some
>   features described here land in v1.0).
>
> Sections marked **(v1.0)** describe APIs landing in the v1.0 sprint. Sections
> marked **(today)** describe what works in the current 3.0 beta line. If you are
> starting an extension now, you can mix both — APIs are additive.
>
> **Recent (3.0 betas):** extensions are delivered **from the registry on demand**
> (not bundled on disk); studio pages are **declarative SDUI** schemas (no per-host
> rebuild); **`ctx.db` is now tenant-scoped by default** (H-12) — cross-tenant
> access requires the `db:admin` permission + `ctx.adminDb`.

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
│   ├── pages/
│   │   └── +page.svelte          # tier-3 admin page (synced at release)
│   └── src/
│       ├── components/           # optional shared UI
│       └── contribute.ts.example # rename → contribute.ts for slot widgets
└── .github/workflows/ci.yml
```

No `studio/vite.config.ts`, `studio/package.json`, or `studio/dist/` — the v1
per-extension Studio bundle pipeline was removed in alpha.94 / beta.15.

### Run in development

```bash
# Terminal 1: keep the engine running. The dev command attaches to it; it
# does not start the engine itself.
cd packages/engine && bun run dev

# Terminal 2: watch your extension.
cd zveltio-extensions/content/my-feature
zveltio extension dev
```

`zveltio extension dev` does two things:

- **Engine watch**: per-file `fs.watch` over `engine/**/*.{ts,js,sql}`. On
  change, debounces 250ms and POSTs `{ name }` to
  `http://localhost:3000/__zveltio_dev_reload`. The engine drops the
  cached module + scoped state (services, queryAlter, entityAccess, cron)
  and re-imports with a cache-buster — your next request hits the new
  code without an engine restart.
- **Studio preview**: tier-3 pages and slot widgets are **compile-time copies**
  into the monorepo Studio (`packages/studio/scripts/sync-extensions.ts`), not
  a per-extension Vite dev server. From a sibling checkout:
  `cd packages/studio && bun scripts/sync-extensions.ts && bun run dev`, then
  open `/admin/my-feature`. Slot contributions need `studio/src/contribute.ts`
  (see [EXTENSION-AUTHORING.md](./EXTENSION-AUTHORING.md)). Legacy scaffolds
  that still ship `studio/package.json` get vite HMR here; new scaffolds do not.

Open `http://localhost:3000/admin/my-feature` to see your Studio page.

Flags:

```bash
zveltio extension dev --url http://localhost:3001    # custom engine URL
zveltio extension dev --name communications/mail     # if cwd lacks manifest
zveltio extension dev --no-studio                    # engine watch only
```

Limits (intentional):

- **The engine must already be running and have the extension active.**
  Reload re-imports the source; it doesn't enable a never-loaded
  extension. Toggle in Studio's `/admin/extensions` first.
- **Migration changes (SQL files under `engine/migrations/`) still need a
  reinstall.** The watcher only re-imports `engine/index.ts`. Add a new
  numbered migration file, then disable/enable the extension to apply it.
- **Endpoint is dev-only.** `POST /__zveltio_dev_reload` is skipped when
  `NODE_ENV=production`. If you see HTTP 404 from the dev probe, check
  the engine's env.

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
│   ├── pages/             # tier-3 SvelteKit routes (+page.svelte)
│   ├── schemas/           # SDUI JSON (manifest.studio.pages[].schema)
│   └── src/
│       ├── components/    # shared Svelte → $lib/ext/<name>/ after sync
│       └── contribute.ts  # optional slot widgets (Model 2.5)
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

Minimal valid manifest (v2 — what `zveltio extension pack` produces):

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
  },
  "engine": {
    "entry": "engine/index.js",
    "format": "esm",
    "target": "bun",
    "bundled": true,
    "bundlePeers": false,
    "isolation": "inline"
  },
  "integrity": {
    "engineSha256": "<filled by pack>"
  }
}
```

You don't write the `engine` and `integrity` blocks by hand — run
`zveltio extension pack` and the CLI bundles `engine/index.ts` → `engine/index.js`,
computes the SHA-256, and patches these blocks in place.

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
| `permissions` | string[] | no | **Enforced capabilities.** See §Capabilities below. Validated at load — an unknown value fails the manifest. |
| `publicRoutes` | string[] | no | Routes reachable WITHOUT a session, relative to the `/ext/<name>` mount (e.g. `["/webhook/twilio", "/public/*"]`). Everything else is fail-closed (401 for anonymous). `*` matches across `/`. See §5 "Authentication". |
| `peerDependencies` | object | no | Bundled INTO `engine/index.js` when `engine.bundlePeers: true`. The "install at enable time" model was retired in alpha.113 — bundling is the only path that works on the compiled binary. |
| `dependencies` | object[] | no | `[{ name: "other/extension", minVersion: "1.0.0" }]`. |
| `contributes.engine` | bool | no | `false` for UI-only extensions. |
| `contributes.studio` | bool | no | |
| `contributes.client` | bool | no | |
| `contributes.fieldTypes` | string[] | no | List of field type IDs registered. |
| `contributes.stepTypes` | string[] | no | For workflow steps. |
| `contributes.schedules` | string[] | no | Names of cron schedules declared. |
| `studio.navGroup` | string | no | Sidebar group: `business`, `finance`, `hr`, `compliance`, … |
| `studio.pages` | object[] | no | `[{ path, label, icon, schema? }]`. One entry per Studio page. |
| `studio.pages[].schema` | string | no | Path to a declarative page schema (e.g. `schemas/crm.json`), relative to the extension root. Present → the page renders from JSON (no `+page.svelte`, no per-host build). Absent → the page is a code `+page.svelte`. See §10. |
| `quotas.bundleSizeKbMax` | number | no | Default 50000. |
| `quotas.nodeModulesSizeMbMax` | number | no | Default 200. |
| `quotas.migrationsMax` | number | no | Default 100. |
| `engine.entry` | string | yes (v2) | Path to bundled JS. Default `engine/index.js`. |
| `engine.format` | `"esm"` | no | Always `esm`. |
| `engine.target` | `"bun" \| "node" \| "*"` | no | Default `"bun"`. |
| `engine.bundled` | bool | yes (v2) | Always `true` post-alpha.111. Bun compiled binary can't resolve bare specifiers at runtime, so deps must be bundled at pack time. |
| `engine.bundlePeers` | bool | no | Default `false`. Set `true` to inline the `peerDependencies` into the bundle. Required when the extension uses any peer dep — external peers don't work on the binary install. See alpha.113 in CHANGELOG. |
| `engine.isolation` | `"inline" \| "worker"` | no | Default `"inline"`. **`"worker"` is REQUIRED for community/third-party submissions** per MARKETPLACE-POLICY.md §2 — the loader hard-fails the enable otherwise. See §13.5 below for the trade-offs. |
| `integrity.engineSha256` | hex64 | yes (v2) | SHA-256 of `engine/index.js`. Filled by pack; engine refuses to load a bundle whose bytes don't match. |
| `integrity.archiveSha256` | hex64 | no | SHA-256 of the `.zvext` archive. Optional; the registry computes and stores this on upload. Engine verifies it against the `X-Archive-Sha256` response header at install time. |
| `signature` | object | no | Filled by `zveltio extension publish`. Do not edit by hand. |

### Capabilities

`permissions` is the capability list. Anything an extension can do that the host
has to mediate is named, declared, and enforced — in the engine, when it builds
your `ctx`, not inside your own code.

| Capability | Grants |
| --- | --- |
| `db:admin` | `ctx.adminDb` — the cross-tenant database handle. |
| `ddl` | `ctx.internals.enqueueDDLJob` — create/alter physical tables. |
| `secrets` | `encryptSecret` / `decryptSecret`. |
| `auth:session` | `createBetterAuthSession` — mint a session for any user. |
| `notifications` | `sendNotification`. |
| `files` | `extractTextFromFile`, `moveToTrash`, `scheduleFileIndexing`. |
| `documents` | `generatePDF`, `generatePDFAsync`, `renderTemplate`. |
| `edge-functions` | `runEdgeFunction`. |
| `introspection` | `introspectSchema`, `extensionRegistry`, `runQualityScan`. |
| `storage` | `ctx.config.objectStorage` — S3 settings **and credentials**. |
| `cron` | Register cron schedules. |
| `field-types` | Contribute engine-side field types. |
| `net:<host>` | One outbound destination, e.g. `net:api.stripe.com`. |

`database`, `settings` and `network` are accepted for backwards compatibility
and grant nothing. Prefer `net:<host>` over `network`: it makes the egress list
reviewable instead of a blanket claim.

Using an undeclared capability throws at the call site, naming what to add.

**Configuration.** Read `ctx.config`, not `process.env`. In-process, the
environment is the *engine's* — database credentials, the auth secret, the
field-encryption key — and reading it goes around this contract entirely. CI
rejects `process.env` and the authority-bearing `node:*` modules in extension
code.

Your own deployment settings arrive on `ctx.config.vars`: everything the
operator set as `ZVELTIO_EXT_<YOUR_NAME>_<KEY>`, with the prefix stripped, and
nothing else. `<YOUR_NAME>` is your extension name uppercased with `/` and `-`
replaced by `_`.

```ts
// operator sets ZVELTIO_EXT_SEARCH_MEILISEARCH_URL=http://meili:7700
const url = ctx.config.vars.MEILISEARCH_URL ?? 'http://localhost:7700';
```

Values are strings; coerce at the point of use, and treat a missing key as *not
configured* rather than defaulting to something that half-works. The object is
frozen, and another extension's keys are not in it.

Settings an **administrator** should be able to change at runtime do not belong
here — put those in a table in your own `zv_<name>_*` namespace and give them a
route, the way `ai` keeps providers in `zv_ai_providers`. `ctx.config.vars` is
for what the deployment decides, not what the tenant decides.

Secrets you need to store go through `ctx.internals.encryptSecret` /
`decryptSecret` under the `secrets` capability. Do not hold key material: the
host has the keys, and asking it to encrypt is the whole point of the
capability.

**Consent.** The manifest *asks*; an administrator *decides*. What was approved
is recorded at install, and a later version that declares more runs **without**
the additions until an admin approves them
(`POST /api/marketplace/<name>/approve-capabilities`). Widening your manifest is
not a way to widen your access. Installs predating consent tracking keep running
with what they declare.

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
- `ctx.db` is a `Kysely<DB>` (v1.0) or `any` (today). **It is TENANT-SCOPED
  (since H-12):** every query runs against the current request/job tenant's
  transaction, so the `zveltio.current_tenant` GUC is set and FORCE row-level
  security isolates your rows automatically. You no longer need `ctx.reqDb(c)`
  for isolation — `ctx.db` is safe by default in a request handler. Outside any
  tenant context (boot, migrations) it falls back to the global pool. `reqDb(c)`
  remains as an explicit equivalent for handlers that already pass `c`.
- **Cross-tenant access is opt-in via `ctx.adminDb`.** For legitimately global
  work (platform-wide reporting, backup) declare the **`db:admin`** permission
  in your manifest; the engine then hands you `ctx.adminDb` (the global pool).
  Without that permission any use of `ctx.adminDb` throws — so cross-tenant
  access is always visible at review + install time. See
  `MULTI-TENANT-ENABLEMENT.md` §5.
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

### Authentication — the fail-closed `/ext/*` gate

**Every route under `/ext/<your-extension>/*` requires an authenticated session
by default.** The engine mounts a fail-closed gate
(`middleware/extension-auth-gate.ts`) BEFORE your routes: an anonymous request to
any route you have not explicitly declared public gets `401` before it ever
reaches your handler. So a route you forget to guard is *safe by omission*, not
*exposed by omission* — the inverse of the old model, where a missing check
silently exposed the route (real holes shipped that way).

Inside a handler you can read `c.get('user')` (the gate sets it after a
successful session check).

**To make a route public**, declare it in your `manifest.json` `publicRoutes`,
relative to your mount. Only these bypass the gate:

```jsonc
{
  "name": "sms",
  "publicRoutes": [
    "/webhook/twilio"     // exact route
    // "/public/*"        // everything under /public/  (* matches across '/')
    // "/cms", "/cms/*"   // the mount root AND everything below it
  ]
}
```

A route that is public-*entry* but authorizes internally (e.g. a webhook that
verifies an HMAC, or a GraphQL endpoint that allows some queries anonymously) is
declared here too — the gate only enforces **authentication**, never
authorization. Keep your HMAC / token check in the handler.

> **Gotcha — the guard runs on the FULL path.** Inside a `subapp`-mounted
> extension, `c.req.path` is the full `/ext/<name>/…`, NOT the mount-relative
> path. A hand-rolled `if (c.req.path.startsWith('/public/'))` exemption will
> never fire. Prefer declaring `publicRoutes` in the manifest; if you must check
> in code, match the `/public/` segment anywhere (`c.req.path.includes('/public/')`).

**Authorization** (who may do what) is still yours. Use
[`permissionGate(ctx, '<name>')`](#) for route-level RBAC, and
[`entityAccess`](#hook_entity_access) hooks for per-record checks:

```typescript
// after the gate has authenticated, enforce a role/permission:
app.use('*', permissionGate(ctx, 'my-extension'));
```

**Escape hatches.** Routes mounted on the global app via
`ctx.registerPublicRoute` (CDN links, user-deployed webhooks) live outside
`/ext/*` and the gate — they are public by construction; guard them yourself. An
operator can disable the gate entirely with `ZVELTIO_EXT_AUTH_GATE=0` (an
availability valve — leave it on).

**CI enforces this.** `scripts/probe-ext-auth.ts` boots a live engine and asserts
every declared `publicRoutes` entry is actually reachable anonymously and that a
non-declared path is `401`. A forgotten declaration or a regressed gate fails the
`runtime-probe` job.

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

### `-- NO TRANSACTION`

Your pending migrations normally run as **one transaction**: the extension
either installs or it does not, with nothing half-applied in between. Keep it
that way unless you have the specific problem below.

The problem is adding an index to a table that already has rows — a migration
you ship in version 4 for a table created in version 1. `CREATE INDEX` locks
that table against writes for the length of the build, which is nothing on a
small table and an outage on a customer's `zvd_invoices`. The fix is
`CONCURRENTLY`, and Postgres refuses that inside a transaction block.

Mark such a migration and it runs on its own, outside the transaction:

```sql
-- NO TRANSACTION
DROP INDEX IF EXISTS idx_my_items_name;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_my_items_name
  ON zv_content_my_feature_items (name);
```

Migrations before and after it still batch into their own transactions — the
chain is cut, not abandoned.

Three things this costs you, all of them consequences of the same fact:

- **Nothing rolls back.** If the third of five statements fails, the first two
  stay. Write every statement so it survives running twice; the migration is
  only recorded once all of it succeeds, so a failed run is retried whole.
- **Earlier segments are already committed** when a later one fails. An
  extension can end up on an intermediate version and must be able to reach the
  next one from there.
- **A failed `CONCURRENTLY` leaves an INVALID index behind**, and
  `IF NOT EXISTS` will happily skip re-creating it. That is why the example
  drops first.

Index at creation time while the table is empty whenever you can. This marker
is for the case where you no longer can.

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

### Generating types from migrations

```bash
zveltio extension types
```

Generates `.zveltio/db.d.ts` from your `engine/migrations/*.sql` files. The
output is a Kysely-friendly `export interface ExtensionSchema { ... }` with
one entry per `CREATE TABLE` you've declared, columns mapped to TypeScript:

```typescript
// .zveltio/db.d.ts  (auto-generated — do not edit)
export interface ExtensionSchema {
  zv_my_items: {
    id: string;                       // UUID
    name: string;                     // TEXT
    metadata: Record<string, unknown>; // JSONB
    created_at: Date;                 // TIMESTAMPTZ
  };
}
```

Add `.zveltio/` to your `.gitignore` (the monorepo's `.gitignore` already
covers it). Re-run after every migration edit.

#### Wiring the types into your extension

Pass the schema as a generic to `ZveltioExtension<DB>`. The engine threads
it through `ctx.db: Kysely<DB>` so `selectFrom(...)` autocompletes table +
column names and `tsc` flags typos:

```typescript
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { ExtensionSchema as DB } from './.zveltio/db.js';
import { join } from 'path';
import { myFeatureRoutes } from './routes.js';

const extension: ZveltioExtension<DB> = {
  name: 'category/name',
  category: 'category',
  mountStrategy: 'subapp',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_init.sql')];
  },

  async register(app, ctx) {
    // ctx.db is Kysely<DB>. The table name is checked against your schema.
    const rows = await ctx.db
      .selectFrom('zv_my_items')
      .select(['id', 'name'])
      .execute();

    app.route('/', myFeatureRoutes(ctx));
  },
};

export default extension;
```

Migrating an existing extension to typed `ctx.db` is opt-in — the default
`DB = any` means extensions that don't pass a generic keep compiling
exactly as before.

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

**Hook scope** — what triggers pre-hooks:

| Source | beforeInsert | beforeUpdate | beforeDelete |
|---|---|---|---|
| `POST /:collection` (HTTP) | ✓ | — | — |
| `PUT/PATCH/DELETE /:collection/:id` (HTTP) | — | ✓ / ✓ / ✓ | ✓ |
| `POST /:collection/bulk` etc. (HTTP) | per-row ✓ | per-row ✓ | per-row ✓ |
| `ctx.db.insertInto('zvd_*').values(...).execute()` | ✓ | — | — |
| `ctx.db.updateTable('zvd_*').set(...).where('id', '=', X).execute()` | — | ✓ | — |
| `ctx.db.deleteFrom('zvd_*').where('id', '=', X).execute()` | — | — | ✓ |
| `ctx.db.updateTable/deleteFrom` with bulk WHERE | — | skip + warn | skip + warn |
| Raw ``ctx.db.executeQuery(sql`...`)`` | — | — | — |

For extension-internal writes, the hook payload's `userId` is set to
`system:<your-extension-name>` so post-write hooks can tell user-driven
changes from extension-driven ones.

**Why bulk updates/deletes skip hooks**: a `WHERE tenant_id = X` may touch
thousands of rows. Firing per-row hooks would be slow and surprising
(rows that didn't exist when the hook author wrote the rule could match).
Pre-fetch ids in a `selectFrom` and loop with single-row writes if you
need per-row semantics.

**Raw SQL bypasses hooks**: ``ctx.db.executeQuery(sql`INSERT INTO ...`)``
goes around the Kysely builder and so around the hook layer. Use the
Kysely builder for hooked writes.

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

There are **two ways** to ship an extension's Studio UI. Pick by the shape of
the page:

| | Declarative (SDUI schema) — **preferred** | Code page (bespoke) |
|---|---|---|
| You ship | `studio/schemas/<slug>.json` | `studio/pages/**/+page.svelte` |
| Rendered by | trusted generic host components | your compiled Svelte |
| Install cost | **zero build toolchain** (data, not code) | Studio rebuild / release-time bake |
| Use for | list+form, multi-tab, settings, cards, master-detail | editors, canvases, maps, kanban, chat, file browsers, live timers, composers |

Most CRUD/settings pages are declarative. Reach for a code page only when the UI
needs a genuinely bespoke widget the schema vocabulary can't express.

### The page belongs to the extension

Whichever form you pick, the page lives in the extension and is declared in its
manifest. The engine must not carry a hand-written page for an extension
feature, for a reason that is easy to state and was learned the hard way: an
extension is optional, so anything the engine holds on its behalf ships to
people who will never install it — and, worse, becomes a second implementation
that drifts.

`scripts/check-extension-page-ownership.ts` enforces this. It allows exactly one
thing in `packages/studio/src/routes/(admin)` that talks to `/ext/*`: a
**generated snapshot**, byte-identical to the extension page it came from.
`scripts/sync-extensions.ts` produces it, and it is committed so a release build
— which has no `zveltio-extensions` sibling — still ships a working admin.

Anything else is one of three faults, and the gate names which:

- **ORPHAN** — no extension declares this path. Somebody wrote an extension's UI
  in the engine, or the extension declares a different path and this is a second
  route for the same feature.
- **STALE** — the snapshot has fallen behind its source. Until it is synced the
  engine ships an older screen than the extension does. This is not theoretical:
  the media library's committed copy drifted onto i18n keys belonging to
  `storage/cloud` and `communications/mail`.
- **SHADOWS** — the extension ships a declarative schema for this path and a code
  page sits on top of it. The schema never renders, and nobody maintaining it can
  tell.

Two routes for one feature is the failure this prevents. BYOD had exactly that:
a 223-line page in the engine at `/introspect`, a `/byod` route redirecting to
it, and an extension page calling endpoints that did not exist. The engine's
copy was the only working one, and the extension's had been broken since it
shipped, because nothing looked.

### Declarative pages (SDUI schema) — preferred

An extension page is a JSON file referenced from the manifest. The engine inlines
it into `/api/extensions` at load (`embedPageSchemas`), and the Studio catch-all
route renders it with `SchemaPage`/`SettingsPage` — **no per-host build, no
third-party JS in the admin**.

**1. Author** `studio/schemas/<slug>.json`. Two archetypes:

```jsonc
// list + form (PageSchema). One resource → a single table; many → tabs.
{
  "sduiSchema": 1,
  "title": "crm.title",                 // i18n key (resolved via m[key]()) or literal
  "subtitle": "crm.subtitle",
  "newLabel": "common.new",             // header "+ New" button → opens active resource's form
  "resources": [
    {
      "id": "contacts",
      "label": "crm.tab.contacts",
      "icon": "Users",
      "dataSource": "/ext/crm/contacts",  // GET; array read from dataPath
      "dataPath": "data",
      "search": { "fields": ["first_name", "email"] },   // client-side; or { "param": "q" } server-side
      "columns": [
        { "key": "first_name", "label": "crm.col.name", "join": { "keys": ["first_name", "last_name"], "sep": " " } },
        { "key": "email", "label": "crm.col.email" },
        { "key": "status", "label": "common.col.status", "type": "badge",
          "badge": { "colors": { "active": "badge-success" }, "labels": { "active": "crm.status.active" } } },
        { "key": "value", "label": "crm.col.value", "type": "currency", "currency": { "codeKey": "currency" } }
      ],
      "rowActions": [
        { "id": "delete", "icon": "Trash2", "variant": "text-error", "label": "common.delete",
          "method": "DELETE", "endpoint": "/ext/crm/contacts/{id}", "confirm": "ext.confirmDelete" }
      ],
      "form": {
        "endpoint": "/ext/crm/contacts",
        "fields": [
          { "name": "first_name", "label": "crm.form.firstName", "required": true, "colSpan": 1 },
          { "name": "email", "label": "crm.col.email", "type": "email", "colSpan": 1 }
        ]
      }
    }
  ]
}
```

```jsonc
// settings (SettingsSchema) — a singleton config page, not a list.
{
  "kind": "settings",
  "sduiSchema": 1,
  "title": "auth.saml.title",
  "dataSource": "/ext/auth/saml/config",   // GET the config object
  "dataPath": "config",
  "saveEndpoint": "/ext/auth/saml/config",  // POST to save
  "info": [                                  // read-only rows w/ copy button; {ENGINE_URL} token
    { "label": "auth.saml.ui.sp_metadata_url", "value": "{ENGINE_URL}/ext/auth/saml/metadata" }
  ],
  "sections": [
    { "title": "auth.saml.section.idp", "fields": [
      { "name": "enabled", "label": "auth.saml.enable", "type": "boolean", "colSpan": 2 },
      { "name": "cert", "label": "auth.saml.ui.cert", "type": "textarea", "rows": 5, "mono": true, "colSpan": 2 }
    ] }
  ],
  "actions": [ { "id": "test", "label": "auth.ldap.testConnection", "endpoint": "/ext/auth/ldap/test" } ]
}
```

**2. Reference it** from `manifest.json`:

```jsonc
"studio": {
  "navGroup": "business",
  "pages": [
    { "path": "/admin/crm", "label": "CRM", "icon": "Users", "schema": "schemas/crm.json" }
  ]
}
```

**3. Don't ship a `+page.svelte`** for that slug — the catch-all route owns it.
Schemas live in `studio/schemas/` (not `studio/pages/`), so the sync step ignores
them automatically.

**Vocabulary** (full source of truth: [`packages/studio/src/lib/sdui/types.ts`](../packages/studio/src/lib/sdui/types.ts)):
- **Resources**: single or multi-tab; per-resource `dataSource`/`dataPath`/`search`/`filters`/`pagination`/`stats`.
- **Columns** `type`: `text` · `mono` · `date` · `currency` (`code` or `codeKey`) · `badge` (`colors`+`labels`) · `relation` (id→label from another endpoint) · `boolean` (✓/—). Plus `secondary` (two-line cell), `join`, `template` (`{ENGINE_URL}`/`{field}` tokens), `classWhen` (conditional CSS), `editable` (inline select/text PATCH on change).
- **Row/detail actions**: `kind` `call`|`edit`|`download` (opens cookie-authed endpoint in a new tab), `method`, `endpoint` (`{id}`/`{field}` tokens), `visibleWhen`, `confirm`, `body` (`{field}` tokens, `{a-b}` subtraction).
- **Form fields** `type`: text/email/tel/number/date/select/relation/boolean/password/textarea/json/file. Plus `required`, `colSpan` (1|2), `default` (incl. `"today"`), `placeholder`, `options`, `relation`, `visibleWhen` (conditional fields), `accept` (file).
- **Form `submit`**: default = JSON POST/PATCH; `{ "kind": "download" }` = GET endpoint → querystring → new tab; `{ "kind": "upload" }` = multipart POST. Escape hatches: `repeatable` (line items) + `computed` (sums).
- **Layouts**: `layout: "cards"` (+`card:{title,badge,subtitle}`); `master` (+`detailActions`) = left selector list → detail table templated `{masterId}`.
- **Stats**: KPI tiles above the table.

i18n: every string is an `m[key]()` lookup with literal fallback — same Paraglide
keys as code pages (see i18n note below). A malformed/future-version schema renders
a friendly error panel (see `validateSchema`), never a white screen.

### Code pages (bespoke / Tier-3) + i18n

For UIs the schema can't express (editors, canvases, maps, kanban, AI chat, file
browsers, live timers, message composers), ship `studio/pages/+page.svelte` under
the extension repo. At install/sync time these are copied into Studio's route tree
(`packages/studio/src/routes/(admin)/…`). In page code, import Studio libs
via `$lib/…` (same as core pages).

**All user-visible strings must use Paraglide** — see [§10.5 Translating your
extension](#105-translating-your-extension) for the rules, the shared vocabulary
and what `validate` enforces.

**Layout:** use `ExtensionPageShell`, `ExtensionDataPanel`, and `ConfirmModal`
instead of ad-hoc headers / `confirm()`. See
`packages/studio/src/lib/components/extension/README.md`.

**Sidebar grouping:** set `studio.navGroup` in `manifest.json` (`business`,
`finance`, `hr`, …). Extension labels in the nav come from the manifest
`displayName` / page `label` (not translated).

### Pages

Tier-3 pages live under **`studio/pages/`** and become real SvelteKit routes
after `sync-extensions` copies them into `packages/studio/src/routes/(admin)/…`.
Declare the URL in `manifest.studio.pages[].path` (e.g. `/admin/my-feature`).

```svelte
<!-- studio/pages/+page.svelte -->
<script lang="ts">
  import { api } from '$lib/api.js';

  let items = $state<unknown[]>([]);
  $effect(() => {
    api.get('/ext/content/my-feature/items').then((r) => {
      items = r.items ?? [];
    });
  });
</script>

{#each items as item}
  <div>{item.name}</div>
{/each}
```

Prefer **SDUI** (`manifest.studio.pages[].schema` → JSON under `studio/schemas/`)
when the UI is CRUD-shaped — zero Studio build, same delivery model as first-party
extensions. See [EXTENSION-AUTHORING.md](./EXTENSION-AUTHORING.md).

**Do not** use `registerRoute()` from a runtime bundle — that was the removed v1
IIFE path (`studio/dist/bundle.js`, deleted beta.15).

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

### Form alters (S3-02)

Mutate any registered Studio form before it renders. Same shape as
Drupal's `hook_form_alter`.

```typescript
import { registerFormAlter } from '@zveltio/sdk/studio';

registerFormAlter('core:user-edit', (form, ctx) => {
  // Add a field after an existing one. Anchor by name.
  form.addField({
    after: 'email',
    field: {
      name: 'preferred_language',
      type: 'select',
      options: ['en', 'ro', 'fr'],
      label: 'Preferred language',
    },
  });
  // Hide without removing — server-side defaults still apply.
  form.hideField('legacy_pin');
  // Append a validator. Return null if valid, an error string otherwise.
  form.addValidator('phone', (value) => {
    return typeof value === 'string' && value.startsWith('+') ? null : 'Must start with +';
  });
  // Move fields to the front of the form.
  form.reorder(['name', 'email']);
});
```

Hooks receive `(form, ctx)`. `ctx` is whatever the form host passes —
typically `{ user, mode }`. Throwing hooks are isolated: the rest still
run. Multiple alters on the same form id run in registration order, so
two extensions can layer changes.

Well-known form IDs (live — extension hooks fire against these):
- `core:user-invite` — admin "Invite User" modal

More core forms wire through SchemaForm incrementally. Until your target
form is migrated, the hook is harmless (registers fine, just never fires).

> Form-alter only works on forms whose renderer is built on
> `<SchemaForm formId="..." schema={...} bind:values />`. SchemaForm
> calls `studioApi.applyFormAlters(formId, schema, ctx)` internally.
> Custom hand-rolled forms can opt in by calling
> `studioApi.applyFormAlters` themselves before rendering their field
> list.

### Slots (S3-03)

Inject components into named composition points scattered through
Studio. Slot hosts declare a slot once with `<Slot name="...">`;
extensions fill it via **`studio/src/contribute.ts`** (compile-time sync —
not a runtime bundle).

```typescript
// studio/src/contribute.ts — synced to $lib/ext/<name>/contribute.ts
import { registerContributionSlot } from '$lib/extension-api.svelte.js';
import RevenueWidget from './components/RevenueWidget.svelte';

const OWNER = 'content/my-feature'; // manifest.name

export function activate(): void {
  registerContributionSlot(OWNER, 'dashboard.widgets', {
    component: RevenueWidget,
    priority: 10,
    visible: (ctx) => Array.isArray((ctx.user as { roles?: string[] })?.roles)
      && ctx.user.roles.includes('finance'),
    props: { initialRange: '30d' },
  });
}
```

List targeted slots in `manifest.contributes.slots` (metadata). The admin
layout loads `activate()` only when the extension is **enabled**.

`@zveltio/sdk/studio` still exports **`sortSlotContributions`**, form-alter
helpers, and **`SlotContribution`** types for unit tests — not the compile-time
registration entry point above.

The component receives `props` AND any keys the host passes as `ctx`.
For `dashboard.widgets` the host passes `{ user }`, so the widget can
declare `let { user, initialRange } = $props()`.

If no extension targets the slot the markup collapses to nothing —
hosts can declare slots liberally without empty-state worries.

Well-known slots (live):
- `dashboard.widgets` — top of the admin dashboard. `ctx: { user }`.
- `dashboard.hero` — featured area above the stat cards (e.g. AI greeting,
  what-changed feed). `ctx: { user, stats }`.
- `dashboard.suggestions` — below the stat cards (recommendations, anomaly
  alerts). `ctx: { user, stats, collections }`.
- `sidebar.bottom` — admin sidebar, above the footer. `ctx: { user, collapsed }`.
- `topbar.left` / `topbar.center` / `topbar.right` — slim top-bar above
  `<main>`. Desktop top-bar **renders only** when one of these slots has
  content (otherwise no chrome cost). Mobile header always renders and
  embeds these slots inline. `ctx: { user, viewport: 'mobile' | 'desktop' }`.
- `page.assist` — floating-position slot inside every `<main>` for FAB-style
  contextual assistants. `ctx: { user, pathname }`.
- `settings.tabs` — Settings page tab bar (extension tabs render after core).
  `ctx: { user, activeTab }`.
- `account.sections` — `/admin/account` page sections. `ctx: { user }`.
- `collection-detail.header` — under the collection name on
  `/admin/collections/<name>`. `ctx: { user, collection }`.
- `collection-detail.actions` — next to the header primary action.
  `ctx: { user, collection, activeTab }`.

**For first-class integrations** (the `ai` extension, observability
dashboards, etc.), prefer these slots over routing into a separate page
— they bring extension UX into the user's existing flow rather than
making them context-switch.

> Slot hosts are added incrementally. Adding one is a one-line change in
> the host page (`<Slot name="..." ctx={...} />`). The list above grows
> as core pages adopt the pattern.

### 10.5. Translating your extension

Zveltio ships **nine locales** — `en`, `ro`, `fr`, `de`, `es`, `it`, `nl`, `pl`,
`hu` — and the Studio is fully translated in all of them. An extension that
ships English-only text is visibly a bolt-on, so `zveltio extension validate`
checks this and CI runs it.

#### Where the keys live

```
your-extension/
  studio/
    messages/
      en.json   ro.json   fr.json   de.json   es.json
      it.json   nl.json   pl.json   hu.json
```

One file per locale, **all nine, with identical key sets**. `en` is the source
of truth for which keys exist. Namespace your keys with your extension id,
dotted: `finance/quotes` → `finance.quotes.*`.

```json
{
  "finance.quotes.title": "Quotes",
  "finance.quotes.form.validUntil": "Valid until"
}
```

Studio merges every extension's catalogue with its own at build time
(`bun run i18n:compile` in `packages/studio`).

#### Three rules, and the reason for each

**1. Reuse the shared vocabulary instead of minting a key.** `common.*` and
`ext.*` are the host's generic words — Save, Cancel, Status, Name, Price,
Currency, "Delete this item?" — and you may use them without shipping them.
Nobody needs a thirtieth private key for "Save". The full list is
[`packages/sdk/src/validate/shared-message-keys.ts`](../packages/sdk/src/validate/shared-message-keys.ts);
if a genuinely generic word is missing, add it to `messages/core/` in the host
rather than privately.

**2. Never use another extension's keys.** `crm.form.currency` resolves on your
machine because the Studio bundle is the union of every installed extension. Ship
your extension to a host without `crm` and the user sees the raw key. If you
genuinely depend on another extension, declare it in `manifest.dependencies` —
then its keys are legitimately yours to use, the same rule the endpoint check
already applies.

**3. Never rely on the host's core catalogue for your own text.** An extension
whose translations live in the host renders correctly only on a host that already
knows about it. That is not a property an installable extension can have, and it
is fatal for a third-party one.

#### Declarative (SDUI) pages

In a schema, every user-visible string **is a key**. `title`, `subtitle`,
`label`, `placeholder`, `note`, `confirm`, `description`, `emptyText`,
`emptyTitle` and `hint` are resolved against the bundle:

```json
{ "name": "bindDN", "label": "auth.ldap.ui.bind_dn", "type": "text" }
```

The host falls back to rendering the string literally when a key is unknown, so a
typo is silent — the user just sees `auth.ldap.ui.bnid_dn` in the form. This is
exactly why the validator checks schemas: they are data, so every slot can be
verified precisely, with no source parsing and no guessing at what is prose.

#### What `validate` reports

| | |
|---|---|
| `SDUI_I18N_KEY_MISSING` | **Error.** A key-shaped string that resolves in neither your catalogue, the shared vocabulary, nor a declared dependency. The user sees the raw key. |
| `SDUI_I18N_HARDCODED` | **Warning.** Prose sitting in a slot instead of a key — it stays English in the other eight locales. |

Literals are legitimate for things that do not translate: protocol tokens
(`JSON`, `CSV`), code samples (`status=active`, a PEM block), and vendor names
(`Notion`, `Okta`). Vendor names are a curated list in the validator, because
nothing can tell `Notion` from `Furniture` automatically — send a PR to add one.

```bash
zveltio extension validate --dir path/to/your-extension
```

#### Two things that catch people out

**Untranslated does not mean English.** Several extensions shipped hardcoded
*Romanian* — `Proces Verbal`, `Alocat:`, `TVA 19%` — which a French operator saw
as Romanian. If you sweep for untranslated text by looking for English prose, you
will walk straight past it.

**Don't put literal braces in a message.** Paraglide reads `{…}` as a parameter,
so `"Hello {{record.name}}"` breaks. Pass the token as a parameter instead:

```svelte
{m['flowEdit.emailBodyPh']({ token: '{{record.name}}' })}
```

---

## 11. Testing

`@zveltio/sdk/testing` provides four primitives — enough to write meaningful
unit tests for your extension without a real Postgres or auth setup:

- `createTestContext(overrides?)` — a fake `ExtensionContext` with sensible
  defaults (recording mock db, signed-in test user, no-op event bus, scoped
  registries). Override any field per test.
- `createTestApp(extension, opts?)` — spins up a Hono with your extension's
  `register()` called against it. Honors `mountStrategy`.
- `mockDb(presets?)` — proxy that records every method chain. Terminal calls
  (`.execute`, `.executeTakeFirst`, `.executeTakeFirstOrThrow`) return your
  presets or `[]` / `undefined`.
- `mockEventBus`, `mockServiceRegistry`, `mockAuth` — composable building
  blocks if you don't want the full `createTestContext`.

### Unit tests

```typescript
import { test, expect } from 'bun:test';
import { createTestContext, createTestApp, mockDb } from '@zveltio/sdk/testing';
import extension from '../index.js';

test('GET / lists items', async () => {
  // Preset the db response. Chain captures METHOD names only; args are
  // not part of the key. Use suffix matches or function presets if you
  // need argument-based differentiation.
  const db = mockDb({
    'selectFrom.selectAll.execute': [
      { id: '1', name: 'A' },
      { id: '2', name: 'B' },
    ],
  });

  const ctx = createTestContext({ db });
  const app = await createTestApp(extension, { ctx, mountSubappAt: false });

  const res = await app.request('/');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.items).toHaveLength(2);
});

test('POST aborts when an extension hook says no', async () => {
  const ctx = createTestContext();
  // Wire a pre-write hook from outside the extension to verify the
  // extension propagates it correctly.
  (ctx.events as any).onBefore('record.beforeInsert', (e: any) => {
    e.abort('not allowed in tests');
  });

  const app = await createTestApp(extension, { ctx, mountSubappAt: false });
  const res = await app.request('/', { method: 'POST', body: '{}' });
  expect(res.status).toBe(422);
});
```

### Verifying side effects

`mockDb` records every chain call. Use that to assert your extension hits
the database with the expected shape:

```typescript
test('writes go through the dynamicInsert path', async () => {
  const db = mockDb();
  const ctx = createTestContext({ db });
  const app = await createTestApp(extension, { ctx, mountSubappAt: false });

  await app.request('/', { method: 'POST', body: JSON.stringify({ name: 'x' }) });

  const inserts = db.calls.filter((c) => c.chain.includes('insertInto'));
  expect(inserts.length).toBeGreaterThan(0);
});
```

### Custom user / auth

```typescript
import { createTestContext, mockAuth } from '@zveltio/sdk/testing';

const ctx = createTestContext({
  auth: mockAuth({ user: { id: 'alice', roles: ['admin'] } }),
});
// ctx.auth.api.getSession() returns { user: alice }.
// ctx.checkPermission always returns true in the default mock — override
// via createTestContext({ extra: { checkPermission: async () => false } })
// if you want to test the denial path.
```

### Integration tests (real Postgres)

For end-to-end coverage against actual SQL, use `withTestDb` to spin up
a real Postgres container via `@testcontainers/postgresql`.

```bash
bun add -d @testcontainers/postgresql pg @types/pg
```

The `withTestDb` callback receives a fresh Kysely instance against an
empty database — apply your migrations, run your assertions, the
wrapper tears the container down.

```typescript
// engine/tests/contacts.integration.test.ts
import { describe, it, expect } from 'bun:test';
import { withTestDb, applyMigrationFiles } from '@zveltio/sdk/testing';
import { join } from 'path';
import { glob } from 'glob';
import contactsExtension from '../index.js';

describe('contacts extension — integration', () => {
  it('createContact persists a row and fires beforeInsert hooks', async () => {
    await withTestDb(async (db) => {
      // 1. Apply migrations (engine system migrations + this extension's).
      const engineMigrations = await glob('../../packages/engine/src/db/migrations/sql/*.sql');
      const extMigrations    = await glob('./engine/migrations/*.sql');
      await applyMigrationFiles(db, [...engineMigrations, ...extMigrations]);

      // 2. Drive a real write through the extension's HTTP routes.
      const ctx = createTestContext({ db });
      const app = await createTestApp(contactsExtension, { ctx });

      const res = await app.request('/ext/contacts/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.com', name: 'Alice' }),
      });
      expect(res.status).toBe(201);

      // 3. Assert against the real SQL state.
      const rows = await db.selectFrom('zvd_contacts').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe('a@b.com');
    });
  });
});
```

**Options on `withTestDb`** (also available as `startTestDb({...})` for
manual lifecycle control):

| Option | Default | Notes |
|---|---|---|
| `image` | `postgres:18-alpine` | Override for older PG / extensions like pgvector. |
| `database` | random per-call | DB name created inside the container. |
| `migrations` | `[]` | Optional SQL strings applied immediately after the container is ready. |
| `startupTimeoutMs` | `60_000` | Cold image pulls in CI can take longer — bump to `120_000`. |
| `reuse` | `false` | Reuse a single container across calls (new DB per test). |

**Performance**: first call pays the image-pull cost (~3-5s); subsequent
calls in the same Bun process reuse the cached image (~1-2s). Pass
`reuse: true` if you want to share one container across an entire
`describe()` block.

**Cleanup at process exit**: call `stopReusedTestDb()` once in
`afterAll` / `globalTeardown` to stop the cached container when using
`reuse: true`.

**Helper `applyMigrationFiles`**: runs each file in order, splitting on
SQL statements (handles `$$ ... $$` dollar-quoted blocks and `-- line`
/ `/* block */` comments). Use it to replay engine migrations + your
extension's own SQL.

### Running tests

```bash
bun test           # all tests
bun test --watch   # watch mode
bun test routes    # only files matching "routes"
```

---

## 12. Local development loop

### The `dev` command

```bash
# Terminal 1 — keep the engine running.
cd packages/engine && bun run dev

# Terminal 2 — watch your extension.
cd zveltio-extensions/content/my-feature
zveltio extension dev
```

Two concurrent loops:

1. **Engine watch** — per-file `fs.watch` over `engine/**/*.{ts,js,sql}`,
   debounced 250ms. On change, POSTs `{ name }` to
   `<engine>/__zveltio_dev_reload`. The engine clears the cached module +
   scoped state (services, queryAlter, entityAccess, cron schedules) and
   re-imports via the existing cache-buster query string. Next request
   hits the new code; no engine restart.
2. **Studio watch** — runs `bun run dev` inside `studio/`. Vite handles
   browser HMR; the CLI just keeps the process alive. Skip with
   `--no-studio` when you're only touching backend code.

The endpoint is gated behind `NODE_ENV !== 'production'`. If `zveltio
extension dev` exits with "Engine returned 404 on
`/__zveltio_dev_reload`", the engine was started with NODE_ENV=production
— restart it without that env.

Migration changes (new SQL under `engine/migrations/`) still require a
reinstall: the watcher only re-imports `engine/index.ts`. Toggle the
extension off and on in `/admin/extensions` to apply a new migration.

### Where extension files live (`EXTENSIONS_DIR`)

The engine resolves the extension base directory in priority order:

1. **`EXTENSIONS_DIR`** — explicit env var (recommended for monorepo dev)
2. **`./extensions/`** under the process CWD
3. **Sibling `../zveltio-extensions`** when that folder exists
4. **`./extensions/`** as the default install target

Clone the official extensions repo next to the monorepo, or set:

```bash
export EXTENSIONS_DIR=/path/to/zveltio-extensions
```

**Do not treat `packages/engine/extensions/` as source code.** That path is
gitignored and holds marketplace install artifacts. Stale copies (e.g. an old
`crm` without `GET /ext/crm/briefing`) override nothing — but if you symlink or
set CWD oddly, you can accidentally load the cache instead of the sibling repo.
When in doubt, set `EXTENSIONS_DIR` explicitly and clear the cache.

`ZVELTIO_EXTENSIONS_PATH` loads an **additional** tree of extensions (CI uses
this). Day-to-day dev should use `EXTENSIONS_DIR`.

### Studio dev vs embedded Studio

**Embedded (simplest):** build Studio and copy into the engine:

```bash
# from zveltio repo root
bun run studio:build && bun run studio:embed
# open http://localhost:<PORT>/admin  (same origin — no CORS)
```

**Split dev (Vite HMR):** run `bun run dev` in `packages/studio` and point API
calls at the engine:

```bash
VITE_ENGINE_URL=http://localhost:3400 bun run dev   # match engine PORT
```

Add Studio origins to the engine's `CORS_ORIGINS` (e.g.
`http://localhost:5173`). Without `VITE_ENGINE_URL`, Studio defaults to
`window.location.origin` (`:5173`) and API requests go to the wrong host.

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

### Keypair setup (one-time)

The CLI signs every archive with an Ed25519 keypair stored locally. Generate
one before your first publish:

```bash
zveltio keys generate --id my-publisher-key
```

The private half lands in `~/.zveltio/keys/<id>.json` (mode 0600 on POSIX,
user-only ACL on Windows). The public half prints once — paste it into the
engine's `REGISTRY_PUBLIC_KEYS_JSON` env (self-hosted installs) or hand it to
the registry admin. Back up the private file: losing it means re-keying every
extension you publish.

To list existing keys:

```bash
zveltio keys list
```

To print the public entry again later:

```bash
zveltio keys export my-publisher-key
```

### Publishing

```bash
# Full flow: validate → build → archive → sign → upload to registry.
zveltio extension publish --token $ZVELTIO_REGISTRY_TOKEN
```

What happens in order:

1. **Validate** (S4-04) — manifest schema, peerDep allow-list, migrations
   parse, destructive DDL has DOWN, bundle quota. Same checks as
   `zveltio extension validate`. Skip with `--no-validate` (only when
   re-publishing an emergency hotfix; not recommended).
2. **Build** — runs `bun run build` inside `studio/` if present. Engine code
   is *not* pre-bundled: the engine loader compiles `.ts` on import at
   install time. Skip with `--no-build`.
3. **Archive** — `tar -czf` of the extension folder, excluding
   `node_modules/`, `.zveltio/`, `dist/`, `engine/dist/`, `.git/`,
   `.DS_Store`, and any leftover `*.zvext` files.
4. **Sign** — Ed25519 over `sha256(archive)`. Picks the only key in
   `~/.zveltio/keys/` automatically, or `--key-id <id>` to override. The
   resulting `<archive>.sig` envelope mirrors what the engine's
   `verifySignature` expects (S1-01).
5. **Upload** — multipart `POST` to
   `<registry-url>/api/v1/extensions/publish` with the bearer token. Default
   registry URL: `https://registry.zveltio.com` (override via
   `--registry-url` or `ZVELTIO_REGISTRY_URL`).

### Local-only mode

For CI, air-gapped deploys, or manual review, skip the upload and write the
artifacts locally:

```bash
zveltio extension publish --output ./dist
# → ./dist/<name>-<version>.zvext
# → ./dist/<name>-<version>.zvext.sig
```

The `.zvext` is a plain `.tar.gz`. The `.sig` is the JSON envelope. Upload
both to your registry of choice — the engine's `downloadExtension` fetches
the `.sig` as a sibling of the archive URL.

### Dry-run

To exercise the pipeline without producing an archive (e.g., to assert that
`extension validate` would pass in CI):

```bash
zveltio extension publish --dry-run
```

Runs validate + build, then exits cleanly. No archive, no signature, no
upload.

### Token sources

The registry token is read in this order:

1. `--token <token>` on the command line.
2. `ZVELTIO_REGISTRY_TOKEN` environment variable.

Missing token → CLI exits with a hint to use `--output` for local-only
shipping.

### Today's caveat

The upstream `registry.zveltio.com/api/v1/extensions/publish` endpoint is
still being implemented. Until it lands, `--output <dir>` is the practical
path: build + sign locally, then upload the resulting `.zvext` + `.sig` to
any HTTPS host you control. The engine's `downloadExtension` already
verifies the signature regardless of where the archive is served from, so
self-hosted registries work today.

### Version policy

- **Patch**: bug fixes, no API change. Auto-approved.
- **Minor**: backwards-compatible additions. Auto-approved.
- **Major**: breaking changes. Manual review.

Republishing the same version is forbidden.

---

## 13.5. Isolation tiers (be honest about what you ship)

Zveltio offers three runtime tiers for extensions. Pick based on
**who wrote the code** and **what they're trusted with**, not based on
performance hopes.

### Tier 1 — `inline` (default)

The extension runs in the same V8 isolate as the engine. Maximum
speed (zero IPC), full API surface, transactions work naturally.

- **Performance:** ★★★★★ — direct function calls, no serialization
- **Crash isolation:** ❌ — an uncaught exception can take the
  engine down (the global `unhandledRejection` handler from
  alpha.117 mitigates the most common DB-driver races, but
  arbitrary throws still escape)
- **Memory isolation:** ❌ — a leak in the extension is a leak in
  the engine
- **DB credentials:** the extension sees the same `Bun.SQL` pool as
  the engine; nothing prevents it from running arbitrary SQL within
  its declared permissions
- **Use for:** first-party / audited code (the 54 official
  extensions), workloads chatty with the DB (RLS-bound multi-tenant
  queries), anything that needs transactions or streaming
  responses

Set in manifest: omit `engine.isolation` (default is `inline`).

### Tier 2 — `worker` (opt-in, since alpha.121)

The extension runs in a separate `Bun.Worker` thread. V8 heap is
isolated; the host postMessage-forwards each route invocation and
proxies SQL queries through its own pool.

- **Performance:** ★★★★ — +0.5–2 ms per route hit (one IPC hop),
  +5–20 ms per chatty DB workload (one IPC hop per query)
- **Crash isolation:** ✅ — an uncaught exception in worker code
  doesn't take the engine down. alpha.122 added auto-respawn with
  exponential backoff + heartbeat-based hang detection
- **Memory isolation:** ⚠️ partial — separate V8 isolate, **shared
  OS process**. RSS is not measurable per-extension. There are NO
  per-extension memory limits.
- **DB credentials:** ✅ — worker never sees `DATABASE_URL`. Every
  query crosses the IPC boundary; the host gatekeeps execution
- **Limitations:** no streaming responses (body buffered as text),
  no cross-process transactions (each `db.query()` is independent),
  worker-published services routed via the host registry bridge
- **Use for:** third-party / community extensions where the
  publisher isn't audited, code where crash isolation matters more
  than the latency cost

Set in manifest:

```json
{
  "engine": {
    "entry": "engine/index.js",
    "bundled": true,
    "isolation": "worker"
  }
}
```

Inspect runtime state at `GET /api/admin/extensions/health`:

```json
{
  "engine_rss_mb": 412,
  "engine_heap_used_mb": 187,
  "extensions": [
    { "name": "crm", "isolation": "inline", "status": "running" },
    {
      "name": "third-party-thing",
      "isolation": "worker",
      "status": "running",
      "workerGeneration": 3,
      "lastCrashAt": "2026-05-31T12:14:02.000Z",
      "inFlightRequests": 2,
      "totalRequests": 1847,
      "routes": 7
    }
  ]
}
```

### How the tier is decided — and what the CLI does for you

Your **publisher tier** (not a per-extension setting) determines which
isolation values you're allowed to ship:

| Publisher tier | `engine.isolation` allowed | How you get it |
|----------------|----------------------------|----------------|
| `first-party`  | `inline` or `worker`       | Zveltio team (the 54 official extensions) |
| `verified`     | `inline` or `worker`       | Enrolled by a marketplace admin after review of your identity / track record |
| `community`    | `worker` only              | Default for any newly enrolled publisher |

The registry stores your tier against your signing key
(`allowed_publishers.tier`) and exposes it at
`GET /api/dev/publisher/self`. Enforcement runs at **four** points so
you never get surprised late:

1. **`extension pack`** — if `engine.isolation` isn't already set, the
   CLI resolves your tier and **auto-injects `"isolation": "worker"`**
   for community publishers. First-party / verified keep the inline
   default. Pass `--first-party` for vendor / monorepo builds (offline,
   no registry call), or set `ZVELTIO_REGISTRY_TOKEN` so a verified tier
   is confirmed.
2. **`extension validate`** — hard-fails (exit 1) if a community
   publisher ships `inline`. Same tier resolution as pack.
3. **`extension publish` / registry submit** — the registry re-checks
   and returns `422 ISOLATION_POLICY_VIOLATION` rather than letting an
   un-enable-able extension into the review queue.
4. **engine enable** — final backstop: the loader refuses inline for a
   community/unknown publisher (`ZVELTIO_ALLOW_INLINE_THIRD_PARTY=1`
   overrides this on trusted self-hosted installs only).

#### Before your first publish

```bash
# 1. Generate + export your signing key, email it for enrollment
zveltio keys generate
zveltio keys export <keyId>   # → marketplace@zveltio.com

# 2. Check what tier you've been granted
curl -H "Authorization: Bearer $ZVELTIO_REGISTRY_TOKEN" \
  https://registry.zveltio.com/api/dev/publisher/self   # → { "tier": "...", "allows_inline": ... }

# 3. Pack — community publishers get worker auto-injected
zveltio extension pack

# 4. Publish
ZVELTIO_REGISTRY_TOKEN=zvt_… zveltio extension publish
```

If you're a community publisher and you'd rather ship `inline` for
performance, you need to be enrolled as `verified` first — open a
request with the marketplace admins. There's no self-service path to
inline for unaudited code; that's the whole point of §2.

### Tier 3 — subprocess / WASM (not implemented)

True OS-level RSS isolation, OOM-kill per extension, sandboxed
filesystem and network would require either subprocess workers
(`Bun.spawn` with stdin/stdout JSON-RPC) or WASM extensions. Both
are large investments: subprocess adds fork + serialization cost
to every query (estimated 5–10× slower for chatty workloads); WASM
needs a complete ABI redesign (~6 months of work) before existing
extensions could migrate.

The honest position: until there's evidence of a third-party
extension actively abusing memory or trying to exfiltrate
credentials, Tier 3 stays a "future if needed" item. Don't
oversell Tier 2 as a sandbox — `worker` mode is crash isolation +
credential separation, not OS sandboxing.

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
- **Tier-3 page:** confirm `manifest.studio.pages[].path` matches the URL and
  that `studio/pages/` was synced into the monorepo (`sync-extensions`) and
  committed under `packages/studio/src/routes/(admin)/…`.
- **SDUI page:** confirm `manifest.studio.pages[].schema` resolves and
  `GET /api/extensions` inlines the schema in meta.
- **Slot widget:** confirm `studio/src/contribute.ts` exists, is listed in
  `.synced.json` `contributions`, and the extension is enabled.
- There is **no** `studio/dist/bundle.js` path anymore (removed beta.15).

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
// studio/src/contribute.ts (optional — dashboard/settings slot widgets)
import { registerContributionSlot } from '$lib/extension-api.svelte.js';
import MyWidget from './components/MyWidget.svelte';

export function activate(): void {
  registerContributionSlot('category/name', 'dashboard.widgets', {
    component: MyWidget,
    priority: 5,
  });
}
```

Field types and form alters that mutate core Studio surfaces at runtime still
use `window.__zveltio` (installed by the admin layout) or shared components
imported from synced `$lib/ext/<name>/` — see §Custom field types above.

*End of guide. Last updated: 2026-08-22.*
