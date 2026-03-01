# CLAUDE CODE INSTRUCTIONS — Zveltio Complete Migration Fix

> **Context:** Zveltio este un BaaS (Backend-as-a-Service). Avem un OLD REPO (`src/`) și un NEW REPO (`packages/`).
> Acest document conține TOATE task-urile necesare pentru a aduce `packages/` la paritate completă cu `src/`.
> Execută task-urile **în ordinea dată**. Fiecare task are secțiunea lui cu fișiere sursă, destinație, și cod.
> **Nu sări peste niciun task. Nu reimplementa ce există deja. Citește fișierele sursă și adaptează-le.**

---

## REGULI ABSOLUTE — Respectă-le la FIECARE linie de cod

```
1. Runtime = Bun, NU Node.js
   ✅ Bun.file(), Bun.serve(), Bun.spawn()
   ❌ fs/promises, child_process, http module

2. Database = Kysely, NU raw SQL concatenat
   ✅ db.selectFrom('table').where('col', '=', val).execute()
   ✅ sql`ALTER TABLE ${sql.id(name)} ...`.execute(db)
   ❌ db.execute('SELECT * FROM ' + tableName)

3. DDL = DDLManager + ddl-queue, tranzacțional
   ✅ DDLManager.createCollection(db, def)
   ❌ ALTER TABLE direct în route handlers

4. Fields = FieldTypeRegistry
   ✅ fieldTypeRegistry.get(type), fieldTypeRegistry.has(type)
   ❌ switch/case pe field.type

5. Studio = Svelte 5 runes, NU Svelte 4 stores
   ✅ let count = $state(0); let doubled = $derived(count * 2)
   ❌ import { writable } from 'svelte/store'
   ✅ import { page } from '$app/state'
   ❌ import { page } from '$app/stores'

6. Studio API = $lib/api.js
   ✅ import { api } from '$lib/api.js'; api.get('/api/...')
   ❌ fetch('/api/...') direct, engineClient.request()

7. Route pattern standard (engine):
   export function myRoutes(db: Database, auth: any): Hono {
     const app = new Hono();
     // ... routes
     return app;
   }

8. Icons = @lucide/svelte
   ✅ import { Settings } from '@lucide/svelte'
   ❌ heroicons, phosphor, etc.

9. Styling = TailwindCSS 4 + DaisyUI
   ✅ class="btn btn-primary", class="card bg-base-100"
   ❌ CSS modules, styled-components

10. Extensii NU importă din packages/engine/ direct
    ✅ Primesc tot prin ExtensionContext (ctx.db, ctx.auth)
```

---

## FAZA 0 — FIX IMEDIAT (15 minute)

### TASK 0.1 — Înregistrează rutele existente dar neconectate

**Fișier:** `packages/engine/src/routes/index.ts`

Caută funcția `registerRoutes` (sau echivalentul) și adaugă aceste importuri + înregistrări.
Verifică mai întâi că fiecare fișier există în `packages/engine/src/routes/`. Dacă nu există, sari la task-ul de portare corespunzător.

```typescript
// Adaugă importuri (verifică că fișierele există):
import { schemaBranchesRoutes } from './schema-branches.js';
import { apiDocsRoutes } from './api-docs.js';
import { databaseRoutes } from './database.js';
import { aiSchemaRoutes } from './ai-schema-gen.js';

// Adaugă înregistrări (după ultimul app.route existent):
app.route('/api/schema', schemaBranchesRoutes);
app.route('/api/docs', apiDocsRoutes);
app.route('/api/database', databaseRoutes);
app.route('/api/ai/schema', aiSchemaRoutes);
```

**Verificare:** Dacă vreuna din aceste rute acceptă `(db, auth)` ca parametri, apelează cu `schemaBranchesRoutes(db, auth)` etc. Uită-te la export-ul din fiecare fișier ca să vezi signatura.

### TASK 0.2 — Verifică pages.ts

Verifică dacă `packages/engine/src/routes/pages.ts` este înregistrat în `routes/index.ts`. Dacă nu:

```typescript
import { pagesRoutes } from './pages.js';
app.route('/api/pages', pagesRoutes(db, auth));
```

---

## FAZA 1 — REALTIME + WEBSOCKET (Critică)

### TASK 1.1 — Portează WebSocket handler

**Sursă:** `src/routes/ws.ts`
**Destinație:** `packages/engine/src/routes/ws.ts`

Citește `src/routes/ws.ts` din old repo. Adaptează:
- Înlocuiește `import { db } from '../db/index.js'` cu parametru `(db: Database, auth: any)`
- Folosește Bun WebSocket nativ sau Hono upgrade:

