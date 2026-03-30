# Zveltio — Instrucțiuni Complete pentru Claude Code
> Analiză de arhitectură + refactoring plan + implementare pas cu pas

---

## CONTEXT ȘI FILOZOFIE

Zveltio este un BaaS self-hosted ambițios cu stack Bun + Hono + Kysely + Better-Auth + Casbin + PostgreSQL.
Codul are fundații solide (Ghost DDL, RBAC, AI native) dar acumulat datorii tehnice și inconsistențe arhitecturale.
**Regula de aur:** nu adăugăm features noi înainte să stabilizăm ce există.

---

## BLOC 1 — REFACTORING ARHITECTURAL: ZONES / PAGES / VIEWS

### Problema actuală
Navigația Studio conține `Pages`, `Portal Builder` și `Client Portal` ca entități separate fără relație clară.
Tabelele `zvd_portal_pages`, `zvd_portal_sections`, `zvd_portal_theme`, `zvd_collection_views` sunt fragmentate și inconsistente.

### Modelul nou (3 straturi)

```
Collections → Views → Pages → Zones
```

- **View** = bloc atomic reutilizabil: din ce colecție vine, ce câmpuri, ce filtre, ce tip de randare
- **Page** = container de Views cu slug, titlu, icon, ordine
- **Zone** = portal complet (Client, Intranet, etc.) cu propriile pagini, acces pe roluri, branding

### Task 1.1 — Crează migration `060_zones_pages_views.sql`

**Path:** `packages/engine/src/db/migrations/sql/060_zones_pages_views.sql`

```sql
-- ═══════════════════════════════════════════════════════════════
-- Migration 060: Zones / Pages / Views — arhitectura unificată de portale
-- Înlocuiește: zvd_portal_pages, zvd_portal_sections, zvd_portal_theme,
--              zvd_collection_views, zvd_portal_client_config
-- ═══════════════════════════════════════════════════════════════

-- STRATUL 1: Views — blocuri atomice reutilizabile
CREATE TABLE IF NOT EXISTS zvd_views (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        REFERENCES zv_tenants(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  description  TEXT,
  collection   TEXT        NOT NULL,
  view_type    TEXT        NOT NULL DEFAULT 'table'
                 CHECK (view_type IN ('table','kanban','calendar','gallery','stats','chart','list','timeline')),
  fields       JSONB       NOT NULL DEFAULT '[]',
  filters      JSONB       NOT NULL DEFAULT '[]',
  sort_field   TEXT,
  sort_dir     TEXT        DEFAULT 'desc' CHECK (sort_dir IN ('asc','desc')),
  page_size    INT         DEFAULT 20,
  config       JSONB       NOT NULL DEFAULT '{}',
  is_public    BOOLEAN     NOT NULL DEFAULT false,
  created_by   TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zvd_views_collection ON zvd_views(collection);
CREATE INDEX IF NOT EXISTS idx_zvd_views_tenant     ON zvd_views(tenant_id);

-- STRATUL 2: Zones — portaluri complete
CREATE TABLE IF NOT EXISTS zvd_zones (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        REFERENCES zv_tenants(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  slug           TEXT        NOT NULL,
  description    TEXT,
  is_active      BOOLEAN     NOT NULL DEFAULT false,
  access_roles   TEXT[]      NOT NULL DEFAULT '{}',
  base_path      TEXT        NOT NULL,
  -- Branding per-zonă
  site_name      TEXT,
  site_logo_url  TEXT,
  primary_color  TEXT        DEFAULT '#069494',
  secondary_color TEXT,
  custom_css     TEXT,
  nav_position   TEXT        DEFAULT 'sidebar' CHECK (nav_position IN ('sidebar','topbar','both')),
  show_breadcrumbs BOOLEAN   DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_zvd_zones_slug   ON zvd_zones(slug);
CREATE INDEX IF NOT EXISTS idx_zvd_zones_tenant ON zvd_zones(tenant_id);

-- STRATUL 3: Pages — container de views, aparține unei Zone
CREATE TABLE IF NOT EXISTS zvd_pages (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        REFERENCES zv_tenants(id) ON DELETE CASCADE,
  zone_id       UUID        NOT NULL REFERENCES zvd_zones(id) ON DELETE CASCADE,
  parent_id     UUID        REFERENCES zvd_pages(id) ON DELETE SET NULL,
  title         TEXT        NOT NULL,
  slug          TEXT        NOT NULL,
  icon          TEXT,
  description   TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  is_homepage   BOOLEAN     NOT NULL DEFAULT false,
  auth_required BOOLEAN     NOT NULL DEFAULT true,
  allowed_roles TEXT[]      NOT NULL DEFAULT '{}',
  sort_order    INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (zone_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_zvd_pages_zone   ON zvd_pages(zone_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_zvd_pages_tenant ON zvd_pages(tenant_id);

-- Joncțiune Page ↔ View (M:N — un view poate apărea pe mai multe pagini)
CREATE TABLE IF NOT EXISTS zvd_page_views (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         UUID NOT NULL REFERENCES zvd_pages(id) ON DELETE CASCADE,
  view_id         UUID NOT NULL REFERENCES zvd_views(id) ON DELETE CASCADE,
  title_override  TEXT,
  col_span        INT  DEFAULT 12 CHECK (col_span BETWEEN 1 AND 12),
  sort_order      INT  DEFAULT 0,
  config_override JSONB DEFAULT '{}',
  UNIQUE (page_id, view_id)
);

CREATE INDEX IF NOT EXISTS idx_zvd_page_views_page ON zvd_page_views(page_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_zvd_page_views_view ON zvd_page_views(view_id);

-- ═══ MIGRARE DATE EXISTENTE ═══════════════════════════════════

-- Migrează zvd_collection_views → zvd_views
INSERT INTO zvd_views (id, name, collection, view_type, fields, filters, config, created_at, updated_at)
SELECT
  id,
  COALESCE(name, 'View ' || id::text),
  collection_name,
  COALESCE(view_type, 'table'),
  COALESCE(config->'fields', '[]'::jsonb),
  COALESCE(config->'filters', '[]'::jsonb),
  COALESCE(config, '{}'),
  COALESCE(created_at, NOW()),
  COALESCE(updated_at, NOW())
FROM zvd_collection_views
ON CONFLICT (id) DO NOTHING;

-- Creează zona "client" din configurația existentă
INSERT INTO zvd_zones (name, slug, description, is_active, base_path, site_name, primary_color, nav_position)
VALUES ('Client Portal', 'client', 'Portal pentru clienți externi', false, '/portal/client', 'Client Portal', '#069494', 'sidebar')
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- Creează zona "intranet" default
INSERT INTO zvd_zones (name, slug, description, is_active, base_path, access_roles, site_name, nav_position)
VALUES ('Intranet', 'intranet', 'Portal intern pentru angajați', false, '/intranet', ARRAY['employee','manager'], 'Intranet', 'sidebar')
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- Migrează zvd_portal_pages → zvd_pages (în zona client)
INSERT INTO zvd_pages (id, zone_id, title, slug, icon, is_active, auth_required, sort_order, created_at, updated_at)
SELECT
  p.id,
  (SELECT id FROM zvd_zones WHERE slug = 'client' LIMIT 1),
  COALESCE(p.title, 'Page'),
  COALESCE(p.slug, 'page-' || p.id::text),
  p.icon,
  COALESCE(p.is_active, true),
  COALESCE(p.auth_required, true),
  COALESCE(p.sort_order, 0),
  COALESCE(p.created_at, NOW()),
  COALESCE(p.updated_at, NOW())
FROM zvd_portal_pages p
ON CONFLICT DO NOTHING;

-- DOWN (pentru rollback)
-- DROP TABLE IF EXISTS zvd_page_views;
-- DROP TABLE IF EXISTS zvd_pages;
-- DROP TABLE IF EXISTS zvd_zones;
-- DROP TABLE IF EXISTS zvd_views;
```

