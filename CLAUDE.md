# CLAUDE.md — Zveltio Project

Zveltio este un Backend-as-a-Service (BaaS) care concurează cu Directus, Supabase, Appwrite și Strapi.
Scopul nu este paritate de features — este o arhitectură superioară.
Obiectiv primar: **single binary** (Bun runtime), Studio embedded, PostgreSQL-powered, extension marketplace.

---

## Structura monorepo

```
zveltio/
├── packages/
│   ├── engine/          # Bun + Hono — compilează la single binary
│   ├── studio/          # SvelteKit 2 + Svelte 5 — embedded în engine la /admin
│   ├── sdk/             # @zveltio/sdk — TypeScript client
│   └── cli/             # @zveltio/cli — tooling
└── extensions/          # Feature extensions opționale
    ├── workflow/approvals
    ├── workflow/checklists
    ├── ai/core-ai
    ├── content/page-builder
    ├── automation/flows
    ├── developer/edge-functions
    ├── geospatial/postgis
    └── compliance/gdpr
```

---

## Stack tehnic

### Engine (`packages/engine/`)

| Layer | Tehnologie | Note |
|-------|-----------|------|
| Runtime | **Bun** | `Bun.file()`, `Bun.serve()` — niciodată `fs` din Node |
| HTTP | **Hono** | Middleware, routing, context |
| ORM | **Kysely** + `dynamic.ts` | Nu raw SQL direct |
| Auth | **Better-Auth** | Tabele `user`, `session` gestionate automat |
| AuthZ | **Casbin** | RBAC cu policy files |
| DB | **PostgreSQL 17** + pgvector | Via PgBouncer (port 6432) |
| Cache | **Valkey** | `cache.get/set/del` |
| Storage | **SeaweedFS** S3-compatible | Presigned URLs |
| Fields | **FieldTypeRegistry** | TOATE tipurile trec prin registry |
| Schema | **DDLManager** + **ddl-queue** | TOATE mutațiile DDL trec prin acestea |
| Extensions | **ExtensionLoader** | `loadAll()`, `loadFromDB()`, `loadDynamic()` |

### Studio (`packages/studio/`)

| Layer | Tehnologie |
|-------|-----------|
| Framework | SvelteKit 2 + **Svelte 5 runes** |
| Styling | TailwindCSS 4 + **DaisyUI** |
| Icons | `@lucide/svelte` |
| API | `import { api } from '$lib/api.js'` |
| Auth | `import { auth } from '$lib/auth.svelte.js'` |

---

## Reguli absolute — nu le negocia niciodată

### 1. Runtime Bun, nu Node.js
```typescript
// ✅
const file = await Bun.file(path).text();
const json = await Bun.file(path).json();
const proc = Bun.spawn(['pg_dump', ...args], { stdout: 'pipe' });
const output = await new Response(proc.stdout).text();

// ❌
import { readFile } from 'fs/promises';
import { spawn } from 'child_process';
```

### 2. Kysely, nu raw SQL concatenat
```typescript
// ✅ Kysely query builder
await db.selectFrom('zv_collections').selectAll().where('name', '=', name).execute();

// ✅ sql tag din Kysely pentru DDL și funcții PG-native
await sql`ALTER TABLE ${sql.id(tableName)} ADD COLUMN ${sql.id(colName)} text`.execute(db);
await sql`SELECT pg_notify('zveltio_changes', ${JSON.stringify(payload)})`.execute(db);

// ❌ Nu concatena niciodată
db.execute('SELECT * FROM ' + tableName);
```

### 3. DDL exclusiv prin DDLManager + ddl-queue — tranzacțional
```typescript
// ✅
await DDLManager.createCollection(db, definition);
await DDLManager.addField(db, collectionName, field);

// ❌ Niciodată ALTER TABLE direct în route handlers
```

### 4. Field types exclusiv prin FieldTypeRegistry
```typescript
// ✅ Înregistrare
fieldTypeRegistry.register({
  type: 'my_type',
  label: 'My Type',
  category: 'special',
  db: { columnType: 'text' },
  api: { filterOperators: ['eq', 'neq'] },
  typescript: { inputType: 'string', outputType: 'string' },
});

// ✅ Serializare/deserializare
const value = fieldTypeRegistry.serialize(field.type, rawValue);

// ❌ Niciodată switch/if hardcodat pe tipuri de câmpuri
```

