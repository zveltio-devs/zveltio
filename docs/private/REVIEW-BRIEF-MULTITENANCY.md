# Brief pentru un audit independent al izolării pe firme

Scris pentru cineva care nu cunoaște codul. Scopul lui nu e să explice ce e bine,
ci **să scurteze drumul până la ce e prost** — și să nu se piardă timp pe piste
deja măsurate ca false.

---

## 1. Ce e sistemul, în trei rânduri

Zveltio e un BaaS self-hosted: motor Bun + Hono, Postgres, extensii care rulează
în același proces. O instalare servește **mai multe firme** (corporații cu
societăți, instituții cu unități subordonate — ierarhic, nu plat).

Piața țintă e **self-hosted, adesea fără Valkey**. Asta contează la audit: multe
căi au un cache Redis/Valkey în față, iar pe instalarea tipică acel cache **nu
există**, deci ramura „fără cache" e ramura de producție, nu cea excepțională.

---

## 2. Unde stă izolarea, de fapt — patru straturi

Un auditor care nu știe asta va judeca stratul greșit.

| strat | ce decide | unde rulează | ce se întâmplă dacă e uitat |
|---|---|---|---|
| **1. Casbin** | dacă utilizatorul are voie să facă *acțiunea* | motor | scurgere |
| **2. Politici RLS pe `tenant_id`** | *care rânduri* vede sesiunea | Postgres | nimic — baza refuză |
| **3. Reguli de rând ale produsului** | „vezi doar ce ai creat" etc. | Postgres (generate) **și** motor | nimic — baza refuză |
| **4. `where tenant_id = …` explicit** | performanță, plus curea | motor | de obicei nimic (2 acoperă) |

**Faptul arhitectural cel mai important:** motorul se conectează la Postgres ca
**superutilizator** (`rolbypassrls`). Politicile NU se aplică pe conexiunea de
pool. Se aplică doar înăuntrul tranzacției cererii, unde
`withTenantIsolation` face `SET LOCAL ROLE zveltio_rls` și publică variabilele de
sesiune.

**De aici decurge întrebarea centrală a auditului:** *ce cod atinge date de firmă
în afara acelei tranzacții?* Orice astfel de loc ocolește straturile 2 și 3 în
întregime.

---

## 3. Fișierele care contează

```
packages/engine/src/lib/tenancy/tenant-manager.ts   withTenantIsolation, GUC-urile, politicile
packages/engine/src/lib/tenancy/tenant-context.ts   AsyncLocalStorage, createRequestScopedDb
packages/engine/src/lib/tenancy/rls.ts              getRlsFilters / applyRlsFilters / matchesRlsFilters
packages/engine/src/lib/tenancy/row-rule-policy.ts  generatorul de politici din reguli  ← CEL MAI NOU
packages/engine/src/lib/tenancy/permissions.ts      Casbin, isGodUser, resolveUserRole
packages/engine/src/middleware/tenant.ts            deschide tranzacția, publică identitatea
packages/engine/src/middleware/session-prefetch.ts  rezolvă sesiunea ÎNAINTE de tranzacție
packages/engine/src/lib/route-db.ts                 reqDb(c, db) — tiparul corect
packages/engine/src/db/index.ts                     pool-ul, dimensionarea, urmărirea conexiunilor
packages/engine/src/db/migrations/sql/004,005,008   ierarhia, forma predicatului, un singur god
```

Invariantele sunt scrise ca teste, nu ca documentație:

```
tests/harness/row-rules-in-database.test.ts     regulile se aplică cu WHERE-ul UITAT intenționat
tests/harness/god-enforced-by-database.test.ts  god trece prin politici, nu pe lângă ele
tests/harness/second-reservation.test.ts        nicio cerere nu ia o a doua conexiune
tests/harness/*tenant-isolation*.test.ts        pe tabelă și pe rută
```

---

## 4. Invariantele — formulate ca afirmații testabile

Un audit util **încearcă să le spargă**, nu le rezumă.

1. O cerere a firmei A nu poate citi și nu poate scrie rânduri ale firmei B —
   **nici dacă handler-ul își uită complet filtrele**.
2. Un `god` e **unul singur pe instanță** și e singurul care instalează extensii.
   Vede peste firme **prin politici**, nu ieșind din ele.
3. O regulă de rând (`zvd_rls_policies`) înseamnă **exact același lucru** aplicată
   de motor și aplicată de bază. Dacă diverg, sunt două surse de adevăr.
4. O cerere ține **o singură** conexiune. A doua, cerută cât timp o ține pe prima,
   oprește instanța la `c = DB_POOL_MAX` — nu o încetinește, o oprește.
5. O extensie oprită pentru firma B **nu acționează** pentru B, pe niciuna dintre
   căile prin care poate acționa (rute montate în trei feluri, hook-uri, cron).
6. Ce nu poate fi exprimat în bază **nu e aplicat pe jumătate** — ori întreg, ori
   deloc, și se spune care.

