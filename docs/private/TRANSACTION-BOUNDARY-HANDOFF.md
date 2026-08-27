# Mutarea limitei de tranzacție — context de implementare

*Scris 2026-08-26, după sesiunea în care problema a fost măsurată. Tot ce e aici
e verificat în cod sau măsurat, nu dedus. Unde nu știu, scrie că nu știu.*

---

## 1. Problema, în două propoziții

`tenantMiddleware` deschide o tranzacție și rulează **toată cererea** înăuntrul
ei, fiindcă RLS are nevoie de `SET LOCAL ROLE` + un GUC, iar `SET LOCAL` trăiește
doar într-o tranzacție. O tranzacție ține o conexiune din pool, deci **fiecare
cerere autentificată blochează o conexiune de la `BEGIN` până la răspuns** —
inclusiv cât așteaptă rețeaua sau randează un PDF.

## 2. Dovada

`scripts/bench-concurrency.ts`, pe `/api/me` (cea mai ușoară rută autentificată,
3ms la o singură cerere), `DB_POOL_MAX=10`, două rulări identice care diferă
printr-un singur header:

| concurență | fără `x-tenant-slug` | cu `x-tenant-slug` |
|---|---|---|
| 15 | 23ms, 643 req/s | 21ms, 689 req/s |
| **20** | **29ms, 670 req/s, 0 erori** | **p99 10 401ms, 22 req/s** |
| **30** | **44ms, 683 req/s, 0 erori** | **p95 23 809ms, 5 req/s, 36 eșecuri** |

Fără tranzacție degradarea e lină. Cu ea, prăpastie. Al doilea control: la
`DB_POOL_MAX=40` prăpastia dispare dincolo de c=80 — deci contenția e pe
conexiuni, nu pe costul lucrului.

**Atenție la ce NU dovedește:** la concurență mică varianta cu tranzacție e mai
*rapidă* (7ms vs 10ms la c=5), fiindcă nu reia conexiunea la fiecare interogare.
Orice înlocuire trebuie măsurată la ambele capete, nu doar la vârf.

## 3. Unde e, exact

| ce | fișier |
|---|---|
| deschiderea tranzacției pe cerere | `packages/engine/src/middleware/tenant.ts` (~l. 89) |
| ce se aplică înăuntru | `lib/tenancy/tenant-manager.ts` (~l. 697): `SET LOCAL ROLE zveltio_rls`, `set_config('zveltio.current_tenant', …, true)` |
| predicatul politicilor | `zveltio_tenant_scope_ok(uuid)`, în `db/migrations/sql/001_initial.sql` |
| proxy-ul `ctx.db` al extensiilor | `lib/tenancy/tenant-context.ts` (~l. 153) |
| rezervarea conexiunii | `db/bun-sql-dialect.ts` |
| lista rutelor care sar tranzacția | `TXN_SKIP_PREFIXES` în `middleware/tenant.ts` |

## 4. Ce trebuie să rămână adevărat

1. **Nicio conexiune nu se întoarce în pool cu rol sau GUC de firmă pe ea.** Azi
   Postgres garantează asta: `SET LOCAL` moare la `COMMIT`. Orice variantă care
   mută curățarea în cod trebuie să aibă un test care ia o conexiune, îi pune rol
   și GUC, o eliberează, o reia, și dovedește că e curată.
2. **Extensiile nu capătă o a doua cale de acces.** `ctx.db` rămâne singurul
   mâner, și rămâne delimitat.
3. **`rls_bypass` din `zv_api_keys` nu devine mecanismul de nimic.**

## 5. Ce am aflat și contează

- **Kysely refuză `.transaction()` pe un `Transaction`** — „calling the
  transaction method for a Transaction is not supported". Reprodus.
- **Proxy-ul `ctx.db` interceptează `transaction` și o ALIPEȘTE**
  (`execute: fn => fn(trx)`). Deci cele ~45 de tranzacții explicite adăugate în
  campania de atomicitate sunt azi declarative și **devin reale exact când se
  mută limita**. Aia era precondiția, și e făcută.