### 5. Svelte 5 runes exclusiv — zero Svelte 4 syntax
```svelte
<script lang="ts">
  // ✅ Runes
  let count = $state(0);
  const doubled = $derived(count * 2);
  let { value = $bindable() }: { value: string } = $props();
  $effect(() => { /* side effect */ });

  // ✅ Svelte 5 page state
  import { page } from '$app/state';

  // ❌ Svelte 4 — interzis
  // export let value: string;
  // $: doubled = count * 2;
  // import { writable } from 'svelte/store';
  // import { page } from '$app/stores';
</script>
```

### 6. Extensii izolate — nu importă din engine
```typescript
// ✅ Extensia primește contextul prin parametru
const extension: ZveltioExtension = {
  name: 'category/name',
  category: 'category',
  async register(app, ctx) {
    // ctx.db, ctx.auth, ctx.fieldTypeRegistry — tot ce îți trebuie
    app.route('/api/name', myRoutes(ctx.db, ctx.auth));
  },
};

// ❌ Nu importa direct din engine
import { db } from '../../../packages/engine/src/db/index.js';
```

### 7. Studio servit din VFS (memorie), nu de pe disc
```typescript
// ✅ În producție — fișierele sunt în memorie (generate de generate-studio-embed.ts)
const { getStudioFile } = await import('./studio-embed/index.js');
const result = getStudioFile(path);

// ❌ Nu Bun.file() cu path absolut în producție
```

### 8. Realtime via LISTEN/NOTIFY — nu WAL/CDC direct
```typescript
// ✅ DDLManager creează automat trigger-ul la createCollection()
// Engine menține o conexiune dedicată cu: LISTEN zveltio_changes
// pg_notify('zveltio_changes', JSON.stringify({ collection, event, id, data }))

// ❌ Nu replication slots direct din Bun (umple discul la nesfârșit)
```

### 9. Toate rutele noi în routes/index.ts
```typescript
// ✅ În packages/engine/src/routes/index.ts
import { myFeatureRoutes } from './my-feature.js';
app.route('/api/my-feature', myFeatureRoutes(db, auth));

// ❌ Nu adăuga rute în packages/engine/src/index.ts
```

### 10. Auth guard pe orice rută admin
```typescript
router.use('*', async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'Unauthorized' }, 401);
  const isAdmin = await checkPermission(session.user.id, 'admin', '*');
  if (!isAdmin) return c.json({ error: 'Admin required' }, 403);
  await next();
});
```

---

## Patterns standard

### Rută nouă în engine
```typescript
// packages/engine/src/routes/my-feature.ts
import { Hono } from 'hono';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/casbin.js';
import type { Database } from '../db/index.js';

export function myFeatureRoutes(db: Database, appAuth: any): Hono {
  const router = new Hono();

  router.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    const isAdmin = await checkPermission(session.user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin required' }, 403);
    await next();
  });

  router.get('/', async (c) => {
    const rows = await db.selectFrom('zv_my_feature').selectAll().execute();
    return c.json({ items: rows });
  });

  router.post('/', async (c) => {
    const body = await c.req.json();
    const row = await db.insertInto('zv_my_feature').values(body).returningAll().executeTakeFirst();
    return c.json({ item: row }, 201);
  });

  return router;
}
```

### Pagină nouă în Studio
```svelte
<!-- packages/studio/src/routes/admin/my-page/+page.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { RefreshCw } from '@lucide/svelte';

  let items = $state<any[]>([]);
  let loading = $state(true);
  let error = $state('');

  async function load() {
    loading = true;
    error = '';
    try {
      const res = await api.get('/api/my-feature');
      items = res.items || [];
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  onMount(load);
</script>

<div class="p-6 max-w-7xl mx-auto">
  <div class="flex items-center justify-between mb-6">
    <h1 class="text-3xl font-bold">My Feature</h1>
    <button class="btn btn-ghost btn-sm" onclick={load}>
      <RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
    </button>
  </div>
  {#if error}
    <div class="alert alert-error mb-4">{error}</div>
  {/if}
  {#if loading}
    <div class="flex justify-center py-20">
      <span class="loading loading-spinner loading-lg text-primary"></span>
    </div>
  {:else}
    <!-- content -->
  {/if}
</div>
```