### Task 1.2 — Crează migration `061_deprecate_old_portal_tables.sql`

**Path:** `packages/engine/src/db/migrations/sql/061_deprecate_old_portal_tables.sql`

```sql
-- Migration 061: Deprecare tabele portal vechi
-- Rulat după 060 — elimină tabelele înlocuite de Zones/Pages/Views

-- Redenumire pentru backward compat (nu DROP imediat, pentru safety)
ALTER TABLE IF EXISTS zvd_portal_pages    RENAME TO _deprecated_portal_pages;
ALTER TABLE IF EXISTS zvd_portal_sections RENAME TO _deprecated_portal_sections;
ALTER TABLE IF EXISTS zvd_collection_views RENAME TO _deprecated_collection_views;

-- zvd_portal_theme devine câmpuri pe zvd_zones — tabelul se poate dropa
DROP TABLE IF EXISTS zvd_portal_theme CASCADE;

-- DOWN
-- ALTER TABLE IF EXISTS _deprecated_portal_pages    RENAME TO zvd_portal_pages;
-- ALTER TABLE IF EXISTS _deprecated_portal_sections RENAME TO zvd_portal_sections;
-- ALTER TABLE IF EXISTS _deprecated_collection_views RENAME TO zvd_collection_views;
```

### Task 1.3 — Crează routes pentru Zones/Pages/Views

**Path:** `packages/engine/src/routes/zones.ts`

Implementează următoarele endpoint-uri:

```
# Admin (require god/admin role)
GET    /api/zones                              → lista zonelor
POST   /api/zones                             → creare zonă
GET    /api/zones/:slug                        → detalii zonă
PUT    /api/zones/:slug                        → update zonă
DELETE /api/zones/:slug                        → ștergere zonă

GET    /api/zones/:slug/pages                  → paginile unei zone (cu ordinea)
POST   /api/zones/:slug/pages                  → adaugă pagină în zonă
PUT    /api/zones/:slug/pages/:pageSlug        → update pagină
DELETE /api/zones/:slug/pages/:pageSlug        → șterge pagină
POST   /api/zones/:slug/pages/reorder          → reordoneaza paginile

GET    /api/views                              → toate views-urile (cu paginare)
POST   /api/views                             → creare view
GET    /api/views/:id                          → detalii view
PUT    /api/views/:id                          → update view
DELETE /api/views/:id                          → ștergere view

GET    /api/zones/:slug/pages/:pageSlug/views  → views pe o pagină
POST   /api/zones/:slug/pages/:pageSlug/views  → adaugă view pe pagină
DELETE /api/zones/:slug/pages/:pageSlug/views/:viewId → scoate view din pagină
PUT    /api/zones/:slug/pages/:pageSlug/views/reorder → reordoneaza

# Public render (respectă auth_required și access_roles)
GET    /api/zones/:slug/render                 → navigație + theme zonă
GET    /api/zones/:slug/render/:pageSlug       → pagina cu views-urile rezolvate + date
```

**Reguli de implementare:**
- Toate endpoint-urile admin verifică permisiunile via `checkPermission(userId, 'admin', '*')`
- Endpoint-urile public `/render` verifică `auth_required` al paginii și `access_roles` ale zonei
- Datele din views (câmpurile, filtrele, sortarea) se aplică la query-ul pe colecție în timp real
- Răspunsul `/render/:pageSlug` include: `{ page, zone, views: [{ definition, data: { records, pagination } }] }`

### Task 1.4 — Înregistrează routes în `packages/engine/src/routes/index.ts`

Adaugă după routes existente:
```typescript
import { zonesRoutes } from './zones.js';
// ...
app.route('/api/zones', zonesRoutes(db, auth));
app.route('/api/views', viewsRoutes(db, auth)); // sau integrat în zones.ts
```

### Task 1.5 — Restructurează navigația Studio

**Path:** `packages/studio/src/routes/(admin)/+layout.svelte`

Înlocuiește grupurile `Content & Data` și elementele portal cu:

```javascript
{
  label: 'Content & Data',
  items: [
    { href: `${base}/collections`, icon: Database,    label: 'Collections' },
    { href: `${base}/views`,       icon: Layout,      label: 'Views'       }, // NOU — înlocuiește Pages+Portal
    { href: `${base}/media`,       icon: Images,      label: 'Media'       },
  ]
},
{
  label: 'Portals & Zones',
  items: [
    { href: `${base}/zones`,       icon: LayoutGrid,  label: 'Zones'       }, // NOU — înlocuiește Portal Builder + Client Portal
  ]
},
```

**Elimină din navigație:**
- `Pages` (ca entitate independentă — devine sub-secțiune a unei Zone)
- `Portal Builder`
- `Client Portal`

### Task 1.6 — Crează paginile Studio noi

**`/packages/studio/src/routes/(admin)/views/+page.svelte`**
- Listează toate views-urile cu coloanele: Nume, Colecție, Tip, Creat de
- Buton "New View" → formular: selectează colecție, tip (table/kanban/calendar/gallery/stats/chart), configurează câmpuri/filtre
- Previzualizare live a view-ului în modal

**`/packages/studio/src/routes/(admin)/zones/+page.svelte`**
- Listează zonele cu statusul (activ/inactiv), numărul de pagini, base_path
- Click pe o zonă → pagina de management a zonei

**`/packages/studio/src/routes/(admin)/zones/[slug]/+page.svelte`**
- Tab-uri: Pages | Access | Branding
- **Pages tab:** drag-and-drop reordering, adăugare pagini, sub-pagini (ierarhie), assignare Views pe fiecare pagină
- **Access tab:** setare `access_roles` și `is_active`
- **Branding tab:** `site_name`, `primary_color`, `nav_position`, `custom_css`

---

## BLOC 2 — TYPESCRIPT TYPE SAFETY (eliminare `as any`)

### Problema
Kysely este folosit ca query builder type-safe dar codul este plin de `.insertInto('table' as any)`, `.selectFrom('zv_x' as any)` etc. Asta anulează beneficiul principal.

### Task 2.1 — Generează tipurile Kysely pentru tabelele noi

**Path:** `packages/engine/src/db/types.ts`

Adaugă interfețele pentru tabelele noi și asigură-te că **toate** tabelele din DB au un tip corespunzător:

```typescript
export interface ZvdView {
  id: string;
  tenant_id: string | null;
  name: string;
  description: string | null;
  collection: string;
  view_type: 'table' | 'kanban' | 'calendar' | 'gallery' | 'stats' | 'chart' | 'list' | 'timeline';
  fields: unknown; // JSONB
  filters: unknown; // JSONB
  sort_field: string | null;
  sort_dir: 'asc' | 'desc' | null;
  page_size: number;
  config: unknown; // JSONB
  is_public: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ZvdZone {
  id: string;
  tenant_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  is_active: boolean;
  access_roles: string[];
  base_path: string;
  site_name: string | null;
  site_logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  custom_css: string | null;
  nav_position: 'sidebar' | 'topbar' | 'both';
  show_breadcrumbs: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ZvdPage {
  id: string;
  tenant_id: string | null;
  zone_id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  icon: string | null;
  description: string | null;
  is_active: boolean;
  is_homepage: boolean;
  auth_required: boolean;
  allowed_roles: string[];
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface ZvdPageView {
  id: string;
  page_id: string;
  view_id: string;
  title_override: string | null;
  col_span: number;
  sort_order: number;
  config_override: unknown;
}

// Adaugă la interfața Database existentă:
export interface Database {
  // ... existente ...
  zvd_views: ZvdView;
  zvd_zones: ZvdZone;
  zvd_pages: ZvdPage;
  zvd_page_views: ZvdPageView;
}
```

