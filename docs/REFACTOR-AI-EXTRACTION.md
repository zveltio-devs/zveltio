# Refactor: AI extraction + inter-extension service registry

> **Status**: planned, in execution starting 2026-05-08.
> **Target version**: `1.0.0-alpha.67` (breaking change vs alpha.66).
> **Audience**: Claude Code instances and human contributors executing the refactor.

## Context

- Repo: `c:\Users\Liviu\zveltio-ecosystem\zveltio` (engine + studio + sdk + cli).
- Repo extensions: `c:\Users\Liviu\zveltio-ecosystem\zveltio-extensions`.
- Current version: `1.0.0-alpha.66`.
- **No existing installations.** Alpha users accept breaking changes; we do NOT need graceful migration.
- Bun runtime, Hono framework, Kysely ORM, PostgreSQL.
- Build: `bun run build`. Typecheck: `bun run typecheck`.

## Why

1. AI is core today but architecturally should be an extension. Many other extensions depend on it, so it remains "default-installed and important", but not built into the engine binary.
2. Forces the engine to grow a real inter-extension service registry (`ctx.services.register/get`) — Drupal-style services container. This unblocks future ecosystem composition.
3. Ships AI release cycles independently from engine release cycles.
4. Allows organizations with strict no-AI policies (defense, parts of public sector) to install Zveltio without AI files present at all.
5. Aligns with the principle agreed in conversation: things that are *core* must be non-negotiable like Postgres or auth. AI does not meet that bar.

## Non-goals (explicitly out of scope)

- Studio extensibility audit (separate effort, comes after).
- Moving any other features out of core (zones, approvals, flows, multi-tenancy etc. stay in core).
- Open-core / Enterprise edition split.
- Profile-based installation (`--profile=erp`).
- Full hooks/filters Drupal-style system (we add only `ctx.services`, not full alter hooks).

---

## FAZA 0 — Messaging (parallel, ~2h)

**Goal**: messaging consistent "self-hosted Business OS", not BaaS.

### Files

- [README.md](../README.md): line 3 ("high-performance self-hosted BaaS") → `Self-hosted Business OS for organizations that own their infrastructure and data.`
- [package.json](../package.json) line 6: `"description"` → `"Self-hosted Business OS — own your hardware, own your data."`
- [versions.json](../versions.json): `"latest": null`, `"latest_alpha": "1.0.0-alpha.66"`, remove fictional `"version": "1.0.0"` from array (or empty the array until a real release exists).
- Search repo: `git grep -i "BaaS\|baas\|simple blog"` — replace each with Business OS / organization wording.
- Create [FUNDING.md](../FUNDING.md):

  ```markdown
  # Funding & Business Model

  Zveltio is MIT-licensed open source. Self-hosted only — we don't and won't offer cloud hosting. Your data stays on your infrastructure.

  Sustained by:
  - Community donations (GitHub Sponsors)
  - A marketplace of paid business extensions
  - Professional support and SLA contracts (available once the project sustains a team)

  We don't promise everything stays free forever; we promise the core platform stays open source under MIT.
  ```

### Verify

`git grep -i "baas"` returns zero matches.

---

## FAZA 1 — Service registry in SDK + engine

**Goal**: extensions can publish services (`ctx.services.register('ai.providers', ...)`) and consume services published by other extensions (`ctx.services.get('ai.providers')`).

### 1.1 — Add `services` to SDK

**File**: `packages/sdk/src/extension/index.ts`

Add after `ExtensionInternals`:

```ts
/** Inter-extension service registry — extensions publish services here for others to consume. */
export interface ServiceRegistry {
  /** Publish a service under a name. Throws if name is already taken. */
  register<T = unknown>(name: string, value: T): void;
  /** Get a service. Returns null if not registered. */
  get<T = unknown>(name: string): T | null;
  /** Check if a service is registered. */
  has(name: string): boolean;
  /** Wait for a service to be registered. Resolves immediately if already there. */
  waitFor<T = unknown>(name: string, timeoutMs?: number): Promise<T>;
  /** List all registered service names — useful for debugging. */
  list(): string[];
}
```

In `ExtensionContext`, add field:

```ts
/** Inter-extension service registry. */
services: ServiceRegistry;
```

Re-build SDK: `cd packages/sdk && bun run build`.

### 1.2 — Implement in engine

**New file**: `packages/engine/src/lib/service-registry.ts`

