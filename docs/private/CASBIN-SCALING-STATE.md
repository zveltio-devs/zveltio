# Stare — scalarea autorizării Casbin

> **Se citește la începutul fiecărui pas. Se actualizează după fiecare pas.**
> Branch: `perf/casbin-scaling` · pornit din `422377b2` (3.0.0-beta.64)
> Metodă: blocuri de 5–7 pași, cu punct de validare între blocuri.
> Regula care le guvernează pe toate: **nu se construiește nimic înainte ca o
> măsurătoare să arate că merită.** Un bloc are voie să se încheie cu „nu merită".

---

## De ce există branch-ul ăsta

Auditul din 27–29 august a redus o decizie de autorizare de la 364–885 ms la 4,7 ms
rece și 0,115 ms cald. Asta a rezolvat **latența unei verificări**.

Ce n-a rezolvat, și ce am clasificat greșit ca „nu mai e pe calea critică":
**rezolvarea scalează cu mărimea instanței.**

| Politici `p` | Rezolvare rece per (utilizator, firmă) |
|---|---|
| 7 208 | 4,70 ms |
| 23 978 | **9,96 ms** |

Cauza structurală, măsurată: **toate cele 23 978 de reguli `p` au `dom = '*'`.**
Niciuna nu e legată de o firmă. Deci rezolvarea fiecărui utilizator parcurge
politicile întregii instanțe — colecțiile tuturor firmelor plus toate resursele de
extensii. 5 957 de resurse distincte în instanța de măsurare.

Extrapolat: 100 de firme × 20 de colecții ⇒ zeci de mii de reguli, iar prima
verificare a fiecărui utilizator în fereastra de TTL le parcurge pe toate.

**Taxa asta crește cu succesul produsului.** Taxa de tranzacție (0,19 ms per cerere)
e constantă. Pentru un „Business OS multi-tenant", asta e plafonul care contează.

---

## Blocul 1 — MĂSURARE. Nu se scrie cod de producție.

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul ăsta | — | (la fiecare pas) |
| 1 | Banc de scalare controlat pe bază proprie `zv_casbin` | ✅ **FĂCUT** | vezi §Curba |
| 2 | Curba rezolvării — formă, nu două puncte | ✅ **FĂCUT** | **liniară, ușor supra-liniară** |
| 3 | Fezabilitatea `loadFilteredPolicy` cu enforcer singleton partajat între firme | ✅ **FĂCUT** | **NU e fezabil** |
| 4 | Ce s-ar rupe dacă regulile `p` ar fi legate de domeniu în loc de `dom='*'` | ✅ **FĂCUT** | index: 13–19×, dar premisa e falsă |
| 5 | Creșterea regulilor `g` cu utilizatori × firme | ⛔ **ANULAT** | premisa a căzut la pasul 4 |
| 6 | **PUNCT DE VALIDARE** | ✅ **FĂCUT** | **BLOCUL 2 NU SE DESCHIDE** |

### Criteriile punctului de validare (scrise ÎNAINTE de măsurare)

Blocul 2 se deschide **doar dacă** cel puțin una dintre condiții e adevărată:

- Curba e cel puțin liniară în numărul de politici **și** o cale identificată o
  reduce la sub-liniar sau la constant per firmă.
- `loadFilteredPolicy` e fezabil fără a rupe semantica multi-firmă a enforcer-ului
  singleton.

Dacă niciuna nu e adevărată: **blocul 2 nu se deschide.** Se scrie concluzia aici și
se raportează. Un „nu merită" măsurat e un rezultat, nu un eșec.

### Ce NU se atinge în blocul 1

Cod de producție. Politica RLS. Enforcer-ul. Nimic din `packages/engine/src` în
afară de fișiere de măsurare aruncate după.

### Curba (pașii 1–2, măsurat 2026-08-29)

Bancul imită forma reală: politici pe ROL, una per (rol, resursă, acțiune), toate
`dom='*'`. În instanța de audit: `tenant_member` × 3 acțiuni + `tenant_viewer` × 1,
peste 6 161 de resurse = 24 644 de reguli.

