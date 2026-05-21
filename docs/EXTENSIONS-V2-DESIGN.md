# Extensions v2 — design proposal

**Decizia luată**: integrare profundă cu Studio + sprint dedicat 1-2 săptămâni.

Asta înseamnă: extensiile devin **compile-time inclusions** ale Studio-ului,
nu artefacte runtime. Eliminăm cele 3 contradicții ale modelului v1 dintr-o
lovitură.

---

## Filozofia v2 într-o frază

> O extensie e un set de fișiere `.svelte` + `engine/*.ts` care **se
> integrează în build-ul Studio** la enable, nu un bundle JS care se
> încarcă runtime în browser.

## Cum arată concret

### Structura extensiei

```
extensions/crm/
├── manifest.json                    # name, version, deps, permissions
├── engine/
│   ├── index.ts                     # export default ZveltioExtension
│   ├── routes.ts
│   └── migrations/
│       ├── 001_contacts.sql
│       └── 002_deals.sql
├── studio/
│   ├── pages/                       # devine /admin/ext/crm/* după build
│   │   ├── contacts/+page.svelte
│   │   ├── deals/+page.svelte
│   │   └── companies/+page.svelte
│   ├── lib/                         # componente Svelte reutilizabile
│   │   ├── ContactCard.svelte
│   │   └── DealKanban.svelte
│   └── nav.ts                       # contribuie items în sidebar
└── client/                          # opțional: pagini pentru zona client
    └── pages/
        └── my-tickets/+page.svelte
```

### Install flow (rescris complet)

```
POST /api/marketplace/crm/install
   1. download tarball → /opt/zveltio/staging/crm/
   2. validează manifest (schema + zveltio version + permission set)
   3. response: { staged: true }

POST /api/marketplace/crm/enable
   1. atomic copy: /opt/zveltio/staging/crm → /opt/zveltio/extensions/crm
   2. trigger STUDIO_REBUILD job (pg-boss, dedicated worker):
      a. cp -r extensions/crm/studio/pages/* studio-src/src/routes/(admin)/ext/crm/
      b. cp -r extensions/crm/studio/lib studio-src/src/lib/ext/crm/
      c. cd studio-src && bun install (incremental — cache hit pe deps existente)
      d. cd studio-src && bun run build → studio-dist.new/
      e. smoke check: curl http://localhost:3001/admin/ext/crm/contacts (test serve)
      f. atomic swap: mv studio-dist studio-dist.old; mv studio-dist.new studio-dist
      g. rm -rf studio-dist.old (async, după 10s)
   3. engine hot-load: dynamic-import extensions/crm/engine/index.ts
   4. broadcast WS: { type: 'studio:reloaded', changed: ['crm'] }
   5. response: { active: true, studio_rebuild_ms: 4200 }

Client browser:
   - WS message → shows toast "Studio updated. Refresh to load new pages."
   - User clicks refresh → loads fresh /admin/* with the new ext baked in
```

### De ce asta rezolvă cele 3 contradicții

1. **Deploy independent vs Studio rebuild** → Acceptăm rebuild-ul explicit
   ca cost. Cu Vite incremental build pe cache cald, e <5s. Worker dedicat
   îl izolează de hot-path-ul HTTP.
2. **Svelte external vs import map** → DISPARE problema. Extensiile sunt
   build-uite în interiorul Studio-ului. Zero externals, zero specifiers
   bare, zero magic.
3. **Same-process speed vs third-party isolation** → Engine-side rămâne
   same-process (cum era și v1). Studio-side, fiecare ext are propriul
   namespace `/ext/<name>/` dar partajează V8 isolate cu Studio core —
   trade-off acceptat în decizia ta de "integrare profundă".

### Type safety end-to-end

Extension author scrie:
```ts
// extensions/crm/studio/pages/contacts/+page.svelte
<script lang="ts">
  import type { ExtensionContext } from '@zveltio/sdk/extension';
  import { dataApi } from '$lib/api.js';  // ACELAȘI api ca Studio core
  import ContactCard from '$lib/ext/crm/ContactCard.svelte';

  let contacts = $state<any[]>([]);
  // ...
</script>
```

Build-ul Studio compilează acestea ca parte din `tsc --noEmit` — orice
breaking change în SDK e prins la build, nu la runtime în producție.

### Marketplace publishing

Un dezvoltator third-party își dezvoltă extensia local cu:
```bash
zveltio ext init crm
cd extensions/crm
# editează engine/ + studio/
zveltio ext dev          # rulează Studio local + watch pe ext
zveltio ext publish      # upload la registry
```