```ts
import type { ServiceRegistry } from '@zveltio/sdk/extension';

export class ServiceRegistryImpl implements ServiceRegistry {
  private services = new Map<string, unknown>();
  private waiters = new Map<string, Array<(value: unknown) => void>>();

  register<T>(name: string, value: T): void {
    if (this.services.has(name)) {
      throw new Error(`Service "${name}" is already registered.`);
    }
    this.services.set(name, value);
    const pending = this.waiters.get(name);
    if (pending) {
      pending.forEach((resolve) => resolve(value));
      this.waiters.delete(name);
    }
  }

  get<T>(name: string): T | null {
    return (this.services.get(name) as T) ?? null;
  }

  has(name: string): boolean {
    return this.services.has(name);
  }

  async waitFor<T>(name: string, timeoutMs = 30_000): Promise<T> {
    if (this.services.has(name)) return this.services.get(name) as T;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = this.waiters.get(name);
        if (arr) {
          const idx = arr.findIndex((fn) => fn === wrapped);
          if (idx >= 0) arr.splice(idx, 1);
        }
        reject(new Error(`Timeout waiting for service "${name}" after ${timeoutMs}ms`));
      }, timeoutMs);
      const wrapped = (v: unknown) => { clearTimeout(timer); resolve(v as T); };
      if (!this.waiters.has(name)) this.waiters.set(name, []);
      this.waiters.get(name)!.push(wrapped);
    });
  }

  list(): string[] {
    return [...this.services.keys()];
  }
}

export const serviceRegistry = new ServiceRegistryImpl();
```

### 1.3 — Inject `services` into ctx

**File**: `packages/engine/src/lib/extension-loader.ts`

In `ExtensionContext` (~line 432), add `services: ServiceRegistry`.
Add import: `import { serviceRegistry } from './service-registry.js';`
Add re-export: `export { serviceRegistry } from './service-registry.js';`

In every place `restrictedCtx: ExtensionContext = { ... }` is built, add:

```ts
services: serviceRegistry,
```

### 1.4 — Documentation

**File**: `docs/EXTENSION-AUTHORING.md`

Add new section "Inter-extension services" with `register` / `get` / `waitFor` examples. State explicitly: extensions must NOT directly import from other extensions — communication goes exclusively via `ctx.services`.

### 1.5 — Verify

- `bun run typecheck` — no errors
- Engine boots locally: `cd packages/engine && bun run dev` — bootstrap fine
- Log services list at extension load to validate

---

## FAZA 2 — Topological loading

**Goal**: extension B that declares `dependencies: [{ name: "A" }]` always loads after A.

### 2.1

**File**: `packages/engine/src/lib/extension-loader.ts`

Modify `loadAll()` and `loadFromDB()` to:

1. Read all manifests for planned extensions.
2. Build dependency graph.
3. Detect cycles, fail loudly.
4. Return topological order.
5. Load in that order (sequential, as today).

Utility:

```ts
function topoSort(extensions: Array<{ name: string; deps: string[] }>): string[] {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const map = new Map(extensions.map((e) => [e.name, e.deps]));

  function visit(name: string, path: string[]): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular dependency: ${[...path, name].join(' -> ')}`);
    }
    visiting.add(name);
    for (const dep of map.get(name) ?? []) {
      if (!map.has(dep)) {
        console.warn(`Extension "${name}" depends on "${dep}" which is not active — skipping ${name}`);
        visiting.delete(name);
        return;
      }
      visit(dep, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(name);
  }

  for (const { name } of extensions) visit(name, []);
  return sorted;
}
```

### 2.2 — Verify

Test manually: two dummy extensions A (publishes `test.foo`) and B (consumes `test.foo`). Verify B loads after A regardless of alphabetical order.

---

## FAZA 3 — Create AI extension scaffolding

**Goal**: directory structure ready, no code moved yet.

### 3.1 — Layout

```
zveltio-extensions/ai/
├── manifest.json
├── package.json
├── engine/
│   ├── index.ts
│   ├── routes/
│   │   ├── index.ts
│   │   ├── ai.ts
│   │   ├── ai-chats.ts
│   │   ├── ai-schema-gen.ts
│   │   ├── ai-alchemist.ts
│   │   ├── ai-query.ts
│   │   ├── ai-analytics.ts
│   │   └── zveltio-ai.ts
│   ├── lib/
│   │   ├── ai-provider.ts
│   │   ├── ai-embed-hook.ts
│   │   ├── ai-crypto.ts
│   │   └── zveltio-ai/
│   │       ├── engine.ts
│   │       ├── tools.ts
│   │       └── types.ts
│   └── migrations/
│       ├── 001_ai_init.sql
│       ├── 002_embeddings.sql
│       ├── 003_search_config.sql
│       ├── 004_decision_step.sql
│       ├── 005_task_trigger.sql
│       ├── 006_query.sql
│       ├── 007_embed_excluded.sql
│       └── 008_memory.sql
└── studio/
    └── src/
