# Stare — Blocul A: contextul de firmă devine explicit

> **Se citește la începutul fiecărui pas. Se actualizează după fiecare pas.**
> Branch: `block-a/explicit-context` · Plan: `MATURITY-REFACTOR-PLAN.md` §Blocul A.
> Ordinea C → B → F → **A**, aleasă după **ce se întâmplă dacă greșim**.
> C s-a închis cu 3 din 4, B cu 4 din 4, F cu 3 din 4 plus unul anulat — **niciunul cu
> criteriile rescrise după ce s-au văzut cifrele.**

---

## De ce e ultimul, și de ce e cel mai periculos

E **singurul bloc care poate rupe izolarea tăcut.** C și B au fost făcute înainte tocmai
ca o greșeală de aici să devină zgomotoasă în loc de invizibilă:

- un `finally` **sincron** a golit odată tranzacția devreme și a lăsat **302 politici
  inerte, cu testele verzi**;
- `zveltio_rls` a rămas odată cu 11 tabele din 378, și verdele venea din `NODE_ENV=test`.

Ambele s-au întâmplat în acest cod. Blocul trece prin exact același teren.

## Problema, așa cum e descrisă în plan

`registerCoreRoutes(app, { db: scopedDb, poolDb: db, auth })`. Acel `scopedDb` e un
`Proxy` al cărui `get` citește `getCurrentTenantTrx()` **la fiecare acces de proprietate**.
Un `Proxy.get` e **sincron** — nu poate aștepta deschiderea unei tranzacții. De aici, în
lanț: tranzacția se deschide înainte de handler, ține toată cererea, fixează o conexiune
din pool, iar la `DB_POOL_MAX` concurența se blochează.

---

## Criteriile punctului de validare — SCRISE ÎNAINTE DE MĂSURARE

1. **Plafonul de concurență s-a mutat, măsurat la aceeași `DB_POOL_MAX`** — aceeași bază,
   aceeași rută, aceeași sarcină. Nu „pare mai rapid": p95 la concurență peste pool.
2. **Nicio regresie de izolare.** Suita completă verde ȘI o probă care arată că o cerere
   fără context de firmă **nu** poate citi date de firmă.
3. **Orice sit ratat e eroare de compilare**, nu scurgere la rulare — asta e diferența
   dintre refactorizarea asta și cele două incidente de mai sus.
4. **Contractul SDK rămâne valid** pentru extensiile existente, sau are perioadă de
   tranziție scrisă.

**CRITERIU DE OPRIRE, scris acum:** dacă **pasul 1** arată că plafonul **nu se mută** —
că timpul în care conexiunea e ținută degeaba e mic față de durata cererii — blocul se
închide acolo. Restul pașilor nu se fac. Planul spune asta explicit, și e singurul bloc
căruia i s-a scris dinainte dreptul de a se opri la prima măsurătoare.

**Ce NU e criteriu:** eleganța. Un `db` explicit e mai verbos; asta nu e un argument nici
pentru, nici împotriva.

---

## Pași

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul ăsta | — | (la fiecare pas) |
| 1 | **Măsoară** cât e ținută efectiv o conexiune pe o cerere reală, față de cât ar fi cu tranzacții scurte | ✅ **FĂCUT** | plafonul e real; câștigul e ~2,3×, **nu „dispare”** |
| 2 | Inventar: siturile `reqDb`, `?? db`, și codul de extensie pe `ctx.db` | DE FĂCUT | — |
| 3 | Accesorul explicit, `async`, ca TypeScript să prindă siturile ratate | DE FĂCUT | — |
| 4 | Poartă: nicio interogare pe date de firmă în afara tranzacției | DE FĂCUT | — |
| 5 | Migrarea rutelor nucleu, bucăți de ~10, suita verde între ele | DE FĂCUT | — |
| 6 | Contractul SDK pentru extensii, cu tranziție | DE FĂCUT | — |
| 7 | **PUNCT DE VALIDARE** | DE FĂCUT | — |

