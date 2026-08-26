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

1. **Măsoară raportul citiri/scrieri pe rutele reale.** Dacă 90% sunt citiri,
   A aduce aproape tot. Dacă e 55/45, aduce puțin. **Nu știu cifra** — e prima
   lucrare și decide dacă restul merită.
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
