# Authoring Zveltio extensions

Extensions extend the Zveltio engine with new HTTP routes, Studio pages, client
components, custom field types, and migrations. This document is the contract
every extension follows — read it before building one.

## TL;DR

- One npm-style folder per extension at `zveltio-extensions/<category>/<name>/`.
- `manifest.json` declares metadata and dependencies.
- `engine/index.ts` exports a default `ZveltioExtension` with a `register(app, ctx)` function. This is where the truth lives.
- **Your admin page is a JSON schema** — `studio/schemas/<name>.json`, named by `manifest.studio.pages[].schema`. The host renders it; nothing builds.
- The engine injects a `ctx` object — extensions never `import` engine internals directly.
- Real npm packages (`hono`, `zod`, `kysely`, etc.) are auto-installed into `<EXTENSIONS_DIR>/node_modules/` by the engine on first start.

### Where UI goes

Three destinations, and they are not three equal choices. Of the 56 extensions
shipped today, 61 pages are schemas and one is a component.

| You want | You write | How often |
|---|---|---|
| a page | `studio/schemas/*.json` | almost always |
| a widget on a core surface (dashboard, topbar) | `studio/src/contribute.ts` | occasionally |
| UI a schema cannot express — canvas, chat, map, inbox | `studio/pages/+page.svelte` | rarely |

`bunx @zveltio/cli extension create <name>` scaffolds the first. Pass
`--code-page` for the third, and read what it prints before you keep it.

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
├── studio/                        # Admin UI
│   ├── schemas/
│   │   └── my-extension.json      # THE page — rendered by the host, no build
│   ├── messages/
│   │   └── en.json                # keys this extension owns; locales filled from en
│   ├── pages/                     # ONLY for UI a schema cannot express
│   │   └── +page.svelte           # /admin/<slug>/ — baked in at release
│   └── src/
│       ├── contribute.ts          # optional: widgets on core surfaces
│       └── components/            # shared components → $lib/ext/<name>/components/
└── client/                        # UI for the public site / portals — copied into
                                   # the hosts by their sync scripts, same as studio/src
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

### When to use Tier-3 (code pages) vs SDUI

Prefer **SDUI** (`manifest.studio.pages[].schema` → JSON under `studio/schemas/`)
for anything that is CRUD, settings, tabs of tables, or KPI+list. See
[SDUI-SCHEMA-REFERENCE.md](./SDUI-SCHEMA-REFERENCE.md).

Use **Tier-3** (`studio/pages/+page.svelte`, synced into Studio at release) only
when the UI cannot be expressed with the current SDUI vocabulary. Formal criteria
— ship code if **any** of these hold:

| Criterion | Examples that stay Tier-3 |
| --- | --- |
| Real-time or long-lived client session | AI chat, live collaboration cursors |
| Free-form canvas / graph editor | Page builder, flows node graph |
| Spatial / media-heavy interaction | Geospatial map, media gallery lightbox |
| Code or query IDE | GraphQL playground, edge-functions editor |
| Domain calendar / kanban with drag | `developer/views` calendar & board |
| Complex email client (not just account settings) | `communications/mail` inbox |

Even Tier-3 extensions should push **settings, filters, and simple CRUD
sub-pages** to SDUI (or Model 2.5 slot widgets) so only the irreducible surface
stays as Svelte.

**Do not** use Tier-3 to dodge learning SDUI for a normal list+form page — that
reintroduces per-extension Studio churn and blocks the “data, not code” admin
security model.

**Untrusted marketplace UI** (future): iframe sandbox + `postMessage` — not
runtime Web Components and not Tier-3 Svelte executed in the admin origin.
Shadow DOM is style isolation, not a security boundary.

Studio ships a **scaffold** (`MarketplaceSandbox.svelte` +
`lib/components/marketplace/protocol.ts`) behind an explicit `enabled` prop.
It is **not** wired into marketplace install/enable yet. Protocol v1:

