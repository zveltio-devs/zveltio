# 🧩 Zeltio Extensions

Guide to using and creating extensions for Zeltio.

---

## Table of Contents

- [Overview](#overview)
- [Built-in Extensions](#built-in-extensions)
- [Loading Extensions](#loading-extensions)
- [Creating Extensions](#creating-extensions)

---

## Overview

Zeltio uses a **plugin-based architecture** through extensions. Extensions allow adding custom functionality without modifying the core engine.

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

Zeltio includes several built-in extensions:

### AI Extensions

| Extension   | Description                                     |
| ----------- | ----------------------------------------------- |
| **core-ai** | Chat, embeddings, semantic search, AI analytics |

### Automation

| Extension | Description                       |
| --------- | --------------------------------- |
| **flows** | Workflow automation and execution |

### Compliance (Romanian)

| Extension       | Description                     |
| --------------- | ------------------------------- |
| **documents**   | Document management             |
| **efactura**    | Romanian e-Invoicing (eFactura) |
| **procurement** | Public procurement              |

### Content

| Extension        | Description           |
| ---------------- | --------------------- |
| **page-builder** | Dynamic page creation |

### Developer Tools

| Extension          | Description               |
| ------------------ | ------------------------- |
| **edge-functions** | Serverless edge functions |

### Geospatial

| Extension   | Description                  |
| ----------- | ---------------------------- |
| **postgis** | Geographic data with PostGIS |

### Workflow

| Extension      | Description          |
| -------------- | -------------------- |
| **approvals**  | Approval workflows   |
| **checklists** | Checklist management |

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
zeltio/
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
mkdir -p extensions/my-extension/{engine,studio}
```

### Step 2: Create manifest.json

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "A custom extension",
  "engine": {
    "routes": "./engine/routes.ts",
    "index": "./engine/index.ts"
  }
}
```

### Step 3: Create Engine Routes

```typescript
// extensions/my-extension/engine/routes.ts
import { Hono } from 'hono';

const app = new Hono();

app.get('/hello', (c) => {
  return c.json({ message: 'Hello from my extension!' });
});

export default app;
```

### Step 4: Register Extension

Add to main app in `packages/engine/src/routes/index.ts`:

```typescript
import myExtension from '../../extensions/my-extension/engine/routes.ts';

app.route('/api/my-extension', myExtension);
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
