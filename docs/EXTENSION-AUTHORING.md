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
│   ├── index.ts                   # default-exports ZveltioExtension
│   ├── routes.ts                  # Hono routes
│   ├── lib/                       # local helpers
│   └── migrations/
│       └── 001_init.sql
├── studio/                        # Admin UI — compiled INTO Studio at install
│   ├── pages/
│   │   ├── +page.svelte           # /admin/<slug>/
│   │   └── settings/
│   │       └── +page.svelte       # /admin/<slug>/settings/
│   └── src/
│       └── components/            # shared components → $lib/ext/<name>/components/
└── client/                        # End-user components (npm-published separately)
```

### Studio pages — no per-extension build

Extensions never ship a pre-built bundle: **no** `studio/dist/`, **no**
per-extension `vite.config.ts`, **no** per-extension `package.json`. There are
two ways a page reaches the Studio, neither of which builds at enable time
(see "How Studio pages are served" below):

- **Declarative (SDUI, preferred):** ship a JSON schema referenced by
  `manifest.studio.pages[].schema`. The engine inlines it into
  `GET /api/extensions` and a generic host route renders it — zero build.
- **Code (Tier-3):** ship `studio/pages/**/*.svelte`; it is baked into the
  Studio's route tree at **release** (via `sync-extensions`) at
  `(admin)/<slug>/`, `<slug>` derived from `manifest.studio.pages[0].path`
  (e.g. `/admin/crm` → `crm`). Shared components in `studio/src/**` are copied
  to `src/lib/ext/<extension-name>/`.

Use the same imports the Studio core uses — `$lib/api.js`,
`$lib/stores/toast.svelte.js`, Svelte 5 runes, DaisyUI classes.
Anything else has to be vendored under `studio/src/`.

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
ctx.services                                // Inter-extension service registry (see below)
```

### Inter-extension services — `ctx.services.*`

Extensions communicate with each other through a Drupal-style services container.
**Direct imports between extensions are forbidden.** Always go through `ctx.services`.

```ts
// Publishing a service (in YOUR extension's register()):
ctx.services.register('crm.contacts.lookup', async (email: string) => {
  return await ctx.db.selectFrom('zvd_contacts').where('email', '=', email).executeTakeFirst();
});

// Consuming a service (from another extension):
const lookup = ctx.services.get<(email: string) => Promise<unknown>>('crm.contacts.lookup');
if (!lookup) {
  // CRM extension is not active — handle gracefully
  return c.json({ error: 'CRM extension is required for this feature.' }, 503);
}
const contact = await lookup('alice@example.com');

// Waiting for a service to appear (rarely needed if dependencies are declared):
const ai = await ctx.services.waitFor<AiProviders>('ai.providers', 5000);
```

**Naming convention** (recommended): `<extension>.<feature>` or `<extension>.<resource>.<verb>`.
Examples: `ai.providers`, `ai.embed`, `ai.chat`, `crm.contacts.lookup`, `pdf.generate`.

**Declare dependencies** in `manifest.json` so the engine loads providers before consumers:

```json
{
  "dependencies": [
    { "name": "ai", "minVersion": "1.0.0" }
  ]
}
```

The engine topologically sorts extensions before loading, guaranteeing the AI extension is
fully loaded (and `ai.providers` is registered) before any consumer's `register()` runs.

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
- **Never** ship a `studio/dist/`, `studio/vite.config.ts`, or
  `studio/package.json`. The v1 per-extension build pipeline was
  removed in `1.0.0-alpha.94`. Anything you ship there is dead
  weight — the Studio serves pre-built/declarative pages and ignores it.
- **Never** import from `@zveltio/sdk/studio` — that was the v1
  runtime route registration API. It no longer exists. Just put
  pages under `studio/pages/<slug>/+page.svelte` and they become
  real SvelteKit routes after install.

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

## How Studio pages are served (no runtime rebuild)

> **Changed in `3.0.0-beta.15`.** The old "rebuild Studio on enable" path
> (`STUDIO_REBUILD_ON_ENABLE` / `STUDIO_BUILDER_URL` / `studio-builder`
> sidecar) was **removed**. There is no runtime Studio build. Pages are
> served two ways, both already present before enable:

- **Declarative (SDUI) pages** — `manifest.studio.pages[].schema` points at a
  JSON schema (`studio/schemas/<slug>.json`). The engine inlines it into
  `GET /api/extensions` meta, and a generic host route renders it at request
  time. **No build, no copy, no rebuild** — enabling the extension is enough.
  This is the preferred model; prefer it for new pages.
- **Code (Tier-3) pages** — a `+page.svelte` baked into the Studio's route
  tree at **release** time (via `sync-extensions`). Enabling activates the
  extension's engine routes; the page is already in the shipped Studio dist,
  so a refresh shows it.

`POST /api/marketplace/:name/enable` (and `.../disable`) therefore never runs a
build. The response keeps `studio_rebuild` for API compatibility, but it is
always `"skipped"` with `studio_pages_prebuilt: true`:

```json
{
  "success": true,
  "hot_loaded": true,
  "studio_rebuild": "skipped",
  "studio_pages_prebuilt": true,
  "message": "Extension crm is now active. Refresh to see its pages."
}
```

Engine routes are hot-swapped on enable (zero-downtime `buildHonoApp`); only the
browser needs a refresh to pick up newly-activated pages.
