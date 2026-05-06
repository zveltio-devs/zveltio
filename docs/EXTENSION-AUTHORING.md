# Authoring Zveltio extensions

Extensions extend the Zveltio engine with new HTTP routes, Studio pages, client
components, custom field types, and migrations. This document is the contract
every extension follows — read it before building one.

## TL;DR

- One npm-style folder per extension at `zveltio-extensions/<category>/<name>/`.
- Three subfolders: `engine/` (server), `studio/` (admin UI), `client/` (end-user UI). Any subset is fine.
- `manifest.json` declares metadata and dependencies.
- `engine/index.ts` exports a default `ZveltioExtension` with a `register(app, ctx)` function.
- The engine injects a `ctx` object — extensions never `import` engine internals directly.
- Real npm packages (`hono`, `zod`, `kysely`, etc.) are auto-installed into `<EXTENSIONS_DIR>/node_modules/` by the engine on first start.

## Folder layout

```
my-extension/
├── manifest.json
├── engine/
│   ├── index.ts           # default-exports ZveltioExtension
│   ├── routes.ts          # Hono routes
│   ├── lib/               # local helpers
│   └── migrations/
│       └── 001_init.sql
├── studio/                # SvelteKit pages compiled to studio/dist/bundle.js
└── client/                # End-user components (npm-published separately)
```

## `manifest.json`

```json
{
  "name": "category/name",
  "displayName": "Human Friendly Name",
  "category": "content",
  "description": "What this extension does, in one sentence.",
  "version": "1.0.0",
  "zveltioMinVersion": "1.0.0",
  "package": "@zveltio/ext-mine",
  "permissions": ["database", "settings"],
  "peerDependencies": {
    "imapflow": "^1.0.0"
  },
  "contributes": {
    "engine": true,
    "studio": true,
    "client": false,
    "fieldTypes": []
  }
}
```

- **`name`** must equal the path slug exactly (e.g. `finance/accounting`). Mismatches fail registry sync.
- **`zveltioMinVersion`** uses naive semver (`major.minor.patch`); pre-release suffixes like `-alpha.X` are tolerated.
- **`peerDependencies`** are auto-installed via `bun add` when the extension is enabled. Use this for anything beyond `hono`/`zod`/`kysely`/`@hono/zod-validator` (which are global).
- **`contributes.engine: false`** marks UI-only extensions — `register()` may be a no-op.

## `engine/index.ts` — the entry point

```ts
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { myRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'category/name',          // must match manifest.json
  category: 'content',

  // Optional: SQL migrations run on first activation. Use absolute paths.
  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_init.sql')];
  },

  // Required: register routes/listeners. Called once per activation.
  async register(app, ctx) {
    app.route('/api/my-feature', myRoutes(ctx));
  },

  // Optional: cleanup on disable/shutdown. Routes cannot be de-registered.
  async cleanup() {
    // close connections, clear timers, etc.
  },
};

export default extension;
```

**Key rules:**

1. The `ZveltioExtension` import is **type-only** (`import type`). It's erased at compile time so the package path resolution never runs at runtime.
2. `name` must equal `manifest.json` `name` exactly.
3. Don't import from `'@zveltio/engine'`, `'@zveltio/engine-permissions'`, `'@zveltio/engine-db'`, or relative paths into the engine source. **Use `ctx.*` only.**
4. Pass `ctx` (not `ctx.db, ctx.auth`) into the route factory — it carries everything the routes need.

## The `ctx` object — engine-injected context

Every `register()` call receives a populated `ExtensionContext`:

### Stable public API

```ts
ctx.db                                      // Kysely Database (restricted: cannot read zv_* system tables)
ctx.auth                                    // Better-Auth instance — auth.api.getSession({ headers })
ctx.fieldTypeRegistry                       // Register custom field types
ctx.events                                  // Typed event bus — subscribe to record lifecycle events
ctx.checkPermission(userId, resource, action) // → Promise<boolean>
ctx.getUserRoles(userId)                    // → Promise<string[]>
ctx.DDLManager                              // DDL helpers (Ghost Tables, zero-downtime DDL)
```

### Engine internals — `ctx.internals.*`

For first-party extensions only. Stable across patch versions, may break at minor versions.

