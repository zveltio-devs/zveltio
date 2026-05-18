# 🧩 Zveltio Extensions

Guide to using and creating extensions for Zveltio.

---

## Table of Contents

- [Overview](#overview)
- [Repository Structure](#repository-structure)
- [Built-in Extensions](#built-in-extensions)
- [Loading Extensions](#loading-extensions)
- [Creating Extensions](#creating-extensions)

---

## Overview

Zveltio uses a **plugin-based architecture** through extensions. Extensions allow adding custom functionality without modifying the core engine.

### Extension Structure

```
extensions/
├── manifest.json          # Extension metadata
├── engine/               # Backend routes and logic
│   ├── index.ts         # Extension entry point
│   ├── routes.ts        # API routes
│   └── migrations/       # Database migrations
└── studio/              # Admin UI
  ├── package.json
  ├── src/
  │   └── index.ts     # UI entry point
  └── pages/           # SvelteKit pages
```

### manifest.json

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "Description of my extension",
  "engine": {
    "routes": "./engine/routes.ts",
    "index": "./engine/index.ts"
  },
  "studio": {
    "routes": "./studio/src",
    "entry": "./studio/src/index.ts"
  }
}
```

---

## Repository Structure

Zveltio uses separate repositories for better modularity:

### zveltio (Core Engine)

The core engine repository contains:

- `packages/engine/` - Main API server
- `packages/cli/` - CLI tools
- `packages/sdk/` - Extension SDK
- `packages/studio/` - Admin UI

### zveltio-extensions (Official Extensions)

The extensions repository contains 50+ production-ready extensions:

- `analytics/` - Insights, quality dashboards
- `auth/` - LDAP, SAML authentication
- `communications/` - IMAP/SMTP mail client
- `compliance/` - GDPR, e-Factura, documents
- `content/` - Page builder, documents, drafts
- `crm/` - Contacts, organizations
- `data/` - Export, import tools
- `developer/` - GraphQL, edge functions, views
- `geospatial/` - PostGIS field types
- `storage/` - Cloud S3 storage
- `workflow/` - Approvals, checklists

**Clone both repositories:**

```bash
git clone https://github.com/zveltio-devs/zveltio.git
git clone https://github.com/zveltio-devs/zveltio-extensions.git
```

### zveltio-registry (Enterprise Registry)

Central registry for licensing and extension marketplace:

- License management
- Extension marketplace
- Authentication & billing

---

## Built-in Extensions

Zveltio includes several built-in extensions:

### AI Extensions (`extensions/ai/`)

| Extension   | Routes                                                       | Description                                                                                                  |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **core-ai** | `/api/ai/alchemist`, `/api/ai/query`, `/api/ai` (schema-gen) | Documents → DB (Alchemist), Text-to-SQL copilot, Prompt → schema generator, native tool-calling AI assistant |

> **Note:** Core AI chat (`/api/ai/chat`), semantic search (`/api/ai/search`), embeddings, and provider management are **engine-core** features, not extension-provided.

### Automation (`extensions/automation/`)

| Extension      | Routes            | Description                                                                                |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| **flows**      | `/api/flows`      | Workflow automation with triggers, conditions, actions, DLQ retry, and idempotency support |
| **approvals**  | `/api/approvals`  | Multi-step approval workflows with configurable reviewers                                  |
| **checklists** | `/api/checklists` | Checklist management tied to records or workflows                                          |

### Billing (`extensions/billing/`)

| Extension   | Routes                | Description                                                                                                                  |
| ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **billing** | `/extensions/billing` | Usage metering (API calls, storage, records per tenant), Stripe webhook integration (HMAC-verified, no SDK), plan management |

**Tables:** `zv_billing_plans`, `zv_usage_events`, `zv_billing_subscriptions`

**Env vars:** `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`

### Communications (`extensions/communications/`)

| Extension | Routes      | Description                                                                                                                                                                                |
| --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **mail**  | `/api/mail` | Full IMAP/SMTP mail client with folder sync, threading, AI compose/reply, and Sieve filter management. IMAP/SMTP passwords are encrypted at rest with AES-256-GCM (`MAIL_ENCRYPTION_KEY`). |

### Compliance – Romanian (`extensions/compliance/ro/`)

| Extension       | Description                             |
| --------------- | --------------------------------------- |
| **documents**   | Romanian compliance document management |
| **efactura**    | Romanian e-Invoicing (eFactura)         |
| **procurement** | Public procurement                      |

### Forms (`extensions/forms/`)

| Extension | Routes              | Description                                                                                                                                                                                                                |
| --------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **forms** | `/extensions/forms` | Drag-and-drop form builder. Public submit endpoint (rate-limited 10/min per IP). Submissions optionally write to any collection. Supports text, textarea, email, number, select, multiselect, checkbox, date, file fields. |

**Public endpoints (no auth):**

- `GET /extensions/forms/public/:slug` — get form schema for embedding
- `POST /extensions/forms/public/:slug/submit` — submit a form response

### Search (`extensions/search/`)

| Extension  | Routes               | Description                                                                                                                                                                              |
| ---------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **search** | `/extensions/search` | Meilisearch and Typesense adapters. Event-driven sync on record create/update/delete. Full re-index via batch of 100. Per-collection searchable/filterable/sortable field configuration. |

**Env vars:** `MEILISEARCH_HOST`, `MEILISEARCH_API_KEY` or `TYPESENSE_HOST`, `TYPESENSE_PORT`, `TYPESENSE_API_KEY`

### SMS (`extensions/sms/`)

| Extension | Routes            | Description                                                                                                                         |
| --------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **sms**   | `/extensions/sms` | Twilio and Vonage/Nexmo providers (raw fetch, no SDK). Template system with `{{variable}}` interpolation. Delivery status webhooks. |

**Env vars:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` or `VONAGE_API_KEY`, `VONAGE_API_SECRET`

### Content (`extensions/content/`)

| Extension              | Routes                                   | Description                                      |
| ---------------------- | ---------------------------------------- | ------------------------------------------------ |
| **page-builder**       | `/api/cms/pages`, `/api/admin/cms/pages` | CMS pages with Tiptap editor, slug routing, i18n |
| **document-templates** | `/api/document-templates`                | HTML/PDF template management and rendering       |
| **documents**          | `/api/documents`                         | Rich text document management                    |
| **drafts**             | `/api/drafts`                            | Draft/publish workflow for any collection        |
| **media**              | `/api/media`                             | File and media management with SeaweedFS         |

### CRM (`extensions/crm/`)

| Extension | Routes     | Description                                                              |
| --------- | ---------- | ------------------------------------------------------------------------ |
| **crm**   | `/api/crm` | Contacts, organizations, transactions with ownership checks on mutations |

### Data (`extensions/data/`)

| Extension  | Routes        | Description                                                                |
| ---------- | ------------- | -------------------------------------------------------------------------- |
| **export** | `/api/export` | CSV/JSON export with validated column allowlist (prevents field injection) |
| **import** | `/api/import` | CSV/JSON import with 100MB size check before reading to memory             |

### Developer Tools (`extensions/developer/`)

| Extension           | Description                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **edge-functions**  | Sandboxed JS worker runtime. 64MB memory watchdog, SSRF blocked, prototype frozen at startup, `eval`/`require`/`process`/`Bun`/`globalThis` blocked. Runs at `/api/fn/*`. |
| **graphql**         | GraphQL endpoint at `/api/graphql` with DataLoader batching (N+1 prevention)                                                                                              |
| **saved-queries**   | Named parametrized queries with role-based access                                                                                                                         |
| **schema-branches** | Schema branching: preview DDL changes on a branch before applying to production                                                                                           |

### Geospatial (`extensions/geospatial/`)

| Extension   | Description                                                                   |
| ----------- | ----------------------------------------------------------------------------- |
| **postgis** | Geographic data with PostGIS field types: `location`, `polygon`, `linestring` |

### Storage (`extensions/storage/`)

| Extension | Routes                        | Description                                                   |
| --------- | ----------------------------- | ------------------------------------------------------------- |
| **cloud** | `/api/cloud`, `/share/:token` | S3 file versioning, soft-delete trash bin, public share links |

### Workflow (`extensions/workflow/`)

| Extension      | Description                   |
| -------------- | ----------------------------- |
| **approvals**  | Multi-step approval workflows |
| **checklists** | Checklist management          |

---

## Loading Extensions

### Enable Extensions

Add extensions to your environment:

```env
# Comma-separated list of extension IDs
ZVELTIO_EXTENSIONS=graphql,edge-functions,storage/cloud
```

Extensions are loaded from the `zveltio-extensions/` directory:

**Option 1: Using EXTENSIONS_DIR**

```bash
export EXTENSIONS_DIR=/path/to/zveltio-extensions
```

**Option 2: Symlink**

```bash
cd zveltio
ln -s ../zveltio-extensions extensions
```

**Option 3: Clone in parent directory**

```
project/
├── zveltio/
├── zveltio-extensions/  # extensions loaded from here
```

### Extension Initialization

Extensions are initialized when the engine starts:

```typescript
// packages/engine/src/lib/extension-loader.ts
import { loadExtensions } from './lib/extension-loader.ts';

await loadExtensions();
```

---

## Creating Extensions

### Prerequisites

Before creating an extension:

1. Clone the `zveltio-extensions` repository
2. Set `EXTENSIONS_DIR` to point to your extensions folder
3. Ensure `ZVELTIO_EXTENSIONS` env var includes your extension

### Step 1: Create Extension Directory

```bash
mkdir -p category/my-extension/{engine/migrations,studio/src}
```

### Step 2: Create manifest.json

```json
{
  "name": "my-extension",
  "package": "@zveltio/ext-my-extension",
  "category": "developer",
  "displayName": "My Extension",
  "description": "A custom extension",
  "version": "1.0.0",
  "zveltioMinVersion": "1.0.0",
  "runtime": "js",
  "permissions": ["database"],
  "contributes": {
    "engine": true,
    "studio": true,
    "fieldTypes": []
  }
}
```

### Runtime: `js` (default) vs `wasm`

Zveltio supports two extension runtimes, picked via the manifest's
`runtime` field:

| Runtime | Isolation | Languages | When to use |
|---|---|---|---|
| `js` (default) | Shared V8 heap; sandboxed via capability policy | TypeScript / JavaScript | Anything that needs Bun's full module ecosystem (Hono, Kysely, …) |
| `wasm` | Separate WebAssembly linear memory; no V8 heap access | Rust, TinyGo, AssemblyScript, … | Pure-compute extensions where strict isolation matters more than Bun ergonomics |

For `wasm`, drop a precompiled `engine/extension.wasm` into your
extension directory. The host instantiates it with a capability-bound
imports table (db, fetch, crypto, env, fs — each gated by the same
policy that gates JS extensions). The module must export a `register()`
function; `shutdown()` is optional.

CPU + memory ceilings come from the same policy quotas used for JS
extensions (`memoryKbMax`, `cpuMsPerRequest`). See [Security](/security)
for the policy model.

### Step 3: Create Engine Entry Point

```typescript
// category/my-extension/engine/index.ts
import type { ZveltioExtension } from '@zveltio/extensions/extension';
import { myRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'category/my-extension',
  category: 'developer',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_my_extension.sql')];
  },

  async register(app, ctx) {
    app.route('/api/my-extension', myRoutes(ctx.db, ctx.auth));
  },
};

export default extension;
```

### Step 4: Create Routes

```typescript
// category/my-extension/engine/routes.ts
import { Hono } from 'hono';
import { Database } from '@zveltio/extensions/database';
import { checkPermission } from '@zveltio/extensions/auth';

export function myRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth guard
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });

  app.get('/hello', (c) => {
    return c.json({ message: 'Hello from my extension!' });
  });

  return app;
}
```

---

## Extension API

### Using @zveltio/extensions Package

The `@zveltio/extensions` package provides shared types and helpers:

```typescript
// Import shared types
import { Database } from '@zveltio/extensions/database';
import { checkPermission } from '@zveltio/extensions/auth';
import { ZveltioExtension } from '@zveltio/extensions/extension';
```

### Database Access

```typescript
import { Database } from '@zveltio/extensions/database';

export async function myRoute(db: Database) {
  const result = await db.selectFrom('users').selectAll().execute();
  return result;
}
```

### Cache Access

```typescript
import { getCache } from '@zveltio/extensions/cache';

await cache.setex('key', 3600, 'value');
```

### Webhook Triggering

```typescript
import { triggerWebhooks } from '@zveltio/extensions/webhooks';

await triggerWebhooks('my-extension.event', { data: '...' });
```

---

## Best Practices

1. **Use TypeScript** - Maintain type safety
2. **Follow naming conventions** - Use consistent IDs
3. **Handle errors gracefully** - Return proper error responses
4. **Document your extension** - Include README and comments
5. **Test thoroughly** - Include unit and integration tests

## Troubleshooting

**Extension not loading?**

- Check `EXTENSIONS_DIR` env var points to correct path
- Verify `ZVELTIO_EXTENSIONS` includes your extension name
- Check logs for extension load errors

**TypeScript errors?**

- Run `bun install` to ensure dependencies are installed
- Verify `@zveltio/sdk` is in `peerDependencies`

**Need help?**

- Check [zveltio-extensions repo](https://github.com/zveltio-devs/zveltio-extensions)
- Review example extensions in the repository