### Task 2.2 — Elimină `as any` din routes critice

**Prioritate 1 — `packages/engine/src/routes/data.ts`:**
- Înlocuiește toate `.selectFrom('zvd_*' as any)` cu tipurile corespunzătoare
- Înlocuiește `.insertInto('zv_api_keys' as any)` → `.insertInto('zv_api_keys')`
- Păstrează `as any` temporar DOAR pentru tabele care nu au încă tip definit, cu comentariu `// TODO: add type`

**Prioritate 2 — `packages/engine/src/routes/admin.ts`:**
- Toate query-urile pe `zv_api_keys`, `zv_roles`, `zvd_permissions`

**Prioritate 3 — `packages/engine/src/routes/zones.ts` (fișier nou):**
- Scrie de la zero cu tipuri complete — nu folosi `as any` deloc

---

## BLOC 3 — SECURITATE MULTI-TENANCY

### Problema
`withTenantIsolation()` există și funcționează, dar nimic nu forțează folosirea lui. Un developer poate folosi `db` direct și izolarea se rupe silențios.

### Task 3.1 — Middleware enforcement în route handlers

**Path:** `packages/engine/src/middleware/tenant-guard.ts`

Crează un middleware care verifică dacă request-ul are context de tenant și, dacă da, setează automat `c.set('db', tenantTrx)`:

```typescript
export async function tenantDbMiddleware(c: Context, next: Next): Promise<Response | void> {
  const tenant = c.get('tenant');
  if (!tenant) {
    // No tenant context — use regular db, skip isolation
    return next();
  }

  // Wrap entire request în withTenantIsolation
  return withTenantIsolation(tenant.id, async (trx) => {
    c.set('db', trx); // route handlers folosesc c.get('db'), nu db direct
    return next();
  });
}
```

**Aplică middleware-ul în `routes/index.ts`** pe toate rutele `/api/data/*` și `/api/zones/*`.

### Task 3.2 — Audit pentru funcția `setCurrentTenant`

Caută în tot codebase-ul orice referință la `setCurrentTenant` și înlocuiește cu `withTenantIsolation`. Funcția deprecated trebuie să rămână (aruncă eroarea), dar nu trebuie apelată nicăieri.

---

## BLOC 4 — EXTENSII: PERMISIUNI ȘI AUDIT

### Problema
Extensiile primesc acces direct la `app` (Hono), `db` și `auth` fără restricții. O extensie malițioasă are acces complet la baza de date.

### Task 4.1 — Context restricționat pentru extensii

**Path:** `packages/engine/src/lib/extension-context.ts`

Crează un wrapper care limitează ce poate face o extensie:

```typescript
export interface ExtensionContext {
  // DB — doar tabele cu prefixul extensiei sau zvd_* (nu zv_* interne)
  db: RestrictedDb;
  // Auth — doar verificare sesiune, nu modificare
  auth: Pick<typeof auth, 'api'>;
  // Events — poate emite, nu poate asculta toate evenimentele
  events: Pick<EventEmitter, 'emit'>;
  // Field types — poate înregistra noi tipuri
  fieldTypeRegistry: FieldTypeRegistry;
  // Logger — nu console.log direct
  logger: ExtensionLogger;
  // Config — configurația extensiei (nu alte extensii)
  config: Record<string, unknown>;
}

// RestrictedDb blochează query-urile pe tabele zv_* (sistem intern)
export function createRestrictedDb(db: Database, extensionName: string): RestrictedDb {
  // Proxy care interceptează selectFrom/insertInto/updateTable/deleteFrom
  // și aruncă eroare dacă tabelul este un tabel de sistem (prefix zv_ fără zvd_)
}
```

### Task 4.2 — Audit trail pentru acțiunile extensiilor

Modifică `ExtensionLoader.loadDynamic()` să înregistreze în `zv_audit_log`:
- Când o extensie este încărcată/dezactivată
- Ce rute înregistrează
- Orice eroare în timpul execuției

---

## BLOC 5 — CONTENT SECURITY POLICY

### Problema
Studio folosește `unsafe-inline` în CSP datorită limitărilor SvelteKit static export.

### Task 5.1 — Evaluează migrarea Studio la SSR

**Cercetează și documentează** (nu implementa deocamdată) costul migrării Studio de la `@sveltejs/adapter-static` la `@sveltejs/adapter-node`. SSR ar permite:
- Nonce-based CSP (elimină `unsafe-inline`)
- Server-side rendering pentru pagini mari
- Streaming responses

Creează fișierul `docs/STUDIO_SSR_MIGRATION.md` cu analiza.

### Task 5.2 — Hardening CSP temporar (fără SSR)

Până la migrarea la SSR, adaugă în `packages/engine/src/index.ts` la middleware-ul `/admin/*`:

```typescript
// Adaugă trusted-types pentru a limita suprafața de atac
// chiar dacă unsafe-inline este necesar pentru SvelteKit
'Content-Security-Policy': [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'", // necesar SvelteKit — urmărire pentru eliminare
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",          // previne clickjacking
  "base-uri 'self'",                 // previne base tag injection
  "form-action 'self'",
].join('; ')
```

---

## BLOC 6 — ROLUL GOD ȘI AUDIT

### Problema
Rolul `god` bypass-ează toate verificările Casbin fără audit trail dedicat.

### Task 6.1 — Audit trail pentru acțiunile god

**Path:** `packages/engine/src/middleware/god-audit.ts`

```typescript
// Middleware care loghează în zv_audit_log orice acțiune a unui user cu rol 'god'
export async function godAuditMiddleware(c: Context, next: Next) {
  const user = c.get('user');
  if (user?.role === 'god') {
    const start = Date.now();
    await next();
    // Log async — nu blochează response
    logGodAction(c, user, Date.now() - start).catch(console.error);
  } else {
    await next();
  }
}
```

Aplică middleware-ul pe toate rutele `/api/*`.

### Task 6.2 — Rate limiting separat pentru god

În `packages/engine/src/routes/index.ts`, adaugă rate limiting strict pentru endpoint-urile distructive (DELETE, DROP) chiar și pentru god:

```typescript
const destructiveRateLimit = rateLimiter({ max: 10, window: '1m' }); // max 10 delete/min
app.on(['DELETE'], '/api/collections/*', destructiveRateLimit);
app.on(['DELETE'], '/api/data/*', destructiveRateLimit);
```

---

## BLOC 7 — WEBHOOK WORKER: EXTENSII HOT-UNLOAD

### Problema
Extensiile hot-loaded rămân active în memorie după disable. `this.loaded` Map crește fără cleanup.

### Task 7.1 — Hot-unload extensii

**Path:** `packages/engine/src/lib/extension-loader.ts`

Adaugă metodă `unload(name: string)`:

```typescript
async unload(name: string): Promise<void> {
  const ext = this.loaded.get(name);
  if (!ext) return;
  
  // Dacă extensia expune cleanup function
  if (ext.cleanup && typeof ext.cleanup === 'function') {
    await ext.cleanup().catch(console.error);
  }
  
  // Elimină rutele înregistrate de extensie (Hono nu suportă asta direct —
  // necesită restart sau pattern cu prefix dedicat extensiei)
  this.loaded.delete(name);
  console.log(`🔌 Extension unloaded: ${name}`);
}
```

**Notă pentru implementare:** Hono nu permite de-înregistrare de rute la runtime. Documentează această limitare în cod și adaugă `needs_restart: true` la disable dacă extensia a înregistrat rute. Dacă extensia a înregistrat doar middleware/handlers pe prefix dedicat, poate fi simulat un unload prin flag.