### Migrare nouă
```sql
-- packages/engine/src/db/migrations/sql/0XX_feature.sql
CREATE TABLE IF NOT EXISTS zv_feature (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  config      jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

### Extension nouă
```typescript
// extensions/category/name/engine/index.ts
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { join } from 'path';

const extension: ZveltioExtension = {
  name: 'category/name',
  category: 'category',
  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_init.sql')];
  },
  async register(app, ctx) {
    app.route('/api/name', myRoutes(ctx.db, ctx.auth));
  },
  registerFieldTypes(registry) {
    // opțional
  },
};
export default extension;
```

### Convenții răspunsuri API
```typescript
return c.json({ resource: row });           // item singular
return c.json({ resources: rows });         // colecție
return c.json({ error: 'mesaj' }, 400);    // eroare client
return c.json({ error: 'mesaj' }, 401);    // neautentificat
return c.json({ error: 'mesaj' }, 403);    // nepermis
return c.json({ success: true });           // mutație fără output
```

### Naming conventions
```
zvd_{name}     → tabele cu datele utilizatorilor (colecții)
zv_{name}      → tabele sistem ale platformei
0XX_desc.sql   → fișiere migrare (zero-padded, secvențial)
```

### Importuri standard Studio
```typescript
import { api } from '$lib/api.js';
import { auth } from '$lib/auth.svelte.js';
import { ENGINE_URL } from '$lib/config.js';
import { base } from '$app/paths';
import { page } from '$app/state';                    // Svelte 5 — NU $app/stores
import { extensions } from '$lib/extensions.svelte.js';
import { extensionRegistry } from '$lib/extension-registry.svelte.js';
```

### Checklist rută nouă (urmează întotdeauna acești pași)
1. Creează `packages/engine/src/routes/my-feature.ts`
2. Importă și înregistrează în `packages/engine/src/routes/index.ts`
3. Dacă e nevoie de tabel nou → migrare SQL în `packages/engine/src/db/migrations/sql/0XX_*.sql`
4. Creează pagina Studio în `packages/studio/src/routes/admin/my-page/+page.svelte`
5. Adaugă în `coreNav` din `packages/studio/src/routes/admin/+layout.svelte`

---

## Ce este deja implementat — nu reimplementa

- Autentificare completă (Better-Auth) cu OAuth/SSO (Google, GitHub, Microsoft, SAML 2.0)
- RBAC complet (Casbin) cu 4 scopuri: ALL/ORG/DEPT/OWN
- Collections CRUD cu DDLManager + ddl-queue tranzacțional
- 25+ field types în FieldTypeRegistry
- Relations (m2o, o2m, m2m, m2a)
- GraphQL auto-generat din schema colecțiilor
- WebSocket realtime (`ws.ts`, `realtime.ts`) via LISTEN/NOTIFY
- Storage S3 cu presigned URLs (SeaweedFS)
- Webhooks (înregistrare, delivery, retry, worker)
- AI integration multi-provider (OpenAI, Anthropic, Mistral, local)
- Email queue cu templates
- Export CSV/JSON/Excel/PDF + Import CSV/JSON
- Audit log complet
- Revisions + Time-Travel (`?as_of=`)
- Schema Branches — `packages/engine/src/routes/schema-branches.ts` ✅
- Data Quality Dashboard (`/api/quality`)
- API Playground (`packages/studio/src/routes/admin/api-playground/`)
- OpenAPI per-tenant (`packages/engine/src/routes/api-docs.ts`) ✅
- Extension Marketplace UI + API ✅
- Extension catalog + ExtensionLoader ✅
- `zv_extension_registry` tabel (migrare `013_extension_registry.sql`) ✅
- Single Binary — Studio embedded via VFS (`generate-studio-embed.ts`) ✅
- Database management routes (`packages/engine/src/routes/database.ts`) ✅
- Prometheus metrics (`/metrics`) + Health check (`/health`)
- Flow scheduler (`packages/engine/src/lib/flow-scheduler.ts`) ✅
- Webhook worker (`packages/engine/src/lib/webhook-worker.ts`) ✅
- System Collections (`packages/engine/src/lib/system-collections.ts`) ✅
- Virtual Collections adapter (`packages/engine/src/lib/virtual-collection-adapter.ts`) ✅
- AI Schema Generation (`packages/engine/src/routes/ai-schema-gen.ts`) — `POST /api/ai/generate-schema` ✅
- Schema Watcher + Type Generation (`packages/sdk/src/schema-watcher.ts`) ✅
- Edge Functions în Web Workers (`extensions/developer/edge-functions/engine/sandbox.ts`) ✅
- Field components în Studio (`packages/studio/src/lib/components/fields/`) ✅
- RecordRevisions, RecordComments, IndexManager, AuditLogList, SavedViews în Studio ✅

---

## Task-uri de implementat (în această ordine)

### TASK-1 — Portează Multi-Tenancy
**Sursa old repo:** `src/middleware/tenant.ts` + `src/lib/tenant-manager.ts` + `src/routes/tenants.ts`
**Destinația:** `packages/engine/src/`

Old repo-ul are o implementare **schema-per-tenant** (un PostgreSQL schema separat per tenant — nu `WHERE tenant_id`), cu:
- Rezolvare tenant din subdomain, header `X-Tenant-Slug`, sau env var fallback
- Suport environments (prod/staging/dev) per tenant
- Provisionare automată schema PostgreSQL la creare tenant
- Cache Valkey pentru tenant lookup

**Pași:**
1. Copiază `src/lib/tenant-manager.ts` → `packages/engine/src/lib/tenant-manager.ts`
   - Adaptează importurile: `db` și `cache` vin din `'../db/index.js'`, elimină importuri Node.js
2. Copiază `src/middleware/tenant.ts` → `packages/engine/src/middleware/tenant.ts`
3. Portează `src/routes/tenants.ts` → `packages/engine/src/routes/tenants.ts`
   - Pattern standard: `export function tenantsRoutes(db: Database, auth: any): Hono`
4. Aplică middleware în `packages/engine/src/index.ts` înainte de rute:
   ```typescript
   import { tenantMiddleware } from './middleware/tenant.js';
   app.use('*', tenantMiddleware);
   ```
5. Înregistrează în `packages/engine/src/routes/index.ts`:
   ```typescript
   import { tenantsRoutes } from './tenants.js';
   app.route('/api/tenants', tenantsRoutes(db, auth));
   ```
6. Portează migrarea: `migrations/021_multitenancy.sql` → `packages/engine/src/db/migrations/sql/020_multitenancy.sql`
7. Portează pagina Studio din `src/routes/admin/tenants/` → `packages/studio/src/routes/admin/tenants/`

---

### TASK-2 — Portează `/api/flows` (execuție flow steps)
**Sursa old repo:** `src/routes/flows.ts` + `src/lib/flow-executor.ts`
**Destinația:** `packages/engine/src/`

`flow-scheduler.ts` există și pornește flows pe cron, dar NU execută pașii. Old repo-ul are endpoint-uri CRUD + execuție manuală.

**Pași:**
1. Portează `src/routes/flows.ts` → `packages/engine/src/routes/flows.ts`
   - Pattern standard: `export function flowsRoutes(db: Database, auth: any): Hono`
2. Dacă există `src/lib/flow-executor.ts`, portează la `packages/engine/src/lib/flow-executor.ts`
3. Conectează `flow-scheduler.ts` existent cu executorul portat
4. Înregistrează:
   ```typescript
   import { flowsRoutes } from './flows.js';
   app.route('/api/flows', flowsRoutes(db, auth));
   ```
5. Portează pagina Studio din `src/routes/admin/flows/` → `packages/studio/src/routes/admin/flows/`

---

### TASK-3 — Portează `/api/media` (Media Library)
**Sursa old repo:** `src/routes/media.ts`
**Destinația:** `packages/engine/src/routes/media.ts`

**Atenție:** `/api/storage` există deja și e pentru upload/download fișiere. `/api/media` este Media Library cu folders, tags, galerie — funcționalitate distinctă.

**Pași:**
1. Portează `src/routes/media.ts` → `packages/engine/src/routes/media.ts`
   - Pattern standard: `export function mediaRoutes(db: Database, auth: any): Hono`
2. Verifică că tabelele `zv_media_folders` și `zv_media_files` există în migrări — dacă nu, adaugă migrare nouă
3. Înregistrează:
   ```typescript
   import { mediaRoutes } from './media.js';
   app.route('/api/media', mediaRoutes(db, auth));
   ```
4. Portează pagina Studio `src/routes/admin/media/+page.svelte` → `packages/studio/src/routes/admin/media/+page.svelte`
5. Adaugă în `coreNav`:
   ```typescript
   import { Image } from '@lucide/svelte';
   { href: `${base}/media`, icon: Image, label: 'Media' }
   ```

---

### TASK-4 — Portează `/api/backup` (Backup & Restore)
**Sursa old repo:** `src/routes/backup.ts`
**Destinația:** `packages/engine/src/routes/backup.ts`

**Atenție Bun:** înlocuiește `child_process.spawn` cu `Bun.spawn`:
```typescript
// ❌ Node
import { spawn } from 'child_process';
spawn('pg_dump', args);