```typescript
import { Hono } from 'hono';
import type { Database } from '../db/index.js';

export function wsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.get('/ws', async (c) => {
    // Bun native WebSocket upgrade
    const server = c.env?.server;
    if (!server) return c.text('WebSocket not supported', 500);

    const upgraded = server.upgrade(c.req.raw, {
      data: { db, auth }
    });
    if (!upgraded) return c.text('Upgrade failed', 400);
    return new Response(null);
  });

  return app;
}
```

**Important:** Old repo-ul folosește PostgreSQL LISTEN/NOTIFY pentru realtime. Portează și logica de listener.

### TASK 1.2 — Portează Realtime listener

**Sursă:** `src/routes/realtime.ts` + orice `LISTEN/NOTIFY` logic din `src/`
**Destinație:** `packages/engine/src/routes/realtime.ts` + `packages/engine/src/lib/realtime.ts`

Portează cu pattern standard. Asigură-te că:
- Conectarea la PostgreSQL pentru LISTEN se face cu un `pg` client separat (nu prin Kysely)
- `pg_notify('zveltio_changes', payload)` este emis la CRUD operations în `data.ts`
- Clienții WebSocket primesc evenimente pe baza subscripțiilor lor

Înregistrează în `routes/index.ts`:
```typescript
import { realtimeRoutes } from './realtime.js';
app.route('/api/realtime', realtimeRoutes(db, auth));
```

---

## FAZA 2 — FLOW EXECUTOR (Critică)

### TASK 2.1 — Portează Flow Executor

**Sursă:** `src/lib/flow-executor.ts` (dacă există) sau `src/routes/flows.ts`
**Destinație:** `packages/engine/src/lib/flow-executor.ts`

Citește `src/lib/flow-executor.ts` din old repo. Acesta execută pașii unui flow:
- Condiții (if/else)
- Acțiuni (send email, create record, call webhook, etc.)
- Run history logging

Adaptează importurile la noul pattern. Conectează cu `flow-scheduler.ts` existent:

```typescript
// În packages/engine/src/lib/flow-scheduler.ts, importă executorul:
import { executeFlow } from './flow-executor.js';

// Unde scheduler-ul găsește un flow due, apelează:
await executeFlow(db, flow);
```

### TASK 2.2 — Portează Flows Routes

**Sursă:** `src/routes/flows.ts`
**Destinație:** `packages/engine/src/routes/flows.ts`

Pattern standard:
```typescript
export function flowsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();
  // GET / — list flows
  // POST / — create flow
  // GET /:id — get flow
  // PATCH /:id — update flow
  // DELETE /:id — delete flow
  // POST /:id/execute — manual trigger
  // GET /:id/runs — run history
  return app;
}
```

Înregistrează:
```typescript
import { flowsRoutes } from './flows.js';
app.route('/api/flows', flowsRoutes(db, auth));
```

---

## FAZA 3 — GRAPHQL (Critică)

### TASK 3.1 — Portează GraphQL

**Sursă:** `src/routes/graphql.ts`
**Destinație:** `packages/engine/src/routes/graphql.ts`

Old repo-ul generează automat un schema GraphQL din colecțiile existente (zv_collections + zv_fields). Portează complet.

**Dependență:** Verifică ce librărie GraphQL folosește old repo-ul (probabil `graphql` sau `graphql-yoga`). Adaugă la `packages/engine/package.json`:
```bash
cd packages/engine && bun add graphql graphql-yoga
```

Înregistrează:
```typescript
import { graphqlRoutes } from './graphql.js';
app.route('/api/graphql', graphqlRoutes(db, auth));
```

---

## FAZA 4 — RUTE API LIPSĂ (în ordine de prioritate)

### TASK 4.1 — Media Library

**Sursă:** `src/routes/media.ts`
**Destinație:** `packages/engine/src/routes/media.ts`

ATENȚIE: `/api/storage` = upload/download fișiere. `/api/media` = Media Library cu folders, tags, organizare galerie. Sunt distincte.

Portează cu pattern standard. Verifică că tabelele `zv_media_folders` și `zv_media_files` există în migrări. Dacă nu, creează:

**Fișier migrare:** `packages/engine/src/db/migrations/sql/018_media_library.sql`
```sql
CREATE TABLE IF NOT EXISTS zv_media_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  parent_id UUID REFERENCES zv_media_folders(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS zv_media_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id UUID REFERENCES zv_media_folders(id) ON DELETE SET NULL,
  file_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE INDEX idx_media_files_folder ON zv_media_files(folder_id);
CREATE INDEX idx_media_files_tags ON zv_media_files USING GIN(tags);
```