---

## Măsurătoarea (pasul 1, 2026-08-30)

Motor viu pe `:3400`, colecție cu 50 000 de rânduri, `/api/data/benchrows?limit=25`,
sarcină reală prin HTTP cu sesiune god. Probe din `pg_stat_activity` în timpul sarcinii.

### Plafonul există, e exact la `DB_POOL_MAX`, și deasupra lui serviciul SE OPREȘTE

| `DB_POOL_MAX` | c | cereri | erori | p95 | stări în pool |
|---:|---:|---:|---:|---:|---|
| 10 | 5 | 2 146 | 0 | 19,6 ms | `idle in transaction×4` |
| 10 | **10** | **10** | **10** | **9 724 ms** | **`idle in transaction×10`, `active×1`** |
| 10 | 15 / 20 / 30 | = c | toate | ~11 975 ms | identic |
| 25 | 20 | 2 603 | 0 | 59,6 ms | — |
| 25 | **25** | **25** | **25** | **10 489 ms** | — |

Nu e o degradare, e o oprire: la `c = DB_POOL_MAX` fiecare conexiune e ținută
`idle in transaction` și **una singură lucrează**. Motorul refuză în loc să aștepte
(garda `pool_busy`, din lucrarea de limită de tranzacție), deci răspunde cu eroare în loc
să atârne — dar răspunde cu eroare.

**Plafonul se mută liniar cu `DB_POOL_MAX`, și cu nimic altceva.**

### Cât din timpul ținut e muncă reală

Douăzeci de probe în timpul unei sarcini la c=5, `DB_POOL_MAX=10`:

| | conexiuni |
|---|---:|
| `active` — muncă reală | **2,20** |
| `idle in transaction` — ținute degeaba | **2,85** |
| **fracțiunea de muncă reală** | **44%** |

### Ce înseamnă, și de ce corectează planul

Planul spune că, prin tranzacții scurte, **„plafonul de concurență dispare, fiindcă o
conexiune e ținută microsecunde, nu milisecunde"**. Măsurătoarea nu susține asta.

56% din timpul în care o conexiune e ținută e petrecut `idle in transaction`. Cu tranzacții
scurte, capacitatea la același pool ar crește cu aproximativ **1 / 0,44 ≈ 2,3×** — de la
c≈10 la c≈23 pe un pool de 10. Real, dar **nu nemărginit**, și nu „dispare".

**Rezerva la propria mea cifră:** 44% vine dintr-o sarcină sub saturație, pe o rută simplă
(o listare de 25 de rânduri) cu baza locală. O cerere cu mai multă muncă per apel ar
deplasa raportul în oricare direcție. Cifra e un ordin de mărime, nu o promisiune.

### Alternativa ieftină, măsurată alături

`DB_POOL_MAX` mută același plafon, liniar, **fără nicio schimbare de cod**: de la 10 la 25
plafonul urcă de la c=10 la c=25. E limitat de `max_connections / instanțe`, și e chiar
decizia de proprietar din §Blocul E.

Deci întrebarea nu e „merită plafonul mutat" — e **„merită mutat cu 2,3× prin cel mai
riscant refactor din plan, când o linie de configurație îl mută liniar"**. Asta e o decizie
de proprietar, nu de inginerie, și blocul se oprește aici până când e luată.

**Criteriul de oprire NU s-a activat literal** — 56% nu e „mic". Dar cifra e destul de
departe de promisiunea planului cât să nu deschid pașii 2–7 fără ca proprietarul să vadă
comparația.

## Varianta aleasă: 3 — configurația acum, refactorul când nu mai ajunge

Proprietarul a ales să ridice plafonul prin `DB_POOL_MAX` întâi, și să lase Blocul A
pentru când plafonul ridicat nu mai ajunge. Cele două nu se exclud, iar prima e gratuită.

