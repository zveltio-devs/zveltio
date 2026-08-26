# Tenancy ierarhic — plan de implementare

*2026-08-26. Cele patru întrebări deschise au primit răspuns; documentul e acum
plan, nu ciornă. Faptele despre starea actuală sunt verificate în cod și în baza
de date, nu deduse.*

---

## 1. Ce există azi

| element | stare |
|---|---|
| `zv_tenants` | listă **plată**: `id, slug, name, plan, status, max_records, max_storage_gb, max_api_calls_day, max_users, billing_email, trial_ends_at, settings`. **Fără `parent_id`.** |
| `zv_tenant_users` | `(id, tenant_id, user_id, role, invited_by, joined_at)` — un rol per pereche, fără rază, fără valabilitate |
| predicatul RLS | `zveltio_tenant_scope_ok(row_tenant)` = **egalitate simplă** cu GUC-ul |
| politicile | `FOR ALL`, cu **același predicat în `USING` și în `WITH CHECK`** |
| autorizare | Casbin, cu firma drept **domeniu** |
| acoperire | 29 de tabele cu `tenant_id` la bază, 48 cu extensiile |
| rânduri globale | **nu există**: 17 tabele permit `tenant_id` NULL, dar `NULL = X` dă NULL, deci un asemenea rând e invizibil pentru toți |

Coloanele `plan`, `trial_ends_at`, `billing_email` spun ce model a fost
construit: o listă de clienți SaaS cu abonament.

## 2. De ce nu ajunge

ANSVSA are 41 de direcții județene în subordine. Contabilitatea ANSVSA trebuie
să vadă ce au completat județele; Buzău și Călărași nu trebuie să se vadă între
ele. Cu egalitate simplă, a doua cerință merge, **prima n-are cum** — nu există
noțiunea de „deasupra".

Orice corporație cu filiale are aceeași formă. Un singur caz, nu două.

## 3. Modelul

Unitățile formează un **arbore de adâncime arbitrară**. Ce se configurează nu e
arborele, ci **raza fiecărei atribuiri**:

*(persoană, unitate, rol, rază_citire, valabil_de_la, valabil_până_la)*

| rază de citire | acoperă |
|---|---|
| `self` | doar unitatea |
| `subtree` | unitatea și tot ce e sub ea |
| `list` | un set explicit de unități |
| `org` | tot |

**Scrierea nu are rază.** *Datele sunt ale subordonatului.* Se scrie numai în
nodul propriu, oricine ai fi. Un nivel superior citește și aprobă; nu corectează
în locul altuia.

### Vizibilitatea merge în ambele sensuri

Regula de mai sus lasă două situații reale fără soluție, deci modelul are nevoie
și de direcția opusă:

- **nomenclatoarele naționale** — legislație, registrul unităților autorizate,
  coduri: scrise o dată sus, citite de toate unitățile de dedesubt;
- **o inspecție făcută de o echipă centrală la o unitate subordonată** — o scrie
  centrul, în nodul lui, dar e despre subordonat, care trebuie să o vadă.

**Vizibilitatea în jos e opt-in pe colecție, nu automată.** Salarizarea centrului
nu devine vizibilă județelor doar pentru că e mai sus.

**Vizibilitatea în sus NU e opt-in pe colecție** — și asta e o decizie, nu o
omisiune. Susul e deja controlat pe două axe: `read_scope` pe persoană (cine are
`subtree` vede sub el, cine are `self` nu) și Casbin pe resursă. Un al treilea
steag ar duplica în mare parte a doua axă, iar riscul a trei dimensiuni nu e
performanța, e **credința greșită**: cineva configurează una din trei și crede că
datele sunt ascunse când nu sunt.

Cazul „holdingul nu trebuie să vadă filiala X" se exprimă prin
`read_scope = 'list'` — set explicit în loc de subarbore. E granularitatea
corectă: pe persoană, nu pe colecție.

Iar ușa rămâne deschisă **gratis**: steagul e un literal în politică, nu o
coloană citită pe rând. Dacă apare un caz real care cere „colecția asta nu urcă
niciodată, indiferent de rază", se adaugă un al doilea literal doar în politicile
colecțiilor care au nevoie — fără migrație și fără cost pentru restul. Tabelul de
mai jos e dovada: un literal fals dispare din plan.

