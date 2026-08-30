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
| 4 | Egalitatea explicită pe calea extensiilor, sau motiv scris | DE FĂCUT | — |
| 5 | Compusul lipsă din `reconcileExtensionTenantRLS` | DE FĂCUT | — |
| 6 | Poartă: un index nou declară tiparul servit | DE FĂCUT | — |
| 7 | **PUNCT DE VALIDARE** | DE FĂCUT | — |

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
