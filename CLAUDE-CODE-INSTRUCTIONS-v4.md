# CLAUDE CODE INSTRUCTIONS v4 — Zveltio Migration & Architecture Fix + Security Hardening + AI Engine

> **FILOSOFIE:** Nu mai genera fișiere goale. Fiecare task din acest document produce **cod funcțional, testat**.
> Execută fazele **strict în ordine**. Fiecare fază se termină cu un smoke test.
> Când portezi din old repo (`src/`), citește ÎNTÂI fișierul sursă, înțelege logica, apoi rescrie-l pentru noul pattern.

---

## REGULI ABSOLUTE — La fiecare linie de cod

```
1. Bun runtime, NU Node.js
   ✅ Bun.file(), Bun.serve(), Bun.spawn(['pg_dump', ...args], { stdout: 'pipe' })
   ❌ fs/promises, child_process, require('http')

2. Kysely query builder, NU raw SQL concatenat
   ✅ db.selectFrom('table').where('col', '=', val).execute()
   ✅ sql`ALTER TABLE ${sql.id(name)} ADD COLUMN ...`.execute(db)
   ❌ db.execute('SELECT * FROM ' + tableName)

3. DDL exclusiv prin DDLManager + ddl-queue (tranzacțional)
   ✅ DDLManager.createCollection(db, def)
   ❌ ALTER TABLE direct în route handlers

4. FieldTypeRegistry, NU switch/case pe field.type
   ✅ fieldTypeRegistry.get(type).api.serialize(value)
   ❌ if (field.type === 'json') { ... } else if (...)

5. Svelte 5 runes, NU Svelte 4 stores
   ✅ let count = $state(0); let doubled = $derived(count * 2)
   ❌ import { writable } from 'svelte/store'
   ✅ import { page } from '$app/state'
   ❌ import { page } from '$app/stores'

6. Studio API = $lib/api.js
   ✅ import { api } from '$lib/api.js'; await api.get('/api/...')
   ❌ fetch('/api/...') direct

7. Route pattern (TOATE rutele engine):
   export function myRoutes(db: Database, auth: any): Hono {
     const app = new Hono();
     return app;
   }

8. Icons = @lucide/svelte | Styling = TailwindCSS 4 + DaisyUI

9. Extensiile NU importă din packages/engine/ — primesc ctx: ExtensionContext

10. Package Manager EXCLUSIV Bun
    ✅ bun install, bun add <pkg>, bun add -d <pkg>, bun run <script>
    ❌ pnpm, npm, yarn — INTERZISE complet
    Orice adăugare de pachet = `bun add`. Orice install = `bun install`.
    Lock file = bun.lockb (NU pnpm-lock.yaml, NU package-lock.json)
```

---

## PRE-FAZĂ: Curățenie pnpm → Bun (O singură dată, ÎNAINTE de Faza 0)

Proiectul a fost migrat de la Node/pnpm la Bun. Elimină toate artefactele pnpm:

```bash
# 1. Șterge pnpm artifacts
rm -f pnpm-workspace.yaml pnpm-lock.yaml .npmrc

# 2. Șterge TOATE node_modules (root + packages + extensions)
rm -rf node_modules packages/*/node_modules extensions/*/*/node_modules

# 3. Verifică că package.json root are workspaces definite:
# Dacă NU are "workspaces", adaugă:
```

**Fișier:** `package.json` (root) — verifică/adaugă:
```json
{
  "name": "zveltio",
  "private": true,
  "workspaces": [
    "packages/*",
    "extensions/*/*"
  ]
}
```

```bash
# 4. Instalare curată cu Bun
bun install

# 5. Verifică că s-a generat bun.lockb
ls -la bun.lockb
```

**IMPORTANT:** Turborepo detectează automat `bun.lockb` și va folosi Bun ca package manager pentru toate task-urile. Nu mai e nevoie de configurare suplimentară.

---

# ═══════════════════════════════════════════════════════════
# FAZA 0 — TRACER BULLET: Țeava completă Engine→Studio→SDK
# ═══════════════════════════════════════════════════════════

> **Scopul:** Înainte de orice portare, confirmă că fluxul de bază funcționează
> end-to-end: Engine pornește → Studio se conectează → SDK face CRUD.
> Dacă asta nu merge, nimic altceva nu contează.

### TASK 0.1 — Verificare Engine boot

```bash
cd packages/engine && bun run src/index.ts
```

Trebuie să vezi:
- `Zveltio Engine running on port 3000`
- `GET /health` returnează `200 OK`
- `GET /api/collections` returnează `{ collections: [...] }`

Dacă NU pornește, fix-ează erorile de import/compilare ÎNAINTE de orice altceva.

### TASK 0.2 — Verificare Studio build

```bash
cd packages/studio && bun run build
```

Trebuie să compileze fără erori. Dacă sunt erori de import (componente lipsă, etc.), notează-le dar nu le fixa acum — le fixăm în Faza 7.

### TASK 0.3 — Verificare SDK build

```bash
cd packages/sdk && bun run build
```

Trebuie să compileze. Output în `dist/`.

### TASK 0.4 — Conectează rutele existente dar neînregistrate

**Fișier:** `packages/engine/src/routes/index.ts`

Deschide fișierul. Identifică funcția principală de înregistrare (probabil `registerRoutes`).
Verifică pentru fiecare din aceste fișiere dacă EXISTĂ în `packages/engine/src/routes/`:

```
schema-branches.ts
api-docs.ts
database.ts
ai-schema-gen.ts
pages.ts
```

Pentru fiecare fișier care EXISTĂ dar NU are `app.route()` în `index.ts`, adaugă:

```typescript
// Citește exportul din fișier ca să vezi signatura exactă!
// Dacă exportă o funcție (db, auth) => Hono:
import { schemaBranchesRoutes } from './schema-branches.js';
app.route('/api/schema', schemaBranchesRoutes(db, auth));

// Dacă exportă direct un Hono instance:
import { schemaBranchesRoutes } from './schema-branches.js';
app.route('/api/schema', schemaBranchesRoutes);
```

Fă asta DOAR pentru fișierele care există și au cod real (nu fișiere goale/stub).

**Verificare:** `bun run src/index.ts` — trebuie să pornească fără erori.

---

# ═══════════════════════════════════════════════════════════
# FAZA 1 — WEBSOCKET + REALTIME (Critic — fără asta no live apps)
# ═══════════════════════════════════════════════════════════

### TASK 1.1 — Realtime Core Library

**Destinație:** `packages/engine/src/lib/realtime.ts`

**Dependență:** `cd packages/engine && bun add pg @types/pg`

Citește din old repo `src/routes/ws.ts` și `src/routes/realtime.ts` pentru a înțelege logica.
Implementează un RealtimeManager care:

```typescript
import { Client as PgClient } from 'pg';

// Listener PostgreSQL dedicat (NU prin Kysely — Kysely nu suportă LISTEN persistent)
// Folosește un pg.Client separat cu o conexiune persistentă pentru LISTEN

export class RealtimeManager {
  private pgListener: PgClient | null = null;
  private subscribers: Map<string, Set<WebSocket>> = new Map();

  async start(databaseUrl: string) {
    // 1. Creează un pg.Client dedicat pentru LISTEN (Bun-compatibil via node:net)
    this.pgListener = new PgClient({ connectionString: databaseUrl });
    await this.pgListener.connect();

    // 2. LISTEN pe canalul zveltio_changes
    await this.pgListener.query('LISTEN zveltio_changes');

    // 3. Când primim notificare, distribuie la WebSocket subscribers
    this.pgListener.on('notification', (msg: any) => {
      if (msg.channel === 'zveltio_changes') {
        const payload = JSON.parse(msg.payload);
        const collection = payload.collection;
        const subs = this.subscribers.get(collection) || new Set();
        const dead: WebSocket[] = [];

        subs.forEach((ws) => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(payload));
            } else {
              dead.push(ws);
            }
          } catch { dead.push(ws); }
        });

        // Cleanup dead connections
        dead.forEach((ws) => subs.delete(ws));
      }
    });
  }

  subscribe(collection: string, ws: WebSocket) {
    if (!this.subscribers.has(collection)) {
      this.subscribers.set(collection, new Set());
    }
    this.subscribers.get(collection)!.add(ws);
  }

  unsubscribe(collection: string, ws: WebSocket) {
    this.subscribers.get(collection)?.delete(ws);
  }

  unsubscribeAll(ws: WebSocket) {
    for (const subs of this.subscribers.values()) {
      subs.delete(ws);
    }
  }

  async stop() {
    await this.pgListener?.end();
  }
}

export const realtimeManager = new RealtimeManager();
```

### TASK 1.2 — Emit pg_notify din data routes

**Fișier:** `packages/engine/src/routes/data.ts`

În POST (create), PATCH (update), DELETE — după succesul operației, emit notificare:

```typescript
import { sql } from 'kysely';

// După un INSERT reușit:
await sql`SELECT pg_notify('zveltio_changes', ${JSON.stringify({
  event: 'record.created',
  collection: collection,
  record_id: record.id,
  user_id: user?.id,
  timestamp: new Date().toISOString(),
})})`.execute(db);
```

Fă similar pentru UPDATE (`record.updated`) și DELETE (`record.deleted`).

### TASK 1.3 — WebSocket Route cu Bun nativ

**Destinație:** `packages/engine/src/routes/ws.ts`

```typescript
import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import { realtimeManager } from '../lib/realtime.js';

export function wsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Endpoint pentru Bun.serve() WebSocket upgrade
  // NOTA: Bun WebSocket se configurează la nivel de server, nu la nivel de rută Hono.
  // Această rută servește ca fallback/info endpoint.
  app.get('/', (c) => {
    return c.json({
      message: 'WebSocket endpoint. Connect via ws://host:port/api/ws',
      protocol: 'zveltio-realtime-v1',
    });
  });

  return app;
}
```

### TASK 1.4 — Integrare WebSocket în server bootstrap

**Fișier:** `packages/engine/src/index.ts`

Unde se face `Bun.serve()`, adaugă WebSocket handler:

```typescript
import { realtimeManager } from './lib/realtime.js';

// Start realtime listener
await realtimeManager.start(process.env.DATABASE_URL!);

const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch, // Hono handler

  websocket: {
    open(ws) {
      // ws.data conține info din upgrade
    },
    message(ws, message) {
      try {
        const msg = JSON.parse(String(message));
        if (msg.action === 'subscribe' && msg.collection) {
          realtimeManager.subscribe(msg.collection, ws as any);
        } else if (msg.action === 'unsubscribe' && msg.collection) {
          realtimeManager.unsubscribe(msg.collection, ws as any);
        }
      } catch { /* invalid JSON — ignore */ }
    },
    close(ws) {
      realtimeManager.unsubscribeAll(ws as any);
    },
  },
});

// WebSocket upgrade handler
// Modifică fetch-ul pentru a intercepta upgrade requests:
// (Adaptează la cum e structurat index.ts actual)
```

**IMPORTANT:** Adaptează la structura EXACTĂ a `index.ts` existent. Nu suprascrie ce funcționează deja. Integrează WebSocket în flow-ul existent.

Înregistrează ruta:
```typescript
import { wsRoutes } from './routes/ws.js';
app.route('/api/ws', wsRoutes(db, auth));
```

**Verificare:** `bun run src/index.ts`, apoi `wscat -c ws://localhost:3000/api/ws` — trebuie să se conecteze.

---

# ═══════════════════════════════════════════════════════════
# FAZA 2 — FLOW EXECUTOR (Scheduler-ul e inutil fără el)
# ═══════════════════════════════════════════════════════════

### TASK 2.1 — Flow Executor Engine

**Sursă:** Citește `src/lib/flow-executor.ts` și `src/routes/flows.ts` din old repo.
**Destinație:** `packages/engine/src/lib/flow-executor.ts`

Implementează un executor care procesează pașii unui flow secvențial:

```typescript
import type { Database } from '../db/index.js';
import { sql } from 'kysely';

interface FlowStep {
  id: string;
  type: 'condition' | 'action' | 'delay' | 'webhook' | 'email' | 'create_record' | 'update_record';
  config: Record<string, any>;
  next_on_true?: string;
  next_on_false?: string;
  next?: string;
}

interface FlowRun {
  flow_id: string;
  status: 'running' | 'completed' | 'failed';
  started_at: Date;
  steps_executed: string[];
  error?: string;
}

export async function executeFlow(
  db: Database,
  flow: { id: string; steps: FlowStep[]; trigger_data?: any },
  context: { user_id?: string } = {}
): Promise<FlowRun> {
  const run: FlowRun = {
    flow_id: flow.id,
    status: 'running',
    started_at: new Date(),
    steps_executed: [],
  };

  // Log run start
  const runRecord = await db
    .insertInto('zv_flow_runs' as any)
    .values({
      flow_id: flow.id,
      status: 'running',
      trigger_data: JSON.stringify(flow.trigger_data || {}),
      started_at: new Date(),
    })
    .returningAll()
    .executeTakeFirst();

  try {
    const stepsMap = new Map(flow.steps.map((s) => [s.id, s]));
    let currentStepId = flow.steps[0]?.id;

    while (currentStepId) {
      const step = stepsMap.get(currentStepId);
      if (!step) break;

      run.steps_executed.push(step.id);

      const result = await executeStep(db, step, flow.trigger_data, context);

      // Determine next step
      if (step.type === 'condition') {
        currentStepId = result ? step.next_on_true : step.next_on_false;
      } else {
        currentStepId = step.next;
      }

      // Update run progress
      await db
        .updateTable('zv_flow_runs' as any)
        .set({
          steps_executed: JSON.stringify(run.steps_executed),
          updated_at: new Date(),
        })
        .where('id', '=', (runRecord as any).id)
        .execute();
    }

    run.status = 'completed';
  } catch (err: any) {
    run.status = 'failed';
    run.error = err.message;
  }

  // Log run completion
  await db
    .updateTable('zv_flow_runs' as any)
    .set({
      status: run.status,
      error: run.error || null,
      completed_at: new Date(),
      steps_executed: JSON.stringify(run.steps_executed),
    })
    .where('id', '=', (runRecord as any).id)
    .execute();

  return run;
}

async function executeStep(
  db: Database,
  step: FlowStep,
  triggerData: any,
  context: { user_id?: string }
): Promise<any> {
  switch (step.type) {
    case 'condition':
      return evaluateCondition(step.config, triggerData);

    case 'create_record':
      return db
        .insertInto(step.config.collection as any)
        .values(resolveVariables(step.config.data, triggerData))
        .returningAll()
        .executeTakeFirst();

    case 'update_record':
      return db
        .updateTable(step.config.collection as any)
        .set(resolveVariables(step.config.data, triggerData))
        .where('id', '=', step.config.record_id)
        .execute();

    case 'webhook': {
      const res = await fetch(step.config.url, {
        method: step.config.method || 'POST',
        headers: { 'Content-Type': 'application/json', ...step.config.headers },
        body: JSON.stringify(resolveVariables(step.config.body || {}, triggerData)),
      });
      return { status: res.status, ok: res.ok };
    }

    case 'email':
      // Queue email via zv_email_queue
      await db
        .insertInto('zv_email_queue' as any)
        .values({
          to_email: resolveVariable(step.config.to, triggerData),
          subject: resolveVariable(step.config.subject, triggerData),
          body_html: resolveVariable(step.config.body, triggerData),
          status: 'pending',
        })
        .execute();
      return { queued: true };

    case 'delay':
      await new Promise((r) => setTimeout(r, (step.config.seconds || 0) * 1000));
      return { delayed: step.config.seconds };

    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

function evaluateCondition(config: any, data: any): boolean {
  const value = resolveVariable(config.field, data);
  switch (config.operator) {
    case 'eq': return value === config.value;
    case 'neq': return value !== config.value;
    case 'gt': return value > config.value;
    case 'lt': return value < config.value;
    case 'contains': return String(value).includes(config.value);
    case 'exists': return value != null;
    default: return false;
  }
}

function resolveVariable(template: string, data: any): any {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
    return path.split('.').reduce((obj: any, key: string) => obj?.[key], data) ?? '';
  });
}

function resolveVariables(obj: any, data: any): any {
  if (typeof obj === 'string') return resolveVariable(obj, data);
  if (Array.isArray(obj)) return obj.map((v) => resolveVariables(v, data));
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveVariables(v, data)]));
  }
  return obj;
}
```

### TASK 2.2 — Conectează Executor la Scheduler

**Fișier:** `packages/engine/src/lib/flow-scheduler.ts`

Deschide fișierul existent. Găsește locul unde scheduler-ul detectează un flow due.
Adaugă:

```typescript
import { executeFlow } from './flow-executor.js';

// Unde scheduler-ul procesează un flow due:
// Înlocuiește orice placeholder/TODO cu:
const flow = await db.selectFrom('zv_flows' as any).selectAll().where('id', '=', flowId).executeTakeFirst();
if (flow) {
  const steps = typeof flow.steps === 'string' ? JSON.parse(flow.steps) : flow.steps;
  await executeFlow(db, { id: flow.id, steps, trigger_data: flow.trigger_config });
}
```

### TASK 2.3 — Flows Routes (CRUD + Manual Execute)

**Sursă:** Citește `src/routes/flows.ts` din old repo.
**Destinație:** `packages/engine/src/routes/flows.ts`

Pattern standard. Endpoints:
- `GET /` — list flows
- `POST /` — create flow (cu steps JSON)
- `GET /:id` — get flow details
- `PATCH /:id` — update flow
- `DELETE /:id` — delete flow
- `POST /:id/execute` — manual trigger (apelează `executeFlow()`)
- `GET /:id/runs` — list run history

Migrare (verifică dacă `zv_flows` și `zv_flow_runs` există; dacă nu, creează):