Înregistrează:
```typescript
import { mediaRoutes } from './media.js';
app.route('/api/media', mediaRoutes(db, auth));
```

### TASK 4.2 — Backup & Restore

**Sursă:** `src/routes/backup.ts`
**Destinație:** `packages/engine/src/routes/backup.ts`

**CRITIC — Bun, nu Node:**
```typescript
// ❌ Node
import { spawn } from 'child_process';
const proc = spawn('pg_dump', args);

// ✅ Bun
const proc = Bun.spawn(['pg_dump', ...args], { stdout: 'pipe' });
const output = await new Response(proc.stdout).text();
```

Endpoints necesare:
- `POST /api/backup` — creează backup (pg_dump)
- `GET /api/backup` — listează backup-uri
- `GET /api/backup/:id` — descarcă backup
- `POST /api/backup/:id/restore` — restaurează (psql)
- `DELETE /api/backup/:id` — șterge backup

Înregistrează:
```typescript
import { backupRoutes } from './backup.js';
app.route('/api/backup', backupRoutes(db, auth));
```

### TASK 4.3 — Multi-Tenancy

**Surse:**
- `src/lib/tenant-manager.ts` → `packages/engine/src/lib/tenant-manager.ts`
- `src/middleware/tenant.ts` → `packages/engine/src/middleware/tenant.ts`
- `src/routes/tenants.ts` → `packages/engine/src/routes/tenants.ts`

Schema-per-tenant: un PostgreSQL schema separat per tenant, cu:
- Rezolvare tenant din subdomain, header `X-Tenant-Slug`, sau env var
- Suport environments (prod/staging/dev) per tenant
- Provisionare automată schema PostgreSQL
- Cache Valkey

Adaptări:
- `db` și `cache` din `'../db/index.js'`
- Elimină importuri Node.js
- `checkPermission` din `'../lib/permissions.js'`

Migrare: `src/db/migrations/sql/020_multitenancy.sql` (creează din old repo)

Înregistrează middleware ÎNAINTE de rute:
```typescript
import { tenantMiddleware } from './middleware/tenant.js';
app.use('*', tenantMiddleware);
```

Și ruta:
```typescript
import { tenantsRoutes } from './tenants.js';
app.route('/api/tenants', tenantsRoutes(db, auth));
```

### TASK 4.4 — Approval Workflows

**Sursă:** `src/routes/approvals.ts`
**Destinație:** `packages/engine/src/routes/approvals.ts`

Portează cu pattern standard. Endpoints:
- CRUD workflows
- Submit record for approval
- Review/Approve/Reject cu comments
- SLA tracking

Migrare dacă nu există: `packages/engine/src/db/migrations/sql/019_approvals.sql`

Înregistrează:
```typescript
import { approvalsRoutes } from './approvals.js';
app.route('/api/approvals', approvalsRoutes(db, auth));
```

### TASK 4.5 — Drafts System

**Sursă:** `src/routes/drafts.ts`
**Destinație:** `packages/engine/src/routes/drafts.ts`

Pattern standard. Salvare records ca draft înainte de publish.

Înregistrează:
```typescript
import { draftsRoutes } from './drafts.js';
app.route('/api/drafts', draftsRoutes(db, auth));
```

### TASK 4.6 — GDPR Compliance

**Sursă:** `src/routes/gdpr.ts`
**Destinație:** `packages/engine/src/routes/gdpr.ts`

Endpoints:
- `GET /api/gdpr/export` — export toate datele utilizatorului (Art. 20)
- `DELETE /api/gdpr/account` — ștergere cont și date (Art. 17)
- `GET /api/gdpr/portability` — export portabil (JSON)

Înregistrează:
```typescript
import { gdprRoutes } from './gdpr.js';
app.route('/api/gdpr', gdprRoutes(db, auth));
```

### TASK 4.7 — Saved Queries

**Sursă:** `src/routes/saved-queries.ts`
**Destinație:** `packages/engine/src/routes/saved-queries.ts`

Pattern standard. CRUD pentru saved queries din API Playground.

Înregistrează:
```typescript
import { savedQueriesRoutes } from './saved-queries.js';
app.route('/api/saved-queries', savedQueriesRoutes(db, auth));
```

### TASK 4.8 — Data Validation

**Sursă:** `src/routes/validation.ts`
**Destinație:** `packages/engine/src/routes/validation.ts`

