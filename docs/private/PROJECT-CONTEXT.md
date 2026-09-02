# PROJECT-CONTEXT.md

Context general al proiectului, pentru oricine preia lucrul aici — om sau
agent. Sinteză a `docs/site/`, `docs/private/`, `docs/adr/` și `CHANGELOG.md`,
compilată 2026-08-31, corectată 2026-09-01 (roluri DB, GUC-uri).
Citește asta ÎNAINTE de orice document mai vechi: la conflicte, câștigă
documentul cu data mai recentă (concluziile infirmate se corectează inline,
nu se șterg — data ultimei corecții contează, nu data creării).

**Excepție la regula de mai sus:** pe multi-tenancy, `docs/MULTI-TENANCY.md`
câștigă indiferent de dată. E scris pentru auditori și verificat rând cu rând;
fișierul ăsta e o sinteză și a greșit deja o dată acolo.

Pentru convenții de cod, comenzi și porți de calitate vezi `AGENTS.md`
(rădăcină). Acest fișier acoperă CE este produsul și DE CE arată cum arată.

## Ce este Zveltio

- **„Business OS" self-hosted**: headless BaaS/CMS (Bun + Hono + PostgreSQL,
  un singur binar compilat) care devine SaaS prin extensii semnate Ed25519
  și sandbox-uite.
- Poziționare: engine = strat BaaS (peer: Supabase/Appwrite/Directus);
  engine + extensii = strat SaaS (peer: Odoo/HubSpot).
- Public țintă: companii și instituții publice; accent pe GDPR, suveranitatea
  datelor, compliance românesc (e-Factura, SAF-T, achiziții publice).
- Componente: engine headless (colecții dinamice, auth Better-Auth, RBAC
  Casbin, multi-tenancy prin Postgres FORCE RLS, realtime WS + LISTEN/NOTIFY,
  audit imuabil), Studio (SvelteKit 5 la `/admin`), client app la `/`,
  SDK public (`@zveltio/sdk` + bindings React/Vue), marketplace de extensii
  cu review manual.
- Status la 2026-08-31: `3.0.0-beta.64`, traiectorie spre v1.0 GA.
  **API-stabil în beta:** suprafața SDK de extensii (`ZveltioExtension`,
  manifest v2, marketplace, contractul de izolare worker). Engine internals
  și Studio se pot schimba.
- Diferențiatori revendicați: environment branching (schema ca Git), DDL fără
  downtime (ghost DDL), Bring Your Own Database, criptare per-câmp
  AES-256-GCM, time travel pe înregistrări, marketplace cu lanț de încredere.

## Transformările majore (cronologie)

### 1. Faza alpha — până la 2026-05-31 (`1.0.0-alpha.1` → `.129`)

- Istorica .1–.47 e doar în git, neconsemnată. .48–.129 = dezvoltare intensă.
- **Extracția AI din engine în extensie (alpha.67, 2026-05-08):** AI nu e
  non-negociabil ca Postgres/auth; organizații no-AI trebuie să poată instala
  fără el. A forțat `ctx.services` (registry de servicii inter-extensii, stil
  Drupal) și încărcarea topologică pe dependențe. Model citat ulterior ca
  „split corect, exemplu de urmat". Aceeași perioadă: rebranding BaaS →
  „Self-hosted Business OS".