// ✅ Bun
const proc = Bun.spawn(['pg_dump', ...args], { stdout: 'pipe' });
const output = await new Response(proc.stdout).text();
```

**Pași:**
1. Portează `src/routes/backup.ts` → `packages/engine/src/routes/backup.ts`
2. Adaugă `BACKUP_DIR` în `.env.example` dacă nu există
3. Înregistrează:
   ```typescript
   import { backupRoutes } from './backup.js';
   app.route('/api/backup', backupRoutes(db, auth));
   ```
4. Portează UI din `src/routes/admin/settings/backup/` → `packages/studio/src/routes/admin/settings/backup/`

---

### TASK-5 — Portează `/api/pages` (CMS Pages + Sitemap)
**Sursa old repo:** `src/routes/pages.ts` + `src/routes/admin-pages.ts`
**Destinația:** `packages/engine/src/routes/`

**Pași:**
1. Portează `src/routes/pages.ts` → `packages/engine/src/routes/pages.ts` (endpoint public)
2. Portează `src/routes/admin-pages.ts` → `packages/engine/src/routes/admin-pages.ts`
3. Adaugă generarea `sitemap.xml` ca rută separată sau în admin-pages
4. Înregistrează:
   ```typescript
   import { publicPagesRoutes } from './pages.js';
   import { adminPagesRoutes } from './admin-pages.js';
   app.route('/api/pages', publicPagesRoutes(db, auth));
   app.route('/api/admin/pages', adminPagesRoutes(db, auth));
   ```

---

### TASK-6 — Portează `/api/gdpr`
**Sursa old repo:** `src/routes/gdpr.ts`
**Destinația:** `packages/engine/src/routes/gdpr.ts`

Include: export date utilizator (GDPR Art. 20), ștergere cont (Art. 17), portabilitate date.

**Pași:**
1. Portează cu pattern standard
2. Înregistrează:
   ```typescript
   import { gdprRoutes } from './gdpr.js';
   app.route('/api/gdpr', gdprRoutes(db, auth));
   ```

---

### TASK-7 — Portează `/api/saved-queries`
**Sursa old repo:** `src/routes/saved-queries.ts`
**Destinația:** `packages/engine/src/routes/saved-queries.ts`

Salvarea și re-execuția query-urilor din API Playground.

**Pași:**
1. Portează cu pattern standard
2. Înregistrează:
   ```typescript
   import { savedQueriesRoutes } from './saved-queries.js';
   app.route('/api/saved-queries', savedQueriesRoutes(db, auth));
   ```

---

### TASK-8 — Portează `/api/drafts`
**Sursa old repo:** `src/routes/drafts.ts`
**Destinația:** `packages/engine/src/routes/drafts.ts`

Sistem de drafts pentru records (salvare înainte de publish).

**Pași:**
1. Portează cu pattern standard
2. Înregistrează:
   ```typescript
   import { draftsRoutes } from './drafts.js';
   app.route('/api/drafts', draftsRoutes(db, auth));
   ```

---

### TASK-9 — Portează `/api/approvals`
**Sursa old repo:** `src/routes/approvals.ts`
**Destinația:** `packages/engine/src/routes/approvals.ts`

Workflow de aprobare pentru records (submit → review → approve/reject).

**Pași:**
1. Portează cu pattern standard
2. Înregistrează:
   ```typescript
   import { approvalsRoutes } from './approvals.js';
   app.route('/api/approvals', approvalsRoutes(db, auth));
   ```

---

### TASK-10 — Portează componentele Studio lipsă sau stub
**Sursa old repo:** `src/lib/components/`
**Destinația:** `packages/studio/src/lib/components/`

**La portare:** înlocuiește `engineClient.request()` cu `api.get/post/patch/delete()` din `$lib/api.js`. Înlocuiește orice `$store` reactiv cu `$state`/`$derived`. Înlocuiește `import { page } from '$app/stores'` cu `import { page } from '$app/state'`.

#### 10a. ConstraintEditor
```
packages/studio/src/lib/components/admin/ConstraintEditor.svelte
← src/lib/components/admin/ConstraintEditor/ConstraintEditor.svelte
```
Afișează constrângerile FK ale tabelului curent + buton drop constraint.

#### 10b. RelationshipManager
```
packages/studio/src/lib/components/admin/RelationshipManager.svelte
← src/lib/components/admin/RelationshipManager/RelationshipManager.svelte
```
Props: `tableName: string`, `constraints: Constraint[]`. Afișează FK-urile și permite navigare la tabela referită.

#### 10c. MetadataSettings
```
packages/studio/src/lib/components/admin/MetadataSettings.svelte
← src/lib/components/admin/MetadataSettings/MetadataSettings.svelte
```
Props: `$bindable<Metadata>` cu `{displayName?, menuGroup?, isLoggable?, icon?}`.

#### 10d. StatsView
```
packages/studio/src/lib/components/views/StatsView.svelte
← src/lib/components/views/StatsView/StatsView.svelte
```
Afișează statistici agregate (count, sum, avg, min, max) pe colecțiile selectate.

#### 10e. TableView
```
packages/studio/src/lib/components/views/TableView.svelte
← src/lib/components/views/TableView/TableView.svelte
```
Tabel cu sortare, filtrare, selecție rânduri, paginare — componenta principală din Data Studio.

#### 10f. DataCell
```
packages/studio/src/lib/components/views/DataCell.svelte
← src/lib/components/views/DataCell/DataCell.svelte
```
Randarea unui câmp individual în tabel în funcție de tipul câmpului (image preview, boolean toggle, date format etc).

#### 10g. OnboardingWizard
```
packages/studio/src/lib/components/admin/OnboardingWizard.svelte
← src/lib/components/admin/OnboardingWizard.svelte
```
UI de onboarding cu textarea pentru AI schema generation. Conectează la `POST /api/ai/generate-schema`.

#### 10h. BrandingSettings
```
packages/studio/src/lib/components/admin/BrandingSettings/
← src/lib/components/admin/BrandingSettings/
    ├── ColorPicker.svelte
    ├── LogoUpload.svelte
    ├── FontSelector.svelte
    └── ThemePreview.svelte