Pattern standard.

Înregistrează:
```typescript
import { validationRoutes } from './validation.js';
app.route('/api/validation', validationRoutes(db, auth));
```

### TASK 4.9 — Data Quality Dashboard

**Sursă:** `src/routes/data-quality.ts` (sau similar)
**Destinație:** `packages/engine/src/routes/quality.ts`

Pattern standard.

Înregistrează:
```typescript
import { qualityRoutes } from './quality.js';
app.route('/api/quality', qualityRoutes(db, auth));
```

### TASK 4.10 — Insights

**Sursă:** `src/routes/insights.ts`
**Destinație:** `packages/engine/src/routes/insights.ts`

Pattern standard.

Înregistrează:
```typescript
import { insightsRoutes } from './insights.js';
app.route('/api/insights', insightsRoutes(db, auth));
```

### TASK 4.11 — Admin Pages (CMS)

**Sursă:** `src/routes/admin-pages.ts`
**Destinație:** `packages/engine/src/routes/admin-pages.ts`

Pattern standard. Include sitemap generation.

Înregistrează:
```typescript
import { adminPagesRoutes } from './admin-pages.js';
app.route('/api/admin/pages', adminPagesRoutes(db, auth));
```

### TASK 4.12 — Sitemap Generator

Adaugă în `packages/engine/src/routes/index.ts` (sau în pages routes):

```typescript
app.get('/api/sitemap.xml', async (c) => {
  const siteUrl = process.env.SITE_URL || 'https://example.com';
  const pages = await db
    .selectFrom('zv_pages')
    .select(['slug', 'updated_at', 'is_homepage'])
    .where('is_active', '=', true)
    .orderBy('title', 'asc')
    .execute();

  const urls = pages.map((page: any) => {
    const loc = page.is_homepage ? siteUrl : `${siteUrl}/${page.slug}`;
    const lastmod = new Date(page.updated_at).toISOString().split('T')[0];
    const priority = page.is_homepage ? '1.0' : '0.8';
    return `<url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><priority>${priority}</priority></url>`;
  }).join('\n');

  c.header('Content-Type', 'application/xml');
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
});
```

### TASK 4.13 — Document Templates

**Sursă:** `src/routes/document-templates.ts`
**Destinație:** `packages/engine/src/routes/document-templates.ts`

Pattern standard.

Înregistrează:
```typescript
import { documentTemplatesRoutes } from './document-templates.js';
app.route('/api/document-templates', documentTemplatesRoutes(db, auth));
```

### TASK 4.14 — Documents Management

**Sursă:** `src/routes/documents.ts`
**Destinație:** `packages/engine/src/routes/documents.ts`

Pattern standard.

Înregistrează:
```typescript
import { documentsRoutes } from './documents.js';
app.route('/api/documents', documentsRoutes(db, auth));
```

---

## FAZA 5 — AI COMPLET

### TASK 5.1 — Verifică extensia ai/core-ai

Deschide `extensions/ai/core-ai/engine/routes.ts` și verifică că acoperă:
- CRUD provideri AI
- Chat completion
- Embeddings generation
- Semantic search (RAG)
- Dacă lipsesc, adaugă-le.

### TASK 5.2 — Portează Z-AI Engine

**Sursă:** `src/lib/zveltio-ai/` (tot directorul)
**Destinație:** `extensions/ai/core-ai/engine/zveltio-ai/` (sau `packages/engine/src/lib/zveltio-ai/`)

Fișiere de portat:
- `src/lib/zveltio-ai/engine.ts` — ZAIEngine class
- `src/lib/zveltio-ai/tools.ts` — AI tools system
- `src/lib/zveltio-ai/types.ts` — TypeScript types

Și rutele:
```typescript
// În extensia ai/core-ai sau în engine:
import { zveltioAIRoutes } from './zveltio-ai-routes.js';
app.route('/api/zveltio-ai', zveltioAIRoutes(db, auth));
```

### TASK 5.3 — AI Analytics

**Sursă:** `src/routes/ai-analytics.ts`
**Destinație:** `extensions/ai/core-ai/engine/analytics.ts` (sau route separată)

Portează usage tracking, cost analytics, token consumption.

Înregistrează:
```typescript
app.route('/api/ai-analytics', aiAnalyticsRoutes(db, auth));
```

### TASK 5.4 — AI Admin Routes

Verifică dacă `extensions/ai/core-ai/engine/routes.ts` include admin endpoints (manage providers, toggle features, view usage). Dacă nu, adaugă pe baza `src/routes/ai-admin.ts`.