- **Extensions v2 (alpha.111 → beta.1):** de la încărcare runtime `.ts`
  fragilă (incidentele alpha.106–110 erau aproape toate regresii de loader)
  la artefact bundled `engine/index.js` + manifest v2 cu `integrity`
  (SHA-256) + CLI `pack/validate/sign/publish`. Zero backward-compat
  („there is no legacy channel"). Toate cele 54 de extensii oficiale migrate
  scripted. Detalii: `docs/private/EXTENSIONS-V2-PHASE1.md`.
- **Worker isolation (alpha.121–122):** extensiile community nu mai sunt
  importate în procesul engine — proces separat, rol DB `zveltio_worker`,
  allowlist SQL.
- Marketplace lansat controlat la alpha.129 (submisii `pending` până la
  review manual).

### 2. Tranziția la beta + saltul de versioning (2026-05-31 → iunie)

- **`1.0.0-beta.1` (2026-05-31):** alpha declarat EOL; modelul de extensii v2
  declarat API-stabil. Detalii: `docs/private/ALPHA-TRACK-EOL.md`.
- **`3.0.0-beta.1` (2026-06-14): re-aliniere de numerotare, NU release de
  funcționalități.** Câteva pachete npm fuseseră publicate greșit la `2.0.x`
  (irecuperabil) → linia sare la `3.0.0`. Cod identic cu beta.3. Regula de
  atunci: versiunile publicate sunt imuabile, greșelile se repară mergând
  înainte (`docs/site/VERSIONING.md`).
- beta.2: echipă de admini marketplace (roluri owner/admin). beta.3: politică
  de publisher pe 3 niveluri (first-party / verified / community), izolare
  worker obligatorie pentru community.

### 3. Multi-tenancy — arcul cel mai lung (beta.18 → prezent)

- **Înainte (≤beta.16):** Casbin global, membership neimpus, RLS opt-in,
  extensii pe pool global. Audit 2026-05-24: 50+ extensii fără
  `tenant_id`/RLS → template `002_tenant_rls.sql` aplicat la 51 de extensii +
  `reqDb(c)` peste tot (închis la `14b0dd0`).
- **Fundația (beta.18–23):** modelul „always one tenant" (default tenant;
  single-tenant = caz degenerat), Casbin cu domenii (`r = sub, dom, obj,
  act`), middleware membership, `tenant_id` coloană de sistem + reconciler
  boot cu FORCE RLS. Două cerințe dure: rolul DB **non-superuser** în
  tranzacțiile tenant (altfel RLS e bypass-uit) și `set_config(..., true)`,
  nu `SET LOCAL = $1`. Detalii: `docs/private/MULTI-TENANT-ENABLEMENT.md`.
- **Ierarhia (aug 2026, `feat/tenancy-hierarchy`):** de la lista plată de
  clienți-cu-abonament la **arbore de unități** (cazul ANSVSA: 41 de direcții
  județene), `read_scope` (`self/subtree/list/org`), scriere doar în nodul
  propriu, vizibilitate în jos opt-in per colecție, două funcții-predicat
  (`tenant_write_ok` / `tenant_scope_ok`), 315 politici rescrise. Coloanele
  de abonament (`plan`, `trial_ends_at`) păstrate deliberat. Detalii:
  `docs/private/TENANCY-HIERARCHY-DESIGN.md`.
- **Maturizarea (aug 2026):** decizii măsurate de a NU schimba: fără
  `loadFilteredPolicy`, fără CASL/Zanzibar. Premisa
  „politicile cresc cu firmele" a fost infirmată măsurat
  (`zvd_collections` nu are `tenant_id`). Detalii:
  `docs/private/CASBIN-SCALING-STATE.md`.

### 4. Pivotarea de poziționare (beta.31 → beta.32, 2026-07-16/17)

- **ADR 0001** (singurul ADR din repo, `docs/adr/0001-...md`) fixează trei
  suprafețe frontend (admin la `/admin`, app+public la `/`, BYO viitor) cu un
  contract de render portabil versionat „v1" și filtrare de permisiuni
  strict server-side.