| Resurse | Politici | Rezolvare (cu rol) | Rezolvare (fără rol) |
|---|---|---|---|
| 1 500 | 6 000 | 3,57 ms | 1,17 ms |
| 3 000 | 12 000 | 7,26 ms | 2,50 ms |
| 6 000 | 24 000 | 16,32 ms | 7,01 ms |
| 12 000 | 48 000 | 28,50 ms | 10,70 ms |
| 24 000 | 96 000 | **62,33 ms** | 26,55 ms |

**De 16× mai multe politici ⇒ de 17,5× mai mult timp.** Liniar, ușor supra-liniar.

Extrapolat la 1 000 de firme × 24 de colecții: **62 ms** pentru fiecare rezolvare
(utilizator, firmă), plătită la prima verificare din fiecare fereastră de TTL de 60 s.

Cazul „fără rol" e mai ieftin dar crește la fel — și el e cazul refuzului, adică cel
pe care îl cere un atacator.

**Prima jumătate a criteriului de validare e îndeplinită:** curba e cel puțin
liniară. Rămâne de arătat că există o cale care o reduce.

### Pasul 3 — `loadFilteredPolicy`: nu e fezabil

Adaptorul Kysely **nu** implementează `FilteredAdapter` (fără `isFiltered`, fără
`loadFilteredPolicy`), iar `_enforcer` e un singleton partajat între firme. Dar
obstacolul real e mai adânc: **nu există felie după care să filtrezi.** Toate
regulile `p` au `dom='*'`, deci o încărcare filtrată pe domeniu le-ar întoarce pe
toate.

### Pasul 4 — indexul ajută, dar numai cu datele schimbate

La 48 000 de politici:

| | Timp | Construit o dată |
|---|---|---|
| A. scanare completă (azi) | 3,405 ms | — |
| B. index pe domeniu | **0,264 ms** | 6,8 ms |
| C. index pe (domeniu, subiect) | **0,182 ms** | 13,9 ms |
| D. index pe subiect, **date neschimbate** | **12,096 ms** | 7,3 ms |

D e verdictul care contează: **fără schimbarea datelor, indexul nu dă nimic** —
`tenant_member` deține 36 000 din 48 000 de reguli, deci separarea pe subiect nu
reduce nimic pentru rolul comun. B și C funcționează doar pentru că le-am construit
pe politici legate de domeniu.

---

## PUNCT DE VALIDARE — verdict: BLOCUL 2 NU SE DESCHIDE

**Premisa branch-ului e falsă, și am descoperit-o abia aici.**

`zvd_collections` **nu are `tenant_id`.** Colecțiile sunt la nivel de instanță,
**partajate între firme** — o instalare cu 100 de firme și 20 de colecții are 20 de
colecții, nu 2 000. Deci numărul de politici **NU crește cu numărul de firme.**
Crește cu numărul de resurse pe care le definește operatorul, mărginit de ce
construiește el, nu de câți clienți are.

Ceea ce înseamnă și că legarea pe domeniu (singura cale care taie curba) **n-are ce
lega**: nu există felie per firmă, fiindcă resursele sunt comune.

### De unde a venit greșeala: propria mea poluare

Baza pe care am măsurat avea **167 de colecții, dintre care 163 artefacte ale
propriilor mele teste** (nume cu marcă de timp). Instanța reală `/opt/zveltio` are
**3 colecții, 79 de politici `p`, 23 de resurse distincte** — de ~300 de ori mai
puțin.

### Corecție la cifrele raportate anterior

Recalculat pe scări realiste:

| Resurse | Politici | `enforce()` — codul vechi | `checkPermission` — codul nou |
|---|---|---|---|
| **23 (instanța reală)** | 92 | **0,930 ms** | 0,351 ms |
| 300 (toate extensiile) | 1 200 | 7,271 ms | 0,672 ms |
| 1 000 | 4 000 | 23,435 ms | 1,509 ms |
| 6 000 | 24 000 | 142,835 ms | 11,440 ms |

