# Zveltio vs Supabase (features) + boundary audit engine ↔ extensii

> **Scris:** 2026-08-21 pe patru branch-uri de cleanup, niciunul dintre ele merge-uit.
> **Aterizat pe master:** 2026-08-22, cu §4.2 reimplementat — vezi tabelul de mai jos.  
> **Scope:** comparație la nivel de **features** (nu maturitate de piață / mărime de echipă), plus audit de cod după migrarea SaaS → BaaS.  
> **Surse:** `README.md`, `docs/site/intro.md`, `docs/private/TECHNICAL-GAPS.md`, `packages/engine/src/routes/index.ts`, `extension-catalog.ts`, repo `~/zveltio-extensions` (CONTEXT.md pe media/import/export).  
> **Context autor:** proiect dezvoltat câteva luni, un om + agenți AI — volumele de feature vs Supabase (ani + echipă) nu sunt metrică de eșec; interesul e parity/diferențiere pe checklist.

---

## Status implementare

Cele patru branch-uri care au produs documentul au rămas nemerge-uite și au
ajuns la 66 de commituri în urmă. Munca lor a fost refăcută direct pe master,
iar în trei locuri **concluzia branch-ului a fost schimbată**, pentru că
masterul se mutase între timp:

| Item | Ce planifica branch-ul | Ce a aterizat |
|------|------------------------|---------------|
| `/api/media`, `/api/approvals` | ștergere | deja făcut pe master prin #318 (shim-uri 410) |
| `/api/export`, `/api/import` | ștergere | **shim-uri 410** via `goneRoutes`, ca la celelalte trei — un apelant vechi primește calea de înlocuire, nu un 404 mut |
| Edge: păstrat `/api/fn`, scos CRUD | — | deja pe master |
| Teste harness pe ușa moartă | șterse | șterse; `gone-doors` primește în schimb aserțiuni pentru export/import |
| `zv_import_logs` ownership | expand + **drop** coloane moarte, într-o migrație | **doar expand** (048). Drop-ul așteaptă un release ulterior: în rolling upgrade o instanță pe engine-ul precedent încă servește `/api/import`, citește coloanele și scrie status `processing`. Poarta `check-migration-safety` respinge pe drept `ban-drop-column` pe UP |
| Catalog orphans | adăugare în catalog | adăugat; metadatele verificate față de manifeste, zero orfani rămași |
| Studio broken redirects | **re-adaugă paginile baked** (625 linii) | **șterge cele două stub-uri de redirect** (40 linii). Direcția branch-ului contrazicea SDUI; `[...extPath]` servește acum ambele pagini din schemele extensiilor |
| Migrare SDUI completă | epic separat | vezi §4.6 — încă deschis |

Restul documentului (§1–§7) e analiza care a motivat cleanup-ul și rămâne
valabilă ca atare.

---

## 1. Cum se citește corect comparația

Zveltio nu e „un Supabase mai slab”. Are **două straturi**:

| Strat | Ce e | Peer onest |
|-------|------|------------|
| **Engine (BaaS)** | Auth, collections/API, RLS/RBAC, realtime, storage, webhooks, flows, Studio | Supabase / PocketBase |
| **+ extensii (SaaS)** | CRM, POS, finance, mail, compliance RO, HR… | Odoo / HubSpot — **nu** Supabase |

Dacă instalezi zero extensii, te compari cu Supabase. Dacă activezi marketplace-ul, te compari cu un Business OS modular. Ambele sunt deployment-uri suportate, nu workaround-uri.

---

## 2. Matrice feature (BaaS layer)

Legendă lead: **Z** = Zveltio ahead · **S** = Supabase ahead · **≈** = parity · **≠** = modele diferite (nu e „mai bun”, e alt bet)