- **Revizia din aceeași zi:** premisa inițială („CMS public-first,
  WordPress-like", homepage public seed-uit) era greșită. Zveltio este
  **app/intranet-first**: `/` = landing de login/sign-up implicit, pagina
  publică e opt-in, page-builder nu mai e instalat implicit,
  self-registration oprit implicit (`registration_enabled`). ADR-ul revizuit
  e sursa adevărului, nu CHANGELOG-ul beta.31.

### 5. Hardening spre stable (beta.30, iulie 2026 → prezent)

- **beta.30 (2026-07-15), „the security release":** 29 fix-uri izolare
  tenant/IDOR, Hardening Wave 9 completă (H-01..H-16), erori RFC 9457
  `problem+json` peste tot, `ctx.db` tenant-scoped pentru extensii, primul
  master complet verde în CI. Plan: `docs/private/HARDENING-9-PLAN.md`.
- **Split-ul god-files (H-04..H-08):** `extension-loader.ts` 1773→<500 linii,
  `data.ts` 1734→63, `admin.ts` 1347→244; `lib/` reorganizat în 8 subsisteme
  sigilate cu barrel + poarta `import-boundaries`.
- **Migrarea graniței engine↔extensii (aug 2026):** promoții curate în core
  (insights, saved-queries, schema-branches, backup), duplicate moarte șterse
  ca shim-uri 410 (#318) — buguri de securitate fuseseră reparate pe copia
  moartă. Audit: `docs/private/ZVELTIO-VS-SUPABASE-AND-BOUNDARY-AUDIT.md`.
- **SDUI pentru Studio (aug 2026):** paginile extensiilor devin scheme JSON
  declarative (`studio/schemas/*.json`) randate de un host generic; 61 de
  scheme migrate, paginile Svelte baked șterse. Spike verdict: 75–80% din
  pagini încap în modelul declarativ. „Model 2.5" adaugă slot-uri
  compile-time. Detalii: `docs/private/SDUI-AGENT-HANDOFF.md`.
- **Migrații:** squash 70 fișiere SQL engine → `001_initial.sql`
  (2026-05-24); verigă cu checksum (`assertChainCompatible`) adăugată în faza
  beta.42+.
- **Performanță:** autorizare Casbin de la 364–885 ms (măsurare poluată,
  vezi mai jos) la ~0,1 ms/decizie reală; citiri paginate cu index
  `(tenant_id, created_at)`.

## Implementarea multi-tenancy — verificată în cod și în baza vie (2026-08-31)

Audit pe cod + verificare independentă pe baza vie (pg_policy, pg_roles).
Verdict: arhitectura descrisă mai jos e confirmată punctual, cu corecțiile
notate. Aceasta e sursa de adevăr pentru „cum funcționează tenancy ACUM";
secțiunea 3 din cronologie rămâne pentru „cum am ajuns aici".

### Fluxul unei cereri (confirmat)

Ordinea middleware (`packages/engine/src/index.ts:694-711`):

1. `sessionPrefetch` rezolvă sesiunea pe pool cu rolul engine-ului, ÎNAINTE
   de tranzacția de tenant — rolul `zveltio_rls` nu are granturi pe
   `session`/`account`/`verification`/`twoFactor`, iar `permission denied`
   ar aborta întreaga tranzacție.
2. `tenantMiddleware` (`middleware/tenant.ts:103`): rezolvă tenantul
   (`X-Tenant-Slug` → subdomeniu → `ZVELTIO_TENANT_ID` → fallback la default
   tenant, `00000000-…-0001`), apoi deschide o tranzacție în care setează
   tranzacțional, într-un singur round-trip, GUC-urile (vezi mai jos).
   Rutele din `TXN_SKIP_PREFIXES` (`middleware/tenant.ts:38-101`) sar
   tranzacția — motiv măsurat în comentariul din cod: c=10 → 12 000 ms p50,
   55/60 cereri eșuate, zece conexiuni `idle in transaction`, zero active.
3. `tenantMembershipMiddleware` (`middleware/tenant-membership.ts:25`):
   pentru tenant non-default, user non-god fără rând în `zv_tenant_users`
   → 403 (blochează pivotul prin header). Eroarea de DB se transformă în 403
   (fail-closed).

### GUC-urile tranzacției de tenant

Erau 4 setări (`role`, `current_tenant`, `visible_tenants`,
`ancestor_tenants`). **Pe master sunt 10** (verificat 2026-09-01 în
`tenant-manager.ts`): se adaugă cele cinci de identitate — `user_id`,
`user_email`, `user_role`, `user_roles`, `rls_bypass` — plus `zveltio.actor`,
tot într-un singur round-trip.

`zveltio.actor` merită explicat, fiindcă existența lui vine dintr-o capcană
Postgres: **după `SET LOCAL` + `COMMIT`, o setare personalizată supraviețuiește
GOLITĂ (`''`), nu ștearsă.** Deci `current_setting(x, true) IS NULL` înseamnă
„prima cerere pe o conexiune proaspătă", nu „nesetat" — iar `set_config(x, NULL,
true)` nu o dezsetează nici el. Un predicat de securitate construit pe absență
ar fi depins de norocul din pool și ar fi trecut orice test pe pool rece. De
aceea `actor` e un steag propriu, scris MEREU.

### Politica RLS reală (confirmată și din pg_policy)

```sql
CREATE POLICY tenant_isolation ON "zvd_<name>"
USING (tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[]))
WITH CHECK (zveltio_tenant_write_ok(tenant_id))
```

Plus FORCE ROW LEVEL SECURITY, coloană `tenant_id` cu default din GUC, index
compus `(tenant_id, created_at DESC)` (măsurat: 1,94 → 0,08 ms pe 300k
rânduri / 63 tenant-uri). Split read/write deliberat: părintele cu `subtree`
CITEȘTE copiii, dar WITH CHECK îi permite scrierea DOAR în nodul propriu.

### Ierarhia (confirmată până la cifră)

Adjacency list (`zv_tenants.parent_id`) + trigger anti-ciclu cu plafon 64;
`read_scope IN ('self','subtree','list','org')` pe `zv_tenant_users`;
rezolvare o dată per cerere ca rol engine, înainte de downgrade; assignments
expirate → setul sentinel `NO_UNITS` (vede nimic, nu fallback la self);
unitățile nu se șterg (`closed_at` + `merged_into`).

### Roluri DB (confirmate din pg_roles)

> **Corectat 2026-09-01.** Rândul de mai jos a fost citit de pe MAȘINA DE
> DEZVOLTARE și scris ca și cum ar fi designul. Nu e. Documentul canonic e
> `docs/MULTI-TENANCY.md` — scris pentru auditori, și el câștigă la conflict.
> Instalarea de producție documentată **nu** folosește superuser:
> `scripts/bootstrap-db-role.sh` rulează o singură dată ca superutilizator,
> creează `zveltio_app` ca `NOSUPERUSER NOBYPASSRLS`, instalează extensiile
> netrusted și pre-creează `zveltio_rls`; după aceea motorul nu mai are nevoie
> de superuser niciodată. `docker-compose.yml` pornește deja Postgres cu
> `POSTGRES_USER=zveltio`. Iar dacă RLS chiar nu se aplică, `rlsBootFailure()`
> oprește pornirea când `NODE_ENV=production`.

- Rolul engine-ului **pe mașina asta de dezvoltare**: `postgres`, `usesuper=t`
  — normal pentru o imagine stock, NU forma de producție (vezi caseta de mai
  sus).
- `zveltio_rls`: NOLOGIN, NOSUPERUSER, NOBYPASSRLS; DML pe tot `public` mai
  puțin cele 4 tabele Better-Auth; recreat la fiecare boot.
- `zveltio_worker`: `rolcanlogin=f, rolsuper=f, rolbypassrls=f`; granturi
  doar pe `zvd_*` + REVOKE explicit pe tabelele de auth.

### Slăbiciuni reale (confirmate pe baza vie)

1. **Fail-open la default tenant prin design** — fără GUC, predicatul rezolvă
   la default tenant. `ZVELTIO_FAIL_CLOSED_TENANT=1` e opt-in, oprit
   implicit. **Primul punct pe lista de lucru următoare** (owner, 2026-08-31).
2. **Pariul central: toate căile coboară la `zveltio_rls`.** Formularea de
   dinainte („rolul engine-ului e superuser, orice query pe pool brut vede
   tot") era greșită ca descriere a produsului: într-o instalare de producție
   rolul motorului e `NOSUPERUSER NOBYPASSRLS`, deci un query pe pool brut
   vede ce-i lasă politicile, nu tot. Pariul care rămâne real e altul, și e
   mai îngust: **o cale care sare de la rolul proprietar la `zveltio_rls`
   scapă de sub granița per-firmă**, fiindcă proprietarul tabelei nu e supus
   politicilor decât prin `FORCE ROW LEVEL SECURITY`. De asta există porțile
   `check:tenant-on-pool` și `check:pooldb-txn`. Vezi `docs/MULTI-TENANCY.md`.
3. **Două sisteme numite „RLS" coexistă** — Postgres RLS (real) și
   `zvd_rls_policies` la nivel de aplicație, care cădea deschis pe valori
   nerezolvabile. **Reparațiile din rundele 1–3 (intrate pe master
   2026-08-31) mută regulile în politici Postgres; fail-open-ul la
   identitate lipsă rămâne deschis.**
4. Lanț de fallback al worker bridge-ului: `zveltio_worker` lipsă →
   `zveltio_rls` → niciun rol; pe Postgres managed fără CREATE ROLE rămâne
   doar string-matching-ul din `worker-sql-policy.ts` (instrument slab,
   recunoscut în cod).
5. Tabelele de colecții **nu au FK pe `tenant_id`** (0 constrângeri,
   verificat în catalog) — `applyTenantRLS` nu adaugă FK, spre deosebire de
   `enableRLS` legacy.

### Corecții la auditul inițial (greșeli de fapt, verificate)

- `provisionTenantSchema` / `tenantSchema` **NU sunt cod mort**:
  `provisionTenantSchema` e apelat la `routes/tenants.ts:182`, `tenantSchema`
  e setat la `middleware/tenant.ts:118` și consumat în
  `lib/data-quality.ts:377`. Schema-per-tenant există și e provizionată —
  doar că NU e calea de izolare (izolarea reală e shared-schema + coloană +
  RLS). „Nefolosit ca mecanism de izolare" ≠ „cod mort".
- `enableRLS` vs `applyTenantRLS` **NU e duplicare moartă**: ambele sunt
  apelate, din locuri diferite (`routes/tenants.ts:325`, respectiv
  `lib/data/ddl-queue.ts:277`).
- `tenantDbMiddleware` (`middleware/tenant-guard.ts:37`) rămâne într-adevăr
  definit și nemontat — singurul „cod mort" confirmat.

## Comparația cu concurența (research web 2026-08-31 — ipoteze, nu fapte)

Partea stângă e verificată în cod (Zveltio chiar face FORCE RLS cu rol
non-superuser per tranzacție; arborele de unități cu read_scope există și
funcționează). Partea dreaptă — ce fac Supabase, Hasura, Directus etc.
ASTĂZI — vine din documentația lor publică și **trebuie tratată ca ipoteze
bine argumentate, nu fapte verificate** (amendament owner: verificarea unei
afirmații de piață e altă meserie decât citirea codului).

Cu această rezervă:

| Platformă | Enforcement | Ierarhie nativă |
|---|---|---|
| **Zveltio** | Postgres FORCE RLS + rol non-superuser per tranzacție (verificat) | Da: arbore de unități, read_scope self/subtree/list/org (verificat) |
| Supabase | RLS real, dar `service_role` are BYPASSRLS; identitatea vine prin PostgREST/JWT | Nu (doar proiecte comunitare) |
| Hasura | Aplicație — session vars compilate în SQL | Documentat explicit: flat, non-ierarhic |
| Directus | Aplicație — permisiuni `$CURRENT_USER.tenant` | Nu |
| Appwrite | Aplicație — permisiuni pe documente (MariaDB) | Nu (teams flat) |
| Payload | Aplicație — Access Control functions | Nu (plugin oficial, flat) |
| PostGraphile | RLS real + GUC per tranzacție — cel mai apropiat tehnic | Nu; nu e BaaS complet |
| Salesforce | platformă proprietară | Ierarhie de roluri de persoane — singurul analog enterprise al read_scope |

Concluzii (cu rezerva de mai sus): tenancy ierarhic cu scope-uri de citire nu
apare nativ la niciun concurent self-hosted; enforcement real la nivel DB e
rar (Zveltio + PostGraphile pe patternul complet); izolarea extensiilor cu
rol DB dedicat pare fără echivalent. Poziția netă: Zveltio e în față pe
ambele axe, dar punctele de atac adversarial sunt fail-open-ul implicit și
pariul `zveltio_rls` — ambele cunoscute și pe lista de lucru.

## Metodologia de lucru cristalizată (aug 2026) — citește înainte să măsori ceva

Greșeala centrală a săptămânii 27–29 aug 2026: o săptămână de măsurători pe
o bază de date poluată de resturile propriilor teste (163 colecții-fantomă) a
produs „364 ms/decizie Casbin", fals, citat în două rapoarte; realul era
0,93 ms. Din asta derivă regulile curente:

1. **Fiecare cifră are o măsurătoare în spate** — „măsoară înainte de a
   construi", criteriile de succes se scriu ÎNAINTE de implementare.
2. **Porțile CI se dovedesc prin plantare de eșecuri** — 9 din 31 erau
   dovedite la audit; 7 porți fail-open (verde pe corpus gol) au fost
   reparate fail-closed; există meta-poarta `check-gate-coverage`.
3. **Un ✅ înseamnă că cineva a scris cod, nu că cineva l-a rulat** — lecția
   `dr-drill.sh` (script mort pe prima comandă, citat ca dovadă 2 luni).
4. Concluziile infirmate se păstrează cu corecții inline, nu se șterg.

Documente-cheie: `docs/private/HANDOFF-2026-08-29.md`,
`docs/private/MATURITY-REFACTOR-PLAN.md` (blocurile A–F, cel mai recent plan
mare), `docs/private/BLOCK-C-GATES-STATE.md`.

## Probleme cunoscute / decizii de fond valabile acum

- **Tranzacția pe cerere:** pinuirea de conexiuni venea din a DOUA rezervare
  de conexiune (rute pe `poolDb`), reparată prin `TXN_SKIP_PREFIXES` + poarta
  `check-pooldb-txn-skip` (`cfc3af59`). Rămân 13 handlere cu muncă non-DB în
  tranzacție — singurul motiv rămas pentru Blocul A din MATURITY-REFACTOR-PLAN.
  Detalii: `docs/private/TRANSACTION-BOUNDARY-HANDOFF.md`.
- **RLS coverage:** 20→16 tabele cu `tenant_id` fără politică, clasificate 11
  legitim inter-firme / 5 de acoperit. Detalii:
  `docs/private/TENANCY-COVERAGE-CLASSIFICATION.md`.
- **Predicatul RLS neindexabil:** schimbat de 3 ori; concluzia măsurată — ca
  politică, planificatorul nu estimează qual-ul de securitate; soluția e
  filtrul explicit de egalitate lângă politică, nu forma funcției. Tensiunea
  `= ANY(tablou)` vs scanare ordonată e declarată permanentă (Blocul F).
- **`0A000` intermitent în CI:** migrațiile extensiilor alterau
  `zvd_collections` după ce pool-ul pregătise planuri → planuri stale;
  remediat la `0dde0504`.
- **P0-urile de inginerie din TECHNICAL-GAPS.md: toate închise** (verificat
  2026-06-30 / beta.25). Ce rămâne spre „production maturity" e go-to-market
  (comunitate, case studies, support), nu cod.

## Repere de versiune (din CHANGELOG.md, 4600+ linii — grep, nu citi integral)

| Data | Versiune | Semnificație |
|---|---|---|
| 2026-04-03 → 05-31 | `1.0.0-alpha.48`–`.129` | dezvoltare intensă; .117–.129 închid modelul extensii v2 + worker isolation + marketplace |
| 2026-05-31 | `1.0.0-beta.1` | alpha EOL; extensions v2 API-stabil |
| 2026-06-14 | `3.0.0-beta.1` | renumbering (pachete npm orfane la 2.0.x); cod = beta.3 |
| iun–iul 2026 | beta.18–24 | multi-tenant enablement complet |
| 2026-07-15 | beta.30 | „the security release" (29 fix-uri tenant/IDOR, RFC 9457) |
| 2026-07-16/17 | beta.31→32 | ADR 0001 + pivotarea app-first/public opt-in |
| 2026-07-31 → 08-29 | beta.42–64 | hardening profund: migrații cu checksum, perf Casbin, SDUI, tenancy ierarhic, porți dovedite |
| viitor | v1.0 GA | criterii codificate în `scripts/release-gate.ts` (H-16); apoi v1.1 (blue/green Studio), v1.2+ (Electric SQL, passkeys) |

Notă: beta.33–.41 lipsesc din CHANGELOG (salt .32 → .42). Documentația
publică din `docs/site/` rămâne uneori în urmă (menționează beta.12,
benchmarks din alpha.99) — la conflicte de versiune, sursa de adevăr e
`packages/engine/package.json`.