**Cifra de „364 ms per decizie" din auditul precedent a fost măsurată pe baza
poluată.** Pe o instanță reală, codul vechi costa **0,93 ms**. Vectorul de
amplificare „3 req/s cu un cont gratuit" e la fel de supraevaluat.

**Reparația rămâne corectă și rămâne utilă** — schimbă panta, iar la ~300 de resurse
(o instalare cu toate extensiile) codul vechi ajunge la 7,3 ms per refuz față de
0,67 ms. Dar nu a reparat o problemă de producție existentă azi; a reparat una care
apare la o scară pe care instanțele reale n-o ating încă.

### Ce se face în schimb

Nimic pe branch-ul ăsta. Concluzia e rezultatul.

Rămâne o singură acțiune, ieftină și fără legătură cu Casbin: **suita de teste lasă
în urmă colecții** (163 într-o singură bază). Asta nu e doar dezordine — a produs o
măsurătoare falsă care a condus un audit întreg. Merită curățenie în `afterAll`.

---

## Blocul 2 — NU SE DESCHIDE (vezi punctul de validare)

---

## Blocul 3 — colecțiile pe care suita le lasă în urmă

Nu e igienă. **O măsurătoare falsă produsă de aici a condus un audit întreg** și a
ajuns în două rapoarte ca „364 ms per decizie de autorizare". Baza avea 163 de
colecții din teste; instanța reală are 3.

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul | — | (la fiecare pas) |
| 1 | Măsoară: câte colecții lasă o rulare completă, pe bază curată | ✅ **FĂCUT** | **5 colecții + 2 tabele fantomă per rulare** |
| 2 | Identifică fișierele vinovate | ✅ **FĂCUT** | 5 fișiere, două ale mele |
| 3 | Repară curățenia | ✅ **FĂCUT** | helper comun `dropTestCollection` |
| 4 | Poartă | ✅ **FĂCUT** | `check:test-leftovers`, dovedită prin plantare |
| 5 | Verificare pe bază curată | ✅ **FĂCUT** (corectat) | **prima trecere a ratat un fișier** — vezi §Corecția |
| 6 | **PUNCT DE VALIDARE** | ✅ **TRECUT** | ambele criterii îndeplinite |

### Ce s-a găsit (pașii 1–3)

O rulare completă lăsa **5 colecții** — deci cele 163 s-au adunat din ~30 de rulări
în timpul auditului. Cauza, în toate cazurile: testele ștergeau **tabelul** dar
lăsau rândul din `zvd_collections`.

| Fișier | Ce lăsa |
|---|---|
| `collections.test.ts` | o a doua colecție, cu numele generat inline — nimic n-o mai putea numi ca s-o șteargă |
| `ddl-tenant-default-guard.test.ts` | rândul |
| `revisions-tenant-isolation.test.ts` | rândul |
| `data-list-count-mode.test.ts` (al meu) | rândul |
| `ghost-ddl-orphan-sweep.test.ts` (al meu) | rândul |
| `ghost-ddl-alter-column` / `-execute` | copia de după swap, fiindcă anulează deliberat timer-ul |
| `ghost-ddl-rename-column` | **aceeași copie — ratat la prima trecere, vezi §Corecția** |

Reparate cu un helper comun, `dropTestCollection(db, name)`, care șterge **și**
tabelul **și** rândul. Cele două de ghost DDL folosesc `sweepGhostOrphans(db)` — deci
testul curăță cu exact calea de cod pe care o folosește producția, nu cu o a doua
scriere a ei.

### Poarta

`check:test-leftovers` caută colecții cu sufix de marcă de timp (deci o colecție
reală a unui operator nu e confundată cu resturi) și tabele `_zv_old_*` /
`_zv_changelog_*`. **Dovedită prin plantare, nu prin citire:** cu o colecție
plantată pică; pe bază curată trece. În CI, imediat după suita de harness.

### Corecția (2026-08-29, după ce CI a picat)

