# 🧩 Zveltio Extensions

Guide to using and creating extensions for Zveltio.

---

## Table of Contents

- [Overview](#overview)
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

## Built-in Extensions

Zveltio includes several built-in extensions:

### AI Extensions (`extensions/ai/`)

| Extension   | Routes                                         | Description                                                                       |
| ----------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| **core-ai** | `/api/ai/alchemist`, `/api/ai/query`, `/api/ai` (schema-gen) | Documents → DB (Alchemist), Text-to-SQL copilot, Prompt → schema generator, native tool-calling AI assistant |

> **Note:** Core AI chat (`/api/ai/chat`), semantic search (`/api/ai/search`), embeddings, and provider management are **engine-core** features, not extension-provided.

### Automation (`extensions/automation/`)

| Extension | Routes      | Description                                                                                 |
| --------- | ----------- | ------------------------------------------------------------------------------------------- |
| **flows** | `/api/flows` | Workflow automation with triggers, conditions, actions, DLQ retry, and idempotency support |

### Communications (`extensions/communications/`)

| Extension | Routes     | Description                                                                    |
| --------- | ---------- | ------------------------------------------------------------------------------ |
| **mail**  | `/api/mail` | Full IMAP/SMTP mail client with folder sync, threading, AI compose/reply, and Sieve filter management |

### Compliance – Romanian (`extensions/compliance/ro/`)

| Extension       | Description                       |
| --------------- | --------------------------------- |
| **documents**   | Romanian compliance document management |
| **efactura**    | Romanian e-Invoicing (eFactura)   |
| **procurement** | Public procurement                |

### Content (`extensions/content/`)

| Extension              | Routes                                  | Description                                   |
| ---------------------- | --------------------------------------- | --------------------------------------------- |
| **page-builder**       | `/api/cms/pages`, `/api/admin/cms/pages` | CMS pages with Tiptap editor, slug routing, i18n |
| **document-templates** | `/api/document-templates`               | HTML/PDF template management and rendering    |

### Developer Tools (`extensions/developer/`)

| Extension          | Description                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **edge-functions** | Studio admin UI only. The sandbox runtime (SSRF protection, 64 MB memory watchdog, prototype freeze) runs in **engine core** at `/api/edge-functions` and `/api/fn/*`. |

### Geospatial (`extensions/geospatial/`)

| Extension   | Description                                  |
| ----------- | -------------------------------------------- |
| **postgis** | Geographic data with PostGIS field types: `location`, `polygon`, `linestring` |

### Storage (`extensions/storage/`)

| Extension | Routes                       | Description                                               |
| --------- | ---------------------------- | --------------------------------------------------------- |
| **cloud** | `/api/cloud`, `/share/:token` | S3 file versioning, soft-delete trash bin, public share links |

### Workflow (`extensions/workflow/`)

| Extension      | Description              |
| -------------- | ------------------------ |
| **approvals**  | Multi-step approval workflows |
| **checklists** | Checklist management     |

---

## Loading Extensions

### Enable Extensions

Add extensions to your environment:

```env
# Comma-separated list of extension IDs
ZVELTIO_EXTENSIONS=core-ai,flows,page-builder
```

Extensions are loaded from the `extensions/` directory:

```
zveltio/
├── extensions/
│   ├── ai/
│   │   └── core-ai/
│   │       ├── manifest.json
│   │       ├── engine/
│   │       └── studio/
│   └── ...
└── packages/
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

### Step 1: Create Extension Directory

```bash
mkdir -p extensions/category/my-extension/{engine/migrations,studio/src}
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
  "zveltioMinVersion": "2.0.0",
  "permissions": ["database"],
  "contributes": {
    "engine": true,
    "studio": true,
    "fieldTypes": []
  }
}
```

### Step 3: Create Engine Entry Point

```typescript
// extensions/category/my-extension/engine/index.ts
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
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
// extensions/category/my-extension/engine/routes.ts
import { Hono } from 'hono';
import type { Database } from '../../../../packages/engine/src/db/index.js';
import { checkPermission } from '../../../../packages/engine/src/lib/permissions.js';

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

### Access Database

```typescript
import { getDb } from '../../packages/engine/src/db/index.ts';

const db = getDb();
const result = await db.selectFrom('users').selectAll().execute();
```

### Use Cache

```typescript
import { getCache } from '../../packages/engine/src/lib/cache.ts';

const cache = getCache();
await cache.setex('key', 3600, 'value');
```

### Trigger Webhooks

```typescript
import { triggerWebhooks } from '../../packages/engine/src/lib/webhooks.ts';

await triggerWebhooks('my-extension.event', { data: '...' });
```

---

## Best Practices

1. **Use TypeScript** - Maintain type safety
2. **Follow naming conventions** - Use consistent IDs
3. **Handle errors gracefully** - Return proper error responses
4. **Document your extension** - Include README and comments
5. **Test thoroughly** - Include unit and integration tests
