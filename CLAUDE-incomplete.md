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
│   ├── studio/          # SvelteKit 5 — embedded în engine la /admin
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

// ❌
import { readFile } from 'fs/promises';
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

  // ❌ Svelte 4 — interzis
  // export let value: string;
  // $: doubled = count * 2;
  // import { writable } from 'svelte/store';
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

### Convenții răspunsuri
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

---

## Ce este deja implementat — nu reimplementa

- Autentificare completă (Better-Auth) cu OAuth/SSO (Google, GitHub, Microsoft, SAML 2.0)
- RBAC complet (Casbin) cu 4 scopuri: ALL/ORG/DEPT/OWN
- Collections CRUD cu DDLManager + ddl-queue
- 25+ field types în FieldTypeRegistry
- Relations (m2o, o2m, m2m, m2a)
- GraphQL auto-generat din schema colecțiilor
- WebSocket realtime (`ws.ts`, `realtime.ts`)
- Storage S3 cu presigned URLs
- Webhooks (înregistrare, delivery, retry, worker)
- AI integration multi-provider (OpenAI, Anthropic, Mistral, local)
- Email queue cu templates
- Export CSV/JSON/Excel/PDF
- Import CSV/JSON
- Audit log complet
- Revisions + Time-Travel (`?as_of=`)
- Schema Branches (git-like pentru DDL)
- Data Quality Dashboard (`/api/quality`)
- API Playground (`packages/studio/src/routes/admin/api-playground/`)
- OpenAPI per-tenant (`src/routes/api-docs.ts`)
- Extension Marketplace UI (`packages/studio/src/routes/admin/marketplace/`)
- Extension Marketplace API (`packages/engine/src/routes/marketplace.ts`)
- Extension catalog (`packages/engine/src/lib/extension-catalog.ts`)
- ExtensionLoader cu `loadAll()`, `loadFromDB()`, `loadDynamic()`, `ctx` saved
- `zv_extension_registry` tabel (migrare `013_extension_registry.sql`)
- Single Binary — Studio embedded via VFS (`generate-studio-embed.ts`)
- Prometheus metrics (`/metrics`)
- Health check (`/health`)
- Flow scheduler (`lib/flow-scheduler.ts`)
- Webhook worker (`lib/webhook-worker.ts`)
- Schema branches routes (`src/routes/schema-branches.ts`)

---

## Task-uri imediate (implementează în această ordine)

### TASK 1 — Înregistrează rutele lipsă în engine
**Fișier:** `packages/engine/src/routes/index.ts`

Adaugă aceste 3 importuri și înregistrări (rutele există, nu sunt conectate):

```typescript
// Import
import { schemaBranchesRoutes } from './schema-branches.js';
import { apiDocsRoutes } from './api-docs.js';
import { databaseRoutes } from './database.js';  // verifică că există în packages/engine/

// Înregistrare (după marketplaceRoutes)
app.route('/api/schema', schemaBranchesRoutes);
app.route('/api/docs', apiDocsRoutes);
app.route('/api/database', databaseRoutes);
```

**Notă:** Dacă `database.ts` nu există în `packages/engine/src/routes/`, portează-l din `src/routes/database.ts` (old repo). Conține routes pentru PostgreSQL functions, triggers, enums, extensions, RLS.

**Adaugă în coreNav** (`packages/studio/src/routes/admin/+layout.svelte`):
```typescript
import { GitBranch } from '@lucide/svelte';
{ href: `${base}/schema-branches`, icon: GitBranch, label: 'Schema Branches' },
```

---

### TASK 2 — Portează componentele din old repo în packages/studio

**Sursa:** `src/lib/components/` (old repo)
**Destinația:** `packages/studio/src/lib/components/`

Portează în ordinea aceasta. La portare, înlocuiește `engineClient.request()` cu `api.get/post/patch/delete()` din `$lib/api.js`.

#### 2a. Fields (prioritate maximă — folosite în record edit)
```
packages/studio/src/lib/components/fields/
├── RichTextEditor.svelte    ← src/lib/components/fields/RichTextEditor.svelte
├── JSONEditor.svelte        ← src/lib/components/fields/JSONEditor.svelte
├── LocationField.svelte     ← src/lib/components/fields/LocationField.svelte
├── MapPicker.svelte         ← src/lib/components/fields/MapPicker.svelte
├── ColorPicker.svelte       ← src/lib/components/fields/ColorPicker.svelte
├── FilePicker.svelte        ← src/lib/components/fields/FilePicker.svelte
└── index.ts
```
Adaugă în `packages/studio/package.json` dependențele Tiptap pentru RichTextEditor:
```json
"@tiptap/core": "^2.0.0",
"@tiptap/starter-kit": "^2.0.0",
"@tiptap/extension-link": "^2.0.0",
"@tiptap/extension-image": "^2.0.0",
"@tiptap/extension-table": "^2.0.0",
"@tiptap/extension-table-row": "^2.0.0",
"@tiptap/extension-table-cell": "^2.0.0",
"@tiptap/extension-table-header": "^2.0.0"
```