**Și nu era nimic de construit.** Pârghia e deja expusă, măsurată și păzită:
`reportConcurrencyCeiling` tipărește la fiecare boot aritmetica — ce plafon ai, ce permite
serverul, câte instanțe încap — sugerează o valoare care încă lasă loc pentru patru
instanțe, și avertizează când sub două mai încap. Implicitul e **deliberat neridicat**, cu
motivul scris: un implicit e moștenit de fiecare instalare, inclusiv de cele cu mai multe
motoare pe un Postgres, unde 25 de fiecare l-au epuizat deja. Ridicarea e o decizie de
operator luată împotriva unui `max_connections` pe care l-a verificat.

Am verificat și că `scripts/bench-concurrency.ts`, la care trimite garda, **există** — o
recomandare care arată spre un script inexistent e chiar clasa `dr-drill.sh`.

### Ce am găsit totuși, și e real

**Codul construiește un pool de 25. Documentația publică spunea 10.**

`DEFAULT_DB_POOL_MAX = 25` în `db/index.ts`, dar `docs/site/CONFIGURATION.md` documenta
implicitul ca `10`. Un operator care își dimensionează `max_connections` din documentație
bugetează 10 pe instanță și primește 25 — de două ori și jumătate mai multe conexiuni
decât a planificat. A doua instanță pică cu *„sorry, too many clients already"*, exact
avertismentul pe care garda de boot îl tipărește.

E **a treia ortografie a aceluiași număr**. Primele două au fost reconciliate deja, printr-un
test scris tocmai pentru asta — `pool-max-single-source.test.ts`, care există fiindcă
`initDatabase` construia cu `?? 25` în timp ce `startup-guards.ts` raționa cu `?? 10`.
Testul păzea codul; copia pe care o citește **omul** a rămas pe dinafară.

Reparat, și adăugat la același test — dovedit prin revenire: cu `10` în documentație pică,
cu `25` trece.

## Pasul mic, făcut: căderea pe pool devine vizibilă

Întrebarea proprietarului care a produs pasul ăsta: *„dacă scapă de engine și de PgDog, nu
vine RLS-ul care protejează?"* Măsurat pe aceeași tabelă, cu `FORCE ROW LEVEL SECURITY` și
politica de producție:

```
pool brut, rol postgres              : 2 rânduri — A+B    ← RLS NU protejează
tranzacție de firmă, rol zveltio_rls : 1 rânduri — A      ← RLS protejează
```

**RLS-ul e real și funcționează, dar e ARMAT de tranzacție.** Motorul se conectează ca
`postgres` — `rolsuper=true`, `rolbypassrls=true` — iar un superuser ocolește RLS
întotdeauna. Protecția vine din `SET LOCAL ROLE zveltio_rls`, care coboară privilegiile, și
acel `SET LOCAL` trăiește exact în tranzacția pe care `?? pool` o sare. Nu e o a doua linie
de apărare acolo; **e aceeași linie.**

De aceea „deschide tranzacția mai târziu" n-a fost niciodată o schimbare mică: greșeala nu
se vede.

### Ce s-a construit

Un contor în `createRequestScopedDb`, cu `ZVELTIO_STRICT_TENANT_SCOPE=1` pentru cine îl
vrea zgomotos. Implicit **nu schimbă niciun comportament de producție** — se livrează ca
diagnostic, iar o aruncare aici pe un apel legitim de boot ar culca o instalare.

Plus `unscoped-fallback.test.ts`: trece cereri reale prin aplicația reală și cere ca
numărul să rămână zero. Al doilea caz produce o cădere **intenționat**, ca un zero să nu
poată fi un contor care nu se mișcă niciodată.

### Prima versiune era prea grosieră, și instrumentul a spus-o singur

La prima rulare a raportat **două căderi** în trei cereri obișnuite. Nu erau scurgeri:

| sit | tabela |
|---|---|
| `middleware/rate-limit.ts:23` | `zv_rate_limit_configs` |
| `ddl-manager.getCollections` | `zvd_collections` |
| `routes/tenants.ts:80` | `zv_tenants` |