### Departamentele nu intră în RLS

RLS răspunde la *care unități*. Casbin, care are deja domeniu pe unitate,
răspunde la *care resurse*. „Contabilitatea centrului vede contabilitatea
județelor, dar nu resursele umane" e treaba lui Casbin. Cele două înmulțite dau
matricea completă.

## 4. Schema

```
zv_tenants
  + parent_id      uuid REFERENCES zv_tenants(id)
  + closed_at      timestamptz          -- unitatea nu se șterge NICIODATĂ
  + merged_into    uuid REFERENCES zv_tenants(id)
  - plan, trial_ends_at, billing_email, max_api_calls_day
        (abonamentul e al instanței, nu al unei filiale)

zv_tenant_users            → devine tabela de atribuiri
  + read_scope   text  CHECK (read_scope IN ('self','subtree','list','org'))
  + scope_list   uuid[]                 -- doar pentru read_scope = 'list'
  + valid_from   timestamptz NOT NULL DEFAULT now()
  + valid_to     timestamptz            -- NULL = fără termen

zv_tenant_transfers        → tabelă nouă
  (id, table_name, record_id, from_tenant, to_tenant, moved_at, moved_by, reason)
```

**`tenant_id` de pe cele 48 de tabele rămâne neatins.** Nicio migrație de date.

**O unitate nu se șterge niciodată.** Fuziune sau desființare înseamnă
`closed_at` plus `merged_into`. Altfel rândurile istorice arată spre un nod
inexistent și raportul de anul trecut nu se mai poate calcula.

**Transferul unui dosar se jurnalizează.** Rândul se mută, dar *faptul mutării*
rămâne. Nu e proprietate temporală completă — aceea ar cere coloane pe toate cele
48 de tabele — dar răspunde la „cine deținea dosarul în martie" și **nu împiedică**
trecerea la varianta completă dacă se dovedește necesară.

## 5. Predicatul

Două funcții în loc de una, fiindcă citirea și scrierea nu mai coincid.

```sql
-- SCRIERE: nodul propriu, atât. Identic cu predicatul de azi, deci
-- `WITH CHECK` din politicile existente rămâne corect fără modificare.
zveltio_tenant_write_ok(row_tenant uuid) →
  row_tenant = current_setting('zveltio.current_tenant')::uuid

-- CITIRE: mulțimea vizibilă, plus ascendenții dacă rândul e dintr-o colecție
-- marcată ca moștenită în jos.
zveltio_tenant_scope_ok(row_tenant uuid, inherit_down boolean DEFAULT false) →
  row_tenant = ANY(current_setting('zveltio.visible_tenants'))
  OR (inherit_down AND row_tenant = ANY(current_setting('zveltio.ancestor_tenants')))
```

`DEFAULT false` e ce face migrarea suportabilă: **fiecare politică existentă
continuă să cheme funcția cu un argument** și se comportă ca înainte.

GUC-uri puse o dată pe cerere, deci **zero căutări pe rând**:

| GUC | conținut |
|---|---|
| `zveltio.current_tenant` | nodul unde lucrez (neschimbat — și `DEFAULT`-ul coloanelor `tenant_id` îl folosește) |
| `zveltio.visible_tenants` | mulțimea pe care o pot citi |
| `zveltio.ancestor_tenants` | lanțul de deasupra nodului meu |

### Costul, măsurat

Pe o tabelă de 500 000 de rânduri cu 200 de unități, index pe `tenant_id`
(2026-08-26, `EXPLAIN ANALYZE`):

| predicat | rânduri citite | timp | plan |
|---|---|---|---|
| egalitate (modelul de azi) | 2 500 | 0,29ms | Index Only Scan |
| `= ANY`, 3 unități | 7 500 | 0,82ms | Index Only Scan |
| `= ANY`, 42 unități | 105 000 | 10,5ms | Index Only Scan |

**Costul pe rând e constant** — 0,116 / 0,109 / 0,100 µs. Mărimea mulțimii nu
contează; contează câte rânduri se returnează. Un nod-părinte care consolidează
citește legitim de 42 de ori mai multe rânduri, și aia e consolidarea, nu
mecanismul. Dacă devine o problemă, remediul e agregatul materializat (§9), nu
reglarea predicatului.

Steagul de moștenire în jos:

| `inherit_down` | timp | plan |
|---|---|---|
| `false` | 0,77ms | **ramura dispare din plan** — identic cu cazul fără steag |
| `true` | 9,5ms | `BitmapOr` peste două scanări de index |

**Un opt-in dezactivat costă exact zero**, fiindcă planificatorul pliază
literalul la compilare. Activat, e de ~7 ori mai scump pe rând, dar tot pe index
și tot în milisecunde.

**Limita de scară:** pentru zeci sau sute de unități, mulțimea e o listă mică
rezolvată o dată pe cerere. Peste câteva mii, trecerea corectă e la cale
materializată (`ltree`) cu potrivire de prefix — **prin aceleași funcții**, deci
decizia se amână fără cost.

## 6. Partea cu rază de acțiune reală

Politicile de azi sunt `FOR ALL` cu **același predicat în `USING` și `WITH
CHECK`**. Ca să se despartă citirea de scriere, **fiecare politică de tenant
trebuie recreată**, iar șablonul din care se creează politici pentru tabelele noi
de extensie trebuie schimbat odată cu ele.

E mecanic, dar **trebuie să fie complet**. Precedentul e în notele proiectului:
`ensureRlsEnforcementRole` a lăsat odată rolul `zveltio_rls` cu 11 tabele din
378, iar nimic n-a semnalat. Migrația trebuie să numere ce a atins și să refuze
dacă numărul nu se potrivește cu ce declară `pg_policies`.

### Cât de mecanic — măsurat 2026-08-26

Pe o bază cu extensiile instalate:

- **315 politici pe 315 tabele** — exact una per tabelă;
- **toate 315 identice**, în fiecare privință: `FOR ALL`, rol `public`,
  `PERMISSIVE`, `USING zveltio_tenant_scope_ok(tenant_id)`, iar `WITH CHECK`
  **același predicat**;
- zero politici de tenant cu altă formă.

Deci rescrierea e **un singur șablon aplicat de 315 ori**, iar verificarea e o
interogare: după migrație, toate 315 trebuie să aibă `zveltio_tenant_write_ok`
în `WITH CHECK` și niciuna să nu mai aibă vechea funcție acolo. Dacă numărul nu e
315, migrația se oprește.

Din cele 315, doar **4 vin din baseline-ul engine-ului**; restul de 311 sunt
create de migrațiile extensiilor. Șablonul lor trebuie schimbat odată cu
migrația, altfel fiecare extensie instalată după aceea reintroduce forma veche.

### Un gol găsit pe drum, care privește direct lucrarea asta

**20 de tabele au `tenant_id` și NICIO politică — și RLS nici măcar activat**
(`relrowsecurity = false`). Pe o bază fără extensii sunt 25.

Reconcilierea de la boot (`reconcileTenantRLS`) rulează **doar pe tabelele de
colecție** (`zvd_*` din `zvd_collections`, plus `pages`/`views`/`zones`); nu
atinge tabelele `zv_*` ale engine-ului.

Unele sunt legitim inter-firme și **nu trebuie** să primească politică:
`zv_tenants`-adiacentele (`zv_tenant_users`, `zv_tenant_usage`,
`zv_environments`), `zv_api_keys`, `zv_extension_registry`.

Altele arată a date de firmă care se bazează doar pe filtrarea din aplicație:
`zv_dashboards`, `zv_flows`, `zv_invitations`, `zv_record_comments`,
`zv_revisions`, `zv_saved_queries`, plus tabelele de scoring din checklists și
`zvd_page_views` / `zvd_webhooks` / `zvd_webhook_deliveries`.

**Nu am verificat dacă vreuna e exploatabilă** — unele pot fi accesate doar prin
căi care filtrează oricum. Dar contează direct aici: **predicatul ierarhic nu le
va proteja nici pe ele.** Prima lucrare a implementării ar trebui să fie
împărțirea acestei liste în „legitim inter-firme" și „lipsă de acoperire", cu
motivul scris lângă fiecare.

## 7. Ordinea de lucru

1. Migrație de schemă (§4). Aditivă, nu mută date.
2. Funcțiile noi (§5). `DEFAULT false` face ca nimic să nu se schimbe încă.
3. Middleware: rezolvă atribuirile → calculează mulțimea vizibilă și lanțul de
   ascendenți → pune GUC-urile.