#### 2b. Admin components
```
packages/studio/src/lib/components/admin/
├── RecordRevisions/         ← src/lib/components/admin/RecordRevisions/
├── RecordComments/          ← src/lib/components/admin/RecordComments/
├── IndexManager/            ← src/lib/components/admin/IndexManager/
├── ConstraintEditor/        ← src/lib/components/admin/ConstraintEditor/
├── OnboardingWizard.svelte  ← src/lib/components/admin/OnboardingWizard.svelte
└── BrandingSettings/        ← src/lib/components/admin/BrandingSettings/
    ├── ColorPicker.svelte
    ├── LogoUpload.svelte
    ├── FontSelector.svelte
    └── ThemePreview.svelte
```

#### 2c. Common components
```
packages/studio/src/lib/components/common/
├── ToastContainer.svelte    ← src/lib/components/common/ToastContainer.svelte
├── ExportActions.svelte     ← src/lib/components/common/ExportActions/
└── Pagination.svelte        ← src/lib/components/common/Pagination/
```
**Important:** Adaugă `<ToastContainer />` în `packages/studio/src/routes/admin/+layout.svelte`.

#### 2d. Views + Forms + Audit
```
packages/studio/src/lib/components/
├── views/
│   ├── DataCell.svelte      ← src/lib/components/views/DataCell/
│   ├── TablePagination.svelte
│   ├── StatsView.svelte
│   └── SavedViews.svelte
├── forms/
│   └── FormField.svelte     ← src/lib/components/forms/FormField/
└── audit/
    └── AuditLogList.svelte  ← src/lib/components/audit/AuditLogList/
```

---

### TASK 3 — Edge Functions în Web Workers (izolare)
**Fișier:** `extensions/developer/edge-functions/engine/sandbox.ts`

Funcțiile custom NU trebuie să ruleze în același thread cu Hono — un `while(true){}` îngheață tot serverul.

Implementare corectă cu Bun Web Workers:
```typescript
// sandbox.ts
export async function runFunction(code: string, payload: any): Promise<any> {
  const worker = new Worker(
    new URL('./worker-runner.ts', import.meta.url),
    { type: 'module' }
  );

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('Function timeout (5s)'));
    }, 5000);

    worker.postMessage({ code, payload });
    worker.onmessage = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(e.message));
    };
  });
}
```

```typescript
// worker-runner.ts (rulează în thread separat)
self.onmessage = async (e) => {
  const { code, payload } = e.data;
  try {
    const fn = new Function('payload', 'require', code);
    const result = await fn(payload, undefined);
    self.postMessage({ success: true, result });
  } catch (err: any) {
    self.postMessage({ success: false, error: err.message });
  }
};
```

---

### TASK 4 — DDL queue tranzacțional cu retry
**Fișier:** `packages/engine/src/lib/ddl-queue.ts`

Fiecare job DDL trebuie să fie în `BEGIN/COMMIT` explicit și să poată fi re-încercat la restart:

```typescript
// La procesarea unui job:
async function processJob(job: DDLJob): Promise<void> {
  try {
    await sql`BEGIN`.execute(db);
    await executeDDL(job.sql);
    await markJobComplete(job.id);
    await sql`COMMIT`.execute(db);
  } catch (err) {
    await sql`ROLLBACK`.execute(db);
    await markJobFailed(job.id, err.message);
    // La restart, joburile cu status='pending' sau 'failed' (retryable) sunt re-încercate
    throw err;
  }
}
```

Tabelul de jobs trebuie să aibă `status: 'pending' | 'running' | 'completed' | 'failed'` și `retry_count`.
La startup, joburile cu `status = 'running'` (crash în mijloc) se resetează la `'pending'` pentru retry.

---

### TASK 5 — System Collections (Better-Auth tables în Studio)
**Scop:** Administratorii să poată vedea/edita utilizatorii direct din Studio ca pe orice colecție.

**Fișier nou:** `packages/engine/src/lib/system-collections.ts`