```ts
ctx.internals.aiProviderManager       // AI providers (OpenAI, Anthropic, Ollama, …)
ctx.internals.dynamicInsert           // Insert into a user-defined collection table
ctx.internals.introspectSchema        // Postgres schema introspection
ctx.internals.runQualityScan          // Data-quality scan
ctx.internals.invalidateRulesCache    // Clear cached validation rules
ctx.internals.runEdgeFunction         // Sandbox-execute edge function code
ctx.internals.extensionRegistry       // Cross-extension hook registry
ctx.internals.generatePDFAsync        // Queue HTML→PDF render
ctx.internals.renderTemplate          // Synchronous {{var}} interpolation
ctx.internals.generatePDF             // Inline HTML→PDF render
ctx.internals.moveToTrash             // Soft-delete a file with TTL
ctx.internals.scheduleFileIndexing    // Async indexing for uploaded files
ctx.internals.DataLoaderRegistry      // GraphQL N+1 batching
ctx.internals.checkQueryDepth         // GraphQL query-depth validator
```

## `engine/routes.ts` — Hono routes

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ExtensionContext } from '@zveltio/sdk/extension';

export function myRoutes(ctx: ExtensionContext): Hono<{ Variables: { user: any } }> {
  const { db, auth, checkPermission } = ctx;

  // Helpers go INSIDE the route function so they close over destructured names.
  async function requireAdmin(c: any): Promise<any | null> {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return null;
    if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
    return session.user;
  }

  const app = new Hono<{ Variables: { user: any } }>();

  app.use('*', async (c, next) => {
    const user = await requireAdmin(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  app.get('/', async (c) => {
    const rows = await db.selectFrom('zvd_my_table').selectAll().execute();
    return c.json({ rows });
  });

  return app;
}
```

**Rules:**

- Route factory **takes `ctx` as a single arg**, never `(db, auth)`.
- Generic `Hono<{ Variables: { user: any } }>` is needed when you use `c.set('user', …)` / `c.get('user')`.
- Define helpers (e.g. `requireAdmin`) **inside** the route factory so they capture the destructured engine internals. Top-level helpers cannot reach them.
- Imports allowed: `hono`, `zod`, `kysely`, `@hono/zod-validator`, plus anything in your `manifest.peerDependencies`. Engine internals come from `ctx`.

## What to avoid

- **Never** `import` from `'../../../packages/engine/src/...'` or `'@zveltio/engine-...'` virtual packages. Those used to be intercepted by `Bun.plugin` shims, but the shim is removed in `1.0.0-alpha.60`. Today these imports fail at runtime.
- **Never** put helper functions that use `auth` / `checkPermission` / `db` / engine internals at module top level — they have no access to the destructured ctx values.
- **Never** type your route factory as `(db: any, auth: any)`. Always `(ctx: ExtensionContext)`.

## Migration from earlier extension styles

If you have an extension authored against an earlier API:

| Before                                                              | After                                |
|---------------------------------------------------------------------|--------------------------------------|
| `import { checkPermission } from '@zveltio/engine-permissions'`     | `const { checkPermission } = ctx;`   |
| `import { auth } from '../../../packages/engine/src/lib/auth.js'`   | `const { auth } = ctx;`              |
| `import { aiProviderManager } from '...src/lib/ai-provider.js'`     | `const { aiProviderManager } = ctx.internals;` |
| `myRoutes(ctx.db, ctx.auth)`                                        | `myRoutes(ctx)`                      |
| `function myRoutes(db, auth) { … }`                                 | `function myRoutes(ctx: ExtensionContext) { const { db, auth } = ctx; … }` |

## How the engine resolves extensions at runtime

Extensions are downloaded as ZIPs from `registry.zveltio.com` and extracted to `<EXTENSIONS_DIR>/<name>/`. On first start the engine runs `ensureExtensionCoreDeps()` which provisions `<EXTENSIONS_DIR>/node_modules/` with `hono`, `zod`, `kysely`, `@hono/zod-validator`. With these on disk, Bun's filesystem resolution finds them when extensions are dynamically imported.

For per-extension peer dependencies declared in `manifest.peerDependencies`, the engine runs `bun add` in `<EXTENSIONS_DIR>/` at activation time.

Both paths require Bun to be on `PATH` for the user running the engine. The official installer handles this — see `install/install.sh`.