```sql
-- packages/engine/src/db/migrations/sql/018_flows.sql
CREATE TABLE IF NOT EXISTS zv_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual', 'schedule', 'event', 'webhook')),
  trigger_config JSONB DEFAULT '{}',
  steps JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS zv_flow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES zv_flows(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  trigger_data JSONB DEFAULT '{}',
  steps_executed JSONB DEFAULT '[]',
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_flow_runs_flow ON zv_flow_runs(flow_id);
CREATE INDEX idx_flow_runs_status ON zv_flow_runs(status);
```

Înregistrează în `routes/index.ts`:
```typescript
import { flowsRoutes } from './flows.js';
app.route('/api/flows', flowsRoutes(db, auth));
```

---

# ═══════════════════════════════════════════════════════════
# FAZA 3 — MULTI-TENANCY cu PostgreSQL RLS (Nu if-uri manuale!)
# ═══════════════════════════════════════════════════════════

> **REGULA DE AUR:** Izolarea între tenanți NU se face cu `WHERE tenant_id = ?`
> în fiecare query. Se face cu **PostgreSQL Row-Level Security (RLS)**.
> Chiar dacă un developer uită un WHERE, Postgres REFUZĂ să returneze date din alt tenant.

### TASK 3.1 — Tenant Manager cu RLS

**Sursă:** Citește `src/lib/tenant-manager.ts` din old repo pentru context.
**Destinație:** `packages/engine/src/lib/tenant-manager.ts`

```typescript
import type { Database } from '../db/index.js';
import { sql } from 'kysely';

export class TenantManager {
  /**
   * Setează tenant-ul curent la nivel de sesiune PostgreSQL.
   * Toate query-urile din această tranzacție vor fi filtrate automat prin RLS.
   */
  static async setCurrentTenant(db: Database, tenantId: string): Promise<void> {
    // SET LOCAL funcționează doar într-o tranzacție, SET funcționează pe conexiune
    await sql`SET LOCAL zveltio.current_tenant = ${tenantId}`.execute(db);
  }

  /**
   * Provisionează un tenant nou:
   * 1. Creează record în zv_tenants
   * 2. Optionally creează un schema separat (pentru izolare completă)
   */
  static async provision(
    db: Database,
    data: { name: string; slug: string; owner_id: string; plan?: string }
  ) {
    const tenant = await db
      .insertInto('zv_tenants' as any)
      .values({
        name: data.name,
        slug: data.slug,
        owner_id: data.owner_id,
        plan: data.plan || 'free',
        is_active: true,
      })
      .returningAll()
      .executeTakeFirst();

    return tenant;
  }

  /**
   * Rezolvă tenant din request (subdomain, header, sau env var fallback)
   */
  static async resolve(
    db: Database,
    opts: { subdomain?: string; header?: string; envFallback?: string }
  ) {
    const slug = opts.subdomain || opts.header || opts.envFallback;
    if (!slug) return null;

    const tenant = await db
      .selectFrom('zv_tenants' as any)
      .selectAll()
      .where('slug', '=', slug)
      .where('is_active', '=', true)
      .executeTakeFirst();

    return tenant;
  }

  /**
   * Activează RLS pe o tabelă existentă.
   * Apelează la crearea fiecărei colecții noi.
   */
  static async enableRLS(db: Database, tableName: string): Promise<void> {
    // Adaugă coloana tenant_id dacă nu există
    await sql`
      ALTER TABLE ${sql.id(tableName)}
      ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES zv_tenants(id) ON DELETE CASCADE
    `.execute(db);

    // Creează index pentru performance
    await sql`
      CREATE INDEX IF NOT EXISTS ${sql.id(`idx_${tableName}_tenant`)}
      ON ${sql.id(tableName)}(tenant_id)
    `.execute(db);

    // Activează RLS
    await sql`ALTER TABLE ${sql.id(tableName)} ENABLE ROW LEVEL SECURITY`.execute(db);

    // Politică: utilizatorul vede DOAR rândurile din tenant-ul curent
    // current_setting('zveltio.current_tenant') este setat de middleware la fiecare request
    await sql`
      CREATE POLICY IF NOT EXISTS tenant_isolation ON ${sql.id(tableName)}
      USING (tenant_id::text = current_setting('zveltio.current_tenant', true))
      WITH CHECK (tenant_id::text = current_setting('zveltio.current_tenant', true))
    `.execute(db).catch(() => {
      // Policy might already exist — ignore
    });
  }
}
```

### TASK 3.2 — Tenant Middleware

**Destinație:** `packages/engine/src/middleware/tenant.ts`

```typescript
import type { Context, Next } from 'hono';
import { TenantManager } from '../lib/tenant-manager.js';

/**
 * Middleware care:
 * 1. Extrage tenant slug din subdomain, header X-Tenant-Slug, sau env var
 * 2. Rezolvă tenant-ul din DB
 * 3. Setează SET LOCAL zveltio.current_tenant = tenant.id
 * 4. Pune tenant în context pentru route handlers
 */
export function tenantMiddleware(db: any) {
  return async (c: Context, next: Next) => {
    // Skip pentru rute publice (health, auth, etc.)
    const path = c.req.path;
    if (path === '/health' || path === '/metrics' || path.startsWith('/api/auth/')) {
      return next();
    }

    // Extrage slug din: subdomain > header > env
    const host = c.req.header('host') || '';
    const subdomain = host.split('.').length > 2 ? host.split('.')[0] : undefined;
    const headerSlug = c.req.header('X-Tenant-Slug') || undefined;
    const envSlug = process.env.DEFAULT_TENANT_SLUG || undefined;

    const tenant = await TenantManager.resolve(db, {
      subdomain,
      header: headerSlug,
      envFallback: envSlug,
    });

    if (tenant) {
      // CRITICA: Setează la nivel PostgreSQL — RLS va filtra automat
      await TenantManager.setCurrentTenant(db, tenant.id);
      c.set('tenant', tenant);
      c.set('tenantId', tenant.id);
    }

    await next();
  };
}
```

### TASK 3.3 — Tenant Routes

**Sursă:** Citește `src/routes/tenants.ts` din old repo.
**Destinație:** `packages/engine/src/routes/tenants.ts`

CRUD tenanți (admin only):
- `GET /` — list tenants
- `POST /` — provision new tenant (apelează TenantManager.provision)
- `GET /:id` — get tenant
- `PATCH /:id` — update tenant
- `DELETE /:id` — deactivate tenant
- `POST /:id/enable-rls/:collection` — enable RLS pe o colecție

### TASK 3.4 — Migrare Multi-Tenancy

**Fișier:** `packages/engine/src/db/migrations/sql/020_multitenancy.sql`

```sql
CREATE TABLE IF NOT EXISTS zv_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  is_active BOOLEAN NOT NULL DEFAULT true,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_tenants_slug ON zv_tenants(slug);

-- Setare variabilă customă în PostgreSQL (necesară pentru RLS)
-- Setează o valoare default goală ca PostgreSQL să nu dea eroare la current_setting
ALTER DATABASE CURRENT SET zveltio.current_tenant = '';
```

### TASK 3.5 — Înregistrare

**Fișier:** `packages/engine/src/routes/index.ts`

```typescript
import { tenantMiddleware } from '../middleware/tenant.js';
import { tenantsRoutes } from './tenants.js';

// Middleware ÎNAINTE de rute (dar DUPĂ auth):
app.use('/api/*', tenantMiddleware(db));

// Rută admin:
app.route('/api/tenants', tenantsRoutes(db, auth));
```

---

# ═══════════════════════════════════════════════════════════
# FAZA 4 — VIRTUAL COLLECTIONS cu Query Translator (NU fetch-all)
# ═══════════════════════════════════════════════════════════

> **REGULA:** NICIODATĂ nu aduci toate datele de la API extern și filtrezi în memorie.
> Adaptorul traduce query AST → parametri URL specifici API-ului extern.
> Dacă API-ul nu suportă un operator, aruncă eroare clară.

### TASK 4.1 — Refactor Virtual Collection Adapter

**Fișier:** `packages/engine/src/lib/virtual-collection-adapter.ts`

Deschide fișierul existent. Verifică dacă face fetch-all sau dacă traduce queries.
Dacă face fetch-all, RESCRIE cu acest pattern:

```typescript
/**
 * Fiecare Virtual Source definește:
 * - baseUrl: URL-ul API-ului extern
 * - auth: cum se autentifică (header, query param, bearer)
 * - supportedOperators: ce filtre poate API-ul
 * - fieldMapping: cum se mapează câmpurile Zveltio → câmpurile API-ului
 * - queryTranslator: funcție care transformă FilterCondition[] → URL params
 */
export interface VirtualSourceConfig {
  type: 'rest' | 'graphql';
  baseUrl: string;
  auth: { type: 'bearer' | 'header' | 'query'; key: string; value: string };
  listEndpoint: string;
  getEndpoint: string; // cu :id placeholder
  supportedOperators: string[]; // ['eq', 'gt', 'lt', 'gte', 'lte', 'in']
  fieldMapping: Record<string, string>; // { 'zveltio_field': 'api_field' }
  paginationStyle: 'offset' | 'cursor' | 'page';
  maxPageSize: number;
}

export interface VirtualQuery {
  filters: Array<{ field: string; op: string; value: any }>;
  sort?: { field: string; direction: 'asc' | 'desc' };
  page: number;
  limit: number;
  search?: string;
}

/**
 * Traduce un VirtualQuery în parametri URL pentru API-ul extern.
 * ARUNCĂ EROARE dacă se cere un operator nesuportat.
 */
export function translateQuery(config: VirtualSourceConfig, query: VirtualQuery): string {
  const params = new URLSearchParams();

  // Validare: aruncă eroare pentru operatori nesuportați
  for (const filter of query.filters) {
    if (!config.supportedOperators.includes(filter.op)) {
      throw new Error(
        `Virtual source "${config.baseUrl}" does not support operator "${filter.op}" on field "${filter.field}". ` +
        `Supported operators: ${config.supportedOperators.join(', ')}`
      );
    }

    const apiField = config.fieldMapping[filter.field] || filter.field;

    // Traducere operator → format API
    // Fiecare API are propriul format; aici e un pattern generic
    switch (filter.op) {
      case 'eq': params.append(apiField, String(filter.value)); break;
      case 'gt': params.append(`${apiField}[gt]`, String(filter.value)); break;
      case 'lt': params.append(`${apiField}[lt]`, String(filter.value)); break;
      case 'gte': params.append(`${apiField}[gte]`, String(filter.value)); break;
      case 'lte': params.append(`${apiField}[lte]`, String(filter.value)); break;
      case 'in': params.append(`${apiField}[in]`, Array.isArray(filter.value) ? filter.value.join(',') : String(filter.value)); break;
    }
  }

  // Paginare
  if (config.paginationStyle === 'offset') {
    params.append('offset', String((query.page - 1) * query.limit));
    params.append('limit', String(Math.min(query.limit, config.maxPageSize)));
  } else if (config.paginationStyle === 'page') {
    params.append('page', String(query.page));
    params.append('per_page', String(Math.min(query.limit, config.maxPageSize)));
  }

  // Sort
  if (query.sort) {
    const apiField = config.fieldMapping[query.sort.field] || query.sort.field;
    params.append('sort', `${query.sort.direction === 'desc' ? '-' : ''}${apiField}`);
  }

  return params.toString();
}

/**
 * Fetch list de la Virtual Source — NU face fetch-all.
 * Trimite query-ul tradus direct la API-ul extern.
 */
export async function virtualList(
  config: VirtualSourceConfig,
  query: VirtualQuery
): Promise<{ data: any[]; total: number }> {
  const qs = translateQuery(config, query);
  const url = `${config.baseUrl}${config.listEndpoint}?${qs}`;

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (config.auth.type === 'bearer') headers['Authorization'] = `Bearer ${config.auth.value}`;
  else if (config.auth.type === 'header') headers[config.auth.key] = config.auth.value;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Virtual source error: ${res.status} ${await res.text()}`);

  const body = await res.json();

  // Normalizare răspuns — adaptează la structura API-ului
  const data = Array.isArray(body) ? body : body.data || body.results || body.items || [];
  const total = typeof body.total === 'number' ? body.total :
                typeof body.total_count === 'number' ? body.total_count :
                data.length;

  return { data, total };
}

export async function virtualGetOne(config: VirtualSourceConfig, id: string): Promise<any> {
  const url = `${config.baseUrl}${config.getEndpoint.replace(':id', id)}`;

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (config.auth.type === 'bearer') headers['Authorization'] = `Bearer ${config.auth.value}`;
  else if (config.auth.type === 'header') headers[config.auth.key] = config.auth.value;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Virtual source error: ${res.status}`);
  }

  return res.json();
}
```

### TASK 4.2 — Studio: Virtual Source Config UI

Când un admin configurează un Virtual Source în Studio, interfața trebuie să:
1. Ceară URL-ul API-ului
2. Ceară tipul de autentificare
3. Ceară field mapping explicit
4. **Afișeze operatorii suportați** — utilizatorul bifează ce suportă API-ul extern
5. Testeze conexiunea cu un `GET ?limit=1`

Verifică dacă `packages/studio/src/routes/admin/collections/` are UI pentru virtual sources. Dacă nu, notează ca TODO.

---

# ═══════════════════════════════════════════════════════════
# FAZA 5 — ZERO-DOWNTIME DDL (Ghost Tables) — Algoritmul Corect
# ═══════════════════════════════════════════════════════════

> **Rețeta GitHub/PlanetScale:** Ghost Table + Trigger Changelog + Batch Copy + Atomic Swap
> NU face ALTER TABLE direct pe tabele cu date live.

### TASK 5.1 — Ghost Table DDL Manager

**Destinație:** `packages/engine/src/lib/ghost-ddl.ts`

```typescript
import type { Database } from '../db/index.js';
import { sql } from 'kysely';

const BATCH_SIZE = 10_000;

export interface GhostMigration {
  originalTable: string;
  ghostTable: string;
  changelogTable: string;
  triggerName: string;
}

export class GhostDDL {
  /**
   * PASUL 1: Creează ghost table identică + aplică modificările DDL pe ea
   */
  static async createGhost(
    db: Database,
    tableName: string,
    ddlStatements: string[] // ex: ['ADD COLUMN phone TEXT', 'DROP COLUMN fax']
  ): Promise<GhostMigration> {
    const ghost = `_zv_ghost_${tableName}`;
    const changelog = `_zv_changelog_${tableName}`;
    const trigger = `_zv_trg_ghost_${tableName}`;

    // 1. Creează ghost table cu aceeași structură
    await sql`CREATE TABLE ${sql.id(ghost)} (LIKE ${sql.id(tableName)} INCLUDING ALL)`.execute(db);

    // 2. Aplică modificările DDL pe ghost table
    for (const ddl of ddlStatements) {
      await sql.raw(`ALTER TABLE ${ghost} ${ddl}`).execute(db);
    }

    // 3. Creează changelog table pentru capturarea mutațiilor din timpul copierii
    await sql`
      CREATE TABLE ${sql.id(changelog)} (
        id BIGSERIAL PRIMARY KEY,
        operation TEXT NOT NULL,
        row_id UUID NOT NULL,
        row_data JSONB,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.execute(db);

    // 4. Creează trigger pe tabela originală care salvează mutațiile în changelog
    await sql.raw(`
      CREATE OR REPLACE FUNCTION ${trigger}_fn() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO ${changelog} (operation, row_id, row_data)
          VALUES ('INSERT', NEW.id, to_jsonb(NEW));
          RETURN NEW;
        ELSIF TG_OP = 'UPDATE' THEN
          INSERT INTO ${changelog} (operation, row_id, row_data)
          VALUES ('UPDATE', NEW.id, to_jsonb(NEW));
          RETURN NEW;
        ELSIF TG_OP = 'DELETE' THEN
          INSERT INTO ${changelog} (operation, row_id, row_data)
          VALUES ('DELETE', OLD.id, NULL);
          RETURN OLD;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER ${trigger}
      AFTER INSERT OR UPDATE OR DELETE ON ${tableName}
      FOR EACH ROW EXECUTE FUNCTION ${trigger}_fn();
    `).execute(db);

    return { originalTable: tableName, ghostTable: ghost, changelogTable: changelog, triggerName: trigger };
  }

  /**
   * PASUL 2: Copiază date în batch-uri din original → ghost
   * Returnează: număr total de rânduri copiate
   */
  static async batchCopy(
    db: Database,
    migration: GhostMigration,
    onProgress?: (copied: number, total: number) => void
  ): Promise<number> {
    // Numără total rânduri
    const countResult = await sql`SELECT count(*) as cnt FROM ${sql.id(migration.originalTable)}`.execute(db);
    const total = Number((countResult.rows[0] as any).cnt);

    let copied = 0;
    let lastId: string | null = null;

    while (copied < total) {
      // Copiază batch ordered by id (cursor-based pentru consistență)
      let query = sql`
        INSERT INTO ${sql.id(migration.ghostTable)}
        SELECT * FROM ${sql.id(migration.originalTable)}
      `;

      if (lastId) {
        query = sql`
          INSERT INTO ${sql.id(migration.ghostTable)}
          SELECT * FROM ${sql.id(migration.originalTable)}
          WHERE id > ${lastId}
          ORDER BY id
          LIMIT ${BATCH_SIZE}
          ON CONFLICT (id) DO NOTHING
        `;
      } else {
        query = sql`
          INSERT INTO ${sql.id(migration.ghostTable)}
          SELECT * FROM ${sql.id(migration.originalTable)}
          ORDER BY id
          LIMIT ${BATCH_SIZE}
          ON CONFLICT (id) DO NOTHING
        `;
      }

      const result = await query.execute(db);
      const batchCount = Number((result as any).numAffectedRows || BATCH_SIZE);
      copied += batchCount;

      // Obține ultimul id copiat
      const lastRow = await sql`
        SELECT id FROM ${sql.id(migration.ghostTable)} ORDER BY id DESC LIMIT 1
      `.execute(db);
      lastId = (lastRow.rows[0] as any)?.id || null;

      onProgress?.(copied, total);

      if (batchCount < BATCH_SIZE) break; // Am terminat

      // Micro-pause pentru a nu sufoca DB-ul
      await new Promise((r) => setTimeout(r, 50));
    }

    return copied;
  }

  /**
   * PASUL 3: Aplică changelog (mutațiile din timpul copierii)
   */
  static async applyChangelog(db: Database, migration: GhostMigration): Promise<number> {
    const changes = await sql`
      SELECT * FROM ${sql.id(migration.changelogTable)} ORDER BY id
    `.execute(db);

    let applied = 0;
    for (const change of changes.rows as any[]) {
      if (change.operation === 'INSERT' || change.operation === 'UPDATE') {
        // Upsert în ghost table
        const data = change.row_data;
        const columns = Object.keys(data);
        const values = Object.values(data);

        // Folosim raw SQL pentru upsert dinamic
        await sql.raw(`
          INSERT INTO ${migration.ghostTable} (${columns.map((c) => `"${c}"`).join(', ')})
          VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
          ON CONFLICT (id) DO UPDATE SET
          ${columns.filter((c) => c !== 'id').map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')}
        `).execute(db); // TODO: parametrizează corect cu Kysely
      } else if (change.operation === 'DELETE') {
        await sql`DELETE FROM ${sql.id(migration.ghostTable)} WHERE id = ${change.row_id}`.execute(db);
      }
      applied++;
    }

    return applied;
  }

  /**
   * PASUL 4: THE SWAP — atomic rename
   * Lock scurt (milisecunde) doar pe scrieri, citirile continuă.
   */
  static async atomicSwap(db: Database, migration: GhostMigration): Promise<void> {
    const oldTable = `_zv_old_${migration.originalTable}`;

    await sql.raw(`
      BEGIN;
        -- Lock doar scrierile (citirile continuă!)
        LOCK TABLE ${migration.originalTable} IN SHARE ROW EXCLUSIVE MODE;

        -- Aplică ultimele changelog entries
        -- (între LOCK și RENAME, nu mai vin scrieri noi)

        -- The Swap (atomic, milisecunde)
        ALTER TABLE ${migration.originalTable} RENAME TO ${oldTable.replace(/"/g, '')};
        ALTER TABLE ${migration.ghostTable} RENAME TO ${migration.originalTable};

        -- Cleanup trigger
        DROP TRIGGER IF EXISTS ${migration.triggerName} ON ${oldTable.replace(/"/g, '')};
        DROP FUNCTION IF EXISTS ${migration.triggerName}_fn();

        -- TODO POST-RELEASE: Redenumește indecșii și PK-urile ghost table
        -- PostgreSQL NU redenumește automat indecșii la RENAME TABLE.
        -- Ghost table va avea indecși cu prefix _zv_ghost_ care funcționează corect
        -- dar au nume confuze. Pentru v2.1, adaugă aici:
        -- ALTER INDEX _zv_ghost_tablename_pkey RENAME TO tablename_pkey;
        -- (pentru fiecare index de pe ghost table)
      COMMIT;
    `).execute(db);

    // Cleanup (async, nu blochează)
    setTimeout(async () => {
      try {
        await sql`DROP TABLE IF EXISTS ${sql.id(oldTable)}`.execute(db);
        await sql`DROP TABLE IF EXISTS ${sql.id(migration.changelogTable)}`.execute(db);
      } catch { /* best effort cleanup */ }
    }, 60_000); // Cleanup după 1 minut (safety net)
  }

  /**
   * Orchestrează întreg procesul Ghost DDL
   */
  static async execute(
    db: Database,
    tableName: string,
    ddlStatements: string[],
    onProgress?: (phase: string, detail: string) => void
  ): Promise<void> {
    onProgress?.('creating', 'Creating ghost table and triggers');
    const migration = await this.createGhost(db, tableName, ddlStatements);

    onProgress?.('copying', 'Batch copying data');
    const copied = await this.batchCopy(db, migration, (done, total) => {
      onProgress?.('copying', `Copied ${done}/${total} rows`);
    });

    onProgress?.('changelog', 'Applying changelog');
    const changelogApplied = await this.applyChangelog(db, migration);

    onProgress?.('swapping', 'Performing atomic swap');
    await this.atomicSwap(db, migration);

    onProgress?.('done', `Migration complete. ${copied} rows migrated, ${changelogApplied} changelog entries applied.`);
  }
}
```

### TASK 5.2 — Integrare Ghost DDL în Schema Branches

**Fișier:** `packages/engine/src/routes/schema-branches.ts`

Deschide fișierul. Când un schema branch se "merge" la main (apply changes), folosește `GhostDDL.execute()` în loc de `ALTER TABLE` direct:

```typescript
import { GhostDDL } from '../lib/ghost-ddl.js';