```typescript
// Înregistrează tabelele Better-Auth ca System Collections vizibile în Studio
export const SYSTEM_COLLECTIONS = [
  {
    name: 'user',
    tableName: 'user',
    displayName: 'Users',
    icon: 'Users',
    isSystem: true,
    readonly: false,
    fields: [
      { name: 'id', type: 'uuid', required: true },
      { name: 'name', type: 'text', required: true },
      { name: 'email', type: 'email', required: true },
      { name: 'emailVerified', type: 'boolean', required: false },
      { name: 'image', type: 'text', required: false },
      { name: 'createdAt', type: 'datetime', required: true },
      { name: 'updatedAt', type: 'datetime', required: true },
      { name: 'role', type: 'text', required: false },
    ],
  },
  {
    name: 'session',
    tableName: 'session',
    displayName: 'Sessions',
    icon: 'Key',
    isSystem: true,
    readonly: true, // sessions sunt read-only
    fields: [
      { name: 'id', type: 'uuid', required: true },
      { name: 'userId', type: 'uuid', required: true },
      { name: 'token', type: 'text', required: true },
      { name: 'expiresAt', type: 'datetime', required: true },
      { name: 'createdAt', type: 'datetime', required: true },
    ],
  },
];
```

Endpoint-ul `GET /api/collections` trebuie să returneze și System Collections (marcate cu `is_system: true`).
DDL-ul NU trebuie să fie disponibil pe System Collections — doar CRUD date.

---

## Priorități competitive (implementează după task-urile imediate)

### P1 — Zero-Downtime DDL Migrations
**Scop:** ALTER TABLE pe tabele mari fără lock (diferențiator față de Directus/Supabase).

**Abordare Ghost Table** în `ddl-queue.ts`:
1. `CREATE TABLE zvd_{name}_ghost LIKE zvd_{name}` cu noua schemă
2. Copiază datele asincron în batches (nu blochează tabelul original)
3. Crează un trigger pe tabela originală care sincronizează INSERT/UPDATE/DELETE către ghost
4. La final: `ALTER TABLE zvd_{name} RENAME TO zvd_{name}_old; ALTER TABLE zvd_{name}_ghost RENAME TO zvd_{name};`
5. Drop trigger + drop old table

Activare: când coloana adăugată are `NOT NULL` fără default sau când tabelul depășește N rânduri (configurable).

### P2 — Multi-Tenancy nativ
**Scop:** Toggle în Settings → toate query-urile Kysely injectează automat `WHERE tenant_id = ?`.

**Abordare:**
- Middleware Hono care extrage `tenant_id` din JWT/header și îl pune în `c.var`
- Plugin Kysely (sau wrapper peste `db`) care adaugă automat `.where('tenant_id', '=', tenantId)` pe `selectFrom`
- Migrare care adaugă `tenant_id uuid` pe toate tabelele `zvd_*`
- UI în Settings: toggle "Enable Multi-Tenancy" + management organizații

### P3 — SDK Local-First
**Scop:** `zveltio.collection('posts').save()` scrie instant local (zero latency UI), sync în background.

**Abordare:**
- `@zveltio/sdk` adaugă un store local bazat pe IndexedDB (browser) sau SQLite (Node)
- Operațiunile returnează instant din local store
- Un sync engine rulează în background și reconciliează cu serverul
- Conflict resolution: last-write-wins sau custom merge function

### P4 — Virtual Collections (Data Federation)
**Scop:** Colecții care fac proxy la API-uri externe (Stripe, Shopify, ERP) — pentru client arată ca tabele normale.

**Abordare:**
- Tip nou de colecție în Studio: `type: 'virtual'` (în loc de `type: 'table'`)
- La creare, userul configurează: `source_url`, `auth_type`, `field_mapping` (FieldTypeRegistry mapează câmpurile externe)
- Tabelul `zv_collections` primește coloana `virtual_config jsonb`
- Engine-ul interceptează CRUD pe colecții virtuale și face proxy la API-ul extern în loc de query PostgreSQL
- `GET /api/data/my_virtual_col` → fetch la `source_url` → mapare câmpuri → răspuns uniform SDK

**Fișier nou:** `packages/engine/src/lib/virtual-collection-adapter.ts`
```typescript
export interface VirtualConfig {
  source_url: string;
  auth_type: 'none' | 'bearer' | 'api_key' | 'basic';
  auth_value?: string;
  field_mapping: Record<string, string>; // zveltio_field_name → external_field_name
  list_path: string;    // JSONPath în răspuns pentru array de date, ex: "$.data.items"
  id_field: string;     // câmpul care servește drept id, ex: "id"
}

export async function virtualFetch(config: VirtualConfig, params: any): Promise<any[]> {
  // fetch + mapare câmpuri + paginare uniformă
}
```