---

## FAZA 6 — CHECKLIST & WORKFLOW EXTENSIONS

### TASK 6.1 — Checklist Templates Extension

Verifică dacă `extensions/workflow/checklists/` are implementare reală. Dacă nu:

**Sursă:** `src/routes/checklist-templates.ts` + `src/routes/checklist-responses.ts`
**Destinație:** `extensions/workflow/checklists/engine/`

Creează extensia cu pattern standard:
```typescript
const extension: ZveltioExtension = {
  name: 'workflow/checklists',
  category: 'workflow',
  getMigrations() { return [join(import.meta.dir, 'migrations/001_checklists.sql')]; },
  async register(app, ctx) {
    app.route('/api/checklist-templates', checklistTemplatesRoutes(ctx.db, ctx.auth));
    app.route('/api/checklist-responses', checklistResponsesRoutes(ctx.db, ctx.auth));
  },
};
```

### TASK 6.2 — Approvals Extension

Verifică `extensions/workflow/approvals/`. Dacă nu are implementare reală, portează din `src/routes/approvals.ts`.

---

## FAZA 7 — STUDIO COMPONENTS

### TASK 7.1 — RichTextEditor (PRIORITATE MAXIMĂ)

**Sursă:** `src/lib/components/fields/RichTextEditor.svelte`
**Destinație:** `packages/studio/src/lib/components/fields/RichTextEditor.svelte`

Verifică că Tiptap deps sunt în `packages/studio/package.json`:
```bash
cd packages/studio && bun add @tiptap/core @tiptap/starter-kit @tiptap/extension-link @tiptap/extension-image @tiptap/extension-table @tiptap/extension-table-row @tiptap/extension-table-cell @tiptap/extension-table-header @tiptap/pm
```

Portare:
- Înlocuiește orice `$store` cu `$state`/`$derived`
- Înlocuiește `engineClient.request()` cu `api` din `$lib/api.js`
- Folosește runes Svelte 5 syntax

### TASK 7.2 — JSONEditor

**Sursă:** `src/lib/components/fields/JSONEditor.svelte`
**Destinație:** `packages/studio/src/lib/components/fields/JSONEditor.svelte`

Svelte 5 runes. `$bindable` prop pentru value.

### TASK 7.3 — LocationField + MapPicker

**Sursă:** `src/lib/components/fields/LocationField.svelte` + `MapPicker.svelte`
**Destinație:** `packages/studio/src/lib/components/fields/`

Verifică dependența Leaflet: `bun add leaflet @types/leaflet` dacă nu există.

### TASK 7.4 — ColorPicker

**Sursă:** `src/lib/components/fields/ColorPicker.svelte`
**Destinație:** `packages/studio/src/lib/components/fields/ColorPicker.svelte`

### TASK 7.5 — FilePicker

**Sursă:** `src/lib/components/fields/FilePicker.svelte`
**Destinație:** `packages/studio/src/lib/components/fields/FilePicker.svelte`

### TASK 7.6 — ConstraintEditor (implementare reală, nu stub)

**Sursă:** `src/lib/components/admin/ConstraintEditor/ConstraintEditor.svelte`
**Destinație:** `packages/studio/src/lib/components/admin/ConstraintEditor.svelte`

Props: `tableName: string`. Afișează FK constraints, permite drop.

### TASK 7.7 — RelationshipManager (implementare reală)

**Sursă:** `src/lib/components/admin/RelationshipManager/RelationshipManager.svelte`
**Destinație:** `packages/studio/src/lib/components/admin/RelationshipManager.svelte`

Props: `tableName: string`, `constraints: Constraint[]`.

### TASK 7.8 — MetadataSettings (implementare reală)

**Sursă:** `src/lib/components/admin/MetadataSettings/MetadataSettings.svelte`
**Destinație:** `packages/studio/src/lib/components/admin/MetadataSettings.svelte`

### TASK 7.9 — StatsView (implementare reală)

**Sursă:** `src/lib/components/views/StatsView/StatsView.svelte`
**Destinație:** `packages/studio/src/lib/components/views/StatsView.svelte`

### TASK 7.10 — Field components index

Creează/actualizează `packages/studio/src/lib/components/fields/index.ts`:
```typescript
export { default as RichTextEditor } from './RichTextEditor.svelte';
export { default as JSONEditor } from './JSONEditor.svelte';
export { default as LocationField } from './LocationField.svelte';
export { default as MapPicker } from './MapPicker.svelte';
export { default as ColorPicker } from './ColorPicker.svelte';
export { default as FilePicker } from './FilePicker.svelte';
```

