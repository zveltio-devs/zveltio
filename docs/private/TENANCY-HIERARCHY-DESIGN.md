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

## 10. Notat separat

Toate instalările rulează **medii de producție**. Schemele `_dev` per unitate,
`resolveEnvironment` și `provisionEnvironment` devin astfel greutate moartă care
se înmulțește cu fiecare unitate nouă. Simplificare reală, cu rază de acțiune
proprie — de decis separat, nu odată cu asta.

## 11. Federație — proiectat acum, construit mai târziu

Ca să nu se rescrie lanțul de acces peste un an, **principalul e polimorf de la
început**: persoană | serviciu | instanță străină. Un acord către o instanță
străină e o atribuire ca oricare alta, cu aceeași gramatică de raze și cu
valabilitate în timp — deci **un singur punct de aplicare**, nu o a doua cale
mai slabă.

`zv_api_keys` are deja `scopes`, `expires_at`, `allowed_ips` și `casbin_subject`:
jumătate din mecanism. Ce lipsește e identitatea instanței (cheie publică/mTLS)
și transportul.

**`rls_bypass` nu devine niciodată mecanismul federației.**