```

---

### TASK-11 — Zero-Downtime DDL (Ghost Table)
**Destinație:** `packages/engine/src/lib/ddl-queue.ts` (extinde implementarea existentă)

DDL queue există și funcționează tranzacțional. Adaugă tipuri noi de joburi: `'add_column_safe'` și `'alter_column_safe'`.

**Logica:** dacă tabela are > `threshold` rânduri (default 10.000) SAU coloana e `NOT NULL` fără default → ghost table. Altfel → `ALTER TABLE` direct (fast path).

```typescript
async function processAddColumnSafe(db: Database, job: DDLJob): Promise<void> {
  const { collection, column, pgType, notNull, defaultValue, threshold = 10000 } = job.payload;
  const tableName = DDLManager.getTableName(collection);

  const { rows } = await sql`SELECT COUNT(*) as cnt FROM ${sql.id(tableName)}`.execute(db);
  const rowCount = parseInt((rows[0] as any).cnt);
  const needsGhost = rowCount > threshold || (notNull && !defaultValue);

  if (!needsGhost) {
    await sql`ALTER TABLE ${sql.id(tableName)} ADD COLUMN IF NOT EXISTS ${sql.id(column)} ${sql.raw(pgType)}`.execute(db);
    return;
  }

  const ghostName = `${tableName}_ghost_${Date.now()}`;

  // 1. Create ghost with new schema
  await sql`CREATE TABLE ${sql.id(ghostName)} (LIKE ${sql.id(tableName)} INCLUDING ALL)`.execute(db);
  await sql`ALTER TABLE ${sql.id(ghostName)} ADD COLUMN ${sql.id(column)} ${sql.raw(pgType)}`.execute(db);

  // 2. Copy data in batches (non-blocking)
  let lastId: string | null = null;
  while (true) {
    const batch = await sql`
      SELECT * FROM ${sql.id(tableName)}
      ${lastId ? sql`WHERE id > ${lastId}` : sql``}
      ORDER BY id LIMIT 1000
    `.execute(db);
    if (batch.rows.length === 0) break;
    for (const row of batch.rows) {
      await db.insertInto(ghostName as any).values(row as any).onConflict(oc => oc.doNothing()).execute();
    }
    lastId = (batch.rows[batch.rows.length - 1] as any).id;
  }

  // 3. Sync trigger: INSERT/UPDATE/DELETE pe original → propagă pe ghost
  const triggerFn = `${tableName}_ghost_sync_fn`;
  const triggerName = `${tableName}_ghost_sync`;
  await sql`
    CREATE OR REPLACE FUNCTION ${sql.id(triggerFn)}() RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO ${sql.id(ghostName)} VALUES (NEW.*) ON CONFLICT (id) DO UPDATE SET id = NEW.id;
      ELSIF TG_OP = 'UPDATE' THEN
        UPDATE ${sql.id(ghostName)} SET id = NEW.id WHERE id = OLD.id;
      ELSIF TG_OP = 'DELETE' THEN
        DELETE FROM ${sql.id(ghostName)} WHERE id = OLD.id;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
  `.execute(db);
  await sql`
    CREATE TRIGGER ${sql.id(triggerName)}
    AFTER INSERT OR UPDATE OR DELETE ON ${sql.id(tableName)}
    FOR EACH ROW EXECUTE FUNCTION ${sql.id(triggerFn)}()
  `.execute(db);

  // 4. Atomic swap (lock de milisecunde)
  const oldName = `${tableName}_old_${Date.now()}`;
  await sql`ALTER TABLE ${sql.id(tableName)} RENAME TO ${sql.id(oldName)}`.execute(db);
  await sql`ALTER TABLE ${sql.id(ghostName)} RENAME TO ${sql.id(tableName)}`.execute(db);

  // 5. Cleanup
  await sql`DROP TRIGGER IF EXISTS ${sql.id(triggerName)} ON ${sql.id(oldName)}`.execute(db);
  await sql`DROP FUNCTION IF EXISTS ${sql.id(triggerFn)}()`.execute(db);
  await sql`DROP TABLE IF EXISTS ${sql.id(oldName)}`.execute(db);
}
```

Adaugă `case 'add_column_safe': await processAddColumnSafe(db, job); break;` în switch-ul din `processNextJob()`.

---

### TASK-12 — SDK Local-First (IndexedDB + Sync)
**Destinație:** `packages/sdk/src/local/`

**Fișiere noi:**
```
packages/sdk/src/local/
├── LocalStore.ts    ← IndexedDB (browser) sau Map in-memory (Node/fallback)
├── SyncEngine.ts    ← sync background cu server
└── index.ts
```

**LocalStore.ts:**
```typescript
export class LocalStore {
  private idb: IDBDatabase | null = null;
  private mem: Map<string, any> = new Map(); // Node fallback