---

## BLOC 8 — SDK TYPE GENERATION

### Problema
Codul din `packages/sdk/` nu beneficiază de tipurile colecțiilor dinamice. Developer-ul care folosește SDK-ul nu are autocompletion.

### Task 8.1 — Generare tipuri din colecții

**Path:** `packages/sdk/src/generate-types.ts`

Implementează un generator care, dat un endpoint Zveltio, generează un fișier `.d.ts`:

```typescript
// Exemplu output generat:
export interface ProductsCollection {
  id: string;
  name: string;
  price: number;
  category: string;
  created_at: string;
  updated_at: string;
}

export interface ZveltioCollections {
  products: ProductsCollection;
  orders: OrdersCollection;
  // ...
}
```

Comanda CLI existentă `zveltio generate-types --output ./types/zveltio.d.ts` trebuie să apeleze acest generator.

---

## BLOC 9 — FLOWS: VALIDARE STEPS

### Problema
`zv_flow_steps` are tipuri de steps (`run_script`, `send_email`, etc.) dar configurația (`config JSONB`) nu este validată la creare.

### Task 9.1 — Zod schemas pentru fiecare tip de step

**Path:** `packages/engine/src/lib/flow-step-schemas.ts`

```typescript
import { z } from 'zod';

export const stepSchemas = {
  run_script: z.object({
    script: z.string().min(1),
    timeout_ms: z.number().int().max(30_000).default(5000),
  }),
  send_email: z.object({
    to: z.string().email().or(z.string().startsWith('{{')),
    subject: z.string().min(1),
    body: z.string().min(1),
    from: z.string().optional(),
  }),
  webhook: z.object({
    url: z.string().url().or(z.string().startsWith('{{')),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    headers: z.record(z.string()).default({}),
    body_template: z.string().optional(),
  }),
  condition: z.object({
    expression: z.string().min(1),
    true_branch: z.array(z.string().uuid()).default([]),
    false_branch: z.array(z.string().uuid()).default([]),
  }),
  delay: z.object({
    duration_ms: z.number().int().min(100).max(86_400_000),
  }),
  // ... etc
};

export function validateStepConfig(type: string, config: unknown): { valid: boolean; errors: string[] } {
  const schema = stepSchemas[type as keyof typeof stepSchemas];
  if (!schema) return { valid: false, errors: [`Unknown step type: ${type}`] };
  const result = schema.safeParse(config);
  return result.success 
    ? { valid: true, errors: [] }
    : { valid: false, errors: result.error.errors.map(e => e.message) };
}
```

Aplică validarea în `POST /api/flows/:id/steps`.

---

## BLOC 10 — GRAFANA DASHBOARDS ȘI OBSERVABILITATE

Există deja `grafana/dashboards/zveltio-webhooks.json`. Asigură-te că:

### Task 10.1 — Metrics pentru Zones/Views

Adaugă în `packages/engine/src/lib/telemetry.ts` (sau echivalent) counter-e pentru:
- `zone_render_requests_total{zone_slug, page_slug}` — câte render requests per pagină
- `view_query_duration_ms{view_id, collection}` — latența query-urilor de view
- `zone_access_denied_total{zone_slug, role}` — accesuri refuzate pe roluri

### Task 10.2 — Dashboard Grafana pentru Zones

Crează `grafana/dashboards/zveltio-zones.json` cu panel-uri pentru metricile de mai sus.

---

---

## BLOC 11 — CAUZA RĂDĂCINĂ A TUTUROR `as any`: TIPUL `Database`

### ⚠️ ACEASTA ESTE PRIORITATEA #1 — ÎNAINTE DE ORICE ALTCEVA

**Path:** `packages/engine/src/db/index.ts`

Linia actuală:
```typescript
export type Database = Kysely<any>;
```

Aceasta este cauza rădăcină a TUTUROR problemelor de tip-safety din proiect. `Kysely<any>` înseamnă că compilatorul TypeScript acceptă orice query, orice tabel, orice coloană — fără nicio verificare. De aceea tot codul a ajuns să folosească `as any`: nu era necesar, compilatorul nu verifica oricum nimic.

### Task 11.1 — Crează `packages/engine/src/db/schema.ts`

Acest fișier definește schema completă a bazei de date ca interfețe TypeScript. Kysely folosește aceste interfețe pentru a valida la compile-time că tabelele și coloanele există.

