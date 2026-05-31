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

> **As of 1.0.0-beta.1**, extensions ship as **bundled artifacts**
> (`engine/index.js` produced by `zveltio extension pack`), not raw
> `.ts` source. The engine binary refuses to load v1-style manifests
> in production. See the full developer guide at
> [`docs/EXTENSION-DEVELOPER-GUIDE.md`](https://github.com/zveltio-devs/zveltio/blob/master/docs/EXTENSION-DEVELOPER-GUIDE.md).

### Quick start

```bash
# Scaffold a new extension (includes .gitattributes + CI workflow)
zveltio extension create my-feature --category content

cd extensions/content/my-feature

# Write your engine code
edit engine/index.ts

# Bundle + write integrity hash into manifest
zveltio extension pack

# Sanity check before publish
zveltio extension validate
```

### The manifest (v2)

The bundle pipeline writes `engine` and `integrity` blocks for you;
the rest you author by hand:

```json
{
  "name": "content/my-feature",
  "displayName": "My Feature",
  "category": "content",
  "description": "What this extension does, in one sentence.",
  "version": "1.0.0",
  "zveltioMinVersion": "1.0.0",
  "permissions": ["database"],
  "contributes": { "engine": true, "studio": true },
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

### Engine entry point

```typescript
// engine/index.ts
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';
import { myRoutes } from './routes.js';

const extension: ZveltioExtension = {
  name: 'content/my-feature',
  category: 'content',
  mountStrategy: 'subapp', // routes mounted under /ext/content/my-feature/*

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_initial.sql')];
  },

  async register(app, ctx) {
    app.route('/', myRoutes(ctx));
  },
};

export default extension;
```

The host wraps `app` in a sub-app rooted at `/ext/<name>/*`, so
`app.get('/items')` becomes `/ext/content/my-feature/items` on the
engine. Use `mountStrategy: 'global'` only when you genuinely need
a route at the engine root (rare — CDN-style links, dynamic
user-deployed endpoints).

### Isolation tiers

| Tier | `engine.isolation` | Use for | Tradeoff |
|---|---|---|---|
| **Inline** (default) | omit or `"inline"` | First-party / audited code | Max speed, full functionality, no crash isolation |
| **Worker** | `"worker"` | Community / third-party / untrusted code | Crash isolation + no DB credentials in worker. **MANDATORY** for community submissions per [`MARKETPLACE-POLICY.md`](https://github.com/zveltio-devs/zveltio/blob/master/docs/MARKETPLACE-POLICY.md) §2. ~1-2ms IPC overhead per route hit. |
| **Subprocess / WASM** | _not yet implemented_ | True OS sandbox + RSS limit | Future track. See `EXTENSION-DEVELOPER-GUIDE.md` §13.5 for the threat model. |

The engine refuses to enable a non-official extension that doesn't
declare `engine.isolation: "worker"` (override via
`ZVELTIO_ALLOW_INLINE_THIRD_PARTY=1` for trusted self-hosted code).

### Peer dependencies

If your extension uses packages that ship with native bindings (e.g.
`imapflow`, `sharp`, AWS SDK), declare them in `peerDependencies`
**and** set `engine.bundlePeers: true`. The "install peers at enable
time" model never worked on the compiled binary — bundling is the
only path that runs in production.

```json
{
  "peerDependencies": {
    "imapflow": "^1.0.0"
  },
  "engine": { "bundled": true, "bundlePeers": true }
}
```

Install the peer locally (`bun add imapflow`) so `Bun.build` can
resolve it at pack time.

---

## Publishing to the marketplace

> **Controlled launch** at beta.1: community submissions are
> accepted, but every submission lands in `pending` until a
> marketplace admin approves manually. See
> [`MARKETPLACE-POLICY.md`](https://github.com/zveltio-devs/zveltio/blob/master/docs/MARKETPLACE-POLICY.md)
> for review criteria, SLA expectations, and takedown process.

### Step-by-step

```bash
# 1. Generate your signing key (one-time)
zveltio keys generate

# 2. Get your public key for marketplace enrollment
zveltio keys export <keyId>
# Email the JSON to marketplace@zveltio.com — an admin enrolls you
# via `zveltio admin marketplace enroll-publisher` and you receive
# confirmation.

# 3. After you're enrolled, mint a developer token via
# apps.zveltio.com — you'll need it to authenticate publish.
export ZVELTIO_REGISTRY_TOKEN="zvt_..."

# 4. Pack, validate, publish — all-in-one
zveltio extension publish
```

The publish command runs validate → pack → archive → sign → upload.
The registry verifies the publisher-declared archive SHA-256, stores
the signed `.zvext` in R2, and marks the extension `pending` for
review.

### Tracking your submission

```bash
zveltio extension status content/my-feature
# → Status: pending / published / rejected / taken_down + reason
```

You'll also receive email notifications on approve/reject/takedown.

### Updates

To publish a new version, bump `manifest.version` and re-run
`zveltio extension publish`. The new version goes through the same
pending → approved cycle; the old version stays available to
existing installs until the new one is approved.

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