| Feature | Zveltio | Supabase | Lead | Notă scurtă |
|---------|---------|----------|------|-------------|
| Auth (email, OAuth, 2FA, magic link) | Better-Auth + passkeys | GoTrue + JWT + Auth Hooks | ≈ | S mai bogat pe SSO enterprise / third-party JWT |
| DB API | Collections dinamice + REST/RPC | Postgres + PostgREST SQL-first | ≠ | Z abstrage schema; S e native SQL |
| Authorization | Casbin + FORCE RLS tenant + column perms | Postgres RLS pe JWT | S* | *Z: RLS per-user pe **read**; update/delete încă incomplete (README) |
| Realtime | WS + Valkey / LISTEN/NOTIFY | Changes + Broadcast + Presence | S | Presence/Broadcast lipsesc la Z |
| Storage | Local FS default + S3 | Storage GA + CDN + transforms | ≈/S | Parity self-host; S Cloud + DX |
| Edge / Functions | TS pe instanță (process/worker) | Deno Edge global | S | Z = serverless pe VPS-ul tău |
| Branching | Schema / env branches | DB branching (matur 2025–26) | ≈ | Claim-ul din `intro.md` „Supabase No” e **depășit** — de actualizat |
| Webhooks | HMAC outbound | DB webhooks + Edge | ≈ | |
| Admin UI | Studio + Client zones | Dashboard excelent | ≠ | Z țintește și UI de business |
| Automation / Flows | **În core** (DLQ, idempotency) | DIY Edge + webhooks | **Z** | Diferențiator clar pe BaaS |
| Ghost DDL | Zero-downtime alter | Migrations clasice | **Z** | |
| BYOD | Introspect Postgres existent | Nu ca produs | **Z** | |
| Audit trail | Write audit built-in | Logging / DIY | **Z** | |
| Offline sync | CRDT (+ Electric optional) | Nu ca produs core | **Z** | |
| Multi-tenancy | Primordial (GUC + membership) | RLS DIY per proiect | **Z** | |
| Single binary / self-host ops | Bun + un proces | Compose multi-servicii | **Z** | |
| Extensibility business | ~57 extensii semnate + marketplace | PG extensions + Edge | **Z** | Stratul care mută categoria |
| CRM / finance / POS / mail | Extensii | Nu | **Z** | Nu e gap Supabase — e altă categorie |
| Compliance fiscală (RO) | e-Factura, SAF-T, e-Transport | Nu | **Z** | Compliance de operațiuni vs de platformă |
| Certificări cloud (SOC2/ISO) | Post-1.0 | Da (cloud) | S | Procurement, nu feature runtime |
| Ecosystem (SDK ubiquity, tutorials) | SDK TS/React/Vue | Dominant pe piață | S | Nu e feature; afectează adopția |

### Verdict features (fără „cât de maturi sunt ei”)

- **Pe checklist BaaS:** Zveltio acoperă aproape tot ce evaluează un founder pe Supabase, plus câteva care **nu există** la ei (flows nativ, Ghost DDL, BYOD, tenancy-as-product, offline, audit first-class).
- **Unde S încă bate pe features concrete:** Presence/Broadcast, edge geografic, RLS write-complete, SQL-first PostgREST, storage transforms/CDN ca produs.
- **Unde Z bate categoric:** automation în core + marketplace care transformă BaaS în SaaS pe același auth/RLS/audit.

Pentru un singur dezvoltator în câteva luni, surface-ul de features e **neobișnuit de complet** față de un BaaS „greenfield”. Gap-ul de piață (trust, community, certs) e separat de gap-ul de features — și e rezolvabil cu echipă când produsul prinde.

---

## 3. Ce aș mai implementa ca să atragă utilizatori

Prioritate pe **conversie + wow + unblock evaluare**, nu pe încă un modul ERP.

### P0 — atrage și convertește (săptămâni, nu luni)

1. **Demo public hosted + „Install CRM in one click”**  
   Codul de demo există; lipsește hosting-ul. Un evaluator care vede CRM + flows pe date fake în 30s bate orice feature matrix.

2. **Template → app live în <2 minute**  
   Templates există; faceți path-ul: `curl install → pick template → Studio deschis pe pipeline`. Zero docs obligatorii.

3. **RLS pe update/delete (parity cu claim-ul de security)**  
   Nu e „sexy”, dar e primul lucru pe care-l verifică un ex-Supabase. Blochează trust-ul tehnic.

4. **„Supabase → Zveltio” migrator (schema + auth users stub)**  
   Există `integrations/migrators` pe disk, necatalogat. Un wizard „import PostgREST/schema dump” e magnet pentru churn din S.

5. **Benchmark public pe hardware identic vs PocketBase/PostgREST**  
   Un singur grafic p50/p95 pe CRUD + realtime. Oamenii nu citesc FEATURE tables; citesc „e suficient de rapid?”.

### P1 — diferențiatori care se vând singuri

6. **SDUI coverage pe cele ~57 extensii** (azi ~26/57 per vision)  
   Instalarea unei extensii trebuie să „apară” UI fără pagini hardcoded în Studio. Asta e promisiunea BaaS→SaaS vizibilă.

7. **AI schema → collections → permissions → first screen**  
   Aveți text-to-schema; legați-l de un onboarding: „Descrie business-ul → app”.

8. **Briefing / entrepreneur dashboard ca default post-login**  
   `briefing.ts` e deja pe ideea bună („cine îmi datorează bani”). Extindeți la 3–5 answers, nu metrics de engine.

9. **Public marketplace browse fără install** (site)  
   „Înlocuiește HubSpot / Zapier / e-Factura” cu carduri → CTA install.