---

## FAZA 8 — STUDIO PAGES LIPSĂ

### TASK 8.1 — Media Library Page

**Sursă:** `src/routes/admin/media/+page.svelte`
**Destinație:** `packages/studio/src/routes/admin/media/+page.svelte`

Portare:
- `fetch()` → `api.get/post()` din `$lib/api.js`
- `$store` → `$state`/`$derived`
- `$: ` → `$derived()` sau `$effect()`

Adaugă în `coreNav` din `packages/studio/src/routes/admin/+layout.svelte`:
```typescript
import { Image } from '@lucide/svelte';
{ href: `${base}/media`, icon: Image, label: 'Media' },
```

### TASK 8.2 — Flows Page

**Sursă:** `src/routes/admin/flows/`
**Destinație:** `packages/studio/src/routes/admin/flows/+page.svelte`

Adaugă în `coreNav`:
```typescript
import { Workflow } from '@lucide/svelte';
{ href: `${base}/flows`, icon: Workflow, label: 'Flows' },
```

### TASK 8.3 — Tenants Page

**Sursă:** `src/routes/admin/tenants/`
**Destinație:** `packages/studio/src/routes/admin/tenants/+page.svelte`

Adaugă în `coreNav`:
```typescript
import { Building2 } from '@lucide/svelte';
{ href: `${base}/tenants`, icon: Building2, label: 'Tenants' },
```

### TASK 8.4 — Backup Settings Page

**Sursă:** `src/routes/admin/settings/backup/`
**Destinație:** `packages/studio/src/routes/admin/settings/backup/+page.svelte`

### TASK 8.5 — Approvals Page

**Sursă:** `src/routes/admin/approvals/`
**Destinație:** `packages/studio/src/routes/admin/approvals/+page.svelte`

### TASK 8.6 — Schema Branches Page

**Destinație:** `packages/studio/src/routes/admin/schema-branches/+page.svelte`

Adaugă în `coreNav`:
```typescript
import { GitBranch } from '@lucide/svelte';
{ href: `${base}/schema-branches`, icon: GitBranch, label: 'Schema Branches' },
```

---

## FAZA 9 — SDK COMPLET

### TASK 9.1 — HTTP Client

**Destinație:** `packages/sdk/src/client.ts`

Creează un client HTTP real pe baza `src/lib/api-client.ts`:

```typescript
export interface ZveltioClientConfig {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export class ZveltioClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: ZveltioClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'X-API-Key': config.apiKey } : {}),
      ...config.headers,
    };
  }

  async get<T = any>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers, credentials: 'include' });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return res.json();
  }

  async post<T = any>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST', headers: this.headers, credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
    return res.json();
  }

  async patch<T = any>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH', headers: this.headers, credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status}`);
    return res.json();
  }

  async delete<T = any>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE', headers: this.headers, credentials: 'include',
    });
    if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
    return res.json();
  }

  async upload<T = any>(path: string, formData: FormData): Promise<T> {
    const headers = { ...this.headers };
    delete headers['Content-Type']; // Let browser set multipart
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST', headers, credentials: 'include', body: formData,
    });
    if (!res.ok) throw new Error(`Upload ${path} failed: ${res.status}`);
    return res.json();
  }

  // Collection helpers
  collection(name: string) {
    return {
      list: (params?: { page?: number; limit?: number; sort?: string; order?: string; search?: string; filter?: Record<string, any> }) => {
        const qs = new URLSearchParams();
        if (params?.page) qs.set('page', String(params.page));
        if (params?.limit) qs.set('limit', String(params.limit));
        if (params?.sort) qs.set('sort', params.sort);
        if (params?.order) qs.set('order', params.order);
        if (params?.search) qs.set('search', params.search);
        if (params?.filter) qs.set('filter', JSON.stringify(params.filter));
        return this.get(`/api/data/${name}?${qs}`);
      },
      get: (id: string) => this.get(`/api/data/${name}/${id}`),
      create: (data: Record<string, any>) => this.post(`/api/data/${name}`, data),
      update: (id: string, data: Record<string, any>) => this.patch(`/api/data/${name}/${id}`, data),
      delete: (id: string) => this.delete(`/api/data/${name}/${id}`),
    };
  }

  // Auth helpers
  auth = {
    login: (email: string, password: string) => this.post('/api/auth/sign-in/email', { email, password }),
    signup: (email: string, password: string, name: string) => this.post('/api/auth/sign-up/email', { email, password, name }),
    logout: () => this.post('/api/auth/sign-out'),
    session: () => this.get('/api/auth/get-session'),
  };

  // Storage helpers
  storage = {
    upload: (file: File, folder?: string) => {
      const fd = new FormData();
      fd.append('file', file);
      if (folder) fd.append('folder', folder);
      return this.upload('/api/storage/upload', fd);
    },
    list: (folder?: string) => this.get(`/api/storage${folder ? `?folder=${folder}` : ''}`),
    delete: (key: string) => this.delete(`/api/storage/${encodeURIComponent(key)}`),
  };
}