```

### 3.2 — `manifest.json`

```json
{
  "name": "ai",
  "displayName": "AI",
  "category": "intelligence",
  "description": "AI capabilities: providers, chat, embeddings, semantic search, text-to-SQL, schema generation, agentic workflows.",
  "version": "1.0.0",
  "zveltioMinVersion": "1.0.0-alpha.67",
  "package": "@zveltio/ext-ai",
  "permissions": ["database", "settings", "network"],
  "contributes": {
    "engine": true,
    "studio": true,
    "fieldTypes": [],
    "stepTypes": ["ai_decision"]
  },
  "studio": {
    "pages": [
      { "path": "/admin/ai", "label": "AI", "icon": "Bot" }
    ]
  }
}
```

### 3.3 — Empty `engine/index.ts` (populated in FAZA 4)

```ts
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';

const extension: ZveltioExtension = {
  name: 'ai',
  category: 'intelligence',
  getMigrations() {
    return [
      join(import.meta.dir, 'migrations/001_ai_init.sql'),
      join(import.meta.dir, 'migrations/002_embeddings.sql'),
      join(import.meta.dir, 'migrations/003_search_config.sql'),
      join(import.meta.dir, 'migrations/004_decision_step.sql'),
      join(import.meta.dir, 'migrations/005_task_trigger.sql'),
      join(import.meta.dir, 'migrations/006_query.sql'),
      join(import.meta.dir, 'migrations/007_embed_excluded.sql'),
      join(import.meta.dir, 'migrations/008_memory.sql'),
    ];
  },
  async register(_app, _ctx) {
    // populated in FAZA 4
  },
};

export default extension;
```

---

## FAZA 4 — Move AI code from engine to extension

### 4.1 — `git mv` files (preserve history)

```bash
cd c:\Users\Liviu\zveltio-ecosystem\zveltio

# Routes
git mv packages/engine/src/routes/ai.ts            ../zveltio-extensions/ai/engine/routes/ai.ts
git mv packages/engine/src/routes/ai-chats.ts      ../zveltio-extensions/ai/engine/routes/ai-chats.ts
git mv packages/engine/src/routes/ai-schema-gen.ts ../zveltio-extensions/ai/engine/routes/ai-schema-gen.ts
git mv packages/engine/src/routes/ai-alchemist.ts  ../zveltio-extensions/ai/engine/routes/ai-alchemist.ts
git mv packages/engine/src/routes/ai-query.ts      ../zveltio-extensions/ai/engine/routes/ai-query.ts
git mv packages/engine/src/routes/ai-analytics.ts  ../zveltio-extensions/ai/engine/routes/ai-analytics.ts
git mv packages/engine/src/routes/zveltio-ai.ts    ../zveltio-extensions/ai/engine/routes/zveltio-ai.ts

# Lib
git mv packages/engine/src/lib/ai-provider.ts    ../zveltio-extensions/ai/engine/lib/ai-provider.ts
git mv packages/engine/src/lib/ai-embed-hook.ts  ../zveltio-extensions/ai/engine/lib/ai-embed-hook.ts
git mv packages/engine/src/lib/ai-crypto.ts      ../zveltio-extensions/ai/engine/lib/ai-crypto.ts
git mv packages/engine/src/lib/zveltio-ai        ../zveltio-extensions/ai/engine/lib/zveltio-ai