### P5 — AI Prompt-to-Backend (Onboarding)
**Scop:** Dev-ul descrie aplicația în text → Zveltio generează schema, relațiile, permisiunile și seed data în <10 secunde.

**Abordare:**
- UI: pagina de onboarding (`packages/studio/src/routes/admin/onboarding/`) cu un textarea mare
- Engine: endpoint `POST /api/ai/generate-schema` care trimite prompt-ul la LLM configurat
- Prompt system include: lista de field types disponibile, convențiile de naming (`zvd_*`), tipurile de relații (m2o/o2m/m2m)
- LLM răspunde cu JSON structurat: `{ collections, fields, relations, permissions, seed_count }`
- Engine validează JSON-ul prin `CollectionSchema` (Zod) și execută prin DDLManager
- Seed data: al doilea apel LLM generează `seed_count` rânduri realiste per colecție

**Fișier nou:** `packages/engine/src/routes/ai-schema-gen.ts`
```typescript
router.post('/generate-schema', async (c) => {
  const { description, seed } = await c.req.json();
  
  // 1. Trimite la LLM cu system prompt care include field types disponibile
  const schema = await generateSchemaFromDescription(description);
  
  // 2. Validează și execută fiecare colecție prin DDLManager
  for (const col of schema.collections) {
    await DDLManager.createCollection(db, col);
  }
  
  // 3. Setează relațiile și permisiunile
  // 4. Dacă seed=true, generează date sintetice realiste
  
  return c.json({ collections: schema.collections, seed_count: schema.seedData?.length });
});
```

### P6 — End-to-End Type Safety fără CLI
**Scop:** Adaugi o coloană în Studio → TypeScript-ul din SDK se actualizează automat, fără `pnpm generate-types`.

**Abordare:**
- Endpoint existent `GET /api/collections` returnează schema completă cu toate câmpurile și tipurile
- `@zveltio/sdk` expune un tip generic `ZveltioClient<Schema>` unde `Schema` se inferă din schema endpoint
- În monorepo (dacă packages/sdk și app sunt în același workspace): un plugin Vite/TypeScript în SDK care face fetch la `/api/collections` la `dev` start și generează `schema.d.ts` în `node_modules/@zveltio/sdk/dist/`
- **Varianta simplă (fără CLI):** `zveltio.collection<Post>('posts')` — developer declară tipul local, SDK verifică la runtime
- **Varianta completă:** `zveltio dev --watch` → daemon care ascultă WebSocket pentru schema changes → regenerează `schema.d.ts` la orice modificare DDL din Studio

**Fișier nou:** `packages/sdk/src/schema-watcher.ts`
```typescript
// Rulează în background când `zveltio dev --watch` e activ
export async function watchSchema(engineUrl: string, outputPath: string) {
  const ws = new WebSocket(`${engineUrl}/ws`);
  ws.onmessage = async (e) => {
    const { event, collection } = JSON.parse(e.data);
    if (event === 'schema:changed') {
      const schema = await fetch(`${engineUrl}/api/collections`).then(r => r.json());
      await generateTypesFile(schema, outputPath);
      console.log(`✓ Types updated for collection: ${collection}`);
    }
  };
}
```

---

## Ce NU face niciodată

1. Nu adăuga dependențe Node.js-only în `packages/engine/` (ex: `express`, `multer`, `fs-extra`)
2. Nu crea rute fără auth guard
3. Nu modifica tabelele Better-Auth direct (`user`, `session`, `account`, `verification`)
4. Nu folosi `process.env.*` în Svelte — folosește `import.meta.env.VITE_*`
5. Nu importa din `packages/engine/` în extensii — extensiile primesc tot prin `ExtensionContext`
6. Nu folosi `writable()`, `readable()`, `derived()` din `svelte/store` — Svelte 5 runes
7. Nu adăuga rute direct în `packages/engine/src/index.ts`
8. Nu servi fișiere statice cu `Bun.file(absolutePath)` în producție — VFS (studio-embed)
9. Nu folosi WAL replication slots pentru realtime — LISTEN/NOTIFY
10. Nu scrie switch/if pe `field.type` — FieldTypeRegistry

---

## Importuri standard Studio