// La merge branch → main:
if (change.type === 'add_column') {
  await GhostDDL.execute(db, change.table, [`ADD COLUMN "${change.column}" ${change.columnType}`]);
} else if (change.type === 'drop_column') {
  await GhostDDL.execute(db, change.table, [`DROP COLUMN "${change.column}"`]);
}
```

**NOTA:** Pentru tabele mici (<100k rânduri), Ghost DDL e overkill. Adaugă un prag:
```typescript
const count = await sql`SELECT count(*) as cnt FROM ${sql.id(tableName)}`.execute(db);
if (Number((count.rows[0] as any).cnt) > 100_000) {
  await GhostDDL.execute(db, tableName, ddlStatements);
} else {
  // ALTER TABLE direct — e rapid pe tabele mici
  for (const ddl of ddlStatements) {
    await sql.raw(`ALTER TABLE ${tableName} ${ddl}`).execute(db);
  }
}
```

---

# ═══════════════════════════════════════════════════════════
# FAZA 6 — RESTUL RUTELOR API LIPSĂ (portare din old repo)
# ═══════════════════════════════════════════════════════════

> **Pattern pentru TOATE:** Citește fișierul sursă din `src/routes/X.ts`,
> adaptează la `export function XRoutes(db: Database, auth: any): Hono`,
> și înregistrează în `routes/index.ts`.

### TASK 6.1 — GraphQL Auto-Generated

**Sursă:** `src/routes/graphql.ts`
**Destinație:** `packages/engine/src/routes/graphql.ts`

Dependență: `cd packages/engine && bun add graphql graphql-yoga`

Portează cu pattern standard. Schema-ul GraphQL se generează dinamic din `DDLManager.getCollections()`.

```typescript
import { flowsRoutes } from './graphql.js';
app.route('/api/graphql', graphqlRoutes(db, auth));
```

### TASK 6.2 — Media Library

**Sursă:** `src/routes/media.ts`
**Destinație:** `packages/engine/src/routes/media.ts`

Migrare: `019_media_library.sql` (folders + files + tags + GIN index)

```typescript
app.route('/api/media', mediaRoutes(db, auth));
```

### TASK 6.3 — Backup & Restore

**Sursă:** `src/routes/backup.ts` (ATENȚIE: Bun.spawn, NU child_process!)
**Destinație:** `packages/engine/src/routes/backup.ts`

```typescript
// ✅ Bun pattern:
const proc = Bun.spawn(['pg_dump', '-Fc', '--dbname', dbUrl, '-f', outputPath], { stdout: 'pipe' });
await proc.exited; // Wait for completion
```

```typescript
app.route('/api/backup', backupRoutes(db, auth));
```

### TASK 6.4 — Approval Workflows

**Sursă:** `src/routes/approvals.ts`
**Destinație:** `packages/engine/src/routes/approvals.ts`

Migrare: `021_approvals.sql` (workflows, requests, steps, decisions)

```typescript
app.route('/api/approvals', approvalsRoutes(db, auth));
```

### TASK 6.5 — Drafts System

**Sursă:** `src/routes/drafts.ts`
**Destinație:** `packages/engine/src/routes/drafts.ts`

```typescript
app.route('/api/drafts', draftsRoutes(db, auth));
```

### TASK 6.6 — GDPR Compliance

**Sursă:** `src/routes/gdpr.ts`
**Destinație:** `packages/engine/src/routes/gdpr.ts`

Endpoints: export date (Art. 20), ștergere cont (Art. 17), portabilitate.

```typescript
app.route('/api/gdpr', gdprRoutes(db, auth));
```

### TASK 6.7 — Saved Queries

**Sursă:** `src/routes/saved-queries.ts`
**Destinație:** `packages/engine/src/routes/saved-queries.ts`

```typescript
app.route('/api/saved-queries', savedQueriesRoutes(db, auth));
```

### TASK 6.8 — Data Validation

**Sursă:** `src/routes/validation.ts`
**Destinație:** `packages/engine/src/routes/validation.ts`

```typescript
app.route('/api/validation', validationRoutes(db, auth));
```

### TASK 6.9 — Data Quality Dashboard

**Sursă:** `src/routes/data-quality.ts` (sau similar)
**Destinație:** `packages/engine/src/routes/quality.ts`

```typescript
app.route('/api/quality', qualityRoutes(db, auth));
```

### TASK 6.10 — Insights

**Sursă:** `src/routes/insights.ts`
**Destinație:** `packages/engine/src/routes/insights.ts`

```typescript
app.route('/api/insights', insightsRoutes(db, auth));
```

### TASK 6.11 — Admin Pages CMS

**Sursă:** `src/routes/admin-pages.ts`
**Destinație:** `packages/engine/src/routes/admin-pages.ts`

```typescript
app.route('/api/admin/pages', adminPagesRoutes(db, auth));
```

### TASK 6.12 — Document Templates

**Sursă:** `src/routes/document-templates.ts`
**Destinație:** `packages/engine/src/routes/document-templates.ts`

```typescript
app.route('/api/document-templates', documentTemplatesRoutes(db, auth));
```

### TASK 6.13 — Documents Management

**Sursă:** `src/routes/documents.ts`
**Destinație:** `packages/engine/src/routes/documents.ts`

```typescript
app.route('/api/documents', documentsRoutes(db, auth));
```

### TASK 6.14 — Sitemap Generator

Adaugă direct în `routes/index.ts`:
```typescript
app.get('/api/sitemap.xml', async (c) => {
  const siteUrl = process.env.SITE_URL || 'https://example.com';
  const pages = await db.selectFrom('zv_pages' as any)
    .select(['slug', 'updated_at', 'is_homepage'])
    .where('is_active', '=', true)
    .orderBy('title', 'asc')
    .execute();

  const urls = (pages as any[]).map((p) => {
    const loc = p.is_homepage ? siteUrl : `${siteUrl}/${p.slug}`;
    const lastmod = new Date(p.updated_at).toISOString().split('T')[0];
    return `<url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><priority>${p.is_homepage ? '1.0' : '0.8'}</priority></url>`;
  }).join('\n');

  c.header('Content-Type', 'application/xml');
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
});
```

---

# ═══════════════════════════════════════════════════════════
# FAZA 7 — AI COMPLET
# ═══════════════════════════════════════════════════════════

### TASK 7.1 — Verifică extensia ai/core-ai

Deschide `extensions/ai/core-ai/engine/routes.ts`. Verifică ce acoperă.
Dacă lipsesc: chat completion, embeddings, RAG semantic search — adaugă-le.

### TASK 7.2 — Portează Z-AI Engine

**Sursă:** `src/lib/zveltio-ai/` (engine.ts, tools.ts, types.ts)
**Destinație:** `extensions/ai/core-ai/engine/zveltio-ai/`

Adaptează importurile. Înregistrează rutele în extensia ai/core-ai.

### TASK 7.3 — AI Analytics

**Sursă:** `src/routes/ai-analytics.ts`
Portează în extensia ai/core-ai sau ca rută separată.

---

# ═══════════════════════════════════════════════════════════
# FAZA 8 — STUDIO COMPONENTS & PAGES
# ═══════════════════════════════════════════════════════════

### TASK 8.1 — RichTextEditor (Tiptap)

**Sursă:** `src/lib/components/fields/RichTextEditor.svelte`
**Destinație:** `packages/studio/src/lib/components/fields/RichTextEditor.svelte`

```bash
cd packages/studio && bun add @tiptap/core @tiptap/starter-kit @tiptap/extension-link @tiptap/extension-image @tiptap/extension-table @tiptap/extension-table-row @tiptap/extension-table-cell @tiptap/extension-table-header @tiptap/pm
```

Portare: `$store` → `$state`/`$derived`, `engineClient` → `api` din `$lib/api.js`

### TASK 8.2 — JSONEditor, LocationField, MapPicker, ColorPicker, FilePicker

Portează fiecare din `src/lib/components/fields/` cu aceleași reguli de conversie Svelte 5.

### TASK 8.3 — Admin Components (implementare reală)

Înlocuiește stub-urile din `packages/studio/src/lib/components/admin/`:
- ConstraintEditor.svelte
- RelationshipManager.svelte
- MetadataSettings.svelte
- StatsView.svelte

### TASK 8.4 — Studio Pages noi

Creează (portează din old repo):
- `packages/studio/src/routes/admin/media/+page.svelte`
- `packages/studio/src/routes/admin/flows/+page.svelte`
- `packages/studio/src/routes/admin/tenants/+page.svelte`
- `packages/studio/src/routes/admin/settings/backup/+page.svelte`
- `packages/studio/src/routes/admin/approvals/+page.svelte`
- `packages/studio/src/routes/admin/schema-branches/+page.svelte`

Adaugă TOATE în `coreNav` din `+layout.svelte`:
```typescript
import { Image, Workflow, Building2, GitBranch, CheckSquare, Database } from '@lucide/svelte';
{ href: `${base}/media`, icon: Image, label: 'Media' },
{ href: `${base}/flows`, icon: Workflow, label: 'Flows' },
{ href: `${base}/tenants`, icon: Building2, label: 'Tenants' },
{ href: `${base}/schema-branches`, icon: GitBranch, label: 'Schema Branches' },
{ href: `${base}/approvals`, icon: CheckSquare, label: 'Approvals' },
```

---

# ═══════════════════════════════════════════════════════════
# FAZA 9 — SDK cu HTTP Client Real
# ═══════════════════════════════════════════════════════════

### TASK 9.1 — ZveltioClient

**Destinație:** `packages/sdk/src/client.ts`

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

  private async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  get<T = any>(path: string) { return this.request<T>('GET', path); }
  post<T = any>(path: string, body?: unknown) { return this.request<T>('POST', path, body); }
  patch<T = any>(path: string, body?: unknown) { return this.request<T>('PATCH', path, body); }
  delete<T = any>(path: string) { return this.request<T>('DELETE', path); }

  async upload<T = any>(path: string, formData: FormData): Promise<T> {
    const headers = { ...this.headers };
    delete headers['Content-Type']; // Browser sets multipart boundary
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST', headers, credentials: 'include', body: formData,
    });
    if (!res.ok) throw new Error(`Upload ${path} failed: ${res.status}`);
    return res.json();
  }

  /** Collection CRUD helper */
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
        const query = qs.toString();
        return this.get(`/api/data/${name}${query ? `?${query}` : ''}`);
      },
      get: (id: string) => this.get(`/api/data/${name}/${id}`),
      create: (data: Record<string, any>) => this.post(`/api/data/${name}`, data),
      update: (id: string, data: Record<string, any>) => this.patch(`/api/data/${name}/${id}`, data),
      delete: (id: string) => this.delete(`/api/data/${name}/${id}`),
    };
  }

  /** Auth helpers */
  auth = {
    login: (email: string, password: string) =>
      this.post('/api/auth/sign-in/email', { email, password }),
    signup: (email: string, password: string, name: string) =>
      this.post('/api/auth/sign-up/email', { email, password, name }),
    logout: () => this.post('/api/auth/sign-out'),
    session: () => this.get('/api/auth/get-session'),
  };

  /** Storage helpers */
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

### TASK 9.2 — Realtime Client

**Destinație:** `packages/sdk/src/realtime.ts`

```typescript
export class ZveltioRealtime {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();
  private baseUrl: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseUrl: string) {
    // Convert http(s) to ws(s)
    this.baseUrl = baseUrl.replace(/^http/, 'ws');
  }

  connect(): void {
    const wsUrl = `${this.baseUrl}/api/ws`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      // Re-subscribe la toate colecțiile existente
      for (const collection of this.listeners.keys()) {
        this.ws?.send(JSON.stringify({ action: 'subscribe', collection }));
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const collection = msg.collection;
        const subs = this.listeners.get(collection);
        if (subs) {
          subs.forEach((fn) => {
            try { fn(msg); } catch { /* ignore callback errors */ }
          });
        }
      } catch { /* invalid JSON — ignore */ }
    };

    this.ws.onclose = () => {
      this.attemptReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    // Exponential backoff: 1s, 2s, 4s, 8s, ...
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  subscribe(collection: string, callback: (data: any) => void): () => void {
    if (!this.listeners.has(collection)) this.listeners.set(collection, new Set());
    this.listeners.get(collection)!.add(callback);

    // Trimite subscribe la server
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'subscribe', collection }));
    }

    // Return unsubscribe function
    return () => {
      this.listeners.get(collection)?.delete(callback);
      if (this.listeners.get(collection)?.size === 0) {
        this.listeners.delete(collection);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ action: 'unsubscribe', collection }));
        }
      }
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent auto-reconnect
    this.ws?.close();
    this.ws = null;
    this.listeners.clear();
  }
}
```

### TASK 9.3 — SDK Index

**Fișier:** `packages/sdk/src/index.ts`

```typescript
export { ZveltioClient, createZveltioClient } from './client.js';
export { ZveltioRealtime } from './realtime.js';
export type { ZveltioClientConfig } from './client.js';
export type { ZveltioExtension } from './extension/index.js';
```

---

# ═══════════════════════════════════════════════════════════
# FAZA 10 — CLI + CLEANUP + SMOKE TEST
# ═══════════════════════════════════════════════════════════

### TASK 10.1 — CLI: init command

**Destinație:** `packages/cli/src/commands/init.ts`

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

  writeFileSync(join(dir, '.env'), [
    `DATABASE_URL=postgresql://admin:password@localhost:5432/${name}`,
    'PORT=3000',
    'VALKEY_URL=redis://localhost:6379',
    'S3_ENDPOINT=http://localhost:8333',
    'S3_BUCKET=zveltio',
    'S3_ACCESS_KEY=admin',
    'S3_SECRET_KEY=password',
    '',
  ].join('\n'));

  writeFileSync(join(dir, '.env.example'), [
    'DATABASE_URL=postgresql://user:pass@localhost:5432/dbname',
    'PORT=3000',
    'VALKEY_URL=redis://localhost:6379',
    'S3_ENDPOINT=http://localhost:8333',
    'S3_BUCKET=zveltio',
    'S3_ACCESS_KEY=admin',
    'S3_SECRET_KEY=password',
    '',
  ].join('\n'));

  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    private: true,
    scripts: {
      dev: 'zveltio dev',
      start: 'zveltio start',
    },
    dependencies: {
      '@zveltio/engine': 'latest',
    },
  }, null, 2));

  console.log(`✅ Zveltio project "${name}" initialized at ${dir}`);
  console.log(`\nNext steps:\n  cd ${name}\n  bun install\n  zveltio dev\n`);
}
```

### TASK 10.1b — CLI: migrate command

**Destinație:** `packages/cli/src/commands/migrate.ts`

```typescript
export async function migrateCommand() {
  console.log('🔄 Running database migrations...');
  const proc = Bun.spawn(['bun', 'run', 'packages/engine/src/db/migrate.ts'], {
    stdio: ['inherit', 'inherit', 'inherit'],
    cwd: process.cwd(),
  });
  const exitCode = await proc.exited;
  if (exitCode === 0) {
    console.log('✅ Migrations completed successfully');
  } else {
    console.error('❌ Migration failed');
    process.exit(exitCode);
  }
}
```

### TASK 10.1c — CLI: Înregistrează comenzile noi

**Fișier:** `packages/cli/src/index.ts`

Adaugă:
```typescript
import { initCommand } from './commands/init.js';
import { migrateCommand } from './commands/migrate.js';