```typescript
// packages/engine/src/db/schema.ts
// Definiția completă a schemei DB pentru Kysely type-safety
// NICIODATĂ nu folosi `as any` în query-uri după ce acest fișier e activ.

import type { Generated, Insertable, Selectable, Updateable } from 'kysely';

// ─── Tabele sistem (prefix zv_) ───────────────────────────────

export interface ZvMigrationsTable {
  id: Generated<number>;
  name: string;
  ran_at: Generated<Date>;
}

export interface ZvCollectionsTable {
  id: Generated<string>;
  name: string;
  display_name: string | null;
  description: string | null;
  schema: unknown; // JSONB
  is_managed: boolean;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvApiKeysTable {
  id: Generated<string>;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: unknown; // JSONB — Array<{ collection: string; actions: string[] }>
  rate_limit: number;
  expires_at: Date | null;
  last_used_at: Date | null;
  is_active: boolean;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface ZvRolesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  created_at: Generated<Date>;
}

export interface ZvTenantsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise' | 'custom';
  status: 'active' | 'suspended' | 'deleted';
  max_records: number;
  max_storage_gb: number;
  max_api_calls_day: number;
  max_users: number;
  billing_email: string | null;
  trial_ends_at: Date | null;
  settings: unknown; // JSONB
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvTenantUsersTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  invited_by: string | null;
}

export interface ZvFlowsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  trigger_type: 'manual' | 'on_create' | 'on_update' | 'on_delete' | 'cron' | 'webhook';
  trigger_config: unknown; // JSONB
  trigger: unknown; // JSONB — câmpul folosit în routes/flows.ts
  is_active: boolean;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvFlowStepsTable {
  id: Generated<string>;
  flow_id: string;
  step_order: number;
  name: string;
  type: 'run_script' | 'send_email' | 'webhook' | 'query_db' | 'condition' | 'transform' | 'delay' | 'send_notification' | 'export_collection';
  config: unknown; // JSONB
  on_error: 'stop' | 'continue' | 'retry';
  created_at: Generated<Date>;
}

export interface ZvFlowRunsTable {
  id: Generated<string>;
  flow_id: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  trigger_data: unknown; // JSONB
  output: unknown; // JSONB
  error: string | null;
  started_at: Generated<Date>;
  finished_at: Date | null;
}

export interface ZvFlowDlqTable {
  id: Generated<string>;
  flow_id: string;
  payload: unknown; // JSONB
  error: string | null;
  created_at: Generated<Date>;
}

export interface ZvWebhooksTable {
  id: Generated<string>;
  name: string;
  url: string;
  method: 'POST' | 'PUT' | 'PATCH';
  events: unknown; // JSONB — string[]
  collections: unknown; // JSONB — string[]
  headers: unknown; // JSONB
  secret: string | null;
  is_active: boolean;
  retry_attempts: number;
  timeout: number;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvWebhookDeliveriesTable {
  id: Generated<string>;
  webhook_id: string;
  event: string;
  collection: string;
  payload: unknown; // JSONB
  response_status: number | null;
  response_body: string | null;
  duration_ms: number | null;
  attempt: number;
  success: boolean;
  error: string | null;
  created_at: Generated<Date>;
}

export interface ZvAiUsageTable {
  id: Generated<string>;
  provider: string;
  model: string;
  operation: string;
  prompt_tokens: number;
  response_tokens: number;
  latency_ms: number;
  user_id: string | null;
  created_at: Generated<Date>;
}

export interface ZvAiEmbeddingsTable {
  id: Generated<string>;
  collection: string;
  record_id: string;
  field_name: string;
  content: string;
  metadata: unknown; // JSONB — include embedding vector + model info
  updated_at: Generated<Date>;
}

export interface ZvExtensionRegistryTable {
  id: Generated<string>;
  name: string;
  display_name: string;
  description: string | null;
  category: string;
  version: string;
  author: string;
  is_installed: boolean;
  is_enabled: boolean;
  config: unknown; // JSONB
  installed_at: Date | null;
  enabled_at: Date | null;
}

export interface ZvDdlJobsTable {
  id: Generated<string>;
  table_name: string;
  ddl_statements: unknown; // JSONB — string[]
  status: 'pending' | 'running' | 'done' | 'failed';
  error: string | null;
  retry_count: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvAuditLogTable {
  id: Generated<string>;
  user_id: string | null;
  action: string;
  resource: string;
  resource_id: string | null;
  metadata: unknown; // JSONB
  ip: string | null;
  created_at: Generated<Date>;
}

// ─── Tabele Better-Auth (prefix user/session/account) ────────

export interface UserTable {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: string;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountTable {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  password: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionTable {
  id: string;
  expiresAt: Date;
  token: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Tabele portal noi (prefix zvd_) ─────────────────────────

export interface ZvdViewsTable {
  id: Generated<string>;
  tenant_id: string | null;
  name: string;
  description: string | null;
  collection: string;
  view_type: 'table' | 'kanban' | 'calendar' | 'gallery' | 'stats' | 'chart' | 'list' | 'timeline';
  fields: unknown; // JSONB
  filters: unknown; // JSONB
  sort_field: string | null;
  sort_dir: 'asc' | 'desc' | null;
  page_size: number;
  config: unknown; // JSONB
  is_public: boolean;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdZonesTable {
  id: Generated<string>;
  tenant_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  is_active: boolean;
  access_roles: string[];
  base_path: string;
  site_name: string | null;
  site_logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  custom_css: string | null;
  nav_position: 'sidebar' | 'topbar' | 'both';
  show_breadcrumbs: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdPagesTable {
  id: Generated<string>;
  tenant_id: string | null;
  zone_id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  icon: string | null;
  description: string | null;
  is_active: boolean;
  is_homepage: boolean;
  auth_required: boolean;
  allowed_roles: string[];
  sort_order: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ZvdPageViewsTable {
  id: Generated<string>;
  page_id: string;
  view_id: string;
  title_override: string | null;
  col_span: number;
  sort_order: number;
  config_override: unknown; // JSONB
}

// ─── Interfața completă a bazei de date ──────────────────────

export interface DbSchema {
  // Sistem
  zv_migrations: ZvMigrationsTable;
  zv_collections: ZvCollectionsTable;
  zv_api_keys: ZvApiKeysTable;
  zv_roles: ZvRolesTable;
  zv_tenants: ZvTenantsTable;
  zv_tenant_users: ZvTenantUsersTable;
  zv_flows: ZvFlowsTable;
  zv_flow_steps: ZvFlowStepsTable;
  zv_flow_runs: ZvFlowRunsTable;
  zv_flow_dlq: ZvFlowDlqTable;
  zv_webhooks: ZvWebhooksTable;
  zv_webhook_deliveries: ZvWebhookDeliveriesTable;
  zv_ai_usage: ZvAiUsageTable;
  zv_ai_embeddings: ZvAiEmbeddingsTable;
  zv_extension_registry: ZvExtensionRegistryTable;
  zv_ddl_jobs: ZvDdlJobsTable;
  zv_audit_log: ZvAuditLogTable;
  // Better-Auth
  user: UserTable;
  account: AccountTable;
  session: SessionTable;
  // Portal nou
  zvd_views: ZvdViewsTable;
  zvd_zones: ZvdZonesTable;
  zvd_pages: ZvdPagesTable;
  zvd_page_views: ZvdPageViewsTable;
  // Tabelele zvd_ dinamice (create de utilizator) NU pot fi tipizate static —
  // pentru ele se folosește în continuare db/dynamic.ts cu sql.id() și sql template literal
}

// Tipuri helper Kysely pentru CRUD complet tipizat
export type ZvCollectionRow = Selectable<ZvCollectionsTable>;
export type NewZvCollection = Insertable<ZvCollectionsTable>;
export type ZvCollectionUpdate = Updateable<ZvCollectionsTable>;

export type ZvApiKeyRow = Selectable<ZvApiKeysTable>;
export type NewZvApiKey = Insertable<ZvApiKeysTable>;

export type ZvdViewRow = Selectable<ZvdViewsTable>;
export type NewZvdView = Insertable<ZvdViewsTable>;
export type ZvdViewUpdate = Updateable<ZvdViewsTable>;

export type ZvdZoneRow = Selectable<ZvdZonesTable>;
export type NewZvdZone = Insertable<ZvdZonesTable>;
export type ZvdZoneUpdate = Updateable<ZvdZonesTable>;

export type ZvdPageRow = Selectable<ZvdPagesTable>;
export type NewZvdPage = Insertable<ZvdPagesTable>;
```

### Task 11.2 — Modifică `packages/engine/src/db/index.ts`

```typescript
// ÎNAINTE (cauza tuturor problemelor):
export type Database = Kysely<any>;

// DUPĂ:
import type { DbSchema } from './schema.js';
export type Database = Kysely<DbSchema>;
```

Aceasta este singura modificare în `index.ts`. Tot restul urmează automat.

### Task 11.3 — Elimină `as any` din TOT codul existent

După ce `Database = Kysely<DbSchema>`, compilatorul TypeScript va marca **automat** toate query-urile greșite cu erori. Rulează:

```bash
cd packages/engine && bun run typecheck 2>&1 | head -100
```

Vei vedea lista exactă a fișierelor și liniilor cu probleme. Rezolvă-le în această ordine:

**1. `src/routes/admin.ts`** — API keys, roles, audit
**2. `src/routes/data.ts`** — CRUD colecții
**3. `src/routes/flows.ts`** — flows, DLQ
**4. `src/routes/webhooks.ts`** — webhooks
**5. `src/lib/extension-loader.ts`** — marketplace
**6. `src/lib/ai-provider.ts`** și `src/routes/ai.ts`
**7. Toate celelalte fișiere** în ordinea erorilor

**Reguli pentru fiecare eroare:**
- Dacă tabelul lipsește din `DbSchema` → adaugă interfața în `schema.ts`, nu pune `as any`
- Dacă coloana lipsește dintr-o interfață → adaugă coloana
- Dacă e un tabel dinamic al utilizatorului (ex: `zvd_orders`) → folosește `db/dynamic.ts` cu `sql.raw()` sau `sql.id()`, nu Kysely typed queries (e corect, nu e o excepție)
- Dacă e cu adevărat imposibil de tipizat (ex: result de `sql.raw()`) → `as unknown` în loc de `as any`, cu comentariu explicativ

### Task 11.4 — Verificare finală

```bash
cd packages/engine && bun run typecheck
# Trebuie să returneze 0 erori

bun run build
# Trebuie să compileze fără erori

bun test
# Trebuie să treacă toate testele existente
```

**Notă importantă despre `db/dynamic.ts`:**
Fișierul `dynamic.ts` folosește `sql.raw()` și `sql.id()` în mod intenționat pentru tabelele create dinamic de utilizatori — acestea nu pot fi cunoscute la compile time. Acesta este singurul loc unde este acceptabil să nu avem tipuri Kysely complete. Comentariul existent în fișier explică deja asta corect.