**Pasul 5 a fost raportat drept „zero rămășițe" și nu era.** CI a picat pe chiar
poarta adăugată de blocul ăsta:

```
ghost table _zv_changelog_zvd_hgren_1788004596261
ghost table _zv_old_zvd_hgren_1788004596261
```

`hgren_` vine din `ghost-ddl-rename-column.test.ts` — **al treilea** fișier care
cheamă `GhostDDL.execute`, lângă cele două reparate. Nu fusese atins, deci copia de
după swap și changelog-ul ei supraviețuiau: `DROP TABLE ... CASCADE` pe tabela sursă
nu le atinge, sunt tabele separate.

**Nu e o condiție de CI.** Reproduce local în 1,2 s, pe bază curată, rulând singur
fișierul. Verificarea din pasul 5 pur și simplu nu a acoperit fișierul ăsta — n-a
fost mediu diferit, a fost acoperire lipsă.

Clasa de greșeală e chiar cea scrisă în antetul lui `check-raw-sql-identifiers.ts`:
*enumerating names is the mistake; the pattern is what to match*. Reparația a
enumerat fișierele ghost-ddl de care își amintea, nu pe cele care cheamă
`GhostDDL.execute`. Enumerarea corectă are nouă fișiere; cele patru `harness/`
rămase fără sweep (`multi-ddl`, `changelog-update`, `changelog-delete`,
`changelog-live`) **nu lasă nimic** — verificat pe suita completă, nu presupus,
fiindcă nu anulează timer-ul de curățenie.

Măsurat în ambele direcții, pe două baze curate separate:

| | rezultat |
|---|---|
| fără reparație, doar `ghost-ddl-rename-column` | 2 tabele fantomă, poarta pică |
| cu reparație, suita completă (865 pass, 0 fail) | **zero colecții, zero fantome**, poarta trece |

A doua reparație din același tur: `dropTestCollection` interpola un identificator
citat într-un `sql.raw` fără gardă, ceea ce `check:raw-sql` a prins. Are acum
`SAFE_NAME` — un test care dă un nume nescriibil primește o eroare, nu SQL rupt.

### Criteriile punctului de validare (scrise ÎNAINTE)

- O rulare completă de harness pe o bază curată lasă **zero** colecții și zero
  tabele `zvd_*` orfane.
- Poarta pică pe un test care lasă o colecție în urmă (dovedit prin plantare, nu
  prin citire).

Dacă poarta nu poate fi făcută să pice la o violare plantată, nu se comite — o
poartă nedovedită e decor, și tocmai am petrecut o săptămână demonstrând asta.

---

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-29 | setup | Branch creat din `422377b2`. Document de stare scris. Blocul 1 definit cu criterii de validare stabilite înainte de măsurare. |
| 2026-08-29 | 1–2 | Banc pe bază proprie `zv_casbin`, cinci puncte de măsurare. Curba e liniară: 6 000 → 96 000 de politici mută rezolvarea de la 3,57 la 62,33 ms. Prima jumătate a criteriului e îndeplinită. |
| 2026-08-29 | 3 | `loadFilteredPolicy` nu e fezabil: adaptorul nu implementează interfața, enforcer-ul e partajat, și nu există felie de filtrat fiindcă `dom='*'`. |
| 2026-08-29 | 4 | Indexul dă 13–19× **doar** pe politici legate de domeniu. Fără schimbarea datelor: zero. |
| 2026-08-29 | 3.5 corecție | **Pasul 5 era greșit.** CI a picat pe poarta blocului: `ghost-ddl-rename-column` — al treilea fișier care cheamă `GhostDDL.execute` — nu fusese atins. Reproduce local în 1,2 s, deci n-a fost mediu diferit, a fost acoperire lipsă. Reparat prin `sweepGhostOrphans`; enumerarea completă are 9 fișiere, restul verificate curate. Plus garda `SAFE_NAME` în `dropTestCollection`, cerută de `check:raw-sql`. |
| 2026-08-29 | **VALIDARE** | **Blocul 2 NU se deschide.** `zvd_collections` n-are `tenant_id` — colecțiile sunt partajate, deci politicile NU cresc cu firmele. Baza de măsurare avea 163 de colecții din teste; instanța reală are 3. Cifra de 364 ms din auditul precedent a fost artefact de poluare; real e 0,93 ms. |