program
  .command('init <name>')
  .description('Initialize a new Zveltio project')
  .action(initCommand);

program
  .command('migrate')
  .description('Run database migrations')
  .action(migrateCommand);
```

### TASK 10.2 — Webhook Refactor (raw SQL → Kysely)

Scanează `packages/engine/src/routes/webhooks.ts` și `lib/webhook-worker.ts`.
Înlocuiește ORICE raw SQL concatenat cu Kysely query builder:

```typescript
// ❌ CAUTĂ ȘI ÎNLOCUIEȘTE pattern-uri ca:
const result = await db.execute(sql`SELECT * FROM zv_webhooks WHERE event = ${eventName}`);
// sau mai rău:
const result = await db.execute(`SELECT * FROM zv_webhooks WHERE event = '${eventName}'`);

// ✅ CU:
const result = await db
  .selectFrom('zv_webhooks' as any)
  .selectAll()
  .where('event', '=', eventName)
  .where('is_active', '=', true)
  .execute();

// ❌ CAUTĂ:
await db.execute(sql`INSERT INTO zv_webhook_logs ...`);

// ✅ CU:
await db
  .insertInto('zv_webhook_logs' as any)
  .values({ webhook_id: id, status, response_code: code, executed_at: new Date() })
  .execute();
```

### TASK 10.2b — Checklist Extension

Verifică dacă `extensions/workflow/checklists/` are implementare reală. Dacă nu:

**Sursă:** `src/routes/checklist-templates.ts` + `src/routes/checklist-responses.ts`
**Destinație:** `extensions/workflow/checklists/engine/`

Creează extensia cu pattern standard:
```typescript
import { join } from 'path';
import type { ZveltioExtension } from '@zveltio/sdk';

const extension: ZveltioExtension = {
  name: 'workflow/checklists',
  category: 'workflow',
  version: '1.0.0',
  description: 'Checklist templates and responses',

  getMigrations() {
    return [join(import.meta.dir, 'migrations/001_checklists.sql')];
  },

  async register(app, ctx) {
    // Portează din src/routes/checklist-templates.ts
    app.get('/api/checklist-templates', async (c) => {
      const templates = await ctx.db
        .selectFrom('zv_checklist_templates' as any)
        .selectAll()
        .execute();
      return c.json({ templates });
    });

    // CRUD: create, get/:id, patch/:id, delete/:id
    // Portează din src/routes/checklist-responses.ts
    app.get('/api/checklist-responses', async (c) => {
      const responses = await ctx.db
        .selectFrom('zv_checklist_responses' as any)
        .selectAll()
        .execute();
      return c.json({ responses });
    });

    // POST /api/checklist-responses — submit response
    // PATCH /api/checklist-responses/:id — update response
  },
};

export default extension;
```

Migrare: `extensions/workflow/checklists/engine/migrations/001_checklists.sql`:
```sql
CREATE TABLE IF NOT EXISTS zv_checklist_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  items JSONB NOT NULL DEFAULT '[]',
  collection TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_checklist_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES zv_checklist_templates(id) ON DELETE CASCADE,
  record_id UUID,
  collection TEXT,
  responses JSONB NOT NULL DEFAULT '{}',
  completed_at TIMESTAMPTZ,
  completed_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_checklist_responses_template ON zv_checklist_responses(template_id);
CREATE INDEX idx_checklist_responses_record ON zv_checklist_responses(record_id);
```

### TASK 10.3 — Verificare Migrări Complete

Verifică că FIECARE din aceste tabele are migrare SQL în `packages/engine/src/db/migrations/sql/` sau în extensia corespunzătoare. Dacă una lipsește, creează migrarea:

```
✅ = ar trebui să existe deja  |  🆕 = creată de task-urile din acest document

CORE (packages/engine/src/db/migrations/sql/):
✅ zv_collections
✅ zv_fields
✅ zv_webhooks
✅ zv_webhook_logs
✅ zv_settings
✅ zv_audit_log
✅ zv_revisions
✅ zv_email_queue
✅ zv_translations
✅ zv_notifications
✅ zv_api_keys
✅ zv_extension_registry
✅ zv_pages
✅ zv_page_sections
✅ zv_schema_branches

🆕 zv_flows                  — TASK 2.3 (018_flows.sql)
🆕 zv_flow_runs              — TASK 2.3 (018_flows.sql)
🆕 zv_media_folders           — TASK 6.2 (019_media_library.sql)
🆕 zv_media_files             — TASK 6.2 (019_media_library.sql)
🆕 zv_tenants                 — TASK 3.4 (020_multitenancy.sql)
🆕 zv_approval_workflows      — TASK 6.4 (021_approvals.sql)
🆕 zv_approval_requests       — TASK 6.4 (021_approvals.sql)
🆕 zv_approval_steps          — TASK 6.4 (021_approvals.sql)
🆕 zv_drafts                  — TASK 6.5 (022_drafts.sql)
🆕 zv_saved_queries           — TASK 6.7 (023_saved_queries.sql)
🆕 zv_backups                 — TASK 6.3 (024_backups.sql)
🆕 zv_document_templates      — TASK 6.12 (025_document_templates.sql)

EXTENSII (în directorul extensiei corespunzătoare):
🆕 zv_checklist_templates     — TASK 10.2b (extensions/workflow/checklists/)
🆕 zv_checklist_responses     — TASK 10.2b (extensions/workflow/checklists/)
```

Pentru fiecare 🆕 care NU are încă migrare, creează fișierul SQL cu număr secvențial.
Verifică și tabelele Better-Auth (user, session, account, verification) — acestea sunt gestionate de Better-Auth, nu de migrările Zveltio.

### TASK 10.4 — Smoke Test Final

```bash
# 0. Install & Link complet (generare bun.lockb)
cd /path/to/zveltio  # root monorepo
bun install

# 1. Compilare via Turbo (sau individual)
bun run build
# SAU individual:
# cd packages/engine && bun run build
# cd ../studio && bun run build
# cd ../sdk && bun run build
# cd ../cli && bun run build

# 2. TypeScript check
cd packages/engine && bun run tsc --noEmit
cd ../sdk && bun run tsc --noEmit

# 3. Binary build
cd ../.. && bun run build:binary
ls -la dist/zveltio

# 4. Start și test manual
./dist/zveltio &
curl http://localhost:3000/health
curl http://localhost:3000/api/collections
```

---

# ═══════════════════════════════════════════════════════════
# FAZA 11 — SDK LOCAL-FIRST (Offline-Capable + Sync)
# ═══════════════════════════════════════════════════════════

> **REGULA:** NU scrie CRDTs de la zero. Folosește IndexedDB ca local store
> și un Background Sync Manager cu conflict resolution simplă (last-write-wins
> default, cu hook pentru custom merge). Fiecare operație se scrie LOCAL ÎNTÂI,
> apoi se sincronizează async cu serverul.

> **DEPENDENȚĂ:** Faza 1 (WebSocket/Realtime) + Faza 9 (SDK HTTP Client) TREBUIE
> să fie complete înainte de Faza 11. Local-First fără Realtime e doar un cache.

### TASK 11.1 — Local Store (IndexedDB via idb)

**Destinație:** `packages/sdk/src/local-store.ts`

Dependență: `cd packages/sdk && bun add idb`

`idb` e un wrapper mic (~1KB) peste IndexedDB nativ, type-safe, zero dependencies.

```typescript
import { openDB, type IDBPDatabase } from 'idb';

interface LocalRecord {
  id: string;
  collection: string;
  data: Record<string, any>;
  _localVersion: number;     // Incrementat la fiecare write local
  _serverVersion: number;    // Versiunea confirmată de server
  _syncStatus: 'synced' | 'pending' | 'conflict';
  _updatedAt: number;        // timestamp ms
  _deletedAt?: number;       // soft delete pentru sync
}

interface SyncQueueItem {
  id: string;               // auto-generated
  collection: string;
  recordId: string;
  operation: 'create' | 'update' | 'delete';
  payload: Record<string, any>;
  attempts: number;
  createdAt: number;
  lastAttemptAt?: number;
  error?: string;
}

const DB_NAME = 'zveltio_local';
const DB_VERSION = 1;

export class LocalStore {
  private db: IDBPDatabase | null = null;

  async open(): Promise<void> {
    this.db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Store pentru date locale (mirror al colecțiilor server)
        if (!db.objectStoreNames.contains('records')) {
          const store = db.createObjectStore('records', { keyPath: ['collection', 'id'] });
          store.createIndex('by-collection', 'collection');
          store.createIndex('by-sync-status', '_syncStatus');
          store.createIndex('by-updated', '_updatedAt');
        }

        // Coadă de sincronizare (operații pending)
        if (!db.objectStoreNames.contains('sync_queue')) {
          const queue = db.createObjectStore('sync_queue', { keyPath: 'id' });
          queue.createIndex('by-collection', 'collection');
          queue.createIndex('by-created', 'createdAt');
        }

        // Metadata per colecție (last sync timestamp, etc.)
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      },
    });
  }

  /** Scrie un record local + adaugă în sync queue */
  async put(collection: string, id: string, data: Record<string, any>): Promise<LocalRecord> {
    if (!this.db) throw new Error('LocalStore not opened');

    const existing = await this.db.get('records', [collection, id]) as LocalRecord | undefined;

    const record: LocalRecord = {
      id,
      collection,
      data,
      _localVersion: (existing?._localVersion || 0) + 1,
      _serverVersion: existing?._serverVersion || 0,
      _syncStatus: 'pending',
      _updatedAt: Date.now(),
    };

    const tx = this.db.transaction(['records', 'sync_queue'], 'readwrite');

    // 1. Scrie record local
    await tx.objectStore('records').put(record);

    // 2. Adaugă în sync queue
    const queueItem: SyncQueueItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      collection,
      recordId: id,
      operation: existing ? 'update' : 'create',
      payload: data,
      attempts: 0,
      createdAt: Date.now(),
    };
    await tx.objectStore('sync_queue').add(queueItem);

    await tx.done;
    return record;
  }

  /** Citește un record local (instant, fără network) */
  async get(collection: string, id: string): Promise<LocalRecord | undefined> {
    if (!this.db) throw new Error('LocalStore not opened');
    const record = await this.db.get('records', [collection, id]) as LocalRecord | undefined;
    if (record?._deletedAt) return undefined; // Soft-deleted
    return record;
  }

  /** Listează records dintr-o colecție (local) */
  async list(collection: string): Promise<LocalRecord[]> {
    if (!this.db) throw new Error('LocalStore not opened');
    const all = await this.db.getAllFromIndex('records', 'by-collection', collection) as LocalRecord[];
    return all.filter((r) => !r._deletedAt);
  }

  /** Soft delete local + adaugă în sync queue */
  async delete(collection: string, id: string): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');

    const tx = this.db.transaction(['records', 'sync_queue'], 'readwrite');

    const existing = await tx.objectStore('records').get([collection, id]) as LocalRecord | undefined;
    if (existing) {
      existing._deletedAt = Date.now();
      existing._syncStatus = 'pending';
      await tx.objectStore('records').put(existing);
    }

    const queueItem: SyncQueueItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      collection,
      recordId: id,
      operation: 'delete',
      payload: {},
      attempts: 0,
      createdAt: Date.now(),
    };
    await tx.objectStore('sync_queue').add(queueItem);

    await tx.done;
  }

  /** Returnează toate operațiile pending din sync queue */
  async getPendingOps(): Promise<SyncQueueItem[]> {
    if (!this.db) throw new Error('LocalStore not opened');
    return this.db.getAllFromIndex('sync_queue', 'by-created') as Promise<SyncQueueItem[]>;
  }

  /** Marchează o operație ca finalizată (remove din queue, update record status) */
  async markSynced(queueItemId: string, collection: string, recordId: string, serverVersion: number): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');

    const tx = this.db.transaction(['records', 'sync_queue'], 'readwrite');

    // Remove din queue
    await tx.objectStore('sync_queue').delete(queueItemId);

    // Update record status
    const record = await tx.objectStore('records').get([collection, recordId]) as LocalRecord | undefined;
    if (record) {
      record._serverVersion = serverVersion;
      record._syncStatus = 'synced';
      await tx.objectStore('records').put(record);
    }

    await tx.done;
  }

  /** Marchează o operație ca failed (increment attempts, save error) */
  async markFailed(queueItemId: string, error: string): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');
    const item = await this.db.get('sync_queue', queueItemId) as SyncQueueItem | undefined;
    if (item) {
      item.attempts += 1;
      item.lastAttemptAt = Date.now();
      item.error = error;
      await this.db.put('sync_queue', item);
    }
  }

  /** Aplică date venite de la server (prin WebSocket sau pull) */
  async applyServerUpdate(collection: string, id: string, data: Record<string, any>, serverVersion: number): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');

    const existing = await this.db.get('records', [collection, id]) as LocalRecord | undefined;

    // Conflict detection: dacă avem modificări locale nesincronizate
    if (existing && existing._syncStatus === 'pending') {
      // Last-write-wins default — serverul câștigă
      // Dar marcăm ca conflict pentru eventualul custom merge
      existing.data = data;
      existing._serverVersion = serverVersion;
      existing._syncStatus = 'conflict';
      await this.db.put('records', existing);
      return;
    }

    const record: LocalRecord = {
      id,
      collection,
      data,
      _localVersion: existing?._localVersion || 0,
      _serverVersion: serverVersion,
      _syncStatus: 'synced',
      _updatedAt: Date.now(),
    };

    await this.db.put('records', record);
  }

  /** Obține records cu conflicte pentru UI resolution */
  async getConflicts(collection?: string): Promise<LocalRecord[]> {
    if (!this.db) throw new Error('LocalStore not opened');
    const all = await this.db.getAllFromIndex('records', 'by-sync-status', 'conflict') as LocalRecord[];
    if (collection) return all.filter((r) => r.collection === collection);
    return all;
  }

  /** Rezolvă un conflict (user decide care versiune câștigă) */
  async resolveConflict(collection: string, id: string, resolvedData: Record<string, any>): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');
    const record = await this.db.get('records', [collection, id]) as LocalRecord | undefined;
    if (record) {
      record.data = resolvedData;
      record._syncStatus = 'pending'; // Re-sync cu serverul
      record._localVersion += 1;
      await this.db.put('records', record);
    }
  }

  /** Curăță toate datele locale */
  async clear(): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');
    const tx = this.db.transaction(['records', 'sync_queue', 'meta'], 'readwrite');
    await tx.objectStore('records').clear();
    await tx.objectStore('sync_queue').clear();
    await tx.objectStore('meta').clear();
    await tx.done;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}
```

### TASK 11.2 — Background Sync Manager

**Destinație:** `packages/sdk/src/sync-manager.ts`

```typescript
import type { ZveltioClient } from './client.js';
import type { ZveltioRealtime } from './realtime.js';
import { LocalStore } from './local-store.js';

export interface SyncManagerConfig {
  /** Interval de sync în ms (default: 5000) */
  syncInterval?: number;
  /** Max retry attempts per operație (default: 5) */
  maxRetries?: number;
  /** Exponential backoff base în ms (default: 1000) */
  backoffBase?: number;
  /** Callback pentru conflicte (default: server-wins) */
  onConflict?: (local: any, server: any) => any;
}

export class SyncManager {
  private store: LocalStore;
  private client: ZveltioClient;
  private realtime: ZveltioRealtime | null = null;
  private config: Required<SyncManagerConfig>;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private isOnline: boolean = true;
  private isSyncing: boolean = false;
  private listeners: Map<string, Set<(records: any[]) => void>> = new Map();

  constructor(client: ZveltioClient, config: SyncManagerConfig = {}) {
    this.store = new LocalStore();
    this.client = client;
    this.config = {
      syncInterval: config.syncInterval ?? 5000,
      maxRetries: config.maxRetries ?? 5,
      backoffBase: config.backoffBase ?? 1000,
      onConflict: config.onConflict ?? ((_, server) => server), // Server wins default
    };
  }