```typescript
import { api } from '$lib/api.js';
import { auth } from '$lib/auth.svelte.js';
import { ENGINE_URL } from '$lib/config.js';
import { base } from '$app/paths';
import { extensions } from '$lib/extensions.svelte.js';
import { extensionRegistry } from '$lib/extension-registry.svelte.js';
```

## Înregistrare rută nouă (checklist)

1. Creează `packages/engine/src/routes/my-feature.ts`
2. Importă și adaugă în `packages/engine/src/routes/index.ts`
3. Dacă e nevoie de tabel nou → migrare SQL în `src/db/migrations/sql/0XX_*.sql`
4. Creează pagina Studio în `packages/studio/src/routes/admin/my-page/+page.svelte`
5. Adaugă în `coreNav` din `packages/studio/src/routes/admin/+layout.svelte`

---

## Task-uri din audit — portare old repo → packages/ (implementează în această ordine)

Aceste task-uri au reieșit dintr-un audit complet care a comparat `src/` (old monorepo) cu `packages/` (noul monorepo). Sursa pentru portare este întotdeauna în `src/` (old repo atașat la proiect).

---

### AUDIT-1 — Portează Multi-Tenancy (P2) din old repo
**Sursa:** `src/middleware/tenant.ts` + `src/lib/tenant-manager.ts` + `src/routes/tenants.ts`
**Destinația:** `packages/engine/src/`

Old repo-ul are o implementare **schema-per-tenant** (un PostgreSQL schema separat per tenant, nu `WHERE tenant_id`), cu:
- Rezolvare tenant din subdomain, header `X-Tenant-Slug`, sau env var fallback
- Suport environments (prod/staging/dev) per tenant
- Provisionare automată schema PostgreSQL la creare tenant
- Cache Valkey pentru tenant lookup

**Pași:**
1. Copiază `src/lib/tenant-manager.ts` → `packages/engine/src/lib/tenant-manager.ts`
   - Adaptează importurile: `db` și `cache` vin din `'../db/index.js'`, elimină importuri Node.js
2. Copiază `src/middleware/tenant.ts` → `packages/engine/src/middleware/tenant.ts`
3. Portează `src/routes/tenants.ts` → `packages/engine/src/routes/tenants.ts`
   - Înlocuiește `import { db } from '../db/index.js'` cu parametru `db: Database`
   - Înlocuiește `checkPermission` cu import din `'../lib/permissions.js'`
4. Înregistrează în `packages/engine/src/routes/index.ts`:
   ```typescript
   import { tenantsRoutes } from './tenants.js';
   app.route('/api/tenants', tenantsRoutes(db, auth));
   ```
5. Aplică middleware în `packages/engine/src/index.ts` înainte de rute:
   ```typescript
   import { tenantMiddleware } from './middleware/tenant.js';
   app.use('*', tenantMiddleware);
   ```
6. Portează migrările SQL aferente: `migrations/021_multitenancy.sql` → `packages/engine/src/db/migrations/sql/020_multitenancy.sql` (ajustează numărul)
7. Adaugă pagina Studio: `packages/studio/src/routes/admin/tenants/+page.svelte` (portează din `src/routes/admin/tenants/`)

---

### AUDIT-2 — Portează `/api/flows` (Automation Flows cu execuție)
**Sursa:** `src/routes/flows.ts` + `src/lib/flow-executor.ts` (dacă există)
**Destinația:** `packages/engine/src/routes/flows.ts`

Motorul `packages/engine` are `lib/flow-scheduler.ts` care pornește flows pe cron, dar nu execută pașii efectiv. Old repo-ul are endpoint-uri pentru CRUD flows și execuție manuală.

**Pași:**
1. Portează `src/routes/flows.ts` → `packages/engine/src/routes/flows.ts`
   - Pattern standard: `export function flowsRoutes(db: Database, auth: any): Hono`
   - Înlocuiește `import { db }` cu parametru
2. Dacă există `src/lib/flow-executor.ts`, portează-l la `packages/engine/src/lib/flow-executor.ts`
3. Conectează `flow-scheduler.ts` existent cu executorul portat
4. Înregistrează:
   ```typescript
   import { flowsRoutes } from './flows.js';
   app.route('/api/flows', flowsRoutes(db, auth));
   ```
5. Portează pagina Studio din `src/routes/admin/flows/` → `packages/studio/src/routes/admin/flows/`

---

### AUDIT-3 — Portează `/api/media` (Media Library)
**Sursa:** `src/routes/media.ts`
**Destinația:** `packages/engine/src/routes/media.ts`