export function createZveltioClient(config: ZveltioClientConfig): ZveltioClient {
  return new ZveltioClient(config);
}
```

### TASK 9.2 — SDK Index exports

**Fișier:** `packages/sdk/src/index.ts`

```typescript
export { ZveltioClient, createZveltioClient } from './client.js';
export type { ZveltioClientConfig } from './client.js';

// Re-export extension types
export type { ZveltioExtension } from './extension/index.js';
```

### TASK 9.3 — SDK Real-time (opțional dar valoros)

**Fișier:** `packages/sdk/src/realtime.ts`

Client WebSocket pentru subscripții realtime:

```typescript
export class ZveltioRealtime {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();

  constructor(private baseUrl: string) {}

  connect() {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/ws';
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const listeners = this.listeners.get(msg.collection) || new Set();
      listeners.forEach((fn) => fn(msg));
    };
  }

  subscribe(collection: string, callback: (data: any) => void) {
    if (!this.listeners.has(collection)) this.listeners.set(collection, new Set());
    this.listeners.get(collection)!.add(callback);
    this.ws?.send(JSON.stringify({ action: 'subscribe', collection }));
    return () => {
      this.listeners.get(collection)?.delete(callback);
      this.ws?.send(JSON.stringify({ action: 'unsubscribe', collection }));
    };
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
  }
}
```

---

## FAZA 10 — CLI COMPLET

### TASK 10.1 — Init Command

**Fișier:** `packages/cli/src/commands/init.ts`

```typescript
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export async function initCommand(name: string) {
  const dir = join(process.cwd(), name);
  if (existsSync(dir)) {
    console.error(`❌ Directory "${name}" already exists`);
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });

  // Creează .env
  writeFileSync(join(dir, '.env'), `DATABASE_URL=postgresql://admin:password@localhost:5432/${name}\nPORT=3000\n`);

  // Creează .env.example
  writeFileSync(join(dir, '.env.example'), `DATABASE_URL=postgresql://user:pass@localhost:5432/dbname\nPORT=3000\nVALKEY_URL=redis://localhost:6379\nS3_ENDPOINT=http://localhost:8333\nS3_BUCKET=zveltio\nS3_ACCESS_KEY=admin\nS3_SECRET_KEY=password\n`);

  console.log(`✅ Zveltio project "${name}" initialized at ${dir}`);
  console.log(`\nNext steps:\n  cd ${name}\n  zveltio dev\n`);
}
```

### TASK 10.2 — Migrate Command

**Fișier:** `packages/cli/src/commands/migrate.ts`

```typescript
import { spawn } from 'child_process';
import { join } from 'path';

export async function migrateCommand() {
  const migratePath = join(process.cwd(), 'packages/engine/src/db/migrate.ts');
  const proc = spawn('bun', ['run', migratePath], { stdio: 'inherit', shell: true });
  proc.on('close', (code) => process.exit(code ?? 0));
}
```

### TASK 10.3 — Înregistrează comenzile noi

**Fișier:** `packages/cli/src/index.ts`

Adaugă `init` și `migrate` commands în Commander program:
```typescript
import { initCommand } from './commands/init.js';
import { migrateCommand } from './commands/migrate.js';

program.command('init <name>').description('Initialize a new Zveltio project').action(initCommand);
program.command('migrate').description('Run database migrations').action(migrateCommand);
```

---

## FAZA 11 — WEBHOOK REFACTOR (Technical Debt)

### TASK 11.1 — Refactor webhooks de la raw SQL la Kysely

**Fișier:** `packages/engine/src/routes/webhooks.ts` + `packages/engine/src/lib/webhook-worker.ts`

Caută orice instanță de raw SQL (string concatenation, template literals fără `sql` tag din Kysely) și înlocuiește cu Kysely query builder:

```typescript
// ❌ Înlocuiește:
const result = await db.execute(sql`SELECT * FROM zv_webhooks WHERE ...`);