---

## Context care nu trebuie re-descoperit

- **Mediul:** worktree izolat `/home/liviu/zveltio-audit-ba/zveltio`, bază proprie
  `zv_audit_ba`, port `:3400`. Ocupate de alții: `:3000`, `:3200`, `:3201`, `:3300`.
- **Env fără de care testele mint:** `ZVELTIO_REGISTRATION_ENABLED=1`,
  `FIELD_ENCRYPTION_KEY=<64 hex>`, `TEST_PORT`, `TEST_DATABASE_URL` **pe linie
  separată** (`export A=1 B=$A` expandează `$A` înainte de atribuire).
- **Nu contamina baza de măsurare.** `pg_stat_statements` adaugă coloane `rows`,
  `calls`, `wal_*` în `public` și lărgește corpusul porții numerice.
- **CI ≠ local.** De patru ori în auditul precedent, un test a trecut local și a
  picat în CI: suita `unit` rulează fără bază de date; suita partajează procesul,
  deci un fișier anterior poate lăsa un cache în urmă; primul rând din `user` poate
  fi contul god, iar `checkPermission` iese pe scurtătură înainte de memo.
- **Casbin:** modelul e `r = sub, dom, obj, act`; `dom` e firma. Obiectele se compară
  prin **egalitate simplă**, fără `keyMatch`. `getImplicitRolesForUser` e de
  încredere; `getImplicitPermissionsForUser` **NU** — filtrează pe domeniu exact și
  întoarce zero pentru un `tenant_admin`, fiindcă regulile `p` au `dom='*'`.


---

## Blocul 4 — rolul engine-ului: e arhitectura de azi cea bună?

Măsurat: engine-ul se conectează ca `postgres` (`rolsuper=t`, `rolbypassrls=t`).
Pe un tabel cu `FORCE ROW LEVEL SECURITY` pornit, acel rol vede **306 360 de rânduri
din 63 de firme**; `zveltio_rls` vede 100 360 dintr-una. Superuserii nu sunt legați
de RLS, niciodată.

Deci **cererile de utilizator sunt izolate** (`withTenantIsolation` coboară rolul),
iar **tot restul nu e**: job-uri de fundal, reconcilieri, audit, backup.

### Întrebarea de arhitectură, nu doar de configurație

Azi **fiecare cerere își coboară singură privilegiile**. Implicitul e „neîngrădit
până se restrânge cineva". Trei variante de comparat:

- **Zero — azi.** Pool superuser + `SET LOCAL ROLE` per cerere.
- **A — rol simplu + ridicare explicită.** Engine-ul rulează restrâns; ce are nevoie
  de vedere globală se ridică explicit. Inversează implicitul.
- **B — două pool-uri.** Unul conectat CA rol restrâns pentru cereri, unul privilegiat
  pentru fundal și DDL. Identitatea conexiunii poartă privilegiul, deci `SET LOCAL
  ROLE` dispare din calea fierbinte, iar implicitul devine sigur prin construcție.

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul | — | (la fiecare pas) |
| 1 | Inventar | ✅ **FĂCUT** | 111 tabele cu `tenant_id`; ~14 situri în `lib/` |
| 2 | Clasificare | ✅ **FĂCUT** | fundalul are nevoie **structurală** de vedere globală |
| 3 | Costul lui `SET LOCAL ROLE` | ✅ **FĂCUT** | 0,055 ms — și se poate lua **fără** schimbare de arhitectură |
| 4 | Fezabilitatea B | ✅ **FĂCUT** | posibilă, dar nu reduce expunerea |
| 5 | Ce se rupe | ⛔ **ANULAT** | verdictul s-a stabilit la pasul 2 |
| 6 | **PUNCT DE VALIDARE** | ✅ **FĂCUT** | **NU se schimbă rolul** |