10. **Edge functions story clară**  
    Un path singur pentru invoke (`/api/fn`) + CRUD doar în extensie sau doar în core — azi e split confuz (vezi §4).

### P2 — nice, după că product-market fit

11. Presence/Broadcast pe realtime (checkbox vs S).  
12. Storage image transform (sau extensie pe SeaweedFS/imgproxy).  
13. SCIM în catalog (`auth/scim` există pe disk).  
14. Country pack #2 (ex. IT SDI sau DE) — semnalează că RO nu e capătul arhitecturii.  
15. Client SDK snippets „copy from Supabase docs” (mapping mental `from().select()` → collections).

### Ce aș **nu** face acum

- Încă un modul finance/HR înainte de demo + RLS write + cleanup duplicate routes.  
- SOC2 înainte să existe 3 design partners plătitori.  
- Feature parity obsessivă pe Presence — nu e motivul pentru care cineva alege Zveltio.

---

## 4. Audit de graniță: engine ↔ `zveltio-extensions`

Migrarea SaaS → BaaS e **parțială**. Patru promoții spre core s-au făcut corect. Cinci feature-uri rămân **duplicate live** (engine montat la `/api/*` + extensie la `/ext/*`), iar Studio consumă de obicei doar `/ext/*`. Asta a produs deja bug-uri de securitate reparate pe copia moartă (documentat în CONTEXT.md).

### 4.1 Promoții core — curate (bine)

| Feature | Engine | Extension folder |
|---------|--------|------------------|
| insights | `/api/insights` | **șters** (catalog: promoted) |
| saved-queries | `/api/saved-queries` | **șters** |
| schema-branches | `/api/schema/branches` | **șters** |
| backup | `/api/backup` | **șters** |

### 4.2 Duplicate HIGH — de șters din engine (sau de decis un singur owner)

Studio / UI apelează `/ext/…`. Engine încă montează `/api/…` pe aceleași tabele. ~2.5k LOC rute moarte + teste pe ușa greșită.

| Feature | Engine (mort pentru UI) | Extension (viu) | Dovezi |
|---------|-------------------------|-----------------|--------|
| **Media** | `routes/media.ts` (~784 LOC) → `/api/media` | `content/media` → `/ext/content/media` | CONTEXT: „zero consumatori”; fix-uri de security au aterizat întâi pe copia moartă |
| **Approvals** | `routes/approvals.ts` (~663) → `/api/approvals` | `workflow/approvals` → `/ext/workflow/approvals` | Studio: `/ext/workflow/approvals`; extensia are SLA/delegates în plus |
| **Export** | `routes/export.ts` (~171) → `/api/export` | `data/export` → `/ext/data/export` | `ExportActions.svelte` → `/ext/data/export`; CONTEXT: guards pe `/api/export` fără consumatori |
| **Import** | `routes/import.ts` (~433) → `/api/import` | `data/import` → `/ext/data/import` | **Schema clash** pe `zv_import_logs`: `file_format` vs `format`, `error_rows` vs `failed_rows`, `processing` vs `running` — virgin install 500 până la migrația 003 |
| **Edge functions CRUD** | `routes/edge-functions.ts` (~480) → `/api/edge-functions` (+ `/api/fn`) | `developer/edge-functions` | Split: invoke pe engine vs admin pe extensie — de decis un singur model |

**ROI cleanup #1:** unmount + delete `media.ts`, `approvals.ts`, `export.ts`, `import.ts` (+ teste harness care lovesc `/api/*` mort; actualizează `api-reference.md`). Păstrează un singur owner pe tabele.

### 4.3 Split greșit / ownership confuz (MED–HIGH)

| Problemă | Detaliu |
|----------|---------|
| `zv_import_logs` | Creat de core migration + de extensie cu vocabular diferit. Extensia are `003_engine_shaped_table.sql` ca band-aid. Owner ar trebui să fie **doar extensia** după delete engine route. |
| `zv_pages` + sitemap | Engine servește `/api/sitemap.xml` pe tabele pe care `content/pages` le deține conceptual. |
| Edge functions | Două uși CRUD; `/api/fn` intentional pe engine — OK dacă e documentat; CRUD dublu nu. |
| Approvals feature set | Engine = subset; extensie = full. Același `zv_approval_*`. |
| Studio hardcoded `/ext/…` | Zeci de pagini Svelte în `packages/studio` presupun extensia instalată, în paralel cu catch-all SDUI — rest SaaS-era „totul e în monolit”. |
| `analytics/dashboard`, `auth/scim`, `integrations/migrators` | Există pe disk, **lipsesc din** `EXTENSION_CATALOG` — orphan marketplace. |