| Direction | `type` | Payload |
|-----------|--------|---------|
| host → iframe | `zveltio:marketplace:init` | `extensionId`, `locale` |
| iframe → host | `zveltio:marketplace:ready` | — |
| iframe → host | `zveltio:marketplace:navigate` | `path` (must start with `/`) |
| iframe → host | `zveltio:marketplace:toast` | `level`, `message` |

The iframe uses `sandbox="allow-scripts allow-forms allow-popups"` (no
`allow-same-origin`). The host ignores messages from unexpected origins or
unknown types.

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
ctx.db                                      // GLOBAL Kysely Database (restricted; NOT tenant-scoped)
ctx.reqDb(c)                                // Per-request, TENANT-scoped DB — use this in data handlers
ctx.auth                                    // Better-Auth instance — auth.api.getSession({ headers })
ctx.fieldTypeRegistry                       // Register custom field types
ctx.events                                  // Typed event bus — subscribe to record lifecycle events
ctx.checkPermission(userId, resource, action) // → Promise<boolean>
ctx.getUserRoles(userId)                    // → Promise<string[]>
ctx.DDLManager                              // DDL helpers (Ghost Tables, zero-downtime DDL)
ctx.services                                // Inter-extension service registry (see below)
```

### `ctx.db` vs `ctx.reqDb(c)` — tenant isolation

`ctx.db` is the **global** pool: it is table-restricted but **not** tenant-scoped.
In a multi-tenant deployment, querying tenant data through `ctx.db` either returns
zero rows (Postgres FORCE row-level security with no tenant context) or, on tables
without RLS, leaks across tenants.

In any route handler that reads/writes tenant data, use **`ctx.reqDb(c)`** — it
returns the request's tenant transaction (the `zveltio.current_tenant` GUC is set,
so RLS isolates correctly) wrapped in the same table guard:

```ts
app.get('/contacts', async (c) => {
  const db = ctx.reqDb(c); // tenant-scoped
  return c.json(await db.selectFrom('zvd_contacts').selectAll().execute());
});
```

Reserve `ctx.db` for setup/migrations (no request context). See
`docs/private/MULTI-TENANT-ENABLEMENT.md` §5.

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
- **Do not** use `@zveltio/sdk/studio` `registerRoute()` from a runtime
  bundle — that was the v1 IIFE path (removed in beta.15). For **pages**,
  ship `studio/pages/` or an SDUI schema. For **slot widgets**, ship
  `studio/src/contribute.ts` (see below) and import Studio helpers from
  `$lib/…` after sync — same compile-time model as tier-3 pages.
- **`@zveltio/sdk/studio` still exists** for pure helpers (`sortSlotContributions`,
  `makeFormProxy`, types). Synced `contribute.ts` modules import
  `$lib/extension-api.svelte.js` instead of the SDK register proxies.

### Studio slot contributions (compile-time, Model 2.5)

To inject a widget into a core slot (e.g. `dashboard.widgets` on the admin
home page), add **`studio/src/contribute.ts`** (alongside `studio/src/components/`):

```typescript
import { registerContributionSlot } from '$lib/extension-api.svelte.js';
import MyWidget from './components/MyWidget.svelte';

export function activate(): void {
  registerContributionSlot('my-extension', 'dashboard.widgets', {
    component: MyWidget,
    priority: 10,
  });
}
```

`scripts/sync-extensions.ts` copies this to `$lib/ext/<name>/contribute.ts` and
regenerates `$lib/ext/.contributions.generated.ts`. The admin layout loads
`activate()` for each **enabled** extension — no per-extension build, no runtime
bundle, same Svelte instance as core Studio.

Declare targeted slots in `manifest.contributes.slots` (metadata for the
extensions admin UI). Slot names are stable strings declared by core Studio;
see the developer guide for the full list.

**Community / third-party extensions:** slot widgets ship as compile-time Svelte
(`studio/src/contribute.ts`) synced into the Studio bundle at build time — same
as tier-3 pages. Enabling an extension at runtime loads its engine routes and
SDUI schemas immediately, but **slot contributions require a Studio rebuild**
(`sync-extensions` → `vite build`). Marketplace untrusted UI will use iframe
sandbox later; do not expect runtime slot injection from unsigned bundles today.

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