`/api/storage` există deja dar este pentru upload/download fișiere. `/api/media` este Media Library cu folders, tags, organizare galerie — funcționalitate distinctă.

**Pași:**
1. Portează `src/routes/media.ts` → `packages/engine/src/routes/media.ts`
   - Pattern standard cu `(db: Database, auth: any): Hono`
2. Verifică că migrarea pentru `zv_media_folders` și `zv_media_files` există în `packages/engine/src/db/migrations/sql/005_storage.sql` — dacă nu, adaugă separat
3. Înregistrează:
   ```typescript
   import { mediaRoutes } from './media.js';
   app.route('/api/media', mediaRoutes(db, auth));
   ```
4. Portează pagina Studio `src/routes/admin/media/+page.svelte` → `packages/studio/src/routes/admin/media/+page.svelte`
   - Înlocuiește `fetch('/api/media/...')` cu `api.get('/api/media/...')` din `$lib/api.js`
5. Adaugă în `coreNav`:
   ```typescript
   import { Image } from '@lucide/svelte';
   { href: `${base}/media`, icon: Image, label: 'Media' }
   ```

---

### AUDIT-4 — Portează `/api/backup` (Backup & Restore)
**Sursa:** `src/routes/backup.ts`
**Destinația:** `packages/engine/src/routes/backup.ts`

Critical pentru producție. Folosește `pg_dump` subprocess.

**Pași:**
1. Portează `src/routes/backup.ts` → `packages/engine/src/routes/backup.ts`
   - Adaptează subprocess: înlocuiește `child_process.spawn` cu `Bun.spawn`
   - Înlocuiește `import { db }` cu parametru `db: Database`
2. Adaugă variabilă de env `BACKUP_DIR` în `.env.example` (probabil există deja)
3. Înregistrează:
   ```typescript
   import { backupRoutes } from './backup.js';
   app.route('/api/backup', backupRoutes(db, auth));
   ```
4. Portează UI din `src/routes/admin/settings/backup/` → `packages/studio/src/routes/admin/settings/backup/`

**Notă:** `Bun.spawn` înlocuiește `child_process`:
```typescript
// Old (Node):
import { spawn } from 'child_process';
spawn('pg_dump', [...args]);

// New (Bun):
const proc = Bun.spawn(['pg_dump', ...args], { stdout: 'pipe' });
const output = await new Response(proc.stdout).text();
```

---

### AUDIT-5 — Portează `/api/pages` (CMS Pages + Sitemap)
**Sursa:** `src/routes/pages.ts` + `src/routes/admin-pages.ts`
**Destinația:** `packages/engine/src/routes/`

**Pași:**
1. Portează `src/routes/pages.ts` → `packages/engine/src/routes/pages.ts` (public)
2. Portează `src/routes/admin-pages.ts` → `packages/engine/src/routes/admin-pages.ts`
3. Adaugă generarea `sitemap.xml` (există în old `src/index.ts` ca handler inline) ca rută separată în admin-pages sau index
4. Înregistrează:
   ```typescript
   import { publicPagesRoutes } from './pages.js';
   import { adminPagesRoutes } from './admin-pages.js';
   app.route('/api/pages', publicPagesRoutes(db, auth));
   app.route('/api/admin/pages', adminPagesRoutes(db, auth));
   ```

---

### AUDIT-6 — Portează `/api/gdpr` (GDPR Compliance)
**Sursa:** `src/routes/gdpr.ts`
**Destinația:** `packages/engine/src/routes/gdpr.ts`

Include: export date utilizator, ștergere cont, portabilitate date (GDPR Art. 17, 20).

**Pași:**
1. Portează cu pattern standard
2. Înregistrează:
   ```typescript
   import { gdprRoutes } from './gdpr.js';
   app.route('/api/gdpr', gdprRoutes(db, auth));
   ```

---

### AUDIT-7 — Portează `/api/saved-queries`
**Sursa:** `src/routes/saved-queries.ts`
**Destinația:** `packages/engine/src/routes/saved-queries.ts`

Permite salvarea și re-execuția query-urilor din API Playground.

**Pași:**
1. Portează cu pattern standard
2. Înregistrează:
   ```typescript
   import { savedQueriesRoutes } from './saved-queries.js';
   app.route('/api/saved-queries', savedQueriesRoutes(db, auth));
   ```

---

### AUDIT-8 — Portează `/api/drafts`
**Sursa:** `src/routes/drafts.ts`
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

### AUDIT-9 — Portează `/api/approvals` (Approval Workflows)
**Sursa:** `src/routes/approvals.ts`
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