---

## ORDINE DE IMPLEMENTARE RECOMANDATĂ

```
ZI 1 (inainte de orice altceva):
  BLOC 11 -- schema.ts + Database = Kysely<DbSchema> + typecheck fix
  Aceasta deblocheza tot restul. Fara asta, orice alta munca pe TypeScript e inutila.

Saptamana 1:
  BLOC 1 (Zones/Pages/Views) -- migration + backend routes
  BLOC 2 (TypeScript) -- COMPLETARE tipuri dupa Bloc 11 (tabelele noi)

Saptamana 2:
  BLOC 1 -- Studio pages (Views, Zones)
  BLOC 3 (Multi-tenancy middleware)

Saptamana 3:
  BLOC 6 (God audit trail)
  BLOC 9 (Flow step validation)
  BLOC 4 (Extension context restrictionat)

Saptamana 4:
  BLOC 8 (SDK type generation -- acum trivial dupa schema.ts)
  BLOC 5 (CSP + SSR analysis)
  BLOC 7 (Hot-unload)
  BLOC 10 (Metrics + Grafana)
```

---

---

## BLOC 12 — UX/UI: PROBLEME ȘI ÎMBUNĂTĂȚIRI

### 12.1 — `confirm()` și `alert()` native: ELIMINĂ COMPLET

**Problema — critică pentru credibilitate**
În tot codul Studio există `confirm(...)` și `alert(...)` native din browser. Acestea blochează UI-ul, au aspect de pagini web din 2005 și sunt inacceptabile pentru un tool enterprise.

Exemple găsite:
```javascript
if (!confirm('Delete this record?')) return;
if (!confirm(`Delete collection "${name}"? This cannot be undone.`)) return;
if (!confirm(`Disable "${ext.displayName}"?...`)) return;
alert(`Install failed: ${e.message}`);
alert(err?.message ?? 'Failed to delete collection');
```

**Soluția — modal de confirmare reutilizabil:**

Crează `packages/studio/src/lib/components/common/ConfirmModal.svelte`:

```svelte
<script lang="ts">
  interface Props {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    confirmClass?: string; // 'btn-error' | 'btn-warning' | 'btn-primary'
    onconfirm: () => void;
    oncancel: () => void;
  }
  let { open, title, message, confirmLabel = 'Confirm',
        confirmClass = 'btn-error', onconfirm, oncancel } = $props();
</script>

{#if open}
  <div class="modal modal-open">
    <div class="modal-box max-w-sm">
      <h3 class="font-bold text-lg">{title}</h3>
      <p class="py-4 text-sm text-base-content/70">{message}</p>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={oncancel}>Cancel</button>
        <button class="btn {confirmClass} btn-sm" onclick={onconfirm}>{confirmLabel}</button>
      </div>
    </div>
    <div class="modal-backdrop" onclick={oncancel}></div>
  </div>
{/if}
```

**Utilizare în loc de `confirm()`:**
```svelte
<ConfirmModal
  open={showDeleteModal}
  title="Delete collection"
  message={`Are you sure you want to delete "${name}"? This cannot be undone.`}
  confirmLabel="Delete"
  confirmClass="btn-error"
  onconfirm={handleDelete}
  oncancel={() => showDeleteModal = false}
/>
```

**Înlocuiește TOATE aparițiile de `confirm()` și `alert()` din:**
- `packages/studio/src/routes/(admin)/collections/+page.svelte`
- `packages/studio/src/routes/(admin)/collections/[name]/+page.svelte`
- `packages/studio/src/routes/(admin)/marketplace/+page.svelte`
- `packages/studio/src/routes/(admin)/portal/[id]/+page.svelte`
- Orice alt fișier din Studio care conține `confirm(` sau `alert(`

---

### 12.2 — Toast notifications: sistem unificat

**Problema**
Erorile sunt afișate inconsistent: uneori `error = e.message` în text roșu, uneori `alert()`, uneori silențios. Nu există un sistem unificat.

`ToastContainer.svelte` există deja în `$lib/components/common/` — dar nu este folosit consistent.

**Soluția — crează un store global de toasts și folosește-l peste tot:**

Crează `packages/studio/src/lib/stores/toast.svelte.ts`:
```typescript
type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

let toasts = $state<Toast[]>([]);

export function addToast(message: string, type: ToastType = 'info', duration = 4000) {
  const id = crypto.randomUUID();
  toasts = [...toasts, { id, type, message, duration }];
  if (duration > 0) setTimeout(() => removeToast(id), duration);
}

export function removeToast(id: string) {
  toasts = toasts.filter(t => t.id !== id);
}

export { toasts };

// Helpers
export const toast = {
  success: (msg: string) => addToast(msg, 'success'),
  error:   (msg: string) => addToast(msg, 'error', 6000),
  warning: (msg: string) => addToast(msg, 'warning'),
  info:    (msg: string) => addToast(msg, 'info'),
};
```

**Pattern de utilizare în loc de `error = e.message`:**
```javascript
// ÎNAINTE:
} catch (e: any) {
  error = e.message;
}

// DUPĂ:
import { toast } from '$lib/stores/toast.svelte.js';
} catch (e: any) {
  toast.error(e.message ?? 'Something went wrong');
}
```

---

### 12.3 — Skeleton screens în loc de spinners

**Problema**
Toate paginile folosesc `<LoaderCircle class="animate-spin">` în centrul paginii în timp ce datele se încarcă. Pentru liste mari (colecții, records) asta creează un flash dezagreabil.

**Soluția — skeleton loading pentru listele principale:**

Crează `packages/studio/src/lib/components/common/TableSkeleton.svelte`:
```svelte
<script lang="ts">
  let { rows = 5, cols = 3 } = $props();
</script>

<div class="space-y-2 animate-pulse">
  {#each Array(rows) as _}
    <div class="flex gap-4 items-center p-3 rounded-lg bg-base-200">
      {#each Array(cols) as _, i}
        <div class="h-4 bg-base-300 rounded flex-1" style="opacity: {1 - i * 0.2}"></div>
      {/each}
    </div>
  {/each}
</div>
```

Folosește `TableSkeleton` în:
- `collections/+page.svelte` (loading state)
- `collections/[name]/+page.svelte` (tab data)
- `users/+page.svelte`
- Orice pagină cu tabel și state `loading = true`

---

### 12.4 — Global Command Palette (Cmd+K)

**Problema**
Nu există navigație rapidă. Dacă adminul are 50 de colecții și vrea să deschidă una, trebuie să scroll-eze prin lista din sidebar sau să navigheze manual.

**Soluția — CommandPalette component:**

Crează `packages/studio/src/lib/components/common/CommandPalette.svelte`:
- Se deschide cu `Cmd+K` / `Ctrl+K`
- Caută prin: colecții, pagini admin (din nav), users, extensii active
- Rezultatele sunt afișate cu iconițe și navighează direct la click sau Enter
- Implementat ca modal cu input autofocused

```svelte
<!-- Structura de bază -->
<script lang="ts">
  import { collectionsApi } from '$lib/api.js';
  let open = $state(false);
  let query = $state('');

  // Keyboard shortcut
  function onKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      open = true;
    }
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:window onkeydown={onKeyDown} />
```

Adaugă `CommandPalette` în `+layout.svelte` o singură dată, la nivel de layout.

---

### 12.5 — Breadcrumbs lipsă

**Problema**
Paginile nested (ex: `Collections → orders → Fields`) nu au breadcrumbs. Userul nu știe unde se află.

Fișiere afectate:
- `collections/[name]/+page.svelte` — lipsesc breadcrumbs
- `collections/[name]/fields/+page.svelte` — lipsesc
- `collections/[name]/relations/+page.svelte` — lipsesc
- `portal/[id]/+page.svelte` — lipsesc
- `zones/[slug]/+page.svelte` (nou) — trebuie adăugate