  async start(realtimeUrl?: string): Promise<void> {
    await this.store.open();

    // Online/offline detection
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.isOnline = true;
        this.syncNow(); // Sync imediat la reconectare
      });
      window.addEventListener('offline', () => { this.isOnline = false; });
      this.isOnline = navigator.onLine;
    }

    // Realtime: primește push updates de la server
    if (realtimeUrl) {
      const { ZveltioRealtime } = await import('./realtime.js');
      this.realtime = new ZveltioRealtime(realtimeUrl);
      this.realtime.connect();
      // Subscribe-uri se fac per colecție prin collection()
    }

    // Periodic sync
    this.syncTimer = setInterval(() => this.syncNow(), this.config.syncInterval);

    // Sync inițial
    await this.syncNow();
  }

  /**
   * Returnează un collection proxy local-first:
   * - list/get citesc LOCAL (instant)
   * - create/update/delete scriu LOCAL + queue sync
   * - subscribe primește updates în realtime
   */
  collection(name: string) {
    return {
      /** List records — citește LOCAL instant */
      list: async () => {
        const records = await this.store.list(name);
        return records.map((r) => ({ id: r.id, ...r.data, _syncStatus: r._syncStatus }));
      },

      /** Get one record — citește LOCAL instant */
      get: async (id: string) => {
        const record = await this.store.get(name, id);
        if (!record) return null;
        return { id: record.id, ...record.data, _syncStatus: record._syncStatus };
      },

      /** Create — scrie LOCAL + queue sync */
      create: async (data: Record<string, any>) => {
        const id = data.id || crypto.randomUUID();
        const record = await this.store.put(name, id, data);
        this.notifyListeners(name);
        this.syncNow(); // Trigger sync imediat (non-blocking)
        return { id: record.id, ...record.data, _syncStatus: record._syncStatus };
      },

      /** Update — scrie LOCAL + queue sync */
      update: async (id: string, data: Record<string, any>) => {
        const existing = await this.store.get(name, id);
        const merged = { ...(existing?.data || {}), ...data };
        const record = await this.store.put(name, id, merged);
        this.notifyListeners(name);
        this.syncNow();
        return { id: record.id, ...record.data, _syncStatus: record._syncStatus };
      },

      /** Delete — soft delete LOCAL + queue sync */
      delete: async (id: string) => {
        await this.store.delete(name, id);
        this.notifyListeners(name);
        this.syncNow();
      },

      /** Subscribe la changes (realtime + local writes) */
      subscribe: (callback: (records: any[]) => void) => {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name)!.add(callback);

        // Subscribe la realtime server push
        let unsubRealtime: (() => void) | undefined;
        if (this.realtime) {
          unsubRealtime = this.realtime.subscribe(name, async (event) => {
            // Aplică update de la server în local store
            if (event.event === 'record.created' || event.event === 'record.updated') {
              // Fetch data completă de la server
              try {
                const serverRecord = await this.client.collection(name).get(event.record_id);
                await this.store.applyServerUpdate(name, event.record_id, serverRecord, Date.now());
                this.notifyListeners(name);
              } catch { /* offline sau eroare — ignoră, sync-ul periodic va rezolva */ }
            } else if (event.event === 'record.deleted') {
              await this.store.delete(name, event.record_id);
              this.notifyListeners(name);
            }
          });
        }

        // Emit starea curentă imediat
        this.store.list(name).then((records) => {
          callback(records.map((r) => ({ id: r.id, ...r.data, _syncStatus: r._syncStatus })));
        });

        // Return unsubscribe function
        return () => {
          this.listeners.get(name)?.delete(callback);
          unsubRealtime?.();
        };
      },

      /** Obține conflicte pending pentru UI resolution */
      getConflicts: async () => {
        return this.store.getConflicts(name);
      },

      /** Rezolvă un conflict manual */
      resolveConflict: async (id: string, resolvedData: Record<string, any>) => {
        await this.store.resolveConflict(name, id, resolvedData);
        this.notifyListeners(name);
        this.syncNow();
      },
    };
  }

  /** Force sync acum (non-blocking) */
  async syncNow(): Promise<void> {
    if (!this.isOnline || this.isSyncing) return;
    this.isSyncing = true;

    try {
      const pending = await this.store.getPendingOps();

      for (const op of pending) {
        if (op.attempts >= this.config.maxRetries) continue; // Skip operații epuizate

        try {
          let serverVersion = Date.now();

          switch (op.operation) {
            case 'create':
              await this.client.collection(op.collection).create({ id: op.recordId, ...op.payload });
              break;
            case 'update':
              await this.client.collection(op.collection).update(op.recordId, op.payload);
              break;
            case 'delete':
              await this.client.collection(op.collection).delete(op.recordId);
              break;
          }

          await this.store.markSynced(op.id, op.collection, op.recordId, serverVersion);
          this.notifyListeners(op.collection);
        } catch (err: any) {
          // Conflict de la server (409) — aplică conflict resolution
          if (err.message?.includes('409')) {
            try {
              const serverRecord = await this.client.collection(op.collection).get(op.recordId);
              const localRecord = await this.store.get(op.collection, op.recordId);
              const resolved = this.config.onConflict(localRecord?.data, serverRecord);
              await this.store.resolveConflict(op.collection, op.recordId, resolved);
            } catch { /* fallback: server wins */ }
          } else {
            // Exponential backoff
            await this.store.markFailed(op.id, err.message || 'Unknown error');
          }
        }
      }
    } finally {
      this.isSyncing = false;
    }
  }

  private async notifyListeners(collection: string): Promise<void> {
    const callbacks = this.listeners.get(collection);
    if (!callbacks?.size) return;

    const records = await this.store.list(collection);
    const mapped = records.map((r) => ({ id: r.id, ...r.data, _syncStatus: r._syncStatus }));
    callbacks.forEach((cb) => {
      try { cb(mapped); } catch { /* ignore callback errors */ }
    });
  }

  /** Status: câte operații pending, câte conflicte */
  async getStatus(): Promise<{ pending: number; conflicts: number; isOnline: boolean }> {
    const pending = await this.store.getPendingOps();
    const conflicts = await this.store.getConflicts();
    return { pending: pending.length, conflicts: conflicts.length, isOnline: this.isOnline };
  }

  async stop(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.realtime?.disconnect();
    await this.store.close();
  }
}
```

### TASK 11.3 — SDK Sync Endpoint pe Engine

**Destinație:** `packages/engine/src/routes/sync.ts`

Engine-ul trebuie să aibă un endpoint de batch sync pentru eficiență:

```typescript
import { Hono } from 'hono';
import type { Database } from '../db/index.js';

export function syncRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  /**
   * POST /api/sync/push — primește batch de operații de la client
   * Body: { operations: [{ collection, recordId, operation, payload, clientTimestamp }] }
   * Response: { results: [{ recordId, status: 'ok' | 'conflict', serverVersion, serverData? }] }
   *
   * NOTA PERFORMANȚĂ: Bucla secvențială de mai jos e OK pentru MVP.
   * La v2.1, refactorizează în batch upsert (INSERT INTO ... ON CONFLICT)
   * grupat pe colecție, pentru a gestiona eficient batch-uri de 500+ operații.
   */
  app.post('/push', async (c) => {
    const session = c.get('session');
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);

    const { operations } = await c.req.json();
    const results = [];

    for (const op of operations) {
      try {
        switch (op.operation) {
          case 'create': {
            const existing = await db
              .selectFrom(op.collection)
              .selectAll()
              .where('id', '=', op.recordId)
              .executeTakeFirst();

            if (existing) {
              results.push({
                recordId: op.recordId,
                status: 'conflict',
                serverVersion: Date.now(),
                serverData: existing,
              });
            } else {
              await db.insertInto(op.collection).values({ id: op.recordId, ...op.payload }).execute();
              results.push({ recordId: op.recordId, status: 'ok', serverVersion: Date.now() });
            }
            break;
          }
          case 'update': {
            await db.updateTable(op.collection).set(op.payload).where('id', '=', op.recordId).execute();
            results.push({ recordId: op.recordId, status: 'ok', serverVersion: Date.now() });
            break;
          }
          case 'delete': {
            await db.deleteFrom(op.collection).where('id', '=', op.recordId).execute();
            results.push({ recordId: op.recordId, status: 'ok', serverVersion: Date.now() });
            break;
          }
        }
      } catch (err: any) {
        results.push({ recordId: op.recordId, status: 'error', error: err.message });
      }
    }

    return c.json({ results });
  });

  /**
   * POST /api/sync/pull — client cere changes de la un timestamp
   * Body: { collections: ['users', 'posts'], since: 1709000000000 }
   * Response: { changes: [{ collection, id, data, operation, timestamp }] }
   */
  app.post('/pull', async (c) => {
    const session = c.get('session');
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);

    const { collections, since } = await c.req.json();
    const sinceDate = new Date(since);
    const changes = [];

    for (const collection of collections) {
      const updated = await db
        .selectFrom(collection)
        .selectAll()
        .where('updated_at', '>', sinceDate)
        .execute();

      for (const record of updated) {
        changes.push({
          collection,
          id: (record as any).id,
          data: record,
          operation: 'upsert',
          timestamp: new Date((record as any).updated_at).getTime(),
        });
      }
    }

    return c.json({ changes, serverTimestamp: Date.now() });
  });

  return app;
}
```

Înregistrează:
```typescript
import { syncRoutes } from './sync.js';
app.route('/api/sync', syncRoutes(db, auth));
```

### TASK 11.4 — Export SDK Local-First

**Fișier:** `packages/sdk/src/index.ts` — adaugă:

```typescript
export { LocalStore } from './local-store.js';
export { SyncManager } from './sync-manager.js';
export type { SyncManagerConfig } from './sync-manager.js';
```

### TASK 11.5 — Exemplu de utilizare (README / docs)

Adaugă în `packages/sdk/README.md`:

```markdown
## Local-First Usage

Zveltio SDK supports offline-first data access with automatic sync:

\`\`\`typescript
import { createZveltioClient, SyncManager } from '@zveltio/sdk';

const client = createZveltioClient({ baseUrl: 'https://api.myapp.com' });
const sync = new SyncManager(client, {
  syncInterval: 5000,
  onConflict: (local, server) => {
    // Custom merge: keep local changes for 'notes' field, server for rest
    return { ...server, notes: local.notes };
  },
});

await sync.start('wss://api.myapp.com');

// All operations are instant (local-first)
const todos = sync.collection('todos');

// Create — writes locally, syncs in background
await todos.create({ title: 'Buy milk', done: false });

// List — reads from local IndexedDB (instant, works offline)
const all = await todos.list();

// Subscribe — reactive updates (local writes + server push)
const unsub = todos.subscribe((records) => {
  console.log('Todos updated:', records);
  // records include _syncStatus: 'synced' | 'pending' | 'conflict'
});

// Check sync status
const status = await sync.getStatus();
// { pending: 2, conflicts: 0, isOnline: true }

// Handle conflicts manually
const conflicts = await todos.getConflicts();
for (const c of conflicts) {
  await todos.resolveConflict(c.id, { ...c.data, resolved: true });
}
\`\`\`
\`\`\`

### TASK 11.6 — Svelte 5 Store Integration (pentru Studio)

**Destinație:** `packages/sdk/src/svelte.ts`

Opțional dar valoros — un wrapper Svelte 5 runes-compatible:

```typescript
/**
 * Svelte 5 runes integration cu SyncManager.
 * Folosire:
 *   let todos = $state<any[]>([]);
 *   const unsub = useSyncCollection(sync, 'todos', (records) => { todos = records });
 */
export function useSyncCollection(
  sync: SyncManager,
  collection: string,
  setter: (records: any[]) => void
): () => void {
  const col = sync.collection(collection);
  return col.subscribe(setter);
}
```

---

# CHECKLIST FINAL (CORECTAT — rev.3, martie 2026)

```
[ ] PRE-FAZĂ — Curățenie pnpm → Bun (rm pnpm-workspace.yaml, bun install)
[ ] FAZA 0   — Tracer bullet: Engine boots, Studio builds, routes connected
[✅] FAZA 1  — SKIP — Realtime DEJA IMPLEMENTAT via CDC + Redis Pub/Sub + SSE + WebSocket
[✅] FAZA 2  — SKIP — Flow Executor DEJA IMPLEMENTAT (6 step types, cron, run logging)
[✅] FAZA 3  — SKIP — Multi-Tenancy DEJA IMPLEMENTAT (schema-per-tenant, NU RLS!)
[ ] FAZA 4   — Virtual Collections cu Query Translator (nu fetch-all!)
[✅] FAZA 5  — Ghost DDL DEJA IMPLEMENTAT (complet + integrat în schema-branches)
[ ] FAZA 6   — Rute API lipsă (verifică fiecare înainte — multe pot fi deja portate)
[ ] FAZA 7   — AI complet (core-ai + Z-AI + analytics)
[ ] FAZA 8   — Studio: componente + pagini + nav links
[ ] FAZA 9   — SDK cu HTTP client complet + Realtime client cu reconnect
[ ] FAZA 10  — CLI (init, migrate), webhooks Kysely, checklists ext, migrări verify
[✅] FAZA 11 — SDK Local-First: IndexedDB + SyncManager + /api/sync — DEJA IMPLEMENTAT
[ ] FAZA 12  — Vulnerabilități & Edge Cases (DDoS sync, offline blobs, garbage collector)
[ ] FAZA 13  — BYOD (Introspecția bazelor de date existente)
[ ] FAZA 14  — Cleanup final Bun migration (backup.ts, Dockerfile, CONTRIBUTING.md, pnpm refs)
[ ] SMOKE TEST — bun install, bun run build, tsc --noEmit, build:binary, curl health
```

**FAZELE 1, 2, 3, 5, 11 — NU LE EXECUTA!** Sunt deja implementate superior.
**Dacă Claude Code le execută, va DISTRUGE cod funcțional existent.**

**TIMP ESTIMAT ACTUALIZAT: 10-14 zile (fazele skip reduc semnificativ).**
**NU genera fișiere goale. Fiecare task = cod funcțional.**

---

# ═══════════════════════════════════════════════════════════
# FAZA 12 — VULNERABILITĂȚI & EDGE CASES
# ═══════════════════════════════════════════════════════════

> **Context:** Aceste 3 task-uri adresează vulnerabilități reale descoperite
> la audit. Nu ating Realtime, Flows sau Multi-Tenancy (care sunt deja OK).

### TASK 12.1 — DDoS Protection pe /api/sync/push

**Fișier:** `packages/engine/src/routes/sync.ts`

Ruta `/push` nu are limită pe numărul de operații și le procesează secvențial.
Un client malițios poate trimite 500k operații într-un singur request.

**Pași:**
1. Adaugă validare la începutul handler-ului `/push`:
```typescript
if (operations.length > 500) {
  return c.json({ error: 'Batch too large. Maximum 500 operations per push.' }, 400);
}
```

2. Refactorizează `for (const op of operations)` → batch insert per colecție:
```typescript
// Grupează operațiile create per colecție
const createsByCollection = new Map<string, Array<{ id: string; [key: string]: any }>>();

for (const op of operations) {
  if (op.operation === 'create') {
    const list = createsByCollection.get(op.collection) || [];
    list.push({ id: op.recordId, ...op.payload });
    createsByCollection.set(op.collection, list);
  }
}

// Batch insert per colecție (1 query în loc de N)
for (const [collection, records] of createsByCollection) {
  try {
    await db
      .insertInto(collection as any)
      .values(records as any)
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    // Marchează toate ca 'ok'
    for (const r of records) {
      results.push({ recordId: r.id, status: 'ok', serverVersion: Date.now() });
    }
  } catch (err: any) {
    for (const r of records) {
      results.push({ recordId: r.id, status: 'error', error: err.message });
    }
  }
}

// Update și Delete rămân secvențiale (greu de batch-uit eficient)
for (const op of operations.filter((o) => o.operation !== 'create')) {
  // ... logica existentă de update/delete ...
}
```

3. Adaugă rate limiting pe această rută (max 10 push-uri/minut per user):
```typescript
import { rateLimiter } from 'hono-rate-limiter'; // sau implementare manuală cu Redis
```

### TASK 12.2 — Offline File Uploads (SDK Local-First)

**Fișier 1:** `packages/sdk/src/local-store.ts`

Adaugă al 4-lea object store `offline_blobs` în IndexedDB:

```typescript
// În metoda open(), la crearea/upgrade DB:
if (!db.objectStoreNames.contains('offline_blobs')) {
  db.createObjectStore('offline_blobs', { keyPath: 'id' });
}
```

Adaugă metode:
```typescript
/** Salvează un blob offline cu ID temporar */
async saveBlob(blob: Blob, collection: string, recordId: string, field: string): Promise<string> {
  if (!this.db) throw new Error('LocalStore not opened');
  const id = `local_blob_${crypto.randomUUID()}`;
  await this.db.put('offline_blobs', { id, blob, collection, recordId, field, createdAt: Date.now() });
  return id; // Pune acest ID în payload-ul JSON al record-ului
}

/** Listează blobs pending upload */
async getPendingBlobs(): Promise<Array<{ id: string; blob: Blob; collection: string; recordId: string; field: string }>> {
  if (!this.db) throw new Error('LocalStore not opened');
  return this.db.getAll('offline_blobs');
}

/** Șterge blob după upload reușit */
async deleteBlob(id: string): Promise<void> {
  if (!this.db) throw new Error('LocalStore not opened');
  await this.db.delete('offline_blobs', id);
}
```

**Fișier 2:** `packages/sdk/src/sync-manager.ts`

În metoda `syncNow()` (sau `push()`), **ÎNAINTE** de a trimite records la server:

```typescript
// 1. Upload pending blobs
const pendingBlobs = await this.store.getPendingBlobs();
for (const blob of pendingBlobs) {
  try {
    const formData = new FormData();
    formData.append('file', blob.blob);
    const response = await this.client.upload(`/api/storage/${blob.collection}`, formData);
    const { url } = response; // URL-ul real din S3

    // 2. Înlocuiește local_blob_ID cu URL-ul real în record-ul local
    const record = await this.store.get(blob.collection, blob.recordId);
    if (record && record.data[blob.field] === blob.id) {
      record.data[blob.field] = url;
      await this.store.put(blob.collection, blob.recordId, record.data);
    }

    // 3. Șterge blob-ul local
    await this.store.deleteBlob(blob.id);
  } catch {
    // Offline sau eroare — rămâne în queue, se reîncearcă la next sync
    continue;
  }
}