### Pasul 1–2 — inventarul, și de ce clasificarea decide totul

111 tabele poartă `tenant_id`. În `lib/`, ~14 situri le ating în afara tranzacției.
Dar numărul nu e ce contează; **natura lor e.**

- `repairUnsignedWebhooksAtBoot` citește webhook-urile **tuturor** firmelor.
- `flow-executor` caută `tenant_id`-ul unui flow **ca să afle** în ce firmă rulează.
- Reconcilierile de la boot trec peste tabelele tuturor firmelor.

Munca de fundal care operează *între* firme trebuie, prin definiție, să vadă între
firme. Un rol restrâns nu le-ar face nesigure — le-ar face **oarbe**.

### Pasul 3 — câștigul de performanță nu cere schimbarea

| | Timp per cerere |
|---|---|
| Azi: `SET LOCAL ROLE` ca instrucțiune separată | 0,230 ms |
| Varianta B: rolul vine cu conexiunea | 0,181 ms |
| **Rolul setat în același `set_config`** | **0,175 ms** |

A treia e **mai rapidă decât B** și nu cere nicio schimbare de arhitectură.
Verificat că e echivalentă, nu doar mai rapidă: `set_config('role','zveltio_rls',true)`
dă `current_user = zveltio_rls` și RLS se aplică — o firmă vizibilă, exact ca
`SET LOCAL ROLE`. Superuserul vede 63.

---

## PUNCT DE VALIDARE — verdict: NU se schimbă rolul engine-ului

**Criteriul 1 pică.** Locurile care au nevoie de vedere globală nu sunt o mulțime
mică și închidabilă — sunt întregul strat de fundal, prin proiectare.

**Criteriul 2 pică pe fond.** Varianta B e tehnic fezabilă (DDL-ul trece prin
pg-boss, deci prin pool-ul privilegiat), dar **nu reduce expunerea**: pool-ul de
fundal ar rămâne privilegiat, și exact acolo trăiește accesul neîngrădit. B ar face
sigură-prin-construcție doar calea de cerere, care e deja sigură prin coborârea
explicită de rol. Iar câștigul ei măsurat e mai mic decât cel gratuit.

### Ce iese totuși din bloc

1. **Un câștig gratuit, verificat:** rolul mutat în `set_config`-ul existent —
   **0,055 ms per cerere, 24% din costul de pregătire**, o linie, risc zero.
2. ⛔ **INFIRMAT 2026-08-29 — recomandarea de mai jos nu se poate face.** În `lib/` mânerul neîngrădit se numește `db`, la fel ca o tranzacție: măsurat, `lib/` conține identificatorul `poolDb` **o dată, într-un comentariu**, față de 19 ori în `routes/`. O poartă extinsă acolo n-ar prinde nimic, niciodată — și fusese deja încercată și revenită. Vezi `BLOCK-C-GATES-STATE.md` §Pasul 6. Textul original se păstrează mai jos, ca să nu fie re-propus.

   ~~**Expunerea se închide mai bine la build:**~~ extinderea porții
   `check-tenant-table-on-pool` la `lib/`, cu o listă explicită de excepții motivate
   pentru munca de fundal care are nevoie legitimă de vedere globală. Prinde aceeași
   clasă fără să riște să orbească nimic.

**Ce NU se face:** schimbarea rolului de conectare al engine-ului.

### Criteriile punctului de validare (scrise ÎNAINTE)

Se recomandă o schimbare **doar dacă**:
- Numărul locurilor care au nevoie legitimă de vedere globală e mic și enumerabil
  (sub ~10), **și** fiecare poate primi o cale explicită.
- **Sau** varianta B se dovedește fezabilă fără să rupă DDL-ul.

Dacă ies multe locuri legitime: **nu se schimbă rolul.** Expunerea se închide mai
bine caz cu caz — și atunci recomandarea e extinderea porții
`check-tenant-table-on-pool` la `lib/`, care prinde aceeași clasă la build fără să
riște să orbească nimic.