**Soluția — component Breadcrumb simplu:**

Crează `packages/studio/src/lib/components/common/Breadcrumb.svelte`:
```svelte
<script lang="ts">
  interface Crumb { label: string; href?: string }
  let { crumbs }: { crumbs: Crumb[] } = $props();
</script>

<div class="text-sm breadcrumbs mb-4 text-base-content/50">
  <ul>
    {#each crumbs as crumb}
      <li>
        {#if crumb.href}
          <a href={crumb.href} class="hover:text-base-content transition-colors">{crumb.label}</a>
        {:else}
          <span class="text-base-content font-medium">{crumb.label}</span>
        {/if}
      </li>
    {/each}
  </ul>
</div>
```

Utilizare în `collections/[name]/fields/+page.svelte`:
```svelte
<Breadcrumb crumbs={[
  { label: 'Collections', href: `${base}/collections` },
  { label: collectionName, href: `${base}/collections/${collectionName}` },
  { label: 'Fields' }
]} />
```

---

### 12.6 — Navigația AI: consolidare

**Problema**
Grupul "Intelligence" din sidebar are 5 items separați:
- AI Assistant
- Schema Gen
- AI Query
- Alchemist
- Insights

Asta înseamnă 5 intrări în sidebar pentru un singur domeniu. Pe un ecran mic, sidebar-ul devine nefolosibil.

**Soluția — o singură pagină `/ai` cu tab-uri interne:**

```
/ai                    → AI hub cu tab-uri
  Tab: Chat            (fostul AI Assistant)
  Tab: Query           (fostul AI Query)  
  Tab: Schema Gen      (fostul Prompt-to-Schema)
  Tab: Alchemist       (fostul Alchemist)
  Tab: Insights        (fostul Insights — sau rămâne separat dacă e mai complex)
```

Navigația devine:
```javascript
{
  label: 'Intelligence',
  items: [
    { href: `${base}/ai`,       icon: Bot,      label: 'AI Studio'  }, // hub cu tab-uri
    { href: `${base}/insights`, icon: BarChart2, label: 'Insights'  }, // rămâne separat (dashboards complexe)
  ]
}
```

---

### 12.7 — Client Portal: navigație dinamică (aliniat cu Bloc 1)

**Problema critică**
Navigația Client Portal este **hardcodată** în cod pentru fiecare template:
```javascript
const genericNav = [...];
const regulatoryNav = [...];
const saasNav = [...];
const servicesNav = [...];
```

Asta înseamnă că dacă adminul adaugă o pagină în Zones/Client, ea NU apare automat în navigație. Trebuie modificat codul.

**Soluția — navigație dinamică din API (direct legată de Bloc 1):**

Modifică `packages/studio/src/routes/(client)/+layout.svelte` și `packages/studio/src/routes/(intranet)/+layout.svelte` să încarce navigația din API:

```javascript
// În loc de navItems hardcoded:
let navItems = $state<any[]>([]);

onMount(async () => {
  // Zona 'client' sau 'intranet' — din noul sistem Zones
  const res = await api.get('/api/zones/client/pages');
  navItems = (res.pages ?? [])
    .filter((p: any) => p.is_active)
    .map((p: any) => ({
      href: `${base}/portal-client/${p.slug}`,
      label: p.title,
      icon: p.icon, // icon name → rezolvat la render
    }));
});
```

Asta face navigația 100% configurabilă din Studio fără modificări de cod.

---

### 12.8 — Forms Extension: inconsistență styling

**Problema**
`extensions/forms/studio/src/pages/FormsPage.svelte` folosește CSS custom (`class="forms-page"`, `class="btn-primary"` din CSS propriu, `class="table-wrapper"`) în timp ce tot restul Studio-ului folosește DaisyUI + Tailwind.

**Soluția — rescrie FormsPage cu DaisyUI:**
- Înlocuiește `.btn-primary` → `class="btn btn-primary btn-sm"`
- Înlocuiește `.table-wrapper table` → `class="table table-sm w-full"`
- Înlocuiește `.empty-state` → pattern consistent cu restul paginilor
- Înlocuiește `.loading` → `<span class="loading loading-spinner">`
- Elimină orice `<style>` scoped care duplică stiluri DaisyUI

---

### 12.9 — Empty states: ghidare utilizator

**Problema**
Empty states actuale sunt minimale: "No collections yet" cu un buton generic. Nu ghidează userul nou.

**Pattern recomandat pentru empty states:**

```svelte
<!-- Good empty state — explică CE face featura + acțiunea principală -->
<div class="flex flex-col items-center justify-center py-20 text-center gap-4 max-w-sm mx-auto">
  <div class="p-5 rounded-2xl bg-base-200">
    <Database size={40} class="text-base-content/25" />
  </div>
  <div>
    <h3 class="font-semibold text-base-content">No collections yet</h3>
    <p class="text-sm text-base-content/50 mt-1">
      Collections are database tables. Create one to start storing data — 
      fields, types, and relations are all configurable.
    </p>
  </div>
  <button class="btn btn-primary btn-sm gap-2" onclick={openCreateModal}>
    <Plus size={14} /> Create first collection
  </button>
  <a href="https://zveltio.com/docs/collections" target="_blank"
     class="text-xs text-base-content/40 hover:text-base-content/70 transition-colors">
    Read documentation →
  </a>
</div>
```

Aplică acest pattern în: collections, views, zones, flows, webhooks, users.

---

### 12.10 — Dashboard Studio: mai util

**Problema**
Dashboard-ul actual arată: stats sumar + tabel cu colecții. E informativ dar nu ajută userul să facă nimic.

**Îmbunătățiri:**

1. **Quick actions** — butoane mari pentru cele mai frecvente acțiuni:
   - "New Collection", "New Flow", "New Webhook", "Invite User"

2. **Recent activity** — ultimele 10 acțiuni din `zv_audit_log`:
   - "orders collection updated · 5 min ago"
   - "User john@... logged in · 12 min ago"

3. **System health inline** — statusul DB, Cache, Extensions direct pe dashboard (nu separat în Operations > Health):
   - ✅ Database · 12ms   ✅ Cache · 2ms   ✅ 3 extensions

4. **Getting started checklist** (doar dacă nu au colecții):
   - ☐ Create your first collection
   - ☐ Configure authentication
   - ☐ Set up a zone/portal
   - ☐ Connect an AI provider

---

### Ordine de implementare UX/UI

```
Prioritate IMEDIATĂ (afectează credibilitatea):
  12.1 — Elimină confirm() / alert() → ConfirmModal
  12.2 — Toast notifications unificate

Prioritate ÎNALTĂ (afectează usabilitatea zilnică):
  12.7 — Client Portal navigație dinamică (legată de Bloc 1)
  12.5 — Breadcrumbs în paginile nested
  12.6 — Consolidare AI în hub cu tab-uri

Prioritate MEDIE:
  12.3 — Skeleton screens
  12.4 — Command Palette (Cmd+K)
  12.8 — Forms extension re-styling
  12.9 — Empty states îmbunătățite

Prioritate MICĂ (polish):
  12.10 — Dashboard îmbunătățit
```

---

1. **Zero `as any` în fișiere noi** — dacă tipul lipsește, adaugă interfața, nu `as any`
2. **Toate endpoint-urile noi** folosesc `zValidator` cu schema Zod explicită
3. **Toate query-urile pe tabele tenant** trec prin `withTenantIsolation` sau prin `c.get('db')` (care e deja izolat de middleware)
4. **Fiecare migration SQL** are secțiunea `-- DOWN` cu instrucțiunile de rollback
5. **Fiecare route nouă** are integration test minimal (happy path + 401 + 404)
6. **Comentariile** în engleză în cod, dar mesajele de eroare returnate de API pot fi în engleză