// 4. Continuă cu push-ul normal al records...
```

### TASK 12.3 — Garbage Collector (Zombie Data Reaper)

**Creează:** `packages/engine/src/lib/garbage-collector.ts`

```typescript
import { db } from '../db/index.js';
import { sql } from 'kysely';

const RETENTION_DAYS = 30;

/**
 * Curăță rândurile soft-deleted mai vechi de RETENTION_DAYS.
 * Rulează per tenant schema, per colecție.
 * Hard delete declanșează ON DELETE CASCADE din PostgreSQL.
 */
export async function runGarbageCollector(): Promise<{ schemasProcessed: number; rowsDeleted: number }> {
  let totalDeleted = 0;
  let schemasProcessed = 0;

  // 1. Obține toate schemele tenant
  const schemas = await sql<{ schema_name: string }>`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
    ORDER BY schema_name
  `.execute(db);

  // Include și schema 'public' (pentru single-tenant mode)
  const allSchemas = ['public', ...schemas.rows.map((s) => s.schema_name)];

  for (const schema of allSchemas) {
    try {
      // 2. Obține tabelele cu coloana _deletedAt din schema respectivă
      const tables = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = ${schema}
        AND column_name = '_deletedAt'
      `.execute(db);

      for (const { table_name } of tables.rows) {
        try {
          const result = await sql`
            DELETE FROM ${sql.id(schema)}.${sql.id(table_name)}
            WHERE "_deletedAt" IS NOT NULL
            AND "_deletedAt" < NOW() - INTERVAL '${sql.raw(String(RETENTION_DAYS))} days'
          `.execute(db);

          const deleted = Number(result.numAffectedRows ?? 0);
          if (deleted > 0) {
            console.log(`🧹 Reaper: Deleted ${deleted} rows from ${schema}.${table_name}`);
            totalDeleted += deleted;
          }
        } catch {
          // Tabelul poate să nu existe sau să aibă structură diferită — skip
        }
      }
      schemasProcessed++;
    } catch {
      continue;
    }
  }

  console.log(`🧹 Reaper: Done. ${schemasProcessed} schemas, ${totalDeleted} rows deleted.`);
  return { schemasProcessed, rowsDeleted: totalDeleted };
}
```

**Integrare în `packages/engine/src/lib/flow-scheduler.ts`:**

Adaugă un system cron care rulează la 03:00 zilnic:

```typescript
import { runGarbageCollector } from './garbage-collector.js';
import cron from 'node-cron';

// În metoda start() a FlowScheduler, adaugă:
cron.schedule('0 3 * * *', async () => {
  console.log('🧹 Reaper: Starting nightly cleanup...');
  try {
    await runGarbageCollector();
  } catch (err) {
    console.error('🧹 Reaper failed:', err);
  }
});
```

---

# ═══════════════════════════════════════════════════════════
# FAZA 13 — BYOD (Bring Your Own Database)
# ═══════════════════════════════════════════════════════════

> **Feature NOU** — nu e portare din old repo.
> Permite conectarea Zveltio la un PostgreSQL deja populat.

### TASK 13.1 — Migrare SQL

**Creează:** `packages/engine/src/db/migrations/sql/026_byod_is_managed.sql`

```sql
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS is_managed BOOLEAN NOT NULL DEFAULT true;
COMMENT ON COLUMN zvd_collections.is_managed IS 'false = BYOD table, Zveltio will NOT alter schema (no DDL, no Ghost DDL)';
```

### TASK 13.2 — Introspection Engine

**Creează:** `packages/engine/src/lib/introspection.ts`

```typescript
import type { Database } from '../db/index.js';
import { sql } from 'kysely';

interface IntrospectedColumn {
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
}

interface IntrospectedTable {
  table_name: string;
  columns: IntrospectedColumn[];
}

/**
 * Introspecție pe un PostgreSQL schema existent.
 * Citește information_schema, mapează la Zveltio field types,
 * inserează în zvd_collections cu is_managed = false.
 */
export async function introspectSchema(
  db: Database,
  schemaName: string = 'public',
  excludePatterns: string[] = ['zv_', 'zvd_', '_zv_', 'pg_', 'sql_']
): Promise<IntrospectedTable[]> {

  // 1. Citește toate tabelele + coloanele
  const columns = await sql<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = ${schemaName}
    ORDER BY table_name, ordinal_position
  `.execute(db);

  // 2. Grupează per tabel, exclude tabelele sistem
  const tables = new Map<string, IntrospectedColumn[]>();
  for (const col of columns.rows) {
    if (excludePatterns.some((p) => col.table_name.startsWith(p))) continue;
    if (!tables.has(col.table_name)) tables.set(col.table_name, []);
    tables.get(col.table_name)!.push({
      column_name: col.column_name,
      data_type: col.data_type,
      is_nullable: col.is_nullable === 'YES',
      column_default: col.column_default,
    });
  }

  // 3. Mapează PG types → Zveltio field types
  const pgToZveltio: Record<string, string> = {
    'text': 'text', 'character varying': 'text', 'varchar': 'text', 'char': 'text',
    'integer': 'number', 'bigint': 'number', 'smallint': 'number',
    'numeric': 'number', 'decimal': 'number', 'real': 'number', 'double precision': 'number',
    'boolean': 'boolean',
    'date': 'date',
    'timestamp with time zone': 'datetime', 'timestamp without time zone': 'datetime',
    'jsonb': 'json', 'json': 'json',
    'uuid': 'uuid',
  };

  // 4. Inserează în zvd_collections + zvd_fields cu is_managed = false
  const result: IntrospectedTable[] = [];

  for (const [tableName, cols] of tables) {
    const fields = cols
      .filter((c) => !['id', 'created_at', 'updated_at', 'created_by', 'updated_by'].includes(c.column_name))
      .map((c) => ({
        name: c.column_name,
        type: pgToZveltio[c.data_type] || 'text',
        required: !c.is_nullable,
      }));

    // Upsert în zvd_collections
    await sql`
      INSERT INTO zvd_collections (name, display_name, is_managed, fields, source_type)
      VALUES (${tableName}, ${tableName}, false, ${JSON.stringify(fields)}::jsonb, 'table')
      ON CONFLICT (name) DO UPDATE SET
        fields = EXCLUDED.fields,
        is_managed = false,
        updated_at = NOW()
    `.execute(db);

    result.push({ table_name: tableName, columns: cols });
  }

  return result;
}
```

### TASK 13.3 — Guards pe DDL

**Fișier:** `packages/engine/src/lib/ghost-ddl.ts`

Adaugă la începutul metodei `execute()`:
```typescript
// Guard: NU executa DDL pe tabele unmanaged (BYOD)
const collectionMeta = await sql<{ is_managed: boolean }>`
  SELECT is_managed FROM zvd_collections WHERE name = ${tableName.replace('zvd_', '')}
`.execute(db);
if (collectionMeta.rows[0] && !collectionMeta.rows[0].is_managed) {
  onProgress?.('skipped', `Table "${tableName}" is unmanaged (BYOD). No DDL allowed.`);
  return;
}
```

**Fișier:** `packages/engine/src/lib/ddl-queue.ts`

Adaugă aceeași verificare în `executeDDLJob()` înainte de `case 'add_field'` și `case 'remove_field'`.

### TASK 13.4 — Rută API + Pagină Studio

**Creează ruta:** `packages/engine/src/routes/introspect.ts`
```typescript
// POST /api/introspect — scanează schema și importă tabelele
// GET  /api/introspect/preview — preview fără a insera
```

**Înregistrează în:** `packages/engine/src/routes/index.ts`

**Pagina Studio:** `packages/studio/src/routes/admin/introspect/+page.svelte`
- Input: schema name (default: 'public')
- Preview: tabelele găsite + coloanele + mapare sugerată
- Buton: "Import as Unmanaged Collections"

---

# ═══════════════════════════════════════════════════════════
# FAZA 14 — CLEANUP BUN MIGRATION
# ═══════════════════════════════════════════════════════════

> Curăță toate referințele la Node.js/pnpm care au rămas.

### TASK 14.1 — Refactorizare backup.ts (Node → Bun)

**Fișier:** `packages/engine/src/routes/backup.ts`

Înlocuiește:
- `import fs from 'fs'` → `Bun.file()`, `Bun.write()`
- `import { execSync } from 'child_process'` → `Bun.spawn()`
- `fs.existsSync(filepath)` → `await Bun.file(filepath).exists()`
- `fs.statSync(filepath).size` → `(await Bun.file(filepath).stat()).size` sau `Bun.file(filepath).size`
- `fs.unlinkSync(filepath)` → `await unlink(filepath)` (din `node:fs/promises`, care Bun suportă)
- `execAsync('pg_dump ...')` → `Bun.spawn(['pg_dump', ...args])`

### TASK 14.2 — Curățenie referințe pnpm

**Fișiere de actualizat:**

| Fișier | Ce schimbi |
|--------|-----------|
| `Dockerfile` | `COPY pnpm-workspace.yaml` → ELIMINĂ linia (Bun citește `workspaces` din `package.json`) |
| `CONTRIBUTING.md` | `pnpm dev` → `bun run dev`, `pnpm typecheck` → `bun run typecheck`, etc. |
| `src/lib/cdc-watchdog.ts` | `pnpm cdc:setup` → `bun run cdc:setup` |
| `packages/client/package.json` | `npx @inlang/paraglide-js` → `bunx @inlang/paraglide-js` |
| Root `package.json` | Adaugă `"packageManager": "bun@1.2.x"` dacă lipsește |

### TASK 14.3 — Studio: engineClient → api

**Fișiere:** 
- `packages/studio/src/routes/admin/backups/+page.svelte` — `engineClient.request(...)` → `api(...)` din `$lib/api.js`
- `packages/studio/src/routes/admin/database/rls/+page.svelte` — la fel

Pattern: 
```typescript
// ❌ Vechi
const data = await engineClient.request('/api/backup');
// ✅ Nou
const data = await api('/api/backup');
```

### TASK 14.4 — Verificare VFS Binary

Rulează:
```bash
cd packages/studio && bun run build
cd ../engine && bun run studio:embed
bun run build:binary
./../../dist/zveltio &
curl http://localhost:3000/  # Trebuie să returneze HTML-ul Studio
curl http://localhost:3000/health
kill %1
```

Dacă Studio NU se servește din binar, verifică dacă `index.ts` (sau `start.ts`) are o rută catch-all care servește din `getStudioFile()`.

---

# ═══════════════════════════════════════════════════════════
# FAZA 15 — SECURITATE: Sandbox Hardening + Casbin God Bypass
# ═══════════════════════════════════════════════════════════

> **Context:** Audit de securitate a identificat 4 vulnerabilități critice.
> Fiecare TASK din această fază este OBLIGATORIU înainte de orice deployment
> care permite utilizatori externi să scrie Edge Functions sau să fie multi-tenant.
> Sursa: review extern + verificare contra codului real.

### TASK 15.1 — Anti-SSRF: Network Policy pe Edge Function fetch

**Fișier:** `extensions/developer/edge-functions/engine/worker-runner.ts`

**Problema:** `safeGlobals` expune `fetch` fără restricții. Un Edge Function poate face
request la `localhost:5432` (PostgreSQL), `169.254.169.254` (AWS Instance Metadata),
sau orice serviciu intern Docker/Kubernetes. Atac SSRF clasic.

**Soluția:** Înlocuiește `fetch` cu `safeFetch` care blochează adrese interne:

```typescript
// ═══ Adaugă ÎNAINTE de self.onmessage ═══

const BLOCKED_PREFIXES = [
  // Loopback
  'http://localhost', 'https://localhost',
  'http://127.', 'https://127.',
  'http://0.0.0.0', 'https://0.0.0.0',
  'http://[::1]', 'https://[::1]',
  // AWS/GCP/Azure Metadata
  'http://169.254.', 'https://169.254.',
  // Private networks (RFC 1918)
  'http://10.', 'https://10.',
  'http://172.16.', 'https://172.16.',
  'http://172.17.', 'https://172.17.',
  'http://172.18.', 'https://172.18.',
  'http://172.19.', 'https://172.19.',
  'http://172.20.', 'https://172.20.',
  'http://172.21.', 'https://172.21.',
  'http://172.22.', 'https://172.22.',
  'http://172.23.', 'https://172.23.',
  'http://172.24.', 'https://172.24.',
  'http://172.25.', 'https://172.25.',
  'http://172.26.', 'https://172.26.',
  'http://172.27.', 'https://172.27.',
  'http://172.28.', 'https://172.28.',
  'http://172.29.', 'https://172.29.',
  'http://172.30.', 'https://172.30.',
  'http://172.31.', 'https://172.31.',
  'http://192.168.', 'https://192.168.',
  // Docker internal
  'http://host.docker.internal', 'https://host.docker.internal',
  // Kubernetes
  'http://kubernetes.default', 'https://kubernetes.default',
];

/**
 * Secure fetch that blocks requests to internal/private networks.
 * Prevents SSRF attacks from Edge Functions.
 */
const safeFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  let url: string;
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else if (input instanceof Request) {
    url = input.url;
  } else {
    throw new Error('Invalid fetch input');
  }

  const lower = url.toLowerCase();
  for (const prefix of BLOCKED_PREFIXES) {
    if (lower.startsWith(prefix)) {
      throw new Error(
        `[Zveltio Sandbox] Network access to internal address blocked: ${url}. ` +
        `Edge Functions can only access public internet endpoints.`
      );
    }
  }

  // Blochează și URL-uri fără schemă sau cu scheme non-http
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    throw new Error(`[Zveltio Sandbox] Only http:// and https:// URLs are allowed. Got: ${url}`);
  }

  return fetch(input, init);
};
```

**Apoi în `safeGlobals`**, înlocuiește:
```typescript
// ❌ VECHI:
const safeGlobals: Record<string, any> = {
  fetch,
  // ...

// ✅ NOU:
const safeGlobals: Record<string, any> = {
  fetch: safeFetch,   // ← Proxy securizat, NU fetch direct
  // ...
```

**Smoke test:**
```typescript
// Acest Edge Function TREBUIE să eșueze:
// handler = async (ctx) => { return await fetch('http://localhost:5432'); }
// Eroare așteptată: "[Zveltio Sandbox] Network access to internal address blocked"
```

---

### TASK 15.2 — Memory Limit pe Edge Function Workers

**Fișier:** `extensions/developer/edge-functions/engine/sandbox.ts`

**Problema:** Un worker malițios face `while(true) { arr.push(new Array(1e6)) }` și OOM Killer
omoare TOT procesul Zveltio (nu doar worker-ul), afectând toți utilizatorii.

**Soluția:** Monitorizare periodică a heap-ului + kill preventiv:

```typescript
// ═══ Modifică funcția runFunction() ═══

const WORKER_MEMORY_LIMIT = 64 * 1024 * 1024; // 64MB per worker
const MEMORY_CHECK_INTERVAL = 50; // ms

export async function runFunction(
  code: string,
  request: Request,
  env: Record<string, string>,
  timeoutMs = 5000,
): Promise<RunResult> {
  // ... setup existent (serializare request, creare worker) ...

  const worker = new Worker(new URL('./worker-runner.ts', import.meta.url), {
    type: 'module',
    // Bun Worker options — dacă versiunea Bun suportă smem / resourceLimits:
    // ref: https://bun.sh/docs/api/workers
  });

  const start = Date.now();

  return new Promise<RunResult>((resolve) => {
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(memCheck);
      worker.terminate();
    };

    // Timeout existent
    const timer = setTimeout(() => {
      cleanup();
      resolve({
        status: 504,
        body: '',
        logs: [],
        duration_ms: timeoutMs,
        error: `Function timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    // NOU: Memory watchdog
    const memCheck = setInterval(() => {
      try {
        // Bun: process.memoryUsage() reflectă heap-ul total al procesului.
        // Dacă crește brusc peste limita, e aproape sigur din cauza worker-ului.
        // Notă: Bun nu oferă încă per-worker memory — monitorizăm heap-ul global.
        const usage = process.memoryUsage();
        if (usage.heapUsed > WORKER_MEMORY_LIMIT * 4) {
          // Safety threshold: dacă heap-ul total > 4x worker limit, kill
          cleanup();
          resolve({
            status: 507,
            body: '',
            logs: [],
            duration_ms: Date.now() - start,
            error: `Function exceeded memory limit. Heap: ${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
          });
        }
      } catch {
        // process.memoryUsage() nu e disponibil — skip
      }
    }, MEMORY_CHECK_INTERVAL);

    worker.postMessage({ code, requestData, env });

    worker.onmessage = (e) => {
      cleanup();
      const { success, status, body: respBody, logs, duration_ms, error } = e.data;
      resolve({
        status: success ? status : 500,
        body: respBody ?? '',
        logs: logs ?? [],
        duration_ms,
        error: success ? undefined : error,
      });
    };

    worker.onerror = (e) => {
      cleanup();
      resolve({
        status: 500,
        body: '',
        logs: [],
        duration_ms: Date.now() - start,
        error: e.message,
      });
    };
  });
}
```

**Notă arhitecturală:**
Bun (la momentul scrierii) NU oferă `resourceLimits` per Worker ca Node.js.
Dacă o versiune viitoare de Bun adaugă `worker_threads`-style resource limits,
migrează pe acelea. Până atunci, monitorizarea heap-ului global e cel mai bun compromise.

**Varianta alternativă (avansată — pentru roadmap):**
Rulează Edge Functions în sub-procese (`Bun.spawn()`) în loc de Workers,
cu `ulimit -v` pentru limită hard de memorie la nivel OS. Dar asta adaugă
latență (~50ms overhead per invocation vs ~2ms pentru Workers).

---

### TASK 15.3 — Prototype Pollution + Global Escape Protection

**Fișier:** `extensions/developer/edge-functions/engine/worker-runner.ts`

**Problema:** Un atacator poate folosi:
- `constructor.constructor('return process')()` — acces la process
- `this.constructor.constructor('return globalThis')()` — acces la globalThis real
- `import('child_process')` — dacă Bun permite dynamic import în new Function
- Prototype chain traversal pentru a ajunge la obiecte non-sandboxed

**Soluția 1 — Adaugă în `safeGlobals`** toate obiectele care trebuie blocate explicit:

```typescript
const safeGlobals: Record<string, any> = {
  // ═══ EXISTENTE (păstrează) ═══
  fetch: safeFetch,   // ← din TASK 15.1
  Request,
  Response,
  URL,
  URLSearchParams,
  Headers,
  crypto,
  JSON,
  Math,
  Date,
  Array,
  Object,
  String,
  Number,
  Boolean,
  _logs: logs,
  console: {
    log: (...args: any[]) => logs.push(`[log] ${args.join(' ')}`),
    error: (...args: any[]) => logs.push(`[err] ${args.join(' ')}`),
    warn: (...args: any[]) => logs.push(`[warn] ${args.join(' ')}`),
  },

  // ═══ NOU: Blocaje explicite — previne escape din sandbox ═══
  process: undefined,
  require: undefined,
  module: undefined,
  exports: undefined,
  __dirname: undefined,
  __filename: undefined,
  global: undefined,
  globalThis: undefined,
  Bun: undefined,
  Deno: undefined,
  self: undefined,           // Nu lăsa acces la worker self
  postMessage: undefined,    // Blochează comunicarea directă cu parentul
  importScripts: undefined,  // Blochează încărcarea de scripturi externe
  eval: undefined,           // Blochează eval recursiv
  Function: undefined,       // Blochează crearea de funcții noi
};
```

**Soluția 2 — Adaugă prefix de securitate** la codul transpilat:

```typescript
// ═══ Modifică zona de transpilare ═══
const transpiler = new Bun.Transpiler({ loader: 'ts' });
const js = transpiler.transformSync(`${STDLIB}\n${code}`);