- **Corolar neplăcut:** o santinelă aruncată și prinsă nu anulează nimic azi.
  Devine corectă post-mutare. Nu e mai rea decât un `return`, dar nu te baza pe
  ea până atunci.
- **`routes/sync.ts` folosește `c.get('tenantTrx')` direct** — acolo
  `.transaction()` ar arunca. Vezi `_reasons` în `quality-gates/atomic-writes.json`.
- **`withTenantIsolation` există și e deja folosit** de joburile de fundal
  (`runImport`, `runExportJob`) ca să-și deschidă singure tranzacția. E tiparul
  de urmat, nu unul de inventat.

## 6. Variante

**A. Micșorează limita la unitatea de lucru.** Middleware-ul nu mai deschide
nimic; citirile iau context pe interogare, scrierile deschid tranzacție explicită
(ce fac deja handlerele). *Recomandată.*

**B. `SET` de sesiune la împrumut + `DISCARD ALL` la eliberare.** Fără
tranzacție deloc. **Mută garanția de la Postgres în codul nostru** și e
**incompatibilă cu poolerul în mod tranzacție.** Nu o alege fără un motiv care
bate punctul 4.1.

**C. Nu face nimic la limită, doar ridică pool-ul.** Deja făcut: 60 în
`docker-compose.yml`, 25 default. Cumpără spațiu, nu elimină clasa.

## 7. Ordinea sugerată

1. **Raportul citiri/scrieri — măsurat parțial, 2026-08-26.**

   Pe *suprafața de rute*: 535 `GET` față de 750 mutante — **42% citiri**, și
   aproape identic în ambele repo-uri (engine 42%, extensii 41%).

   **Dar suprafața nu e traficul.** Un API CRUD are prin construcție cam o
   citire la o scriere (listă, element, creare, modificare, ștergere), în timp
   ce folosirea reală a unei aplicații de business e dominată de citiri: oamenii
   răsfoiesc liste mult mai des decât salvează înregistrări. Cifra de 42% e deci
   o **limită inferioară** a câștigului, nu o estimare a lui.

   Raportul adevărat se poate scoate doar dintr-o instalare reală, din
   `requestLogMiddleware`, care scrie deja metoda și durata:

   ```sql
   SELECT method, count(*), round(avg(duration_ms)) FROM zv_request_logs
   WHERE created_at > now() - interval '7 days' GROUP BY method ORDER BY 2 DESC;
   ```

   Nu există azi nicio instalare în producție de pe care să se citească, deci
   **asta rămâne prima lucrare când apare una.** Ce se poate spune fără ea: cel
   puțin 42% din suprafață încetează să pinuiască o conexiune, iar traficul real
   înclină în sus, nu în jos.
2. **Testul de conexiune curată** (punctul 4.1), înainte de orice schimbare.
   Trebuie să pice pe codul de azi dacă îl rulezi pe o cale care nu curăță.
3. Mută citirile. Scrierile rămân cum sunt.
4. Abia apoi poolerul pe mod tranzacție — și el cere întâi **rutare pe
   componentă**: `index.ts:406` face din `NATIVE_DATABASE_URL` un ocol GLOBAL,
   deci azi nu poți trimite pg-boss și Better Auth pe direct și restul prin
   pooler. `ddl-queue.ts:87` ia `DATABASE_URL`, care în compose e poolerul.
   Autobuzul de realtime face deja lucrul corect — copiază-l de acolo.

## 8. Cum se verifică

- `bun run scripts/bench-concurrency.ts <url> <cookie> "1,10,20,30,50,80" 300 "x-tenant-slug: <slug>"`
  — cifrele de referință sunt în antetul scriptului.
- `bun run scripts/report-slow-in-transaction.ts` — 13 rute țin o conexiune peste
  muncă non-bază. După mutare ar trebui să nu mai conteze.