### AUDIT-10 — Portează componentele Studio cu stub → implementare reală
**Sursa:** `src/lib/components/` (old repo)
**Destinația:** `packages/studio/src/lib/components/`

Aceste componente există în old repo cu implementare reală dar în packages/studio sunt fie lipsă, fie stub:

#### 10a. ConstraintEditor
```
packages/studio/src/lib/components/admin/ConstraintEditor.svelte
← src/lib/components/admin/ConstraintEditor/ConstraintEditor.svelte
```
Old repo-ul are o implementare reală (verifică `src/lib/components/admin/ConstraintEditor/ConstraintEditor.svelte`). Dacă tot stub, implementează: afișează constrângerile FK ale tabelului curent + buton drop constraint.

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
Props: `$bindable<Metadata>` cu `{displayName?, menuGroup?, isLoggable?, icon?}`. Editor pentru metadatele unei colecții.

#### 10d. StatsView (views)
```
packages/studio/src/lib/components/views/StatsView.svelte
← src/lib/components/views/StatsView/StatsView.svelte
```
Afișează statistici agregate (count, sum, avg, min, max) pe colecțiile selectate.

#### 10e. TableView (views)
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
Randarea unui câmp individual în tabel, în funcție de tipul câmpului (image preview, boolean toggle, date format etc).

**La portare:** înlocuiește `engineClient.request()` cu `api.get/post/patch/delete()` din `$lib/api.js`. Înlocuiește `import { page } from '$app/stores'` cu `import { page } from '$app/state'` (Svelte 5). Înlocuiește orice `$store` reactiv cu `$state` / `$derived`.

---

### AUDIT-11 — Portează P1 Zero-Downtime DDL (Ghost Table)
**Destinație:** `packages/engine/src/lib/ddl-queue.ts` (extinde implementarea existentă)

DDL queue există și funcționează. Adaugă suportul pentru migrări zero-downtime pe tabele mari:

```typescript
// În ddl-queue.ts, adaugă tipuri noi de joburi:
// 'add_column_safe'   → folosește ghost table dacă tabela > N rânduri sau coloana e NOT NULL fără default
// 'alter_column_safe' → idem

async function processAddColumnSafe(db: Database, job: DDLJob): Promise<void> {
  const { collection, column, pgType, notNull, defaultValue, threshold = 10000 } = job.payload;
  const tableName = DDLManager.getTableName(collection);

  // Check row count
  const countResult = await sql`SELECT COUNT(*) as cnt FROM ${sql.id(tableName)}`.execute(db);
  const rowCount = parseInt((countResult.rows[0] as any).cnt);
  const needsGhost = rowCount > threshold || (notNull && !defaultValue);

  if (!needsGhost) {
    // Fast path: ALTER TABLE direct
    await sql`ALTER TABLE ${sql.id(tableName)} ADD COLUMN IF NOT EXISTS ${sql.id(column)} ${sql.raw(pgType)}`.execute(db);
    return;
  }

  // Ghost table path:
  const ghostName = `${tableName}_ghost_${Date.now()}`;

  // 1. Create ghost with new schema
  await sql`CREATE TABLE ${sql.id(ghostName)} (LIKE ${sql.id(tableName)} INCLUDING ALL)`.execute(db);
  await sql`ALTER TABLE ${sql.id(ghostName)} ADD COLUMN ${sql.id(column)} ${sql.raw(pgType)}`.execute(db);

  // 2. Copy data in batches (non-blocking)
  let lastId: string | null = null;
  const batchSize = 1000;
  do {
    const batch = await sql`
      SELECT * FROM ${sql.id(tableName)}
      ${lastId ? sql`WHERE id > ${lastId}` : sql``}
      ORDER BY id LIMIT ${batchSize}
    `.execute(db);
    if (batch.rows.length === 0) break;
    // Insert batch into ghost (column will have NULL/default)
    for (const row of batch.rows) {
      await sql`INSERT INTO ${sql.id(ghostName)} SELECT * FROM (VALUES (${sql.join(Object.values(row as any).map(v => sql`${v}`))})) AS t(${sql.raw(Object.keys(row as any).join(','))}) ON CONFLICT DO NOTHING`.execute(db);
    }
    lastId = (batch.rows[batch.rows.length - 1] as any).id;
  } while (true);

  // 3. Sync trigger on original table
  const triggerName = `${tableName}_ghost_sync`;
  await sql`
    CREATE OR REPLACE FUNCTION ${sql.id(triggerName + '_fn')}() RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO ${sql.id(ghostName)} VALUES (NEW.*) ON CONFLICT (id) DO UPDATE SET id = NEW.id;
      ELSIF TG_OP = 'UPDATE' THEN
        UPDATE ${sql.id(ghostName)} SET id = NEW.id WHERE id = OLD.id;
      ELSIF TG_OP = 'DELETE' THEN
        DELETE FROM ${sql.id(ghostName)} WHERE id = OLD.id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
  await sql`
    CREATE TRIGGER ${sql.id(triggerName)}
    AFTER INSERT OR UPDATE OR DELETE ON ${sql.id(tableName)}
    FOR EACH ROW EXECUTE FUNCTION ${sql.id(triggerName + '_fn')}()
  `.execute(db);

  // 4. Final swap (brief exclusive lock, milliseconds)
  await sql`ALTER TABLE ${sql.id(tableName)} RENAME TO ${sql.id(tableName + '_old_' + Date.now())}`.execute(db);
  await sql`ALTER TABLE ${sql.id(ghostName)} RENAME TO ${sql.id(tableName)}`.execute(db);

  // 5. Cleanup
  await sql`DROP TRIGGER IF EXISTS ${sql.id(triggerName)} ON ${sql.id(tableName + '_old_' + Date.now())}`.execute(db);
  await sql`DROP TABLE IF EXISTS ${sql.id(tableName + '_old_' + Date.now())}`.execute(db);
}
```

Adaugă `'add_column_safe'` ca tip nou în switch-ul din `processNextJob()`.

---

### AUDIT-12 — Portează P3 SDK Local-First
**Destinație:** `packages/sdk/src/local/`

**Fișiere noi:**
```
packages/sdk/src/local/
├── LocalStore.ts       ← IndexedDB (browser) sau Map in-memory (Node/fallback)
├── SyncEngine.ts       ← sync background cu server, conflict resolution
└── index.ts
```

**LocalStore.ts** (browser-first, fallback la Map):
```typescript
export class LocalStore {
  private db: IDBDatabase | null = null;
  private memStore: Map<string, Map<string, any>> = new Map(); // fallback