# Migrations (renumbered)
git mv packages/engine/src/db/migrations/sql/011_ai.sql                       ../zveltio-extensions/ai/engine/migrations/001_ai_init.sql
git mv packages/engine/src/db/migrations/sql/032_ai_embeddings.sql            ../zveltio-extensions/ai/engine/migrations/002_embeddings.sql
git mv packages/engine/src/db/migrations/sql/033_ai_search_config.sql         ../zveltio-extensions/ai/engine/migrations/003_search_config.sql
git mv packages/engine/src/db/migrations/sql/034_ai_decision_step.sql         ../zveltio-extensions/ai/engine/migrations/004_decision_step.sql
git mv packages/engine/src/db/migrations/sql/036_ai_task_trigger.sql          ../zveltio-extensions/ai/engine/migrations/005_task_trigger.sql
git mv packages/engine/src/db/migrations/sql/039_ai_query.sql                 ../zveltio-extensions/ai/engine/migrations/006_query.sql
git mv packages/engine/src/db/migrations/sql/043_ai_embed_excluded_fields.sql ../zveltio-extensions/ai/engine/migrations/007_embed_excluded.sql
git mv packages/engine/src/db/migrations/sql/045_ai_memory.sql                ../zveltio-extensions/ai/engine/migrations/008_memory.sql
```

### 4.2 — Repair imports in moved files

Moved files had relative imports into engine internals. Replace with `ctx.*`:

- `db` direct import → `ctx.db`
- `auth` direct import → `ctx.auth`
- `checkPermission` import → `ctx.checkPermission`
- `engineEvents` import → `ctx.events`
- For `aiProviderManager` referenced internally from within AI extension itself: keep as local import from `./lib/ai-provider.js`.

Model: see `zveltio-extensions/crm/engine/routes.ts`.

### 4.3 — Routes combiner

**New file**: `zveltio-extensions/ai/engine/routes/index.ts`

```ts
import { Hono } from 'hono';
import type { ExtensionContext } from '@zveltio/sdk/extension';
import { aiRoutes } from './ai.js';
import { aiChatsRoutes } from './ai-chats.js';
import { aiSchemaGenRoutes } from './ai-schema-gen.js';
import { aiAlchemistRoutes } from './ai-alchemist.js';
import { aiQueryRoutes } from './ai-query.js';
import { aiAnalyticsRoutes } from './ai-analytics.js';
import { zveltioAIRoutes } from './zveltio-ai.js';

export function buildAIRoutes(ctx: ExtensionContext): Hono {
  const app = new Hono();
  app.route('/api/ai', aiRoutes(ctx));
  app.route('/api/ai', aiChatsRoutes(ctx));
  app.route('/api/ai', aiSchemaGenRoutes(ctx));
  app.route('/api/ai/alchemist', aiAlchemistRoutes(ctx));
  app.route('/api/ai/query', aiQueryRoutes(ctx));
  app.route('/api/ai-analytics', aiAnalyticsRoutes(ctx));
  app.route('/api/zveltio-ai', zveltioAIRoutes(ctx));
  return app;
}
```

### 4.4 — Populate `engine/index.ts`

```ts
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { buildAIRoutes } from './routes/index.js';
import { aiProviderManager, initAIProviders } from './lib/ai-provider.js';
import { triggerEmbedding } from './lib/ai-embed-hook.js';

const extension: ZveltioExtension = {
  name: 'ai',
  category: 'intelligence',
  getMigrations() {
    return [
      join(import.meta.dir, 'migrations/001_ai_init.sql'),
      join(import.meta.dir, 'migrations/002_embeddings.sql'),
      join(import.meta.dir, 'migrations/003_search_config.sql'),
      join(import.meta.dir, 'migrations/004_decision_step.sql'),
      join(import.meta.dir, 'migrations/005_task_trigger.sql'),
      join(import.meta.dir, 'migrations/006_query.sql'),
      join(import.meta.dir, 'migrations/007_embed_excluded.sql'),
      join(import.meta.dir, 'migrations/008_memory.sql'),
    ];
  },
  async register(app, ctx) {
    await initAIProviders(ctx.db);

    ctx.services.register('ai.providers', aiProviderManager);
    ctx.services.register('ai.embed', (text: string, opts?: any) =>
      aiProviderManager.embed(text, opts));
    ctx.services.register('ai.chat', (messages: any[], opts?: any) =>
      aiProviderManager.chat(messages, opts));
    ctx.services.register('ai.triggerEmbedding', triggerEmbedding);

    ctx.events.on('record.created', async (evt: any) => {
      try { await triggerEmbedding(ctx.db, evt); } catch { /* non-fatal */ }
    });
    ctx.events.on('record.updated', async (evt: any) => {
      try { await triggerEmbedding(ctx.db, evt); } catch { /* non-fatal */ }
    });

    app.route('/', buildAIRoutes(ctx));
  },
};