---

## NOTE FINALE PENTRU CLAUDE CODE

- Înainte de orice modificare la `routes/index.ts`, citește întregul fișier
- La modificarea migrărilor, verifică ce index de migrare este ultimul existent (caută fișierele `.sql` din `db/migrations/sql/`)
- Nu șterge tabelele vechi (`zvd_portal_pages` etc.) înainte ca tot codul care le referențiază să fie actualizat
- Testează că migration-ul 060 rulează pe o DB curată ȘI pe una cu date existente
- `bun run build` trebuie să treacă fără erori TypeScript după fiecare bloc

---

## BLOC 13 — FISIERE SI FOLDERE DE STERS DUPA IMPLEMENTARE

**IMPORTANT:** Sterge in aceasta ordine. Nu sterge nimic inainte ca Bloc 1 (Zones/Pages/Views) si migrarile sa fie complet implementate si testate in productie.

---

### FAZA 1 — dupa ce Bloc 1 e complet functional

#### Engine — routes vechi de portal

```
packages/engine/src/routes/portal.ts
```
Inlocuit complet de `zones.ts` (nou). Continea: zvd_portal_theme, zvd_portal_pages, zvd_portal_sections, zvd_collection_views — toate deprecate prin migration 061.

```
packages/engine/src/routes/client-portal.ts
```
Inlocuit de noul sistem Zones cu zona slug='client'. Continea template-uri hardcodate (generic/saas/services/regulatory), operatori, autorizatii, inspectii — toate devin colectii normale configurate in Studio.

Inainte de a sterge, verifica ca din `routes/index.ts` ai eliminat liniile:
```typescript
app.route('/api/portal', portalRoutes(db, auth));
app.route('/api/portal-client', clientPortalRoutes(db, auth));
```
si ca exista:
```typescript
app.route('/api/zones', zonesRoutes(db, auth));
app.route('/api/views', viewsRoutes(db, auth));
```

---

#### Studio — pagini admin vechi

```
packages/studio/src/routes/(admin)/portal/
```
Intregul folder: Portal Builder, editor sectiuni, tema — inlocuite de Zones.

```
packages/studio/src/routes/(admin)/client-portal/
```
Intregul folder: config template hardcodat — inlocuit de Zones.

```
packages/studio/src/routes/(admin)/pages/
```
Daca exista ca folder independent (Pages fara Zone) — inlocuit de zones/[slug]/pages.

---

#### Studio — client portal cu navigatie hardcodata

De sters (inlocuite de sistemul dinamic):
```
packages/studio/src/routes/(client)/portal-client/dashboard/+page.svelte
packages/studio/src/routes/(client)/portal-client/tickets/+page.svelte
packages/studio/src/routes/(client)/portal-client/profile/+page.svelte
packages/studio/src/routes/(client)/portal-client/login/+page.svelte
packages/studio/src/routes/(client)/portal-client/regulatory/    <- tot folderul
packages/studio/src/routes/(client)/+layout.svelte               <- navigatie hardcodata
```

De pastrat si refactorizat (NU sterge):
```
packages/studio/src/routes/(client)/portal-client/   <- folderul radacina ramane
  -> se rescrie +layout.svelte cu navigatie dinamica din API
  -> paginile devin [slug]/+page.svelte care randeaza Views din Zones API
```

---

### FAZA 2 — dupa Bloc 12.6 (consolidare AI in hub cu tab-uri)

```
packages/studio/src/routes/(admin)/prompt-to-schema/
```
Continutul se muta ca tab "Schema Gen" in /admin/ai. Folderul se sterge dupa ce tab-ul exista.

```
packages/studio/src/routes/(admin)/ai/alchemist/
packages/studio/src/routes/(admin)/ai/query/
```
Ambele se muta ca tab-uri in /admin/ai. Folderele se sterg dupa migrare.

---

### FAZA 3 — dupa 2 saptamani in productie (migration 062)

Tabelele redenumite in migration 061 pot fi sterse definitiv:

```sql
-- packages/engine/src/db/migrations/sql/062_drop_deprecated_portal_tables.sql
DROP TABLE IF EXISTS _deprecated_portal_pages CASCADE;
DROP TABLE IF EXISTS _deprecated_portal_sections CASCADE;
DROP TABLE IF EXISTS _deprecated_collection_views CASCADE;
```

Nu crea migration 062 imediat — pastreaza tabelele redenumite ca safety net.

---

### FAZA 4 — cleanup API in studio/src/lib/api.ts

Din `portalApi`, sterge metodele vechi si adauga `zonesApi` si `viewsApi` noi:

```typescript
// DE STERS din portalApi (dupa ce Zones e functional):
// getTheme, saveTheme, listPages, createPage, updatePage, deletePage,
// listSections, createSection, updateSection, deleteSection, reorderSections,
// listViews, createView, updateView, deleteView

// DE ADAUGAT:
export const zonesApi = {
  list: ()              => api.get('/api/zones'),
  create: (data: any)   => api.post('/api/zones', data),
  get: (slug: string)   => api.get(`/api/zones/${slug}`),
  update: (slug: string, data: any) => api.put(`/api/zones/${slug}`, data),
  listPages: (slug: string) => api.get(`/api/zones/${slug}/pages`),
  render: (slug: string) => api.get(`/api/zones/${slug}/render`),
  renderPage: (slug: string, pageSlug: string) => api.get(`/api/zones/${slug}/render/${pageSlug}`),
};

export const viewsApi = {
  list: ()              => api.get('/api/views'),
  create: (data: any)   => api.post('/api/views', data),
  get: (id: string)     => api.get(`/api/views/${id}`),
  update: (id: string, data: any) => api.put(`/api/views/${id}`, data),
  delete: (id: string)  => api.delete(`/api/views/${id}`),
};
```

---

### REZUMAT — ce dispare complet

```
ENGINE:
  src/routes/portal.ts                     STERS  (-> zones.ts nou)
  src/routes/client-portal.ts              STERS  (-> zones slug='client')

STUDIO admin:
  routes/(admin)/portal/                   FOLDER STERS
  routes/(admin)/client-portal/            FOLDER STERS
  routes/(admin)/pages/                    FOLDER STERS (daca exista independent)
  routes/(admin)/prompt-to-schema/         FOLDER STERS (-> tab in /ai)
  routes/(admin)/ai/alchemist/             FOLDER STERS (-> tab in /ai)
  routes/(admin)/ai/query/                 FOLDER STERS (-> tab in /ai)

STUDIO client:
  routes/(client)/+layout.svelte           RESCRIS (nu sters — nav dinamica)
  routes/(client)/portal-client/dashboard/ STERS   (-> [slug]/+page.svelte)
  routes/(client)/portal-client/tickets/   STERS   (-> colectie + view)
  routes/(client)/portal-client/profile/   STERS   (-> pagina din zone)
  routes/(client)/portal-client/login/     STERS   (-> auth standard)
  routes/(client)/portal-client/regulatory/ FOLDER STERS

DB (migration 062 — dupa 2 saptamani):
  _deprecated_portal_pages                 DROP TABLE
  _deprecated_portal_sections              DROP TABLE
  _deprecated_collection_views             DROP TABLE
```

---

### NU sterge acestea (pot parea redundante dar nu sunt)

```
packages/studio/src/routes/(intranet)/    REFACTORIZAT, nu sters
packages/client/src/routes/               PACHETUL CLIENT ramane complet
packages/studio/src/lib/api.ts            REFACTORIZAT, nu inlocuit
```