### 4.4 În engine, discutabil pentru un BaaS „pur” (MED)

Nu sunt neapărat greșite — sunt **resturi de produs SaaS** sau bet-uri deliberate:

| Route | De ce miroase a SaaS | Recomandare |
|-------|----------------------|-------------|
| `/api/briefing` | „Cine îmi datorează bani” pe core `transactions` | **Păstrează** ca diferențiator entrepreneur — dar documentează ca Business OS, nu ca BaaS minimal |
| `/api/templates` | Pack-uri CRM/invoicing/helpdesk/inventory/ansvsa | OK ca seed; pe termen lung = marketplace starters |
| `/api/flows` | Automation grea în core | **Păstrează** — e moat vs Supabase; nu muta în extensie |
| `/api/notifications` | Inbox platformă | Core OK |
| `/api/sql-editor`, ERD | Dev tooling | Core OK pentru BaaS admin |

`routes/index.ts` header încă listează `/api/ai/*` ca „core” deși AI e corect mutat în extensie — **docs drift** (LOW).

### 4.5 Split corect (exemplu de urmat)

| Pattern | Status |
|---------|--------|
| **AI** | Routes în `zveltio-extensions/ai`; engine nu mai montează `/api/ai` |
| **GraphQL, drafts, documents, GDPR, mail, quality UI** | Doar extensie |
| **data-quality engine** | `lib/data-quality.ts` în core ca **capability** (`runQualityScan` via extension internals); UI/routes în `analytics/quality` — OK |
| **Auth, collections, data, RLS, storage, webhooks, tenants, realtime, sync** | Core legitim |

### 4.6 Ordine de cleanup recomandată

1. **Delete dead `/api` copies:** media, approvals, export, import (+ teste + OpenAPI).  
2. **Edge functions:** alegeți (A) CRUD+invoke tot în core, Studio UI în extensie; sau (B) totul în extensie, engine păstrează doar invoke `/api/fn`.  
3. **Import table:** după (1), simplificați migrațiile extensiei; un singur vocabular de coloane.  
4. **Catalog:** adăugați sau arhivați `analytics/dashboard`, `auth/scim`, `integrations/migrators`.  
5. **Studio:** reduceți paginile hardcoded care dublează `studio/` din extensii (media, approvals deja menționate ca near-identical).  
6. **Actualizați** `intro.md` branching claim + header comments din `routes/index.ts`.

---

## 5. Inventar extensii pe disk (`~/zveltio-extensions`)

57 pachete cu `manifest.json` (aproximativ):

```
ai
analytics/dashboard*   analytics/quality
auth/ldap  auth/saml  auth/scim*
billing
communications/mail
compliance/gdpr  compliance/ro/{documents,efactura,etransport,procurement,saft}
content/{documents,document-templates,drafts,media,pages,pdf-viewer}
crm
data/{export,import}
developer/{api-docs,byod,database,edge-functions,graphql,validation}
ecommerce/store
finance/{accounting,banking,expenses,invoicing,quotes,subscriptions}
forms
geospatial/postgis
hr/{employees,leave,payroll,time-tracking}
i18n/translations
integrations/{api-connector,migrators*}
operations/{assets,inventory,pos,traceability}
projects/{helpdesk,management}
search
sms
storage/cloud
workflow/{approvals,checklists}
```

`*` = pe disk, absente din `EXTENSION_CATALOG` la data auditului.

---

## 6. Concluzie executivă

1. **Features vs Supabase:** pe BaaS sunteți competitive + diferențiați (flows, Ghost DDL, BYOD, tenancy, audit, offline). Gap-urile feature reale sunt RLS write, realtime Presence, edge global — nu „lipsește jumătate din produs”.  
2. **Atracție useri:** demo hosted + one-click template + migrator din Supabase + benchmark + RLS write + SDUI pe extensii. Asta vinde; al 58-lea modul ERP nu.  
3. **Cod post-migrație:** promoțiile insights/saved-queries/schema-branches/backup sunt curate. **Datoria mare** e cele 5 duplicate media/approvals/export/import/edge-functions — deja documentate ca „zero consumatori” și cauză de false sense of security. Ștergerea lor e cel mai ieftin win de credibilitate arhitecturală.

---

## 7. Referințe rapide

- Engine mounts: `packages/engine/src/routes/index.ts`  
- Catalog: `packages/engine/src/lib/extensions/extension-catalog.ts`  
- Duplicate docs:  
  - `~/zveltio-extensions/content/media/CONTEXT.md`  
  - `~/zveltio-extensions/data/import/CONTEXT.md`  
  - `~/zveltio-extensions/data/export/CONTEXT.md`  
- Trust/GTM gaps: `docs/private/TECHNICAL-GAPS.md`