- Harness: `NODE_ENV=test ZVELTIO_REGISTRATION_ENABLED=1 FIELD_ENCRYPTION_KEY=$(openssl rand -hex 32) TEST_DATABASE_URL=…/<bază proaspătă>`
  — 800/800. **Bază nouă de fiecare dată**; una lăsată de o rulare întreruptă dă
  ~21 de eșecuri false.

## 9. Ce să nu faci

- Să nu implementezi B fără testul de la 4.1.
- Să nu ridici `DB_POOL_MAX` ca „remediu" — plafonul e `max_connections ÷
  instanțe`, iar poolerul e livrat în `pooler_mode = "session"`, unde nu
  multiplexează.
- Să nu presupui că tranzacțiile explicite din extensii te acoperă. Ele rezolvă
  *ce se comite împreună*; conexiunea e pinuită de tranzacția de deasupra lor.

---

## 10. Remăsurat 2026-08-26, pe `feat/tenancy-hierarchy`

*Prima lucrare din §7 (raportul citiri/scrieri) cere o instalare în producție,
care nu există. A doua — testul de conexiune curată — e făcută. Pe drum,
măsurătoarea din §2 nu s-a mai reprodus, iar motivul schimbă recomandarea.*

### §2 nu se mai reproduce — și de ce

Instanță vie pe `:3399`, `DB_POOL_MAX=10`, `/api/me`, aceleași două rulări care
diferă printr-un singur header:

| concurență | fără `x-tenant-slug` | cu `x-tenant-slug` |
|---|---|---|
| 20 | 29ms p50, 685 req/s | 30ms p50, 670 req/s |
| 50 | 73ms p50, 683 req/s | 74ms p50, 668 req/s |
| 80 | 119ms p50, 670 req/s | 122ms p50, 640 req/s |
| **120** | **178ms p50, 0 erori** | **177ms p50, 0 erori** |

Cele două curbe sunt **indistinctibile până la c=120**, cu un pool de 10. Nicio
prăpastie, niciun eșec. `pg_stat_activity` în timpul rulării arată 8–9 conexiuni
`idle in transaction`, deci tranzacția chiar se deschide — mecanismul din §1 e
real, dar **nu mai costă**.

Cauza prăpastiei din §2 era **a doua rezervare**, nu tranzacția: o cerere ținea o
conexiune rezervată ȘI cerea alta din pool. Comentariul din `db/index.ts` spune
că golul acela a fost închis între timp — `createRequestScopedDb` dă rutelor
proxy-ul care rezolvă tranzacția curentă și atinge pool-ul doar când nu există
una. Măsurătoarea din §2 a prins codul de dinainte.

### Precizare: §2 se reproduce în continuare pe `master` (2026-08-27)

Măsurătoarea de mai sus e corectă, dar titlul induce în eroare. Am rulat
controlul: `master`, bază curată, aceeași rută, același header, `DB_POOL_MAX=10`.

| concurență | `master` | `feat/tenancy-hierarchy` |
|---|---|---|
| 15 | 23ms, 600 req/s | 26ms, 555 req/s |
| **20** | **p99 10 371ms, 23 req/s** | **33ms, 607 req/s** |
| **30** | p50 11 839ms, **125 din 240 eșuate** | 50ms, 0 eșecuri |

Deci nu „măsurătoarea din §2 nu se mai reproduce" — **se reproduce exact pe
`master`.** Ce s-a schimbat e că `cfc3af59` a închis cauza. Diagnosticul a doua
rezervare de conexiune e corect; ce nu e corect e sugestia că era închisă
dinainte.

Nuanța contează pentru cine citește mai târziu: dovada din §2 nu era falsă și nu
trebuie scoasă. E **istorică**, și explică de ce a fost făcută reparația. Fără
precizarea asta, cineva care revine peste un an ar putea conchide că problema
n-a existat niciodată, și ar putea da înapoi reparația.

Concluzia despre recomandarea A rămâne însă valabilă, doar cu alt motiv: A își
pierde dovada principală pentru că problema **a fost rezolvată**, nu pentru că
n-a existat.

### Prăpastia mai există exact unde a doua rezervare a rămas

`insightsRoutes`, `backupRoutes`, `sqlEditorRoutes` și `flowsRoutes` primesc
`poolDb` **explicit**. Ele rulează pe pool în timp ce cererea ține deja o
tranzacție — deci cer a doua conexiune. Pe `/api/insights/dashboards`:

| concurență | înainte | după |
|---|---|---|
| 5 | 10ms p50, 0 eșecuri, 530 req/s | 10ms p50, 457 req/s |
| **10** | **12 000ms p50, 20 520ms p95, 55 din 60 eșuate, 1 req/s** | **15ms p50, 0 eșecuri, 629 req/s** |
| 15 | (blocat) | 19ms p50, 791 req/s |
| 50 | (blocat) | 52ms p50, 870 req/s |

`pg_stat_activity` în rândul din mijloc: **zece conexiuni `idle in transaction`,
zero `active`.** Nu încărcare — încremenire. Și se întâmplă exact la
`c = DB_POOL_MAX`, nu treptat.

**Reparat** adăugând cele patru prefixe în `TXN_SKIP_PREFIXES`. E sigur fiindcă
niciunul nu citește `tenantTrx`: `insights` și `flows` filtrează explicit prin
`tenantOf(c)` — trebuie, fiind pe pool — iar `backup` și `sql-editor` n-au deloc
noțiune de firmă. `/api/users` **nu** e în listă: ia `poolDb` ca al treilea
argument, doar ca să revoce sesiuni la ștergere, și rulează restul pe tranzacția
cererii.

Poarta `scripts/check-pooldb-txn-skip.ts` (în `prepush`) ține lista și
`routes/index.ts` de acord, ca un router mutat pe `poolDb` mâine să nu
reintroducă încremenirea tăcut. Verificat că pică pe cazul pe care îl păzește.

### Ce înseamnă pentru §6

**Recomandarea A („micșorează limita la unitatea de lucru") își pierde dovada
principală.** Ea se sprijinea pe tabelul din §2; acel tabel măsura a doua
rezervare, iar aceea e acum închisă în ambele locuri unde apărea. Pentru o rută
care ține **o** conexiune și nu cere a doua, tranzacția pe cerere nu costă nimic
măsurabil până la c=120.

Ce rămâne real e **§8, punctul doi**: 13 handlere care țin o conexiune peste
muncă non-bază (apeluri HTTP către ANAF, generare PDF, încărcare în object
storage, conectare la un server de mail). Acelea chiar țin o conexiune secunde
întregi.

**Dar nu se pot repara din extensii.** Tranzacția e deschisă de
`tenantMiddleware` pentru toată cererea; `ctx.db` doar o rezolvă. O extensie nu
are cum să o închidă la mijlocul handlerului, iar a le pune în
`TXN_SKIP_PREFIXES` le-ar lăsa fără RLS, ceea ce nu e o opțiune. Deci cele 13
cer chiar mutarea limitei din gazdă — dar acum pentru **motivul corect** (muncă
lentă în tranzacție), nu pentru cel din §2, și cu o rază mult mai mică: rutele
care fac muncă non-bază, nu toate citirile.

Asta e o decizie de proprietar, fiindcă schimbă felul în care fiecare rută
primește mânerul de bază de date. Testul de la §7.2 există acum tocmai ca să o
poată judeca: `src/tests/harness/connection-hygiene.test.ts`.

### §7.2 — testul de conexiune curată, făcut

`packages/engine/src/tests/harness/connection-hygiene.test.ts`. Pool fixat la
**o singură conexiune**, ca „aceeași conexiune fizică" să fie singura
posibilitate, cu `pg_backend_pid()` verificat, nu presupus. Trei cazuri: rolul și
GUC-urile nu supraviețuiesc tranzacției; noile `visible_tenants` /
`ancestor_tenants` nu supraviețuiesc nici ele; și — cazul care le ține pe
primele două oneste — **detectorul chiar vede o conexiune murdară**, printr-un
`SET` de sesiune deliberat, urmat de `DISCARD ALL`, care e rețeta pe care ar
trebui să o folosească varianta B.