---

## 5. Piste deja măsurate — NU le raporta ca descoperiri

Fiecare a costat deja timp cuiva.

- **„Politicile RLS nu pot folosi indexul"** — FALS. S-a greșit de două ori, în
  direcții opuse. Forma predicatului decide: `= ANY(array)` nu conduce o parcurgere
  ordonată, egalitatea explicită da. 415 → 204 → 129 ms, măsurat.
- **„God e verificat după numele rolului"** — a fost adevărat și era **cod mort**;
  e o permisiune acum (`data:view_all`). Dacă găsești o comparație cu `'god'`
  într-un predicat, aia e o regresie reală — dar verific-o, nu o presupune.
- **`broadcastSSE` cod mort** — nu e. **„mail iframe XSS"** — fals.
- **Twilio, postgis authz** — reparate. **Sesiuni la ștergerea userului, Valkey,
  DLQ webhooks** — închise.
- **`session.user.role` e gol** — nu e declarat în better-auth. Codul care se
  bazează pe el e mort, nu periculos; a fost deja curățat unde conta.
- **Antetul e `x-tenant-slug`**, nu `x-tenant-id`, pentru selecția firmei. Un
  `x-tenant-id` folosit ca sursă de adevăr **e** un defect — unul a fost găsit și
  reparat la instalarea extensiilor; mai pot fi.
- **Extensiile se încarcă la nivel de instanță**, într-un singur proces. „Încarcă
  doar pentru firma B" nu există și nu e o constatare.

---

## 6. Ce s-a schimbat în ultimele două zile — deci e cel mai puțin bătătorit

Aici e cea mai mare probabilitate de defect, fiindcă e cel mai recent:

1. **`row-rule-policy.ts`** — generează politici Postgres RESTRICTIVE din regulile
   produsului. **Întrebarea cea mai valoroasă a întregului audit:** există vreo
   combinație (operator × sursă de valoare × tip de coloană × NULL × rol) în care
   predicatul generat înseamnă **altceva** decât `getRlsFilters`? Un exemplu
   concret valorează mai mult decât zece observații generale.
2. **Un singur god + recuperarea transferă rolul** (migrația 008,
   `routes/permissions.ts`). Cine deține un jeton de recuperare valid ia rolul de
   la deținătorul actual. E intenționat. E și corect?
3. **Patru amânări cu `setTimeout(…, 0)`** (`request-log`, `god-audit`,
   `slow-query`, refacerea politicilor de reguli). Presupun că tranzacția s-a
   închis până la bătaia următoare. E adevărat azi; **nu e garantat de nimic
   scris**. Ce se întâmplă sub presiune, sau dacă handler-ul aruncă?
4. **Cache-uri în proces de 5 secunde** pentru `isGodUser` și `resolveUserRole`.
   Un god retrogradat păstrează puterea până la 5 s **pe o instanță soră** —
   `DEL`-ul ajunge la Valkey, harta din memorie nu. Acceptabil? Ce cale de atac
   deschide?
5. **Dimensionarea automată a pool-ului** din `max_connections`, împărțit la
   `ZVELTIO_INSTANCES`. Ce se întâmplă dacă e declarat greșit?

---

## 7. Ce vreau înapoi, și în ce formă

**Fiecare constatare trebuie să spună cum se reproduce.** Nu „ar putea exista o
scurgere", ci: cererea, starea, rândurile așteptate, rândurile obținute.

Pentru fiecare, marchează explicit:

- **EXECUTAT** — am rulat asta și am văzut rezultatul; sau
- **CITIT** — deduc din cod, nu am rulat.

Ambele sunt utile. Confundate, nu.

**Ordonează după consecință, nu după cât de ușor e de reparat.** O scurgere între
firme bate zece nume de variabile.

**Spune și ce ai verificat și e în regulă**, mai ales pe lista de invariante de la
§4 — un audit care raportează numai probleme nu spune cât din suprafață a fost
atins.

Dacă ceva pare greșit dar testele îl acoperă, **citește testul** înainte de a
raporta: s-ar putea ca testul să fie cel greșit, și aia e o constatare mai bună.

---

## 8. Cum se rulează, dacă vrei să execuți

```
scripts/setup-test-db.sh                      # Postgres 18 + pgvector
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/<baza_ta>
export ZVELTIO_REGISTRATION_ENABLED=1         # fără el, ~240 de teste pică din alt motiv
bun test packages/engine/src/tests/harness --timeout 30000
```

**Bază proprie**, nu `zveltio_test`: are lanțul de migrații divergent, iar două
sesiuni pe aceeași bază își strică rezultatele reciproc — eșecurile arată a
regresie, nu a coliziune.

Pentru a vedea cine ia o a doua conexiune:
`ZVELTIO_TRACE_CONNECTIONS=1`, apoi antetul `x-zveltio-extra-connections`.