export default extension;
```

---

## FAZA 5 — Clean engine of AI references

### 5.1 — `packages/engine/src/index.ts`

- Remove imports: `initAIProviders`, any `aiProviderManager`.
- Remove the `initAIProviders(db).then(...)` branch from the `Promise.all([...])` block (~line 528).

### 5.2 — `packages/engine/src/routes/index.ts`

Remove:
- Imports: `aiRoutes`, `aiChatsRoutes`, `zveltioAIRoutes`, `aiAnalyticsRoutes`, `aiAlchemistRoutes`, `aiQueryRoutes`, `aiSchemaGenRoutes`.
- Mounts (~lines 270-277): all `app.route('/api/ai', …)`, `app.route('/api/zveltio-ai', …)`, `app.route('/api/ai-analytics', …)`.

### 5.3 — `packages/engine/src/lib/extension-loader.ts`

In `buildExtensionInternals()` (~line 408):
- Remove `aiProviderManager` from returned object.
- Remove import: `import { aiProviderManager } from './ai-provider.js';`

In `ExtensionInternals` interface (~line 448):
- Remove `aiProviderManager: any;`

### 5.4 — `packages/sdk/src/extension/index.ts`

In `ExtensionInternals` (line 60):
- Remove `aiProviderManager: any;` and its comment.

Re-build SDK: `cd packages/sdk && bun run build`.

### 5.5 — Verify

- `bun run typecheck` in packages/engine — must pass. If it fails on extensions still using `ctx.internals.aiProviderManager`, note them and fix in FAZA 6.
- `grep -r "aiProviderManager\|initAIProviders" packages/engine/src/` — zero matches.

---

## FAZA 6 — Update consumers

### 6.1 — Find consumers

```bash
grep -rl "ctx\.internals\.aiProviderManager\|aiProviderManager\b" zveltio-extensions/ packages/engine/src/lib/flow-executor.ts
```

Likely candidates: `packages/engine/src/lib/flow-executor.ts` (for `ai_decision` step), possibly `analytics/insights`, `search`, `developer/edge-functions`.

### 6.2 — Replacement pattern

```ts
// BEFORE:
const ai = ctx.internals.aiProviderManager;
const result = await ai.chat(messages);