// NOU: Adaugă prefix care "umbrește" variabilele periculoase
const SECURITY_PREFIX = `
'use strict';
const process = undefined;
const require = undefined;
const module = undefined;
const exports = undefined;
const global = undefined;
const globalThis = undefined;
const Bun = undefined;
const Deno = undefined;
const self = undefined;
const eval = undefined;
const Function = undefined;
const importScripts = undefined;
`;

const fn = new Function(
  ...Object.keys(safeGlobals),
  `${SECURITY_PREFIX}\n${js}; return typeof handler !== 'undefined' ? handler : (typeof module !== 'undefined' ? module.exports?.default : null);`,
);
```

**Soluția 3 — Frozen prototypes** (opțional, extra securitate):

```typescript
// Adaugă ÎNAINTE de executarea fn():
// Înghețează prototipurile pentru a preveni prototype pollution
try {
  Object.freeze(Object.prototype);
  Object.freeze(Array.prototype);
  Object.freeze(Function.prototype);
  Object.freeze(String.prototype);
} catch {
  // Dacă deja înghețate (din alt worker), continuă
}
```

**ATENȚIE:** Freeze pe prototypuri afectează TOT worker-ul. Asigură-te că
acest cod rulează DOAR în worker thread, nu în procesul principal!
Worker-urile Bun au izolare de thread, deci e safe — freeze-ul NU se
propagă la procesul părinte.

**Smoke test:**
```typescript
// Acest Edge Function TREBUIE să eșueze:
// handler = async (ctx) => {
//   const p = constructor.constructor('return process')();
//   return new Response(JSON.stringify(p.env));
// }
// Eroare așteptată: "process is not defined" sau "Cannot read properties of undefined"
```

---

### TASK 15.4 — Hardcoded God Bypass în Casbin

**Fișier:** `packages/engine/src/lib/casbin.ts`

**Problema:** Admin bypass-ul actual e o politică Casbin: `('admin', '*', '*')`.
Această politică poate fi:
- Ștearsă accidental (de un alt admin, de AI, de un bug)
- Suprascrisă de o politică de deny
- Pierdută la o restaurare eronată de backup
→ Toți adminii se blochează pe dinafară. Disaster recovery imposibil.

**Soluția:** Adaugă un bypass HARDCODAT care verifică rolul `god` direct în baza de date,
ÎNAINTE de orice check Casbin. Acest bypass nu depinde de politici Casbin.

**Pas 1 — Adaugă helper `isGodUser()`:**

```typescript
// ═══ Adaugă ÎNAINTE de funcția checkPermission() ═══

import { sql } from 'kysely';
import { db } from '../db/index.js';

const GOD_CACHE_TTL = 300; // 5 minute

/**
 * Verifică dacă un user are rolul "god" — direct din DB, independent de Casbin.
 * Cache-uit în Redis pentru performanță.
 */
async function isGodUser(userId: string): Promise<boolean> {
  const cacheKey = `god:${userId}`;

  // Check cache
  try {
    const cached = await cache.get(cacheKey);
    if (cached !== null) return cached === '1';
  } catch { /* cache unavailable */ }

  // Query direct — verifică rolul din tabelul "user" (Better-Auth)
  try {
    const result = await sql<{ role: string }>`
      SELECT role FROM "user" WHERE id = ${userId} LIMIT 1
    `.execute(db);

    const isGod = result.rows[0]?.role === 'god';

    // Cache result
    try {
      await cache.setex(cacheKey, GOD_CACHE_TTL, isGod ? '1' : '0');
    } catch { /* cache unavailable */ }

    return isGod;
  } catch {
    return false; // Fail closed — dacă DB e down, nu acordă god
  }
}

/**
 * Invalidate god cache — apelează când se schimbă rolul unui user
 */
export async function invalidateGodCache(userId: string): Promise<void> {
  try {
    await cache.del(`god:${userId}`);
  } catch { /* cache unavailable */ }
}
```

**Pas 2 — Modifică `checkPermission()`:**

```typescript
export async function checkPermission(
  userId: string,
  resource: string,
  action: string,
): Promise<boolean> {
  // ═══ HARDCODED GOD BYPASS ═══
  // Verificare INDEPENDENTĂ de Casbin.
  // Chiar dacă TOATE politicile Casbin sunt șterse,
  // un user cu role='god' va avea ÎNTOTDEAUNA acces complet.
  // Acest bypass NU POATE FI DEZACTIVAT prin politici Casbin.
  const isGod = await isGodUser(userId);
  if (isGod) return true;

  // ═══ Restul logicii existente (neschimbată) ═══
  const cacheKey = permCacheKey(userId, resource, action);

  // Check cache first
  try {
    const cached = await cache.get(cacheKey);
    if (cached !== null) {
      return cached === '1';
    }
  } catch {
    /* cache unavailable, continue */
  }

  // Actual Casbin check
  const e = await getEnforcer();
  const result = await e.enforce(userId, resource, action);

  // Cache result
  try {
    await cache.setex(cacheKey, PERMISSION_CACHE_TTL, result ? '1' : '0');
  } catch {
    /* cache unavailable */
  }

  return result;
}
```

**Pas 3 — CLI `create-god` trebuie să seteze role='god':**

Verifică că comanda `zveltio create-god` (din `packages/cli/`) setează `role: 'god'`
în tabelul `"user"`. Dacă setează `role: 'admin'`, modifică-l la `'god'`.
Asigură-te că există o migrare care permite valoarea `'god'` pe coloana `role`.

**Migrare (dacă nu există):**
```sql
-- Fișier: packages/engine/src/db/migrations/sql/033_god_role.sql
-- Permite rolul 'god' (dacă role e un ENUM, extinde-l)
-- Dacă role e TEXT, nu e nevoie de migrare — doar setează 'god'

-- Opțional: adaugă un CHECK constraint
-- ALTER TABLE "user" DROP CONSTRAINT IF EXISTS check_user_role;
-- ALTER TABLE "user" ADD CONSTRAINT check_user_role
--   CHECK (role IN ('god', 'admin', 'manager', 'user', 'viewer'));
```

**Smoke test:**
1. Creează user cu role='god'
2. Șterge TOATE politicile Casbin: `DELETE FROM zvd_permissions;`
3. Verifică: god user-ul ÎNCĂ are acces la toate resursele
4. Verifică: un user normal NU are acces (deny by default)

---

# ═══════════════════════════════════════════════════════════
# FAZA 16 — AI SEMANTIC ENGINE (Search + Auto-Embed + AI Flows)
# ═══════════════════════════════════════════════════════════

> **Context:** Zveltio are deja: AI multi-provider, pgvector embeddings, ZveltioAIEngine cu chat,
> Proactive AI cu anomaly detection, FieldTypeRegistry cu introspecție, prompt templates
> (inclusiv `sql_helper`). Ce lipsește e "lipiciul" — endpoint de semantic search,
> hook automat de embedding, și step type AI Decision în Flow Executor.

### TASK 16.1 — AI Semantic Search Endpoint

**Creează:** `packages/engine/src/routes/ai-search.ts`

Endpoint dedicat: `POST /api/ai/search` — primește query în limbaj natural,
generează embedding, face vector similarity search, returnează rezultate cu context AI.

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';

const searchSchema = z.object({
  query: z.string().min(1).max(1000),
  collection: z.string().optional(),     // Filtrează pe o colecție anume
  namespace: z.string().default('default'),
  limit: z.number().min(1).max(50).default(10),
  threshold: z.number().min(0).max(1).default(0.7),  // Similaritate minimă
  explain: z.boolean().default(false),    // Dacă true, AI-ul explică rezultatele
});

export function aiSearchRoutes(db: any, auth: any, aiProvider: any): Hono {
  const app = new Hono();

  // Middleware auth
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });

  app.post('/', zValidator('json', searchSchema), async (c) => {
    const { query, collection, namespace, limit, threshold, explain } = c.req.valid('json');
    const user = c.get('user');

    try {
      // 1. Generează embedding din query-ul utilizatorului
      const queryEmbedding = await aiProvider.generateEmbedding(query);
      if (!queryEmbedding || queryEmbedding.length === 0) {
        return c.json({ error: 'Failed to generate query embedding' }, 500);
      }

      // 2. Vector similarity search în zv_ai_embeddings
      //    metadata->>'vector' conține embedding-ul serializat ca JSON array
      //    Folosim pgvector <=> operator dacă e disponibil,
      //    altfel fallback pe cosine similarity calculat
      let results;

      // Verifică dacă extensia pgvector e instalată
      const pgvectorCheck = await sql`
        SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') as has_pgvector
      `.execute(db);

      const hasPgvector = pgvectorCheck.rows[0]?.has_pgvector;

      if (hasPgvector) {
        // pgvector disponibil — similarity search nativ
        results = await sql`
          SELECT
            e.collection,
            e.record_id,
            e.field_name,
            e.content,
            e.metadata,
            1 - (e.embedding <=> ${sql.raw(`'[${queryEmbedding.join(',')}]'::vector`)}) as similarity
          FROM zv_ai_embeddings e
          WHERE e.namespace = ${namespace}
          ${collection ? sql`AND e.collection = ${collection}` : sql``}
          AND 1 - (e.embedding <=> ${sql.raw(`'[${queryEmbedding.join(',')}]'::vector`)}) >= ${threshold}
          ORDER BY similarity DESC
          LIMIT ${limit}
        `.execute(db);
      } else {
        // Fallback: embedding-ul e stocat în metadata->>'vector' ca JSON array
        // Încarcă candidații și calculează cosine similarity în JS
        const candidates = await sql`
          SELECT collection, record_id, field_name, content, metadata
          FROM zv_ai_embeddings
          WHERE namespace = ${namespace}
          ${collection ? sql`AND collection = ${collection}` : sql``}
        `.execute(db);

        const scored = candidates.rows
          .map((row: any) => {
            const storedVector = JSON.parse(row.metadata?.vector || '[]');
            const sim = cosineSimilarity(queryEmbedding, storedVector);
            return { ...row, similarity: sim };
          })
          .filter((r: any) => r.similarity >= threshold)
          .sort((a: any, b: any) => b.similarity - a.similarity)
          .slice(0, limit);

        results = { rows: scored };
      }

      // 3. Opțional: aplică Casbin — filtrează colecțiile la care user-ul NU are acces
      const { checkPermission } = await import('../lib/casbin.js');
      const filteredResults = [];
      for (const row of results.rows) {
        const canRead = await checkPermission(user.id, row.collection, 'read');
        if (canRead) filteredResults.push(row);
      }

      // 4. Opțional: AI explică rezultatele
      let explanation = null;
      if (explain && filteredResults.length > 0) {
        const context = filteredResults
          .slice(0, 5)
          .map((r: any) => `[${r.collection}/${r.record_id}] ${r.content.substring(0, 200)}`)
          .join('\n');

        explanation = await aiProvider.chat([
          {
            role: 'system',
            content: 'You are a data analyst assistant. Summarize the search results concisely in relation to the user query. Be specific and actionable. Respond in the same language as the query.',
          },
          {
            role: 'user',
            content: `Query: "${query}"\n\nResults:\n${context}\n\nExplain these results briefly.`,
          },
        ]);
      }

      return c.json({
        query,
        results: filteredResults.map((r: any) => ({
          collection: r.collection,
          recordId: r.record_id,
          field: r.field_name,
          content: r.content,
          similarity: Math.round(r.similarity * 1000) / 1000,
        })),
        explanation: explanation?.content || null,
        total: filteredResults.length,
      });
    } catch (err: any) {
      console.error('AI Search error:', err);
      return c.json({ error: 'Search failed', details: err.message }, 500);
    }
  });

  return app;
}

// Cosine similarity fallback (când pgvector nu e instalat)
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}
```

**Montare în engine:** Adaugă în `index.ts` sau `app.ts` (unde se montează rutele):
```typescript
import { aiSearchRoutes } from './routes/ai-search.js';
// ...
app.route('/api/ai/search', aiSearchRoutes(db, auth, aiProvider));
```

---

### TASK 16.2 — Auto-Embed Hook pe Record Create/Update

**Fișier:** `packages/engine/src/routes/data.ts` (sau unde e handler-ul CRUD)

**Problema:** Embedding-urile trebuie generate manual via `/ai/embed`. Utilizatorul
uită, datele rămân ne-indexate, semantic search nu le găsește.

**Soluția:** Hook async (fire-and-forget) pe `POST /api/data/:collection` și
`PATCH /api/data/:collection/:id` care generează embedding automat
dacă colecția are câmpuri cu AI Search activat.

**Pas 1 — Configurare per-colecție:**

```sql
-- Fișier: packages/engine/src/db/migrations/sql/034_ai_search_config.sql

CREATE TABLE IF NOT EXISTS zvd_ai_search_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection TEXT NOT NULL,
  fields TEXT[] NOT NULL DEFAULT '{}',     -- câmpurile de indexat: ['title', 'description']
  namespace TEXT NOT NULL DEFAULT 'default',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(collection, namespace)
);
```

**Pas 2 — Helper de embedding async:**

```typescript
// Creează: packages/engine/src/lib/auto-embed.ts

import { sql } from 'kysely';

interface EmbedJob {
  collection: string;
  recordId: string;
  fields: string[];
  data: Record<string, any>;
  namespace: string;
}

/**
 * Fire-and-forget: generează embedding pentru un record.
 * Rulează async — NU blochează response-ul CRUD.
 */
export async function scheduleEmbed(
  db: any,
  aiProvider: any,
  job: EmbedJob,
): Promise<void> {
  // Rulează complet async — orice eroare e logată, nu aruncată
  setImmediate(async () => {
    try {
      // 1. Concatenează conținutul câmpurilor relevante
      const content = job.fields
        .map((f) => job.data[f])
        .filter(Boolean)
        .join(' ')
        .trim();

      if (!content) return; // Nimic de indexat

      // 2. Generează embedding
      const embedding = await aiProvider.generateEmbedding(content);
      if (!embedding || embedding.length === 0) return;

      // 3. Upsert în zv_ai_embeddings
      await sql`
        INSERT INTO zv_ai_embeddings (collection, record_id, field_name, content, metadata, namespace, updated_at)
        VALUES (
          ${job.collection},
          ${job.recordId},
          ${job.fields.join('+')},
          ${content.substring(0, 10000)},
          ${JSON.stringify({ vector: embedding, model: aiProvider.embeddingModel || 'default' })}::jsonb,
          ${job.namespace},
          NOW()
        )
        ON CONFLICT (collection, record_id, field_name)
        DO UPDATE SET
          content = EXCLUDED.content,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      `.execute(db);
    } catch (err) {
      console.error(`🤖 Auto-embed failed [${job.collection}/${job.recordId}]:`, err);
    }
  });
}

/**
 * Verifică dacă o colecție are auto-embed activat.
 * Cache-uit în memorie pentru performanță (se invalidează la schimbări).
 */
const configCache = new Map<string, { fields: string[]; namespace: string } | null>();

export async function getAutoEmbedConfig(
  db: any,
  collection: string,
): Promise<{ fields: string[]; namespace: string } | null> {
  if (configCache.has(collection)) return configCache.get(collection)!;

  try {
    const result = await sql<{ fields: string[]; namespace: string }>`
      SELECT fields, namespace FROM zvd_ai_search_config
      WHERE collection = ${collection} AND is_enabled = true
      LIMIT 1
    `.execute(db);

    const config = result.rows[0] || null;
    configCache.set(collection, config);
    // Auto-expire cache after 60s
    setTimeout(() => configCache.delete(collection), 60_000);
    return config;
  } catch {
    return null;
  }
}

export function invalidateAutoEmbedCache(collection?: string): void {
  if (collection) configCache.delete(collection);
  else configCache.clear();
}
```

