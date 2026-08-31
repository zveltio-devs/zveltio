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
| 2 | Inventar | ✅ | **89 de situri — dar inventarul NU e reparația. Vezi mai jos.** |
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

## Modelul de administrare — cerut de proprietar, 2026-08-30

**Un singur superadmin pe instanță (`god`), care instalează extensiile. Administratori
per firmă, care gestionează doar firma lor. Iar când god creează o firmă, trebuie să fie
obligat să creeze și administratorul ei.**

### Ce era, măsurat

`requireInstanceAdmin` = god **SAU** admin al firmei implicite. Al doilea braț e potrivit
pentru majoritatea operațiilor de instanță și greșit pentru instalare: pune **cod nou** pe
instanță, iar migrațiile unei extensii pot altera tabelele engine-ului — extensia `ai`
adaugă trei coloane la `zvd_collections`, măsurat azi. Într-un holding, firma implicită e
compania-mamă, deci administratorul ei ar decide ce cod rulează la filiale.

**Făcut:** zece operații care schimbă instanța — install, enable, enable-all, disable,
config, uninstall, aprobarea capabilităților, plus cele trei de licență — trec de la
`requireInstanceAdmin` la `isGodUser`. Cele două rute de **citire** rămân pe admin: a
vedea ce s-ar putea instala nu strică nimic, iar retragerea lor ar goli pagina din Studio.

Consecință, spusă nu descoperită: **o instanță fără god nu mai poate instala nimic** până
la `zveltio create-god`. Aia e forma cerută, nu o scăpare.

### Activarea per firmă: era IMPOSIBILĂ, nu doar neimplementată

Migrația `070` a adăugat `zv_extension_registry.tenant_id` cu comentariul *„NULL =
instanță, setat = doar acea firmă"*, plus două indexuri, iar listarea din marketplace îl
respecta. **Dar `UNIQUE (name)` pe aceeași tabelă face ca o extensie să aibă exact un rând**
— iar `onConflict` e chiar pe `name`, deci fiecare instalare suprascrie tenant-ul.
Dovedit:

```
INSERT ai pentru firma-A  → ok
INSERT ai pentru firma-B  → ERROR: duplicate key ... Key (name)=(ai) already exists
```

Deci `tenant_id` putea reține doar **cine a instalat ultimul**. Încărcătorul, care îl
ignora, avea din întâmplare singurul comportament corect — iar listarea arăta unei firme o
extensie ca absentă în timp ce codul ei rula pentru toată lumea.

**Făcut:** listarea raportează acum ce face runtime-ul — activă dacă **orice** rând al ei e
activ. Coloana și indexurile rămân, cu explicația lângă ele.

**Ce ar cere activarea reală per firmă**, acum că se știe: cheia unică lărgită de la
`(name)` la `(tenant_id, name)` — campania din `005_tenant_scoped_unique_keys` — **plus**
gating per cerere, fiindcă extensiile își înregistrează rutele și hook-urile într-un singur
proces. Nu e un filtru pe o interogare de încărcare.

### O firmă nu se mai poate crea fără administratorul ei

`admin_user_email` era validat ca **format de e-mail**, niciodată ca utilizator existent. O
greșeală de tastare producea o firmă fără apartenență și fără rol Casbin — și un **201**
care spunea că a mers. Comentariul rutei descria exact asta ca fiind eșecul de evitat:

> *„A tenant row with no membership is a tenant NOBODY can reach… only an instance admin
> querying the table directly would ever find out it exists."*

Intenția era scrisă, codul făcea invers.

**Reparat**, cu o capcană pe drum care merită păstrată: prima versiune întorcea o valoare
din tranzacție, deci **firma rămânea scrisă** — `return` dintr-o tranzacție COMITE, exact
lecția campaniei de scrieri atomice. Testul a prins-o fiindcă verifică tabela, nu doar
codul de stare. Acum aruncă, deci se derulează înapoi.

## Ce NU se atinge

- **Politica RLS, forma predicatului, clasificarea graniței.** B și F le-au închis.
- **Rolul de conectare al engine-ului.** Decis măsurat că nu se schimbă.
- **Ierarhia de firme.** Lucrare separată, necomisă.

---

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-30 | model | Instalarea extensiilor trece pe **god** (10 operații); citirea rămâne pe admin. **Activarea per firmă era IMPOSIBILĂ** — `UNIQUE (name)` pe registry, dovedit; listarea spune acum adevărul. **O firmă nu se mai poate crea fără administratorul ei** — `admin_user_email` era validat doar ca format. Prima versiune a reparației lăsa firma scrisă (`return` dintr-o tranzacție comite); reparat prin aruncare. |
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


---

## Pasul 2 — inventarul, și de ce planul măsura lucrul greșit (2026-08-30)

Inventarul cerut de pas există: **89 de situri** — 46 `reqDb(`, 18 `c.get('tenantTrx')`,
9 `getCurrentTenantTrx()`, 16 căderi `?? db`. Ăsta ar fi refactorul.

Înainte de a-l începe, am măsurat **ce se întâmplă efectiv în timpul în care conexiunea e
ținută**, fiindcă planul spune că tranzacția e ținută prea mult.

### Nu e ținută mult

Instrumentare temporară pe granița tranzacției, sarcină reală prin HTTP:

| | total în tranzacție | până la prima interogare | după ultima | interogări |
|---|---:|---:|---:|---:|
| listare caldă | **1,59 ms** | 0,39 ms | 0,05 ms | 9 |
| listare rece | 10,39 ms | 1,32 ms | 0,10 ms | 34 |

**La margini nu e aproape nimic de tăiat.** O tranzacție de 1,6 ms nu explică un plafon.

### Ce e, de fapt: **a doua rezervare**

O singură cerere, fără nicio concurență:

```
DB_POOL_MAX=1   GET /api/data/spanrows?limit=25   → niciun răspuns, 8,85 s, tăiat
DB_POOL_MAX=2   aceeași cerere                    → 200 în 62 ms
```

**O cerere are nevoie de două conexiuni deodată.** Ține una pentru tranzacția de firmă și
cere pool-ului alta — `checkAccess`, `getColumnAccess`, `DDLManager.getCollection`,
`getVirtualConfig`: șase situri numai în `list.ts`, toate pe `db`, adică pe pool. Sunt
acolo dintr-un motiv real: în tranzacție sesiunea rulează ca `zveltio_rls`, care nu poate
citi ce le trebuie.

**Asta explică exact forma măsurătorii de la pasul 1**, care altfel e ciudată: prăbușirea
e la `c = pool`, nu la `c = pool / 2`. Sub plafon rămâne mereu o conexiune liberă care
poate servi a doua cerere; **la plafon fiecare conexiune e ținută de o tranzacție al cărei
proprietar așteaptă o a doua care nu mai poate veni.** De-asta se vede
`idle in transaction × 10, active × 1` — și de-asta serviciul se oprește în loc să
încetinească.

### Ce înseamnă pentru bloc

Planul propunea un refactor de 89 de situri ca să scurteze tranzacțiile. **Măsurătoarea
spune că tranzacțiile nu sunt problema.** Reparația e alta și e mai mică: **o cerere nu
are voie să ceară pool-ului o a doua conexiune cât timp ține una.** Fie se citesc
metadatele ÎNAINTE de a deschide tranzacția — tiparul există deja în cod, `sessionPrefetch`
face exact asta, cu un comentariu care spune de ce — fie rolul `zveltio_rls` primește
dreptul de citire pe tabelele de metadate, ca citirile să încapă în tranzacție.

### Detectorul care mințea — și cum arată cel care nu minte

Prima formă a verificării pornea motorul cu `DB_POOL_MAX=1` și declara vinovată
orice rută care nu răspundea. A numit zece. **Aceleași zece au răspuns apoi 200,
tot la pool 1, pe un motor pornit de mână cu același mediu** — fiindcă între
sonde scrierile de fundal ale motorului țin singura conexiune, iar o cerere care
n-are nevoie decât de tranzacția ei tot expiră așteptând-o.

Verificarea măsura pălăvrăgeala motorului, nu proprietatea. Și, mai rău, **a
continuat să numească rute după ce fuseseră reparate** — cel mai rău lucru pe
care îl poate face o poartă. A fost aruncată.

Ce a rămas numără proprietatea acolo unde se întâmplă: driverul pool-ului
numără fiecare conexiune luată **cât timp cererea ține deja tranzacția**, iar
middleware-ul de firmă raportează cifra în antetul `x-zveltio-extra-connections`.
Nimic nu depinde de cronometraj, de saturație sau de ce face motorul în fundal.
Trăiește în harness, în proces, ca test — `second-reservation.test.ts`.

### Reparațiile, și ce le-a scos la iveală

`scripts/check-second-reservation.ts` pornește motorul cu `DB_POOL_MAX=1` și întreabă
fiecare rută singurul lucru care nu se poate contesta: **poți răspunde cu o singură
conexiune?**

| răspund | nu răspund |
|---|---|
| `/api/health`, `/api/collections`, `/api/me`, `/api/dashboards` | `/api/webhooks`, `/api/saved-queries`, `/api/notifications`, `/api/revisions`, `/api/flows`, `/api/settings`, `/api/users`, `/api/api-keys`, `/api/tenants`, `/api/audit` |

**10 din 14.** Patru rute sunt deja pe partea bună, deci tiparul e realizabil — nu e o
limită a arhitecturii.

E **cremalieră, nu poartă**: lista are voie să scadă, niciodată să crească. Dovedită în
ambele direcții prin plantare (scoaterea unei rute din prag ⇒ rc=1).

---

## Ce urmează în blocul A

Pașii 3–6 din plan (accesor explicit, poartă, migrarea rutelor, contract SDK) **nu mai
sunt forma corectă a lucrării.** Ce rămâne de făcut, în ordinea în care se poate verifica:

1. Pentru fiecare din cele 10 rute, mută citirea de metadate înaintea tranzacției **sau**
   în tranzacție — și scade pragul cu fiecare.
2. `DB_POOL_MAX` ridicat la 40 (livrat în blocul E) **nu repară asta** — mută plafonul de
   la 25 la 40 de cereri simultane, dar o cerere continuă să ceară două conexiuni.

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-30 | 2 | Inventarul cerut există (89 de situri), dar măsurătoarea a arătat că nu el e reparația: tranzacția ține 1,59 ms, iar o cerere are nevoie de DOUĂ conexiuni. Cremalieră cu 10 rute, dovedită prin plantare. |