// ✅ Cu:
const result = await db
  .selectFrom('zv_webhooks')
  .selectAll()
  .where('event', '=', eventName)
  .where('is_active', '=', true)
  .execute();
```

---

## FAZA 12 — MIGRĂRI LIPSĂ

Verifică că TOATE tabelele necesare au migrări SQL în `packages/engine/src/db/migrations/sql/`.

Tabelele necesare (verifică fiecare):
```
zv_collections          — Ar trebui să existe
zv_fields               — Ar trebui să existe
zv_webhooks             — Ar trebui să existe
zv_settings             — Ar trebui să existe
zv_audit_log            — Ar trebui să existe
zv_revisions            — Ar trebui să existe
zv_email_queue          — Ar trebui să existe
zv_translations         — Ar trebui să existe
zv_notifications        — Ar trebui să existe
zv_api_keys             — Ar trebui să existe
zv_extension_registry   — Ar trebui să existe (013_extension_registry.sql)
zv_media_folders        — Dacă nu există, creează (TASK 4.1)
zv_media_files          — Dacă nu există, creează (TASK 4.1)
zv_flows                — Verifică
zv_flow_runs            — Verifică
zv_approval_workflows   — Dacă nu există, creează (TASK 4.4)
zv_approval_requests    — Dacă nu există, creează
zv_approval_steps       — Dacă nu există, creează
zv_drafts               — Dacă nu există, creează
zv_saved_queries        — Dacă nu există, creează
zv_pages                — Verifică
zv_page_sections        — Verifică
zv_tenants              — Dacă nu există, creează (TASK 4.3)
zv_backups              — Dacă nu există, creează
zv_document_templates   — Dacă nu există, creează
zv_schema_branches      — Verifică
```

Pentru fiecare tabel lipsă, creează o migrare SQL cu număr secvențial în `packages/engine/src/db/migrations/sql/`.

---

## FAZA 13 — SMOKE TEST FINAL

După ce ai terminat TOATE fazele:

### TASK 13.1 — Verificare compilare

```bash
cd packages/engine && bun run build
cd ../studio && bun run build
cd ../sdk && bun run build
cd ../cli && bun run build
```

Toate trebuie să compileze fără erori.

### TASK 13.2 — Verificare TypeScript

```bash
cd packages/engine && bunx tsc --noEmit
cd ../studio && bunx tsc --noEmit
cd ../sdk && bunx tsc --noEmit
```

### TASK 13.3 — Verificare routes/index.ts

Deschide `packages/engine/src/routes/index.ts` și verifică că TOATE rutele importate au `app.route()` corespunzător. Lista completă ar trebui să arate cam așa (adaptează la ce existe efectiv):

```
/api/auth/**
/api/me
/api/collections
/api/relations
/api/data
/api/users
/api/permissions
/api/storage
/api/webhooks
/api/settings
/api/export
/api/import
/api/admin
/api/revisions
/api/translations
/api/notifications (dacă separat de admin)
/api/pages
/api/admin/pages
/api/schema
/api/docs
/api/database
/api/ai/schema
/api/ws
/api/realtime
/api/flows
/api/graphql
/api/media
/api/approvals
/api/drafts
/api/gdpr
/api/backup
/api/saved-queries
/api/validation
/api/quality
/api/insights
/api/document-templates
/api/documents
/api/sitemap.xml
```

### TASK 13.4 — Verificare binary build

```bash
cd ../.. && bun run build:binary
# Ar trebui să producă dist/zveltio
ls -la dist/zveltio
```

---

## CHECKLIST FINAL

```
[ ] FAZA 0  — Rute neînregistrate conectate
[ ] FAZA 1  — WebSocket + Realtime funcțional
[ ] FAZA 2  — Flow Executor conectat la Scheduler
[ ] FAZA 3  — GraphQL auto-generat funcțional
[ ] FAZA 4  — Toate 14 rutele API portate
[ ] FAZA 5  — AI complet (core-ai + Z-AI + analytics)
[ ] FAZA 6  — Extensii workflow (checklists, approvals)
[ ] FAZA 7  — 10 componente Studio portate/implementate
[ ] FAZA 8  — 6 pagini Studio noi create
[ ] FAZA 9  — SDK cu HTTP client real
[ ] FAZA 10 — CLI cu init + migrate
[ ] FAZA 11 — Webhooks refactored la Kysely
[ ] FAZA 12 — Toate migrările SQL verificate
[ ] FAZA 13 — Smoke test passed
```

**Timp estimat total: 15-20 zile de lucru concentrat.**