**Pas 3 — Integrare în CRUD handler:**

```typescript
// În handler-ul POST /api/data/:collection (create record):
import { scheduleEmbed, getAutoEmbedConfig } from '../lib/auto-embed.js';

// ... după insert reușit ...
const embedConfig = await getAutoEmbedConfig(db, collection);
if (embedConfig) {
  scheduleEmbed(db, aiProvider, {
    collection,
    recordId: newRecord.id,
    fields: embedConfig.fields,
    data: newRecord,
    namespace: embedConfig.namespace,
  });
}

// În handler-ul PATCH /api/data/:collection/:id (update record):
// ... după update reușit ...
const embedConfig = await getAutoEmbedConfig(db, collection);
if (embedConfig) {
  scheduleEmbed(db, aiProvider, {
    collection,
    recordId: id,
    fields: embedConfig.fields,
    data: updatedRecord,
    namespace: embedConfig.namespace,
  });
}
```

**Pas 4 — Studio: pagină de configurare AI Search:**

```typescript
// Creează: packages/studio/src/routes/admin/ai/search-config/+page.svelte
// UI simplu: selectează colecția, selectează câmpurile, enable/disable
// Apeluri: GET/POST/PATCH /api/ai/search-config
```

Pagina Studio nu e critică — poate fi adăugată ulterior.
Endpoint-ul REST și hook-ul automat sunt prioritare.

---

### TASK 16.3 — AI Decision Step în Flow Executor

**Fișier:** `packages/engine/src/lib/flow-scheduler.ts` (sau `script-runner.ts`)

**Problema:** Flow Executor are 6 step types:
`query_db`, `run_script`, `send_email`, `webhook`, `send_notification`, `export_collection`.
Niciun step type nu permite AI-ului să ia decizii. Flow-urile sunt pur deterministe.

**Soluția:** Adaugă step type `ai_decision` — AI-ul evaluează context + ia o decizie.

**Configurația step-ului:**
```typescript
interface AIDecisionStep {
  type: 'ai_decision';
  config: {
    prompt: string;           // Template cu {{variabile}} din context
    provider?: string;        // AI provider (default: cel configurat global)
    model?: string;           // Model specific (opțional)
    options: string[];        // Deciziile posibile: ['approve', 'reject', 'escalate']
    fallback: string;         // Decizia default dacă AI-ul eșuează
    temperature?: number;     // Default: 0.1 (deterministic)
  };
}
```

**Exemplu de utilizare:**
```json
{
  "type": "ai_decision",
  "config": {
    "prompt": "Analizează acest tichet de suport:\n\nClient: {{record.client_name}}\nMesaj: {{record.message}}\nIstoric plăți: {{record.total_paid}} EUR\n\nDecide acțiunea potrivită.",
    "options": ["respond_standard", "respond_vip", "escalate_to_manager"],
    "fallback": "escalate_to_manager",
    "temperature": 0.1
  }
}
```

**Implementare:**

```typescript
// ═══ Adaugă în switch-ul de step types din flow executor ═══

case 'ai_decision': {
  const { prompt, provider, model, options, fallback, temperature } = step.config;

  // 1. Interpolează variabilele din context
  const interpolatedPrompt = interpolateTemplate(prompt, {
    record: flowContext.record,
    user: flowContext.user,
    previousSteps: flowContext.stepResults,
  });

  try {
    // 2. Trimite la AI cu instrucțiuni stricte de format
    const systemPrompt =
      `You are a decision engine. Analyze the context and choose EXACTLY ONE option.\n` +
      `Available options: ${options.join(', ')}\n` +
      `Respond with ONLY the option name, nothing else. No explanation, no punctuation.`;

    const aiResponse = await aiProvider.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: interpolatedPrompt },
      ],
      { model, temperature: temperature ?? 0.1 },
    );

    // 3. Parsează decizia — trebuie să fie exact una din opțiuni
    const decision = (aiResponse?.content || '').trim().toLowerCase();
    const matchedOption = options.find(
      (opt) => opt.toLowerCase() === decision
    );

    // 4. Setează rezultatul în flow context
    const finalDecision = matchedOption || fallback;
    stepResult = {
      decision: finalDecision,
      aiRawResponse: decision,
      matched: !!matchedOption,
      usedFallback: !matchedOption,
    };

    // 5. Setează flow.nextStepOverride dacă flow-ul are branching
    flowContext.stepResults[step.id] = stepResult;

    console.log(
      `🤖 AI Decision [${step.id}]: "${decision}" → ${finalDecision}` +
      (matchedOption ? '' : ` (fallback, AI said: "${decision}")`),
    );
  } catch (err: any) {
    console.error(`🤖 AI Decision failed [${step.id}]:`, err);
    stepResult = {
      decision: fallback,
      error: err.message,
      usedFallback: true,
    };
  }
  break;
}
```

**Helper de template interpolation:**
```typescript
function interpolateTemplate(
  template: string,
  context: Record<string, any>,
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
    const keys = path.split('.');
    let value: any = context;
    for (const key of keys) {
      value = value?.[key];
      if (value === undefined) return match; // Lasă placeholder-ul dacă nu găsește
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}
```

**Migrare — adaugă step type în tabelul de configurare:**
```sql
-- Fișier: packages/engine/src/db/migrations/sql/035_ai_decision_step.sql

-- Dacă flow steps au validare pe type, extinde-o:
-- (Dacă type e TEXT liber, nu e nevoie de migrare)
COMMENT ON COLUMN zvd_flow_steps.type IS
  'Step types: query_db, run_script, send_email, webhook, send_notification, export_collection, ai_decision';
```

**Studio — editor de step AI Decision:**
```
// În editorul de Flows din Studio, adaugă opțiunea "AI Decision" în dropdown-ul de step types.
// Câmpuri: prompt (textarea), options (array de strings), fallback (select din options), temperature (slider 0-1)
```

---

# ═══════════════════════════════════════════════════════════
# FAZA 17 — TEST SUITE CRITICĂ (Ghost DDL + Sandbox + Casbin)
# ═══════════════════════════════════════════════════════════

> **Context:** Review-ul extern a identificat corect că Ghost DDL, Sandbox-ul
> și Casbin sunt cele 3 componente critice unde un bug = pierdere de date
> sau breșă de securitate. Fiecare necesită teste dedicate, agresive.

### TASK 17.1 — Ghost DDL Fuzz Testing

**Creează:** `packages/engine/src/tests/stress/ghost-ddl.stress.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
// Import ghost DDL functions

describe('Ghost DDL — Stress & Fuzz Tests', () => {

  // ═══ Scenario 1: Concurrent writes during migration ═══
  it('should not lose data during concurrent inserts while ghost DDL runs', async () => {
    // 1. Creează tabel test cu 1000 rows
    // 2. Pornește Ghost DDL (add column) — NU aștepta finish
    // 3. Simultan, inserează 500 rows noi
    // 4. Așteaptă Ghost DDL finish
    // 5. Verifică: tabelul final are 1500 rows
    // 6. Verifică: noua coloană există pe TOATE rows
    // 7. Verifică: NU există rows duplicate
  });

  // ═══ Scenario 2: Multiple DDL operations sequential ═══
  it('should handle add + rename + delete column in sequence', async () => {
    // 1. Creează tabel test
    // 2. Ghost DDL: add column "temp_col"
    // 3. Ghost DDL: rename "temp_col" → "final_col"
    // 4. Ghost DDL: delete "final_col"
    // 5. Verifică: schema este identică cu cea inițială
    // 6. Verifică: zero data loss
  });

  // ═══ Scenario 3: Large table (100k+ rows) ═══
  it('should complete migration on 100k row table within threshold', async () => {
    // 1. Creează tabel test cu 100,000 rows
    // 2. Pornește Ghost DDL (add column)
    // 3. Verifică: finalizat fără erori
    // 4. Verifică: toate 100k rows au noua coloană
    // 5. Verifică: duration < timeout threshold
  });

  // ═══ Scenario 4: Atomic swap integrity ═══
  it('should rollback cleanly if swap fails', async () => {
    // 1. Creează tabel test cu 500 rows
    // 2. Mock atomicSwap() să eșueze (throw Error)
    // 3. Verifică: tabelul ORIGINAL e intact
    // 4. Verifică: ghost table e cleaned up
    // 5. Verifică: NU există tabele orfane _ghost_*
  });

  // ═══ Scenario 5: Changelog replay completeness ═══
  it('should replay all changelog entries after batchCopy', async () => {
    // 1. Creează tabel test cu 1000 rows
    // 2. Pornește batchCopy (dar NU applyChangelog)
    // 3. Inserează 200 rows + update 100 rows + delete 50 rows
    // 4. Rulează applyChangelog
    // 5. Verifică: ghost table are 1150 rows (1000 + 200 - 50)
    // 6. Verifică: cele 100 updated rows au valorile corecte
  });

  // ═══ Scenario 6: DDL on empty table ═══
  it('should handle DDL on empty table without errors', async () => {
    // Edge case: ghost DDL pe tabel gol
  });

  // ═══ Scenario 7: DDL on table with JSONB, arrays, custom types ═══
  it('should preserve JSONB and array data through migration', async () => {
    // Verifică că datele complexe (JSONB, TEXT[], etc.) supraviețuiesc swap-ului
  });
});
```

**Notă:** Aceste teste necesită o bază de date PostgreSQL reală (nu mock).
Configurează un database de test dedicat în CI/CD.

---

### TASK 17.2 — Sandbox Penetration Tests

**Creează:** `extensions/developer/edge-functions/engine/tests/sandbox.security.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { runFunction } from '../sandbox.js';

const dummyRequest = new Request('http://test.local/fn/test', { method: 'POST' });

describe('Edge Function Sandbox — Security Tests', () => {

  // ═══ SSRF Tests ═══
  it('should block fetch to localhost', async () => {
    const result = await runFunction(
      `export default async (ctx) => {
        const r = await fetch('http://localhost:5432');
        return new Response('SHOULD NOT REACH HERE');
      }`,
      dummyRequest, {}, 5000,
    );
    expect(result.status).not.toBe(200);
    expect(result.error).toContain('blocked');
  });

  it('should block fetch to AWS metadata', async () => {
    const result = await runFunction(
      `export default async (ctx) => {
        const r = await fetch('http://169.254.169.254/latest/meta-data/');
        return new Response(await r.text());
      }`,
      dummyRequest, {}, 5000,
    );
    expect(result.status).not.toBe(200);
    expect(result.error).toContain('blocked');
  });

  it('should block fetch to private networks', async () => {
    const urls = [
      'http://10.0.0.1', 'http://172.16.0.1', 'http://192.168.1.1',
      'http://127.0.0.1:3000', 'http://0.0.0.0:8080',
    ];
    for (const url of urls) {
      const result = await runFunction(
        `export default async (ctx) => { await fetch('${url}'); return new Response('fail'); }`,
        dummyRequest, {}, 5000,
      );
      expect(result.error).toContain('blocked');
    }
  });

  it('should ALLOW fetch to public URLs', async () => {
    const result = await runFunction(
      `export default async (ctx) => {
        // Nu facem fetch real în test, doar verificăm că NU aruncă eroare de blocare
        return new Response('ok');
      }`,
      dummyRequest, {}, 5000,
    );
    expect(result.status).toBe(200);
  });

  // ═══ Prototype Pollution / Escape Tests ═══
  it('should block constructor.constructor escape', async () => {
    const result = await runFunction(
      `export default async (ctx) => {
        try {
          const p = constructor.constructor('return process')();
          return new Response(JSON.stringify(Object.keys(p.env)));
        } catch(e) {
          return new Response('BLOCKED: ' + e.message, { status: 403 });
        }
      }`,
      dummyRequest, {}, 5000,
    );
    // Trebuie să eșueze SAU să returneze 403, NU să returneze env vars
    expect(result.body).not.toContain('DATABASE_URL');
    expect(result.body).not.toContain('SECRET');
  });

  it('should block access to process object', async () => {
    const result = await runFunction(
      `export default async (ctx) => {
        return new Response(typeof process);
      }`,
      dummyRequest, {}, 5000,
    );
    expect(result.body).toBe('undefined');
  });

  it('should block access to Bun global', async () => {
    const result = await runFunction(
      `export default async (ctx) => {
        return new Response(typeof Bun);
      }`,
      dummyRequest, {}, 5000,
    );
    expect(result.body).toBe('undefined');
  });

  it('should block access to require', async () => {
    const result = await runFunction(
      `export default async (ctx) => {
        try {
          const fs = require('fs');
          return new Response('SHOULD NOT REACH');
        } catch(e) {
          return new Response('BLOCKED');
        }
      }`,
      dummyRequest, {}, 5000,
    );
    expect(result.body).toBe('BLOCKED');
  });

  // ═══ Resource Exhaustion Tests ═══
  it('should kill function that exceeds timeout', async () => {
    const result = await runFunction(
      `export default async (ctx) => {
        while(true) {} // Infinite loop
        return new Response('never');
      }`,
      dummyRequest, {}, 1000, // 1s timeout
    );
    expect(result.status).toBe(504);
    expect(result.error).toContain('timed out');
  });

  it('should handle recursive stack overflow', async () => {
    const result = await runFunction(
      `export default async (ctx) => {
        function bomb() { bomb(); }
        bomb();
        return new Response('never');
      }`,
      dummyRequest, {}, 2000,
    );
    expect(result.status).toBe(500);
  });

  // ═══ Data Exfiltration Tests ═══
  it('should not expose env variables from parent process', async () => {
    const result = await runFunction(
      `export default async (ctx) => {
        return new Response(JSON.stringify(ctx.env));
      }`,
      dummyRequest,
      { SAFE_VAR: 'allowed' }, // Doar variabilele explicit pasate
      5000,
    );
    const parsed = JSON.parse(result.body);
    expect(parsed).toEqual({ SAFE_VAR: 'allowed' });
    expect(parsed.DATABASE_URL).toBeUndefined();
    expect(parsed.SECRET_KEY).toBeUndefined();
  });
});
```

---

### TASK 17.3 — Casbin Stress & Lockout Tests

**Creează:** `packages/engine/src/tests/stress/casbin.stress.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('Casbin RBAC — Stress & Lockout Tests', () => {

  // ═══ God Bypass Durability ═══
  it('god user should have access even with ALL policies deleted', async () => {
    // 1. Creează user cu role='god'
    // 2. DELETE FROM zvd_permissions;
    // 3. Invalidate all caches
    // 4. Verifică: checkPermission(godUser, 'anything', 'anything') === true
    // 5. Verifică: checkPermission(normalUser, 'anything', 'anything') === false
  });

  it('god user should have access even with conflicting deny policies', async () => {
    // 1. Creează user cu role='god'
    // 2. Adaugă politică explicită de deny (dacă Casbin suportă)
    // 3. Verifică: god user ÎNCĂ are acces (bypass e ÎNAINTE de Casbin)
  });

  // ═══ Performance sub Load ═══
  it('should handle 1000 permission checks per second', async () => {
    // 1. Creează 100 politici
    // 2. Rulează 1000 checkPermission() în paralel
    // 3. Verifică: toate completate < 2 secunde
    // 4. Verifică: toate răspunsurile corecte
  });

  it('should handle concurrent policy updates + permission checks', async () => {
    // 1. Pornește 100 permission checks
    // 2. Simultan, adaugă/șterge politici
    // 3. Verifică: nicio eroare thrown
    // 4. Verifică: cache-ul se invalidează corect
  });

  // ═══ Cache Consistency ═══
  it('should invalidate cache when policy changes', async () => {
    // 1. checkPermission(user, 'res', 'read') → false (no policy)
    // 2. Adaugă politică: user can read res
    // 3. invalidateUserPermCache(userId)
    // 4. checkPermission(user, 'res', 'read') → true
  });

  it('should handle Redis unavailability gracefully', async () => {
    // 1. Mock Redis to throw on all operations
    // 2. Verifică: checkPermission() ÎNCĂ funcționează (fallback pe Casbin direct)
    // 3. Verifică: nu aruncă excepții
  });
});
```

---

# ═══════════════════════════════════════════════════════════
# NOTA IMPORTANTĂ PENTRU AI (Claude Code / Cursor / Cline)
# ═══════════════════════════════════════════════════════════

**ATENȚIE — NU IMPLEMENTA ACESTE FAZE (sunt deja complete și funcționale):**

| Fază | Ce există deja | De ce NU trebuie atins |
|------|---------------|----------------------|
| **Faza 1** | CDC Listener (Logical Replication) + Redis Pub/Sub + SSE + WebSocket | Superior față de pg_notify simplu |
| **Faza 2** | FlowScheduler cu 6 step types + node-cron + run logging | Executor complet, nu doar scheduler |
| **Faza 3** | Schema-per-tenant cu provisionare, environments, cache Redis | NU RLS cu SET LOCAL — schema isolation e mai sigur |
| **Faza 5** | GhostDDL complet + integrat în schema-branches merge | 4 pași: createGhost → batchCopy → applyChangelog → atomicSwap |
| **Faza 11** | LocalStore (IndexedDB) + SyncManager + /api/sync push/pull | Conflict detection, reconnect, subscribe |

**FAZE V4 NOI (15–17) — TREBUIE EXECUTATE:**

| Fază | Ce adaugă | Prioritate |
|------|-----------|------------|
| **Faza 15** | Sandbox hardening (Anti-SSRF, memory limit, prototype pollution, god bypass) | 🔴 CRITICĂ — securitate |
| **Faza 16** | AI Semantic Search, Auto-Embed Hook, AI Decision Step în Flows | 🟡 IMPORTANTĂ — funcționalitate AI |
| **Faza 17** | Test suite (Ghost DDL fuzz, Sandbox pen test, Casbin stress) | 🟡 IMPORTANTĂ — calitate |

**Dacă rescrii modulele din fazele protejate (1,2,3,5,11), vei distruge funcționalitate existentă superioară.**