Registry-ul stochează tarball. La install pe altă instanță, flow-ul de
mai sus rulează.

**Trade-off acceptat**: developerul trebuie să folosească Svelte 5 + Tailwind
+ DaisyUI (constrânse de Studio). Nu poate aduce React/Vue/altele. Asta e
prețul integrării profunde — și e exact ce ai cerut.

---

## Sprint plan (10 zile lucrătoare)

### Zilele 1-2: Foundation
- [ ] Definește contract manifest v2 (`@zveltio/sdk/extension/v2`)
- [ ] Scrie `studio-rebuild-worker.ts` — pg-boss job care orchestrează
      rebuild + atomic swap
- [ ] Adaugă API `/api/marketplace/:name/install` (staging) și
      `/api/marketplace/:name/enable` (promote + rebuild)
- [ ] WebSocket channel `studio:reloaded` pentru notificare client

### Zilele 3-5: Pilot 5 extensii
Migrez următoarele de pe v1 → v2 ca prove the model works:
- `crm` (CRUD simplu, fără relații complexe)
- `finance/invoicing` (formulare complexe + PDF generation)
- `workflow/approvals` (state machine + UI multi-pas)
- `communications/mail` (external API + setări sensibile)
- `developer/api-docs` (Studio bundle pur, fără engine routes)

Fiecare pilot e o validation point distinctă:
- crm → CRUD baseline
- invoicing → forms heavy
- approvals → flow UI
- mail → external deps + secrets
- api-docs → bundle-only

### Zilele 6-7: Migrare restul (47 ext)
Cu modelul probat pe 5, migrez restul mecanic. Foarte multe sunt
simple CRUD — pot fi semi-automatizate.

### Ziua 8: Marketplace UI rescris
- Pagina `/admin/marketplace` arată progres rebuild în timp real
- Toast cu "Studio updated, refresh to see new pages"
- Buton "Rollback to previous version" dacă rebuild eșuează

### Zilele 9-10: Polish + docs
- `EXTENSION-AUTHORING-V2.md` — ghid complet pentru dezvoltatori
- CLI `zveltio ext init/dev/publish`
- Migration guide v1 → v2 pentru orice extensii third-party (dacă vor exista)
- Deprecate vechiul flow (lasă cod-ul în-place pentru back-compat doar 1 release)

---

## Ce dispare după v2

- ❌ Bun.plugin shims per-extension
- ❌ Import map magic
- ❌ `formats: ['iife']` în extension vite.config (extensiile n-au mai
  au propriul vite.config — Studio le build-uiește)
- ❌ Hot-reload "matcher already built" — niciodată reapare fiindcă
  Studio rebuild face rebuild complet, nu hot-patch
- ❌ Peer deps install dance — toate deps-urile extensiei se rezolvă
  la build prin Vite normal

## Ce rămâne (e bine acolo)

- ✅ Engine-side: `ZveltioExtension.register(app, ctx)` — contract clar,
  testat, merge bine
- ✅ Migrations declarate prin `getMigrations()` — funcționează
- ✅ Audit + permissions cu casbin — neschimbat

---

## Întrebare deschisă: rebuild downtime

Studio rebuild durează ~5s în best-case (Vite incremental). În acel timp,
serverul Studio dist e mid-swap. Două opțiuni:

**A. Atomic swap cu retry**: clientul curent vede 503 timp de ~50ms în
timpul `mv`. Nu observabil de utilizator (browser-ul retry-uie). Foarte
simplu.

**B. Blue/green deploy**: două dist-uri servite simultan, nginx upstream
le balansează. Zero downtime real. Complex de setup.

**Recomandare**: A pentru beta, B pentru v1.1 dacă apare un client care
cere SLA strict.

---

## Decizie cerută înainte să încep

Concret:
1. **Pornesc cu pilot-ul `crm`** ca prove-of-concept (1-2 zile), apoi
   evaluăm înainte de cele 47?
2. **Sau strunjesc întâi infrastructura** (`studio-rebuild-worker` +
   atomic swap + marketplace flow), apoi atac pilot-urile?

Eu aș merge pe **#2** — infrastructura e partea cea mai riscantă; vrei
să știi că funcționează înainte să migrezi orice extensie. Plus, dacă
descopăr ceva incompatibil la mijlocul migrației, nu am 5 extensii
migrate în limbo.