4. Recrearea politicilor (§6), cu numărătoare și refuz la nepotrivire.
5. Marcarea colecțiilor moștenite în jos.
6. Testul (§8).

## 8. Cum se verifică

Un test care construiește arborele în miniatură — rădăcină plus două unități
surori — și dovedește, pe rânduri reale:

1. Sora A nu vede rândurile sorei B.
2. Rădăcina vede rândurile ambelor.
3. Rădăcina **nu poate scrie** în rândurile unei surori.
4. O atribuire expirată nu mai vede nimic.
5. Un rând dintr-o colecție moștenită în jos, scris la rădăcină, e vizibil din
   ambele surori.
6. Un rând dintr-o colecție **ne**marcată, scris la rădăcină, **nu** e vizibil de
   dedesubt.

Punctul 2 trebuie să pice pe codul de azi. E proba că modelul chiar s-a schimbat.

## 9. Explicit în afara modelului

- **Vizibilitate doar pe agregat** („văd totalul, nu înregistrările"). RLS e la
  nivel de rând. Se rezolvă cu vederi sau agregate materializate. Scris aici ca
  să nu încerce nimeni să o forțeze în politici.
- **Reședința datelor** — instanță separată, nu rază.
- **Rânduri cu doi proprietari** — un singur `tenant_id` pe rând. Coproprietatea
  reală ar cere o tabelă de legătură; se rezolvă prin direcție (proprietar unic
  la nodul potrivit, vizibil în jos).

## 10. Abordări respinse, și de ce

Sfaturile de mai jos sunt ce întoarce o căutare pe „multi-tenancy BaaS". Sunt
plauzibile, larg repetate, și **fiecare desface una dintre proprietățile de la
§3–§5**. Scrise aici fiindcă peste un an cineva le va primi din nou și vor părea
rezonabile.

### „Sediul central are un rol care ocolește RLS"

Forma obișnuită: `if (role === 'hq_admin') allowedUnits = []` — listă goală
însemnând „fără restricții".

**De ce nu.** Un rol care *oprește* impunerea e un rol unde o singură eroare
scurge tot. Aici sediul central e `read_scope = 'org'`: tot impus de bază, tot
auditabil, tot vizibil în politici. Un array gol în cod e o gaură; o rază 'org'
e o politică. Vezi și §12: `rls_bypass` nu devine niciodată mecanismul a nimic.

### „Filtrează în query builder / ORM"

Forma obișnuită: un middleware injectează `WHERE org_unit_id IN (…)` în fiecare
interogare, cu argumentul că „chiar dacă un programator terț uită să filtreze,
sistemul filtrează oricum".

**De ce nu.** Adevărat doar dacă interogarea trece prin acel query builder. Zveltio
are 57 de extensii scrise de terți care își scriu propriul SQL și nu sunt
obligate să treacă pe acolo. RLS există tocmai ca impunerea să nu depindă de
disciplina apelantului. Impunerea stă în politicile Postgres; query builder-ul e
ergonomie, nu graniță.

### „Pune unitatea activă în JWT"

Forma obișnuită: `active_org_unit_id` în token, vândut ca optimizare — „nu mai
interoghezi tabela de utilizatori la fiecare cerere".

**De ce nu.** Raza devine irevocabilă până la expirarea token-ului. Retragi o
atribuire, iar purtătorul continuă cu raza veche până expiră. Un milisecund pe
cerere schimbat pe o fereastră de revocare de ore. Atribuirile se rezolvă per
cerere; §4 le dă `valid_from` / `valid_to` tocmai ca revocarea să fie o dată, nu
o repovestire.

### „Scrie auditul asincron, după răspuns"

Forma obișnuită: `setImmediate(() => db.insert(auditLog))`, ca să nu se dubleze
latența.

**De ce nu — și asta e măsurat, nu presupus.** O scriere trimisă după răspuns
rulează pe tranzacția cererii, care e deja comisă și cu conexiunea întoarsă în
pool. Din `data/import/engine/routes.ts`, despre exact acest tipar:

> *„The recovery write went to a closed transaction, its `.catch` discarded the
> error, and a job that died left `status: 'pending'`, `errors: []` and not one
> line anywhere. Measured on a virgin database: an import stayed pending forever
> with no trace, which is how a broken import reads as a slow one."*

Dacă auditul chiar trebuie scos de pe calea critică, îi trebuie **tranzacția lui
proprie** (`withTenantIsolation`), nu contextul cererii.

### „Marchează rândurile globale cu `org_unit_id = NULL`"

**De ce nu, ca atare.** Verificat: sub un predicat de egalitate, `NULL = X` dă
NULL, deci un asemenea rând e invizibil pentru toată lumea, nu vizibil tuturor.
Azi 17 tabele permit NULL și niciuna nu obține nimic din asta. Vizibilitatea în
jos se face prin proprietar la un nod ascendent plus steagul de la §3, nu prin
absența proprietarului.

### „Partiționează pe `org_unit_id`"

**De ce nu aici.** Bun sfat pentru tenanți independenți cu interogări care ating
o singură unitate. Într-un arbore, consolidarea atinge *toate* partițiile —
adaugi cost de planificare exact pe interogarea pentru care există modelul.

### „Transferă între unități printr-o funcție cu drepturi de sistem"

**De ce nu.** Încă un ocol, și contrazice §4: transferul se jurnalizează. O
funcție cu drepturi de sistem e o a doua cale de acces care nu apare în nicio
politică.

## 11. Notat separat

Toate instalările rulează **medii de producție**. Schemele `_dev` per unitate,
`resolveEnvironment` și `provisionEnvironment` devin astfel greutate moartă care
se înmulțește cu fiecare unitate nouă. Simplificare reală, cu rază de acțiune
proprie — de decis separat, nu odată cu asta.

## 12. Federație — proiectat acum, construit mai târziu

Ca să nu se rescrie lanțul de acces peste un an, **principalul e polimorf de la
început**: persoană | serviciu | instanță străină. Un acord către o instanță
străină e o atribuire ca oricare alta, cu aceeași gramatică de raze și cu
valabilitate în timp — deci **un singur punct de aplicare**, nu o a doua cale
mai slabă.

`zv_api_keys` are deja `scopes`, `expires_at`, `allowed_ips` și `casbin_subject`:
jumătate din mecanism. Ce lipsește e identitatea instanței (cheie publică/mTLS)
și transportul.

**`rls_bypass` nu devine niciodată mecanismul federației.**

---

## 13. Note de implementare — ce s-a dovedit altfel (2026-08-26)

*Adăugate după implementare, pe ramura `feat/tenancy-hierarchy`. Planul de mai
sus a fost urmat; patru dintre afirmațiile lui nu au supraviețuit contactului cu
baza de date, și fiecare conta.*

### §5 — `DEFAULT false` ar fi rupt toate cele 315 politici

Planul cerea `zveltio_tenant_scope_ok(row_tenant uuid, inherit_down boolean
DEFAULT false)` **lângă** funcția existentă cu un argument, ca politicile vechi
să cheme mai departe cu un argument. Postgres refuză:

```
ERROR:  function zveltio_tenant_scope_ok(uuid) is not unique
HINT:  Could not choose a best candidate function.
```

Un parametru cu valoare implicită **intră în mulțimea de candidați** pentru un
apel cu un argument, deci apelul devine ambiguu. Nu la creare — **la fiecare
interogare**, pe toate cele 315 politici deodată.

Nici înlocuirea prin ștergere nu e disponibilă: o politică ia dependență tare de
funcția pe care o cheamă, iar `DROP FUNCTION` e refuzat cât timp există politica.

Ce s-a făcut: funcția cu un argument e **rescrisă pe loc** (`CREATE OR REPLACE`,
aceeași semnătură), iar varianta cu două argumente **nu are valoare implicită**,
deci nu poate primi un apel cu un argument și nu creează ambiguitate.

### §5 — tabelul de costuri măsura altceva decât rulează politica

Cifrele din §5 (Index Only Scan, 0,29ms / 10,5ms) sunt reale, dar au fost
măsurate pe un predicat **scris de mână** — `tenant_id = ANY (...)`. Politicile
cheamă o **funcție booleană de rând**, care se expandează într-un `CASE` în
jurul comparației, iar Postgres **nu poate folosi un index printr-un `CASE`**:
coloana indexată trebuie să apară într-o clauză indexabilă la nivelul de sus.

Măsurat pe 500 000 de rânduri, 200 de unități, cu index pe `tenant_id` prezent
tot timpul:

| forma predicatului | plan | timp |
|---|---|---|
| funcție booleană de rând (**forma folosită până acum**) | Seq Scan | **249 ms** |
| `tenant_id = ANY (funcție STABLE care întoarce mulțimea)`, 1 unitate | Index Only Scan | 0,28 ms |
| aceeași, 42 de unități | Index Only Scan | 10,8 ms |

Prin urmare **nu costul ierarhiei era problema, ci forma predicatului — de
dinainte de lucrarea asta.** Migrația scrie politicile în forma indexabilă:
`USING (tenant_id = ANY (zveltio_visible_tenants()))`. Funcțiile cu nume vechi
rămân definite peste aceleași mulțimi, fiindcă 57 de migrații de extensii le
scriu în politicile pe care le creează și nu toate sunt în acest depozit; o
extensie instalată mâine primește o politică **corectă, dar neindexată**, iar
reconcilierul de la boot o mută pe forma rapidă.

Contează mai mult acum decât înainte: un nod-părinte citește legitim de 42 de
ori mai multe rânduri, deci ăsta e exact momentul în care o scanare secvențială
încetează să fie ieftină.

### §6 — sunt 16 pe o instalare curată, nu 20

Cele patru care lipsesc — `zvd_pages`, `zvd_views`, `zvd_zones`,
`zvd_page_views` — **nu există pe o instalare curată**. Sunt tabelele vechi din
care `content/pages` migrează. Baza pe care s-a măsurat §6 era moștenită
dinainte de fuziune. Detalii și împărțirea completă în
`TENANCY-COVERAGE-CLASSIFICATION.md`.

Din cele 16, **5 intră în migrație** și 11 rămân afară cu motiv scris. Cele mai
multe dintre cele 11 nu sunt „administrative": sunt tabele al căror unic
cititor e un lucrător de fundal care rulează **pe pool, fără GUC** — unde o
politică n-ar proteja nimic, ar stinge tăcut funcția. `zv_flows`,
`zvd_webhooks`, `zv_revisions` și `zv_dashboards` sunt exact asta, iar
`insightsRoutes(poolDb, …)` / `flowsRoutes(poolDb, …)` o spun în `routes/index.ts`.

**Una era exploatabilă**, iar §6 lăsase întrebarea deschisă:
`GET /ext/workflow/checklists/templates/:id/scoring-schemes` citea schemele de
punctaj ale altei firme. Dovedit pe rânduri reale, reparat, și acum acoperit de
politică.

### §6 — „dacă numărul nu e 315, migrația se oprește" e prea rigid

315 e ce are o instalare cu toate extensiile. O bază doar cu engine-ul are 4.
Migrația nu poate ști numărul dinainte. Invariantul echivalent și verificabil pe
orice instalare: **numărul rescris = numărul găsit**, **zero politici rămase pe
predicatul vechi**, și toate cele rescrise poartă ambele predicate noi. Migrația
se oprește dacă vreuna nu ține.

### Un gol găsit în reconcilier, nu în plan

`reconcileExtensionTenantRLS` filtra tabelele după prefixul `zv_`/`zvd_`. Cele
11 tabele `trace_*` din `compliance/traceability` au `tenant_id`, declară
politică `tenant_isolation_*` și **erau sărite de fiecare boot** — deci
garanția „gazda pune fiecare tabelă de extensie pe predicatul gazdei" nu era
adevărată, și nimic nu o spunea. Prefixul nu era ce făcea operația sigură;
numele e în continuare validat ca identificator simplu înainte de interpolare.

### Ce NU s-a făcut din §4, deliberat

Cele patru coloane de abonament (`plan`, `trial_ends_at`, `billing_email`,
`max_api_calls_day`) **nu au fost șterse**. Toate patru sunt vii:
`routes/tenants.ts` le acceptă și le întoarce, Studio are formular pe `plan`, iar
`max_api_calls_day` **e** mecanismul de cotă din `middleware/tenant-quota.ts` —
ștergerea lui nu e curățenie, e oprirea cotelor per firmă. Restul planului e
aditiv; asta ar fi fost singura lui parte distructivă, și nu e cerută de nimic
altceva din el. Precedentul pentru amânare e în depozit: jumătatea de
*contracție* a migrației 048 e un reconciliator pe care operatorul îl armează
(`contractImportLogs`), nu o migrație. Decizie de proprietar.