  async open(): Promise<void> {
    if (typeof indexedDB === 'undefined') return; // Node fallback
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('zveltio-local', 1);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('records')) {
          db.createObjectStore('records', { keyPath: '_localKey' });
        }
        if (!db.objectStoreNames.contains('pending')) {
          db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  async get(collection: string, id: string): Promise<any | null> { /* ... */ }
  async set(collection: string, id: string, data: any): Promise<void> { /* ... */ }
  async list(collection: string): Promise<any[]> { /* ... */ }
  async addPending(op: { type: 'create'|'update'|'delete', collection: string, id: string, data: any }): Promise<void> { /* ... */ }
  async getPending(): Promise<any[]> { /* ... */ }
  async clearPending(id: number): Promise<void> { /* ... */ }
}
```

**SyncEngine.ts:**
```typescript
export class SyncEngine {
  constructor(private store: LocalStore, private engineUrl: string, private apiKey?: string) {}

  async sync(collection: string): Promise<void> {
    const pending = await this.store.getPending();
    for (const op of pending) {
      try {
        await this.applyOp(op);
        await this.store.clearPending(op.id);
      } catch (err) {
        console.warn('[zveltio] Sync failed for op', op.id, err);
        // keep in pending, retry next cycle
      }
    }
  }

  private async applyOp(op: any): Promise<void> {
    const headers: any = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    if (op.type === 'create') {
      await fetch(`${this.engineUrl}/api/data/${op.collection}`, { method: 'POST', headers, body: JSON.stringify(op.data) });
    } else if (op.type === 'update') {
      await fetch(`${this.engineUrl}/api/data/${op.collection}/${op.id}`, { method: 'PATCH', headers, body: JSON.stringify(op.data) });
    } else if (op.type === 'delete') {
      await fetch(`${this.engineUrl}/api/data/${op.collection}/${op.id}`, { method: 'DELETE', headers });
    }
  }

  startAutoSync(intervalMs = 5000): () => void {
    const id = setInterval(() => this.sync('*'), intervalMs);
    return () => clearInterval(id);
  }
}
```

Integrează în `ZveltioClient` din `packages/sdk/src/client/ZveltioClient.ts`:
```typescript
// config opțional: localFirst: true
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

Exportă din `packages/sdk/src/index.ts`:
```typescript
export { LocalStore } from './local/LocalStore.js';
export { SyncEngine } from './local/SyncEngine.js';
```