  async open(): Promise<void> {
    if (typeof indexedDB === 'undefined') return; // Node → mem fallback
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('zveltio-local', 1);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('records'))
          db.createObjectStore('records', { keyPath: '_localKey' });
        if (!db.objectStoreNames.contains('pending'))
          db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => { this.idb = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  async get(collection: string, id: string): Promise<any | null> {
    const key = `${collection}:${id}`;
    if (!this.idb) return this.mem.get(key) ?? null;
    return new Promise((res) => {
      const tx = this.idb!.transaction('records', 'readonly');
      const req = tx.objectStore('records').get(key);
      req.onsuccess = () => res(req.result ?? null);
    });
  }

  async set(collection: string, id: string, data: any): Promise<void> {
    const key = `${collection}:${id}`;
    const record = { ...data, _localKey: key };
    if (!this.idb) { this.mem.set(key, record); return; }
    return new Promise((res, rej) => {
      const tx = this.idb!.transaction('records', 'readwrite');
      const req = tx.objectStore('records').put(record);
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  }

  async list(collection: string): Promise<any[]> {
    if (!this.idb) {
      return [...this.mem.entries()]
        .filter(([k]) => k.startsWith(`${collection}:`))
        .map(([, v]) => v);
    }
    return new Promise((res) => {
      const tx = this.idb!.transaction('records', 'readonly');
      const req = tx.objectStore('records').getAll();
      req.onsuccess = () =>
        res((req.result as any[]).filter(r => r._localKey?.startsWith(`${collection}:`)));
    });
  }

  async addPending(op: { type: 'create'|'update'|'delete', collection: string, id: string, data?: any }): Promise<void> {
    if (!this.idb) return;
    return new Promise((res) => {
      const tx = this.idb!.transaction('pending', 'readwrite');
      tx.objectStore('pending').add(op);
      tx.oncomplete = () => res();
    });
  }

  async getPending(): Promise<any[]> {
    if (!this.idb) return [];
    return new Promise((res) => {
      const tx = this.idb!.transaction('pending', 'readonly');
      const req = tx.objectStore('pending').getAll();
      req.onsuccess = () => res(req.result);
    });
  }

  async clearPending(id: number): Promise<void> {
    if (!this.idb) return;
    return new Promise((res) => {
      const tx = this.idb!.transaction('pending', 'readwrite');
      tx.objectStore('pending').delete(id);
      tx.oncomplete = () => res();
    });
  }
}
```

**SyncEngine.ts:**
```typescript
export class SyncEngine {
  constructor(
    private store: LocalStore,
    private engineUrl: string,
    private apiKey?: string
  ) {}

  async sync(): Promise<void> {
    const pending = await this.store.getPending();
    for (const op of pending) {
      try {
        await this.applyOp(op);
        await this.store.clearPending(op.id);
      } catch (err) {
        console.warn('[zveltio] Sync failed for op', op.id, err);
        // rămâne în pending, retry la next cycle
      }
    }
  }

  private async applyOp(op: any): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const base = `${this.engineUrl}/api/data/${op.collection}`;

    if (op.type === 'create')
      await fetch(base, { method: 'POST', headers, body: JSON.stringify(op.data) });
    else if (op.type === 'update')
      await fetch(`${base}/${op.id}`, { method: 'PATCH', headers, body: JSON.stringify(op.data) });
    else if (op.type === 'delete')
      await fetch(`${base}/${op.id}`, { method: 'DELETE', headers });
  }

  startAutoSync(intervalMs = 5000): () => void {
    const id = setInterval(() => this.sync(), intervalMs);
    return () => clearInterval(id);
  }
}
```

**Integrare în ZveltioClient** (`packages/sdk/src/client/ZveltioClient.ts`):
```typescript
// În constructor, dacă config.localFirst === true:
if (config.localFirst) {
  this.localStore = new LocalStore();
  await this.localStore.open();
  this.syncEngine = new SyncEngine(this.localStore, config.engineUrl, config.apiKey);
  this.syncEngine.startAutoSync();
}
// În collection().create() / .update() / .delete():
// dacă localFirst activ → scrie în localStore + addPending, returnează instant
// sync-ul se face în background
```

**Exportă din** `packages/sdk/src/index.ts`:
```typescript
export { LocalStore } from './local/LocalStore.js';
export { SyncEngine } from './local/SyncEngine.js';
```

---

## Ce NU face niciodată

1. Nu adăuga dependențe Node.js-only în `packages/engine/` (ex: `express`, `multer`, `fs-extra`, `child_process`)
2. Nu crea rute fără auth guard
3. Nu modifica tabelele Better-Auth direct (`user`, `session`, `account`, `verification`) — folosește Better-Auth API
4. Nu folosi `process.env.*` în Svelte — folosește `import.meta.env.VITE_*`
5. Nu importa din `packages/engine/` în extensii — extensiile primesc tot prin `ExtensionContext`
6. Nu folosi `writable()`, `readable()`, `derived()` din `svelte/store` — Svelte 5 runes
7. Nu adăuga rute direct în `packages/engine/src/index.ts` — toate în `routes/index.ts`
8. Nu servi fișiere statice cu `Bun.file(absolutePath)` în producție — VFS (studio-embed)
9. Nu folosi WAL replication slots pentru realtime — LISTEN/NOTIFY
10. Nu scrie switch/if pe `field.type` — FieldTypeRegistry
11. Nu concatena SQL manual — Kysely sau `sql` tag
12. Nu reimplementa ce există deja (verifică secțiunea "Ce este deja implementat")