// AFTER:
const ai = ctx.services.get<any>('ai.providers');
if (!ai) {
  throw new Error('AI extension is required for this feature but is not active.');
}
const result = await ai.chat(messages);
```

For flow `ai_decision` step: if AI is unavailable, mark step as `skipped` with clear log; don't fail the whole flow.

### 6.3 — Add manifest dependency

In `manifest.json` of every consumer extension:

```json
"dependencies": [
  { "name": "ai", "minVersion": "1.0.0" }
]
```

### 6.4 — `flow-executor.ts` (engine, not extension)

Lives in engine but `ai_decision` is an AI step. Approach: `flow-executor.ts` stays in engine, but for step type `ai_decision` it calls `serviceRegistry.get('ai.providers')`. If null → step skipped with reason.

### 6.5 — Verify

`bun run typecheck` clean across engine + extensions. Smoke test: engine running without AI extension, create a flow with `ai_decision`, run it — flow continues, step skipped with clear log.

---

## FAZA 7 — Studio AI pages

### 7.1 — Move pages

```bash
git mv packages/studio/src/routes/'(admin)'/ai zveltio-extensions/ai/studio/src/routes/ai
```

### 7.2 — Bundle config

In `zveltio-extensions/ai/studio/`, configure vite for IIFE bundle (model: `zveltio-extensions/content/page-builder/studio/`). Bundle self-registers via `window.__zveltio.registerRoute({ path: '/ai', ... })`.

### 7.3 — Clean Studio core nav

In `packages/studio/src/routes/(admin)/+layout.svelte`, remove any hardcoded "AI" nav item. Studio reads active extension meta and renders nav dynamically (mechanism added in alpha.64).

### 7.4 — Verify

Engine + studio running. AI active → "AI" nav appears, pages work. AI inactive → no nav, no pages, rest of Studio works.

---

## FAZA 8 — Auto-activate AI on first boot

**File**: `packages/engine/src/index.ts` — function `ensureDefaultExtensions` (~line 273).

Add second check for AI, similar to page-builder:

```ts
async function ensureDefaultExtensions(db: any): Promise<void> {
  const defaults = [
    {
      name: 'content/page-builder',
      display_name: 'Page Builder',
      description: 'Visual CMS page builder',
      category: 'content',
    },
    {
      name: 'ai',
      display_name: 'AI',
      description: 'AI capabilities: chat, embeddings, semantic search, text-to-SQL',
      category: 'intelligence',
    },
  ];

  for (const def of defaults) {
    const existing = await db
      .selectFrom('zv_extension_registry')
      .select('name')
      .where('name', '=', def.name)
      .executeTakeFirst()
      .catch(() => null);
    if (existing) continue;

    const extBase = process.env.EXTENSIONS_DIR
      || join(import.meta.dir, '../../../extensions');
    const engineEntry = join(extBase, def.name, 'engine/index.ts');
    const filesOnDisk = await Bun.file(engineEntry).exists().catch(() => false);
    if (!filesOnDisk) {
      console.log(`ℹ️  ${def.name} not on disk — skipping auto-activate`);
      continue;
    }

    await db.insertInto('zv_extension_registry').values({
      ...def,
      version: '1.0.0',
      is_installed: true,
      is_enabled: true,
      installed_at: new Date(),
      enabled_at: new Date(),
    }).execute().catch(() => {});

    console.log(`🔌 Default extension auto-activated: ${def.name}`);
  }
}
```

---

## FAZA 9 — End-to-end verification

### 9.1 — Smoke test: fresh install

```bash
psql -c "DROP DATABASE IF EXISTS zveltio_dev; CREATE DATABASE zveltio_dev;"
cd packages/engine && bun run dev
```

Expected:
- Bootstrap: 61 core migrations run (AI ones not in core anymore).
- Extension loader: finds `ai` in registry, loads, runs 8 AI migrations.
- Service registry log: `Services: ai.providers, ai.embed, ai.chat, ai.triggerEmbedding`.
- Studio: AI nav visible, /admin/ai page functional.

### 9.2 — Smoke test: without AI

`UPDATE zv_extension_registry SET is_enabled = false WHERE name = 'ai';`

Restart engine. Expected:
- `/api/ai/*` → 404
- `/api/zveltio-ai` → 404
- Studio nav has no "AI"
- Rest (collections, data, users, flows) works
- Flow with `ai_decision` runs; step skipped with log "AI service not available".

### 9.3 — Typecheck + tests

```bash
bun run typecheck    # zero errors
bun run test         # all existing tests pass
```

### 9.4 — Cleanup verification

```bash
grep -r "aiProviderManager\|initAIProviders\|zveltio-ai" packages/engine/src/   # zero
ls packages/engine/src/db/migrations/sql/ | grep -i ai                          # zero
ls packages/engine/src/routes/ | grep -i ai                                     # zero
ls packages/engine/src/lib/ | grep -i ai                                        # zero
```

---

## Recommended execution order

```
FAZA 0  (parallel, ~2h)            independent, anytime
FAZA 1  (1-2 days)                 blocking for everything that follows
FAZA 2  (1 day)                    blocking for FAZA 4
FAZA 3  (~2h)                      structure prep
FAZA 4  (2-3 days)                 main effort
FAZA 5  (~1 day)                   engine cleanup
FAZA 6  (1-2 days)                 consumers
FAZA 7  (1-2 days)                 Studio
FAZA 8  (~2h)                      auto-activate
FAZA 9  (~1 day)                   verification
```

**Total**: ~10-12 days of focused work, spread over ~3 weeks real-time.

## Recommended Git branches

- `refactor/service-registry` — FAZE 1 + 2 (independent PR)
- `refactor/ai-extension` — FAZE 3-8 (large PR, after service-registry merged)
- `cleanup/messaging` — FAZA 0 (independent PR, anytime)

## Definition of done

- [ ] Engine starts without any AI code in it (`grep` confirms)
- [ ] All AI migrations run only on AI extension activation, not at engine bootstrap
- [ ] `ctx.services` works — any extension can publish/consume services
- [ ] Topological loading works — manifest dependencies respected
- [ ] Engine without AI active runs cleanly, no errors in log
- [ ] Engine with AI active has functional parity with previous state
- [ ] All integration tests pass
- [ ] CHANGELOG updated with breaking change note for alpha.67
- [ ] "BaaS" eliminated from messaging
- [ ] `versions.json` reflects reality
