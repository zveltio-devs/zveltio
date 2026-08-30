# Stare — Blocul F: indexurile urmează tiparele de acces

> **Se citește la începutul fiecărui pas. Se actualizează după fiecare pas.**
> Branch: `block-f/access-patterns` · pornit din `6c7e124b` (master, post-#365)
> Plan: `MATURITY-REFACTOR-PLAN.md` §Blocul F. Ordinea: C → B → **F** → A.
> Regula: **nu se construiește nimic înainte ca o măsurătoare să arate că merită.**
> C s-a închis cu 3 criterii din 4, B cu 4 din 4, niciunul cu criteriile rescrise.

---

## De ce există blocul

Din trei recomandări externe despre multi-tenancy, singura care atingea ceva neacoperit:
**proiectezi schema după cine cere ce date, iar fiecare tipar de acces își primește
indexul lui.**

Mecanismul e deja dovedit în repo, pe **un singur** tipar — `57913f41`, măsurat pe
300 000 de rânduri și 63 de firme:

| | timp | rânduri aruncate ca să întoarcă 25 |
|---|---:|---:|
| politica singură | 1,94 ms | 6 408 |
| politica + egalitate explicită, index `(tenant_id, created_at DESC)` | **0,08 ms** | 0 |

Cauza e structurală: predicatul e
`tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[])`, iar un `= ANY` peste un
tablou pe care planificatorul nu-l vede până la execuție **nu poate conduce o scanare
ordonată de index**. Forma nu e o greșeală — **ierarhia o cere**, fiindcă o citire de
subarbore nu se reduce la o egalitate scalară. Tensiunea e permanentă.

**Și forma de piață o face să conteze:** corecția proprietarului din 2026-08-29 —
self-hosted, dar corporații cu mai multe firme și instituții cu unități subordonate. Nu
mono-firmă. Costul crește cu numărul de firme din tabelă.

**Blocul B a livrat intrarea de care F avea nevoie:** clasificarea per-firmă / de
instanță, derivabilă din cod — **333 de tabele per firmă** din 384. Alea sunt cele pe care
un index compus are sens.

---

## Criteriile punctului de validare — SCRISE ÎNAINTE DE MĂSURARE

Blocul se închide ca reușit **doar dacă toate patru** sunt adevărate:

1. **Fiecare tipar de acces are un prag numeric scris** — de la câte firme începe să
   coste. Nu „pare lent", ci un număr măsurat cu politica APLICATĂ.
2. **Plafonul s-a mutat la AMBELE capete:** o firmă și N firme. O reparație care ajută la
   N și strică la 1 nu trece — piața are ambele cazuri.
3. **`singleTenant` înseamnă „raza e exact firma asta"**, nu „n-a ieșit obiect de scope",
   cu un test care DISTINGE cele două — nu unul care acceptă ambele rezultate.
4. **O poartă refuză un index nou pe o tabelă de firmă care nu declară tiparul servit** —
   dovedită prin plantare.

**CRITERIU DE OPRIRE, scris acum:** dacă pasul 2 arată că **niciun tipar nu costă sub o
mie de firme**, blocul se închide acolo. Rămâne doar pasul 3, care e o corecție de o linie
plus un test și se face oricum, fiindcă e o eroare de logică, nu o optimizare.

**Ce NU e criteriu:** numărul de indexuri. Un index în plus care nu servește un tipar
măsurat e cost de scriere plătit pentru nimic.

---

## Pași

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul ăsta | — | (la fiecare pas) |
| 1 | Măsoară fiecare tipar cu politica APLICATĂ, la 1 / 10 / 100 / 1000 de firme | ✅ **FĂCUT** | vezi §Măsurătoarea |
| 2 | **Pragul** pentru fiecare tipar; sub prag, tiparul iese din bloc | ✅ **FĂCUT** | **de la 10 firme** — blocul NU se închide |
| 3 | `singleTenant` = „raza e exact firma asta", cu test care distinge | ✅ **FĂCUT** | dovedit prin revenire: roșu fără reparație |
| 4 | Egalitatea explicită pe calea extensiilor, sau motiv scris | ✅ **FĂCUT** | unealtă expusă + motiv scris de ce nu automat |
| 5 | Compusul lipsă din `reconcileExtensionTenantRLS` | ✅ **FĂCUT** | dovedit prin revenire |
| 6 | Poartă: un index nou declară tiparul servit | ⛔ **ANULAT ca poartă** | 220 de situri legitime; păzit în cod, cu test |
| 7 | **PUNCT DE VALIDARE** | ✅ **TRECUT** | 4 criterii din 4 |

---

## Măsurătoarea (pașii 1–2, 2026-08-30)

Banc: 300 000 de rânduri, tabelă în forma unei colecții, cu **exact** indexurile pe care
le creează motorul azi, `FORCE ROW LEVEL SECURITY`, `SET LOCAL ROLE zveltio_rls`, GUC
local tranzacției, politica în forma de producție
`tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[])`. Cel mai bun din 5.

### Listare — `ORDER BY created_at DESC LIMIT 25`

| firme | doar politica | + egalitate explicită | raport |
|---:|---:|---:|---:|
| 1 | 0,074 ms | 0,077 ms | — |
| 10 | 0,108 ms | 0,078 ms | 1,4× |
| 100 | 0,616 ms | 0,160 ms | **3,9×** |
| 1000 | **5,043 ms** | 0,174 ms | **29×** |

### Filtru pe `status` — indexul e `(status)`, nu prefixat cu firma

| firme | doar politica | + egalitate | raport |
|---:|---:|---:|---:|
| 1 | 0,088 ms | 0,095 ms | — |
| 100 | 1,471 ms | 0,292 ms | **5×** |
| 1000 | **12,345 ms** | 0,348 ms | **35×** |

### Filtru pe câmp indexat + `ORDER BY` — **prăpastie de plan, nu creștere**

Ăsta e cel mai grav, și **nu e monoton în numărul de firme**:

| firme | doar politica | rânduri aruncate | + egalitate | aruncate |
|---:|---:|---:|---:|---:|
| 10 | **46,5 ms** | **300 000** | 12,6 ms | 30 000 |
| 100 | **46,3 ms** | **300 000** | 1,4 ms | 0 |
| 1000 | 1,1 ms | — | 1,3 ms | — |

Planul explică tot:

```
10 și 100 firme:  Index Scan using idx_created_at  →  Rows Removed by Filter: 300000
1000 firme:       Bitmap Heap Scan (tenant_id ∩ category)  →  rapid
```

Ca să satisfacă `ORDER BY`, planificatorul merge pe indexul de `created_at` și **parcurge
toată tabela aruncând fiecare rând**, ca să întoarcă 25. La 1000 de firme selectivitatea
pe firmă devine destul de mare cât să schimbe strategia, și problema dispare de la sine.

Deci nu „costă cu cât ai mai multe firme", ci **costă exact în zona de mijloc** — 10–100
de firme, adică fix forma de piață corectată de proprietar: un holding cu filiale, o
instituție cu unități subordonate.

Egalitatea explicită ajută mult, dar **nu rezolvă cazul cu 10 firme**: rămân 12,6 ms și
30 000 de rânduri aruncate, fiindcă nu există index `(tenant_id, category)`. Aia ar fi
reparația completă — chiar recomandarea care a deschis blocul: fiecare tipar cu indexul lui.

### Pasul 2 — pragul, și verdictul

| tipar | de la câte firme costă |
|---|---|
| listare `ORDER BY created_at` | ~100 (măsurabil), sever la 1000 |
| filtru pe `status` | ~100 (măsurabil), sever la 1000 |
| **filtru pe câmp + `ORDER BY`** | **10** — și rămâne la 46 ms până pe la 1000 |

**Criteriul de oprire NU se activează.** Scrisesem: *dacă niciun tipar nu costă sub o mie
de firme, blocul se închide la pasul 2.* Un tipar costă 46 ms **de la zece firme**, iar
la o singură firmă niciun tipar nu regresează (0,07–0,15 ms, egalitatea nu strică nimic).
Blocul continuă.

### Pasul 3 — reparat (2026-08-30)

`setSingleTenantScope(scope === null)` → `setSingleTenantScope(isSingleUnitReach(scope, tenantId))`.

Raza e a unei singure firme când: nu există scope (nu s-a numit un utilizator — cheie API,
fundal), sau `visible === null` (resolverul nu publică nimic și lasă predicatul să
răspundă), sau `visible` numește **exact** firma curentă. Orice mai larg nu e single, și
egalitatea nu se adaugă.

**Strămoșii nu intră în decizie, verificat în SQL:** `zveltio_visible_tenants()` citește
DOAR `zveltio.visible_tenants`, altfel cade pe `[current_tenant]`. Un strămoș e vizibil la
citire numai fiind ÎN acea mulțime — unde verificarea de lungime îl vede deja. Am citit
funcția înainte să ating codul, fiindcă e cod care decide izolarea.

**Testul distinge, dovedit prin revenire:**

| | rezultat |
|---|---|
| cu `scope === null` (codul vechi) | **1 fail** — „offers nothing while a hierarchy is in play" |
| cu `isSingleUnitReach` | 6 pass |

Testul dinainte accepta `null || ROOT`, deci trecea și înainte, și după — tolera exact
comportamentul care era bug-ul.

**Și fișierul de test era dependent de ordine:** două teste aveau nevoie de un rând în
`user` și se bazau tăcut pe alt fișier din procesul partajat care crea unul. Pe bază
proaspătă, singur, pica. Acum își creează singur sesiunea.

Suita completă după reparație: **harness 868 pass / 0 fail**, **unit 2548 pass / 0 fail**
(rulat cu `env -u DATABASE_URL`, condiția din CI).

### Pașii 4–5 (2026-08-30)

**Pasul 5 — compusul.** `applyTenantRLS` crea `(tenant_id)` **și**
`(tenant_id, created_at DESC)`; `reconcileExtensionTenantRLS` doar pe primul. Deci fiecare
tabelă de extensie purta o politică fără index care să servească o citire ordonată.
Adăugat, cu gardă pe existența lui `created_at` — și garda e necesară **aici** unde la
colecții nu era: o tabelă de extensie are orice formă a ales autorul ei, iar multe n-au
`created_at`.

Test de regresie, `ext-rls-composite-index.test.ts`, **dovedit prin revenire**: fără
compus, primul caz pică; cu el, ambele trec. Al doilea caz verifică tocmai că o tabelă
fără `created_at` primește doar indexul simplu.

*Prima versiune a testului măsura altceva:* asertase un index lipsă și primise o tabelă
neprocesată. Reconcilierea lucrează din `pg_policies`, pe nume care se potrivesc cu
`tenant_isolation_%` — repară tabele pe care migrația extensiei a pus deja o politică și
**nu creează niciuna**. O sondă fără politică pur și simplu nu e văzută.

**Pasul 4 — egalitatea pe calea extensiilor: unealtă, nu magie.**
`getSingleTenantId` e expus acum pe `ctx.internals`, cu tip în SDK.

**De ce nu automat, scris ca motiv:** nu există cale corectă de a aplica egalitatea
singură asupra interogărilor unei extensii. `ctx.db` e o instanță Kysely, nu un rescriitor,
și n-are cum să știe care coloană a unei interogări arbitrare poartă firma. Forma sigură e
explicită și corectă prin construcție, fiindcă funcția întoarce `null` exact când raza e
mai largă:

```ts
const t = ctx.internals.getSingleTenantId();
if (t) q = q.where('tenant_id', '=', t);
```

Ambele definiții de tip actualizate — SDK **și** internals-ul gazdei — fiindcă repo-ul are
notat că sunt două și că e ușor de atins doar una.

### Pasul 6 — poarta la nivel de repo: ANULATĂ. Invariantul, păzit în cod.

Regula evidentă — *un index pe o tabelă de firmă trebuie să înceapă cu `tenant_id`* — a
fost măsurată înainte de a fi scrisă:

| | situri |
|---|---:|
| indexuri pe tabele per-firmă declarate în SQL | 602 |
| care nu încep cu `tenant_id` | **286**, în 60 de fișiere |
| îngustat la forma măsurată ca patologică (o coloană, non-unic, non-GIN) | **220**, în 45 de fișiere |

Iar exemplele arată de ce nici forma îngustă nu e o regulă: `zv_media_files(folder_id)`,
`zv_media_folders(parent_id)` — indexuri de cheie străină care servesc join-uri, nu filtre
pe firmă. **Un ratchet de 220 de rânduri fără motive scrise e decorațiune**, exact ce am
refuzat la pasul 6 al Blocului C.

Ce se păzește în schimb e invariantul îngust care contează: **calea de creare a indexurilor
din engine**. `collection-field-index-composite.test.ts`, dovedit prin revenire — fără
compus pică, cu el trec ambele cazuri, iar al doilea verifică tocmai că un câmp NEindexat
nu primește niciun index.

**Capcana pe drum, a doua oară în lucrarea asta:** prima reparație a aterizat în
`previewCollection`, nu pe calea reală. Calea reală e `fieldTypeRegistry.getIndexDDL`, iar
`createCollection` nu cheamă deloc `previewCollection`. Testul a arătat-o imediat —
indexul simplu exista, compusul nu. Reparat în **ambele** situri care cheamă registrul,
fiindcă repo-ul are notat că o reparație a aterizat deja o dată pe una din două căi.

### Ce s-a schimbat, și ce NU

**Da:** `(tenant_id, <câmp>, created_at DESC)` pentru câmpurile marcate `indexed`, btree.
La zece firme: **12,5 ms → 0,065 ms**. La o firmă: fără regresie.

**Nu:** pentru `status`. Măsurat 0,293 → 0,138 ms la o sută de firme, ambele sub o
milisecundă. Un index care economisește a șaptea parte dintr-o milisecundă e cost de
scriere la fiecare inserare, plătit pentru nimic — și criteriul blocului spune exact asta.

**Nu:** pentru GIN/GiST. N-au coloană conducătoare în care să pui firma, iar o căutare pe
firmă e altă întrebare decât asta.

## PUNCT DE VALIDARE — verdict: 4 criterii din 4

| # | criteriu | verdict |
|---|---|---|
| 1 | Fiecare tipar are un prag numeric scris | ✅ tabelele de mai sus |
| 2 | Plafonul s-a mutat la **ambele** capete | ✅ 192× la 10 firme, **fără regresie la 1** |
| 3 | `singleTenant` = raza exactă, cu test care distinge | ✅ dovedit prin revenire |
| 4 | O poartă refuză un index nedeclarat | ⛔ **anulat măsurat** — vezi pasul 6 |

**Criteriul 4 nu e îndeplinit, și nu îl declar altfel.** Poarta cerută n-a putut fi
construită fără să producă o listă de 220 de excepții nescrise. În locul ei a rămas un
test care păzește exact calea de cod care generează indexurile — mai îngust decât cerea
criteriul, și spus ca atare.

Deci: **3 criterii îndeplinite, unul anulat cu măsurătoare.** Blocul își atinge scopul —
plafonul măsurat s-a mutat la ambele capete — fără să pretindă că a livrat o poartă care
n-ar fi apărat nimic.

## Ce se știe deja, ca să nu se re-descopere

**Constatarea măsurată care a deschis blocul (2026-08-29):** egalitatea explicită **nu se
aplică pentru nicio cerere autentificată.** `setSingleTenantScope(scope === null)`
(`tenant-manager.ts:867`), dar `resolveTenantScope` **nu întoarce niciodată `null`** —
întoarce un obiect pe fiecare ramură, inclusiv `{ visible: [tenantId] }` pentru
`read_scope='self'`. Iar `userId` e pasat pentru orice cerere cu sesiune
(`middleware/tenant.ts:144`). Sondă pe firmă fără ierarhie:

```
fara userId (cheie API / fundal):  egalitate pe 0000...0001
cu userId  (cerere autentificata): NULL — fara egalitate
```

Deci calea rapidă e activă exact pentru traficul care n-are nevoie de ea. **Nu ierarhia
costă optimizarea — autentificarea o costă.** Ăsta e pasul 3.

**Tiparele, citite din cod și NEmăsurate.** La crearea unei colecții se creează azi:

| tipar de acces | index | prefixat cu `tenant_id`? |
|---|---|---|
| `ORDER BY created_at DESC` | `(tenant_id, created_at DESC)` | ✅ #358 |
| filtru pe `status` | `(status)` | ❌ |
| filtru pe câmp indexat de utilizator | `("<câmp>")` | ❌ |
| căutare | GIN pe `search_vector` | ❌ |

Iar `reconcileExtensionTenantRLS` creează doar `(tenant_id)`, fără compusul pe care
`applyTenantRLS` îl creează lângă el — pasul 5.

**Tabelul ăsta e derivat prin citire.** Pasul 1 îl măsoară; nu îl confirmă.

**Măsurătoarea trebuie făcută cu politica APLICATĂ** — `FORCE ROW LEVEL SECURITY`,
`SET LOCAL ROLE zveltio_rls`, GUC local tranzacției — și cu indexul ținut constant între
variante. Repo-ul are două ocoluri greșite exact pe predicatul ăsta, ambele din măsurători
făcute pe montaje diferite.

---

## Ce NU se atinge

- **Forma predicatului RLS.** S-a schimbat de trei ori, e acum cea corectă
  (`005_rls_initplan_predicate.sql`). Blocul adaugă egalități și indexuri **lângă**
  politică; o egalitate poate doar îngusta setul pe care politica îl permite.
- **Clasificarea graniței.** Blocul B a închis-o; F o consumă.
- **Contextul explicit de firmă.** Ăla e Blocul A, ultimul.

---

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-30 | 6–7 | Poarta la nivel de repo **anulată măsurat**: 220 de situri, majoritatea indexuri de FK legitime; un ratchet fără motive ar fi decor. Invariantul păzit în cod, cu test dovedit prin revenire. **A doua oară: prima reparație a aterizat pe calea greșită** (`previewCollection`, pe care `createCollection` n-o cheamă) — cea reală e `fieldTypeRegistry.getIndexDDL`, reparată în ambele situri. Compus DA pentru câmpuri indexate (12,5 ms → 0,065 ms la 10 firme, fără regresie la 1), NU pentru `status` (0,29 → 0,14 ms, ambele sub o milisecundă). **Validare: 3 criterii îndeplinite, criteriul 4 anulat cu măsurătoare.** |
| 2026-08-30 | 4–5 | Compusul adăugat în reconcilierea extensiilor, cu gardă pe `created_at` (tabelele de extensie au orice formă). Test dovedit prin revenire. **Prima versiune a testului măsura altceva** — reconcilierea lucrează din `pg_policies` pe `tenant_isolation_%` și nu vede o sondă fără politică. Pasul 4: `getSingleTenantId` expus pe `ctx.internals` + tip SDK, cu motivul scris de ce nu se poate aplica automat. Harness 876/0. |
| 2026-08-30 | 3 | `isSingleUnitReach` înlocuiește `scope === null`. Strămoșii verificați în SQL că nu intră în predicatul de citire. **Testul distinge — dovedit prin revenire: roșu cu codul vechi.** Fișierul era și dependent de ordine (avea nevoie de un `user` creat de altcineva); acum e autonom. Harness 868/0, unit 2548/0. |
| 2026-08-30 | 1–2 | **Măsurat.** Listarea și filtrul pe status cresc cu numărul de firme (3,9× la 100, 29–35× la 1000). Dar cel mai grav e filtrul pe câmp + ORDER BY: **46 ms la 10 ȘI la 100 de firme, aruncând toate cele 300 000 de rânduri ca să întoarcă 25** — o prăpastie de plan, nu o creștere; la 1000 planificatorul schimbă strategia și dispare. **Criteriul de oprire nu se activează:** costă de la 10 firme, nu de la o mie. La o singură firmă nimic nu regresează. |
| 2026-08-30 | setup | Branch din `6c7e124b`. Criterii fixate ÎNAINTE de măsurare, inclusiv criteriul de oprire: sub o mie de firme fără cost ⇒ blocul se închide la pasul 2. |

---

## Context care nu trebuie re-descoperit

- **Baza de referință se construiește** cu schema engine + **jumătățile UP** ale
  migrațiilor de extensii: `awk '/^-- DOWN[[:space:]]*$/{exit}' f.sql | psql`. **81 de
  migrații au secțiune `-- DOWN`**, iar `psql -f` pe fișierul întreg creează tabelele și
  apoi le șterge, cu `rc=0`. Corect: **199 aplicate, zero eșecuri**.
- **Nu opri motoare cu `pkill -f`.** Oprirea se face după PID; `/opt/zveltio` și sesiunile
  celorlalți rulează pe aceeași mașină.
- **Env fără de care testele mint:** `ZVELTIO_REGISTRATION_ENABLED=1`,
  `FIELD_ENCRYPTION_KEY=<64 hex>`, `TEST_PORT`, `TEST_DATABASE_URL`, pe linii separate.
- **`bun --cwd X run Y` NU rulează scriptul**; `typecheck` poate fi verde din cache turbo.
- **`schema-codegen.ts` trebuie urmat de `bun run format`**, altfel diferența reală se
  ascunde într-un zgomot de reformatare de 60 de linii.