**Toate trei sunt de instanță** — chiar clasificarea pe care Blocul B a stabilit-o și a
verificat-o 362/362. Un contor care nu deosebește o tabelă partajată de una de firmă
raportează cod corect drept scurgere, și așa se ajunge ca o poartă să fie oprită.

Reparat: contorul cunoaște acum granița, citită din `information_schema` la boot — după
migrațiile extensiilor, unde tabelele își capătă `tenant_id`. **Nu o listă generată**:
răspunsul e derivabil din baza însăși, deci n-are ce se învechi.

Deci Blocul B nu doar a clasificat granița — a făcut posibil instrumentul care o apără la
rulare. Ordinea C → B → F → A s-a plătit aici.

## Ce NU se atinge

- **Politica RLS, forma predicatului, clasificarea graniței.** B și F le-au închis.
- **Rolul de conectare al engine-ului.** Decis măsurat că nu se schimbă.
- **Ierarhia de firme.** Lucrare separată, necomisă.

---

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-30 | pas mic | Măsurat că **RLS nu protejează pe calea de cădere**: motorul e superuser, `rolbypassrls=true`; 2 rânduri pe pool-ul brut față de 1 în tranzacție. Contor + mod strict + test pe cereri reale. **Prima versiune a raportat 2 căderi care erau cod corect** pe tabele de instanță — reparat folosind granița din Blocul B, citită din `information_schema` la boot. |
| 2026-08-30 | decizie | Varianta 3 aleasă de proprietar: configurația acum, refactorul mai târziu. **Nimic de construit** — pârghia e deja expusă și păzită de `reportConcurrencyCeiling`, iar scriptul la care trimite există. **Dar documentația publică spunea `10` acolo unde codul construiește `25`** — a treia ortografie a unui număr ale cărui prime două fuseseră deja reconciliate printr-un test. Reparat și adăugat la acel test, dovedit prin revenire. |
| 2026-08-30 | 1 | **Plafonul e real și exact la `DB_POOL_MAX`** — la c=pool serviciul se oprește, cu toate conexiunile `idle in transaction` și una activă; verificat la pool 10 și 25. **Dar doar 56% din timpul ținut e degeaba**, deci tranzacțiile scurte ar da ~2,3×, nu „plafonul dispare" cum spune planul. `DB_POOL_MAX` mută același plafon liniar, fără cod. **Blocul se oprește la pasul 1 până la decizia proprietarului.** |
| 2026-08-30 | setup | Document scris, criterii fixate ÎNAINTE de măsurare. Pasul 1 are dreptul declarat să închidă blocul. |

---

## Context care nu trebuie re-descoperit

- **Măsurătoarea de referință care există deja:** `/api/insights` încremenea la
  `c = DB_POOL_MAX` — 10 conexiuni `idle in transaction`, 0 `active`. Reparat prin mutarea
  rutelor pe `poolDb` (v. `project_transaction_boundary_2026_08_26`). Deci calea aia e deja
  scoasă din tranzacție; blocul ăsta e despre restul.
- **Nu opri motoare cu `pkill -f`** — după PID. `/opt/zveltio` (`:3000`) și sesiunile
  celorlalți rulează pe aceeași mașină. Portul meu e `:3400`.
- **Baza de referință:** schema engine + **jumătățile UP** ale migrațiilor de extensii
  (`awk '/^-- DOWN[[:space:]]*$/{exit}'`). 81 de migrații au secțiune DOWN; `psql -f` pe
  fișierul întreg creează tabelele și apoi le șterge, cu `rc=0`.
- **Env fără de care testele mint:** `ZVELTIO_REGISTRATION_ENABLED=1`,
  `FIELD_ENCRYPTION_KEY=<64 hex>`, `TEST_PORT`, `TEST_DATABASE_URL`, pe linii separate.
