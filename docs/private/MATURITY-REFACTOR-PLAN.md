# Planul de maturizare — ce aș schimba dacă aș reconstrui Zveltio

> **Scris:** 2026-08-29, după o săptămână de audit măsurat pe `3.0.0-beta.64`.
> **Premisa proprietarului:** ieșirea din beta nu e grabă. Maturitatea întâi.
> **Forma pieței:** self-hosted, **dar nu neapărat mono-firmă** — vezi secțiunea
> imediat următoare. Premisa inițială a documentului era greșită.
> **Metodă:** blocuri de 5–7 pași, criterii de validare scrise ÎNAINTE de măsurare,
> document de stare citit la începutul fiecărui pas.
>
> **Regula care le guvernează pe toate:** un bloc are voie să se încheie cu „nu
> merită". În săptămâna care a produs documentul ăsta, **patru din cinci blocuri
> s-au încheiat exact așa** — și de fiecare dată măsurătoarea a găsit ceva mai bun
> decât planul pe care îl aveam în cap.


---

## STAREA LUCRĂRII — actualizat 2026-08-30

Planul de mai jos e ce **era** de făcut. Asta e ce s-a făcut. Fiecare bloc executat are un
document de stare propriu, cu măsurătorile și cu punctul lui de validare.

| bloc | stare | unde | livrat prin |
|---|---|---|---|
| **C — porțile** | ✅ **ÎNCHIS, 4 din 4** (2026-08-31) | `BLOCK-C-GATES-STATE.md` | #360, #361, #363, #364 |
| **B — granița per-firmă/instanță** | ✅ **ÎNCHIS, 4 din 4** | `BLOCK-B-BOUNDARY-STATE.md` | #365, ext#62 |
| **F — indexurile pe tiparele de acces** | ✅ **ÎNCHIS, 3 din 4 + unul anulat măsurat** | `BLOCK-F-ACCESS-PATTERNS-STATE.md` | #366 |
| **A — contextul explicit** | ⏸️ **AMÂNAT deliberat** — se ridică întâi `DB_POOL_MAX` | `BLOCK-A-EXPLICIT-CONTEXT-STATE.md` | #367 |
| **G — activarea extensiilor per firmă** | ✅ **ÎNCHIS, 4 din 4** | `BLOCK-G-PER-TENANT-ACTIVATION-STATE.md` | #368 |
| **D — condiții pe rânduri** | ✅ **ÎNCHIS cu „nu merită", 4 din 4** | `BLOCK-D-ROW-CONDITIONS-STATE.md` | — (zero cod de produs) |
| **H — `?as_of=` citea tot** | ✅ **ÎNCHIS, 4 din 4** | `BLOCK-H-TIME-TRAVEL-PAGINATION-STATE.md` | din constatarea lui D |
| **E — decizii de proprietar** | ⬜ neatins | — | — |

### Ce a găsit fiecare bloc, pe scurt

**C.** Meta-poarta `audit:gates` **nu rula nicăieri** — nici în CI, nici în `prepush`, iar
`prepush` nu e legat de niciun hook. Acoperirea reală era **9 porți din 31**, nu „11/11":
11 era numărul de *cazuri*. **Șapte porți erau fail-open** — raportau „curat" fără repo-ul
soră sau fără bază de date, una dintre ele scanând o cincime din corpus. Rămâne deschis
fiindcă 23 de porți din 41 încă nu sunt dovedite prin plantare, iar criteriul **nu a fost
rescris** ca să încapă.

**B.** Granița **e derivabilă din cod** — 384 de tabele, 333 per firmă, 51 de instanță,
confruntat **362 din 362** cu o bază instalată complet. **Nouă tabele de instanță sunt
copii ai unor tabele per-firmă**, izolate doar prin join, fără a doua linie. Un defect real
reparat: `zv_prompt_templates`. Și `admin-gate-check` extinsă la sora, unde erau **113
situri nepăzite** față de zero în engine.

**F.** Tiparele costă **de la zece firme**, nu de la o mie: un filtru pe câmp cu `ORDER BY`
ia **46 ms și aruncă toate cele 300 000 de rânduri** ca să întoarcă 25 — la 10 și la 100
de firme deopotrivă, fiindcă e o prăpastie de plan, nu o creștere. Egalitatea explicită era
**stinsă pentru fiecare cerere autentificată**. Reparate amândouă: **12,5 ms → 0,065 ms**,
fără regresie la o singură firmă.

**G.** `UNIQUE (name)` pe `zv_extension_registry` făcea activarea per firmă **imposibilă**,
nu doar nefăcută — al doilea rând era cheie duplicată. Iar listarea respecta `tenant_id`,
deci arăta unei firme o extensie ca absentă în timp ce codul ei răspundea. Poarta stă pe
**mânerul predat extensiei**, nu pe cale: `mountStrategy: 'global'` (implicitul) îi dă
app-ul motorului. Instalarea lua firma dintr-un **antet**.

**D.** Închis **fără nicio linie de cod de produs**. Tot limbajul de politici de rând e
**patru operatori pe un câmp**, combinate cu ȘI; filtrarea în memorie costă **2,2 ms din
336** — 0,65%. CASL le-ar acoperi pe toate patru, dar ar adăuga o dependență și ar cere
oricum aceeași traducere spre Kysely, scrisă de mână, ca să înlocuiască 70 de linii care nu
pot devia.

**H.** Ce a găsit D în schimb: `?as_of=` **citea tot istoricul colecției ca să întoarcă o
pagină** — 400 000 de rânduri aduse în proces pentru 25. Acum citește **49**. Câștigul e
memoria (~50 MB per cerere), nu timpul: `total` a rămas ~250 ms și e inerent.

**A.** Plafonul de concurență **e real și e exact la `DB_POOL_MAX`** — la `c = pool`
serviciul nu se degradează, se oprește, cu toate conexiunile `idle in transaction` și una
singură activă. Verificat la pool 10 și la 25. **Dar planul promite prea mult:** doar 56%
din timpul în care o conexiune e ținută e petrecut degeaba, deci tranzacțiile scurte ar da
aproximativ **2,3×**, nu „plafonul dispare". Iar `DB_POOL_MAX` mută același plafon liniar,
fără nicio schimbare de cod. Blocul s-a oprit la pasul 1: întrebarea a devenit una de
proprietar, nu de inginerie.

### Ce a fost anulat, măsurat — și de ce contează lista asta

- **C pasul 6**, extinderea lui `check-tenant-table-on-pool` la `lib/`: `lib/` conține
  identificatorul `poolDb` **o dată, într-un comentariu**, față de 19 ori în `routes/`.
  Poarta n-ar prinde nimic, niciodată.
- **F pasul 6**, poarta pe indexuri: regula ar prinde **220 de situri**, majoritatea
  indexuri de cheie străină legitime. Un ratchet fără motive scrise e decorațiune.

Amândouă închise cu aceeași regulă: **o poartă a cărei listă de excepții e singurul lucru
pe care-l produce e mai rea decât nicio poartă.**

### Reparat pe drum, în afara blocurilor

- **`0A000 cached plan must not change result type`** — pica lane-ul de integrare la ~2 din
  3 rulări. Cauza, găsită cu un event trigger de DDL: **migrațiile extensiilor rulează după
  ce motorul și-a deschis pool-ul**, iar extensia `ai` alterează `zvd_collections` la 1,3 s
  după pornire. Reparat prin reciclarea pool-ului (#362).

---

## Forma pieței — corectat de proprietar, 2026-08-29

Documentul a fost scris presupunând că instalarea tipică e self-hosted **cu o
singură firmă**, și a tras de acolo concluzii despre ce merită optimizat. Premisa
e greșită.

**Self-hosted, dar nu neapărat mono-firmă.** Corporații formate din mai multe
firme. Instituții publice care au în subordine alte instituții publice. Adică
exact forma **ierarhică** — un nod care citește peste subarborele lui — nu o
colecție de firme străine una de alta.

**Cerința care decurge, în cuvintele proprietarului:** multi-tenancy nu are voie să
penalizeze performanța **nici** pentru o singură firmă, **nici** pentru mai multe.
Nu e o alegere între cele două cazuri; sunt amândouă, simultan.

Ce se schimbă în document: argumentul „la o singură firmă scanarea completă *e*
planul corect, deci indexarea pe firmă nu plătește" rămâne adevărat **pentru acel
caz**, dar nu mai justifică absența unui bloc despre indexuri — fiindcă acel caz
nu mai e singurul. De aici **Blocul F**.

Ce NU se schimbă: nimic din lista „ce NU e în plan". Fiecare intrare de acolo a
fost respinsă pe alt motiv decât mărimea pieței, iar cele două care ating firmele
(politici legate de domeniu, `loadFilteredPolicy`) cad pentru că **resursele sunt
partajate între firme**, ceea ce corecția asta nu atinge.

---

## Metoda de lucru — obligatorie, nu recomandată

Nu e ceremonie. E procedura care a produs documentul ăsta, și motivul pentru care
patru din cinci blocuri s-au închis cu „nu merită" **înainte** să se scrie cod.

### 1. Un document de stare care călătorește cu sarcina

Un singur fișier care ține starea curentă a lucrării. **Se citește la începutul
fiecărui pas** și **se actualizează după fiecare pas** — nu la finalul blocului, nu
„când e ceva de spus".

Trebuie să conțină:

- **De ce există blocul** — cu cifrele care l-au justificat, nu cu intenția
- **Tabel de pași**, fiecare cu stare (`DE FĂCUT` / `ÎN LUCRU` / `FĂCUT` / `ANULAT`)
  și rezultatul lui
- **Criteriile punctului de validare, scrise ÎNAINTE de măsurare** — ca să nu poată
  fi ajustate după ce se văd cifrele. Ăsta e punctul central al metodei.
- **Ce NU se atinge în bloc** — explicit
- **Jurnal** cu o linie per pas
- **Context care nu trebuie re-descoperit** — mediu, variabile, capcane. Fără el,
  următorul care preia pierde o zi refăcând ce s-a aflat deja.

Exemplu viu: `docs/private/CASBIN-SCALING-STATE.md`.

### 2. Descompunere în blocuri de 5–7 pași

Nu mai mult. Un bloc de doisprezece pași e un plan care nu s-a gândit unde poate
greși. Pasul 0 al fiecărui bloc e întotdeauna „citește documentul de stare".

Primul pas al unui bloc **măsoară**, nu construiește. Dacă măsurătoarea nu confirmă
premisa, blocul se închide acolo și restul pașilor nu se mai fac. S-a întâmplat de
patru ori într-o săptămână.

### 3. Punct de validare între blocuri

Blocul următor **nu se deschide** decât dacă criteriile scrise dinainte sunt
îndeplinite. Un „nu merită" măsurat e un rezultat, nu un eșec — se scrie în document
și se raportează.

Trei reguli care fac diferența dintre validare reală și formalitate:

- **Criteriile se scriu înainte de măsurare.** După, nu mai sunt criterii, sunt
  justificări.
- **O poartă nedovedită prin plantare e decor.** Plantezi violarea pe care zice că o
  prinde și verifici că pică. `audit-gates.ts` face asta pentru toate cele 11.
- **Verifică pe mediul lor, nu pe al tău.** În săptămâna asta, patru schimbări au
  trecut local și au picat în CI — suita `unit` rulează fără bază de date, procesul e
  partajat între fișiere, iar primul rând din `user` poate fi contul god.

### Capcana care a costat cel mai mult

**O bază de date murdară nu dă un test roșu. Dă un număr credibil și fals.**

Suita lăsa cinci colecții per rulare. Treizeci de rulări au produs o bază în care
autorizarea măsura 364 ms per decizie. Cifra a ajuns în două rapoarte scrise înainte
ca cineva să întrebe câte colecții are o instalare reală. Răspunsul era trei, iar
costul real 0,93 ms.

Înainte de orice măsurătoare care produce o cifră raportabilă: **verifică pe ce fel
de bază măsori.**

---

## Ce NU e în plan, și de ce

Se pune aici primul, fiindcă lista asta a costat mai mult de descoperit decât cea
de mai jos.

| Idee | De ce nu |
|---|---|
| Oprirea RLS pe instalările cu o singură firmă | Câștig 0,19 ms/cerere. Pierdere: apărarea în adâncime, iar dacă detecția „o singură firmă" greșește o dată, izolarea nu e mai lentă, e **absentă**. |
| `loadFilteredPolicy` din Casbin | Nu există felie de filtrat: toate regulile `p` au `dom='*'`. Adaptorul nici nu implementează interfața. |
| Politici Casbin legate de domeniu | Colecțiile **nu au `tenant_id`** — sunt partajate între firme. Nu există per-firmă ce să legi. |
| Engine-ul pe rol NOSUPERUSER | Fundalul are nevoie **structurală** de vedere globală: `repairUnsignedWebhooksAtBoot` citește webhook-urile tuturor firmelor; `flow-executor` caută `tenant_id`-ul unui flow ca să afle în ce firmă rulează. Un rol restrâns nu le-ar face nesigure — le-ar face **oarbe**. |
| Înlocuirea Casbin cu CASL | Permisiunile voastre sunt **date editabile la runtime** (`zv_roles`, ecran de administrare, acordare fără deploy). Asta e puterea centrală a Casbin. CASL definește abilitățile **în cod**; ai rescrie depozitul de politici. În plus, `dom` e first-class la Casbin și inexistent la CASL, iar 55+ extensii depind de `permissionGate` ca API. |
| Zanzibar/SpiceDB | Modelul corect la scara Google, dar e **serviciu extern** — contrazice direct simplitatea self-hosted, care e argumentul vostru de vânzare. |
| Două pool-uri (restrâns pentru cereri, privilegiat pentru fundal) | Fezabil, dar nu reduce expunerea: pool-ul de fundal rămâne privilegiat, și acolo trăiește accesul neîngrădit. Iar câștigul (0,181 ms) e mai mic decât cel obținut gratuit prin mutarea rolului în `set_config` (0,175 ms). |

---

## Blocul A — contextul de firmă devine explicit

**Cea mai valoroasă schimbare din document, și cea mai riscantă.**

### Problema, măsurată

`registerCoreRoutes(app, { db: scopedDb, poolDb: db, auth })`. Acel `scopedDb` e un
`Proxy` al cărui `get` citește `getCurrentTenantTrx()` **la fiecare acces de
proprietate**. Extensiile primesc același tipar prin `createRestrictedDb`.

Un `Proxy.get` e **sincron**. Nu poate aștepta deschiderea unei tranzacții. De aici
decurg, în lanț:

- tranzacția trebuie deschisă **înainte** de handler, deci ține toată cererea
- ținând toată cererea, **fixează o conexiune din pool** de la BEGIN la răspuns
- de aici plafonul de concurență: la `DB_POOL_MAX=25`, `p95` sare la secunde peste
  c≈30 pe calea de date
- iar lenevirea tranzacției e **imposibilă** fără a rupe contractul public al SDK-ului
  de extensii: orice `db.selectFrom(...)` dinaintea deschiderii ar cădea tăcut pe
  pool-ul neizolat, în tot engine-ul și în toate cele 55+ extensii deodată

### Ce aș face

Fiecare handler primește un handle **deja legat de firmă**, ca argument explicit.
Mai verbos. În schimb:

- tranzacția poate fi scurtă (per interogare sau per grup), nu per cerere
- „am uitat contextul" devine **eroare de compilare**, nu scurgere tăcută
- plafonul de concurență dispare, fiindcă o conexiune e ținută microsecunde, nu
  milisecunde

### Pași

| # | Pas | Criteriu de ieșire |
|---|---|---|
| 1 | Măsoară cât timp e ținută efectiv o conexiune pe o cerere reală, față de cât ar fi ținută cu tranzacții scurte | cifra, nu estimarea |
| 2 | Inventariază cele 43 de situri `reqDb` + 2 `?? db` + tot codul de extensie pe `ctx.db` | listă completă |
| 3 | Proiectează accesorul explicit — `async`, ca TypeScript să prindă orice sit ratat | prototip pe 3 rute |
| 4 | Poarta care păzește refactorizarea: nicio interogare pe date de firmă în afara tranzacției | **dovedită prin plantare** |
| 5 | Migrarea rutelor nucleu, bucăți de câte ~10, cu suita verde între ele | verde la fiecare bucată |
| 6 | Contractul SDK pentru extensii: `ctx.db` capătă o formă explicită, cu perioadă de tranziție | 57/57 extensii trec |
| 7 | **VALIDARE** — plafonul chiar s-a mutat? | măsurat, nu presupus |

**Criteriul de oprire:** dacă pasul 1 arată că plafonul nu se mută, blocul se închide
acolo. Restul pașilor nu se fac.

**Avertisment din istoric:** un `finally` **sincron** a golit odată tranzacția
devreme și a lăsat 302 politici inerte, cu testele verzi. Refactorizarea asta trece
prin exact același teren.

---

## Blocul B — granița dintre „per firmă" și „de instanță" devine vizibilă

### Problema

`zvd_collections` **nu are `tenant_id`** — colecțiile sunt partajate. La fel
`zvd_relations`, `zvd_rls_policies`, `zvd_permissions`, `zvd_push_tokens`. Dar
`zvd_webhooks` **are**. Prefixul nu spune nimic.

**M-a păcălit personal.** Am scris o poartă presupunând că `zvd_` înseamnă „legat de
firmă", care a raportat trei constatări, toate cod corect. Și am construit premisa
unui branch întreg pe ideea că politicile cresc cu numărul de firme — falsă, exact
din același motiv.

Din 111 tabele cu `tenant_id`, **16 nucleu nu au deloc RLS** — izolarea lor e doar
în cod. E testată, deci nu e scurgere. Dar pe tabelele de colecții un `where` uitat
e prins de RLS; pe cele 16 e scurgere imediată, fără a doua linie.

### Pași

| # | Pas | Criteriu de ieșire |
|---|---|---|
| 1 | Clasifică toate cele 111 + tabelele de instanță, într-un tabel citit de mașină | fișier, nu wiki |
| 2 | Fă clasificarea derivabilă din cod — schemă separată, prefix, sau declarație | o singură sursă |
| 3 | Poartă: un tabel nou trebuie să declare de care parte e | dovedită prin plantare |
| 4 | Cele 16 nucleu: decide pentru fiecare — RLS, sau motiv scris de ce nu | zero nedecise |
| 5 | **VALIDARE** — poate cineva adăuga un tabel fără să declare partea? | nu |

---

## Blocul C — porțile înainte de cod

### De ce e bloc separat

Cele mai valoroase lucruri găsite în auditul din 27–29 august **n-au fost bug-uri**.
Au fost porți care nu verificau nimic:

- `check-numeric-string-arithmetic` ieșea cu 0 în **patru feluri** distincte
- jobul de CI care o rula era singurul care nu clona repo-ul soră
- suita lăsa **5 colecții per rulare**; 30 de rulări au produs o bază în care o
  măsurătoare a raportat autorizarea la 364 ms când realitatea era 0,93 ms

Ultimul e cel care contează: **o poartă lipsă nu dă un test roșu. Dă un număr
credibil și fals**, care ajunge în două rapoarte scrise.

### Pași

| # | Pas | Criteriu de ieșire |
|---|---|---|
| 1 | Fiecare poartă intră în `audit-gates.ts` — plantezi violarea, vezi dacă pică | 100% acoperire, azi 11/11 |
| 2 | Nicio poartă nu are voie să iasă cu 0 când nu poate verifica | fail-closed peste tot |
| 3 | Fiecare poartă declară de ce are nevoie; CI îi dă exact aia | fără sărituri tăcute |
| 4 | Poartă asupra porților: una nouă fără caz în meta-poartă nu se comite | dovedită prin plantare |
| 5 | ~~`check-tenant-table-on-pool` extinsă la `lib/`~~ | ⛔ **ANULAT 2026-08-29, măsurat** |
| 6 | **VALIDARE** — există vreo poartă care trece pe o violare plantată? | zero |

**Pasul 5 s-a închis cu „nu merită".** Venea din blocul 4 al
`CASBIN-SCALING-STATE.md`, dar fusese deja încercat și revenit, iar motivul e scris în
antetul porții: în `lib/` mânerul neîngrădit se numește `db`, la fel ca o tranzacție.
Măsurat: `lib/` conține identificatorul `poolDb` **o singură dată, într-un comentariu**;
`routes/` de 19 ori. Poarta extinsă n-ar putea prinde nimic, niciodată — prima încercare
a livrat exact asta, plus patru „excepții motivate" pentru violări imposibile.

Expunerea rămâne reală, dar cere o aserțiune de **runtime** (o interogare pe o tabelă de
firmă fără GUC de firmă, sub `NODE_ENV=test`), nu o poartă de build. E o proiectare
separată, nu o extindere.

---

## Blocul D — stratul de condiții pe rânduri

### Observație, nu plan ferm

`getRlsFilters()` traduce reguli în condiții de interogare — scris de mână. E exact
ce face **CASL** bine, cu tipare și traducere spre query.

Nu propun schimbarea motorului de autorizare — Casbin rămâne alegerea bună. Dar
partea de **condiții pe rânduri** e o bucată separabilă unde o bibliotecă matură ar
putea plăti. Merită un bloc de măsurare, nu o decizie acum.

Atenție la un lucru găsit: pe calea de *time travel*, filtrele se aplică **în
memorie** (`matchesRlsFilters`), nu în SQL. O regulă care ascunde rânduri costă acolo
tot setul citit înainte de filtrare.

---

## Blocul E — decizii de proprietar, nu de inginerie

1. **Catalogul din engine.** `extension-catalog.ts`: 749 de linii, 60 de intrări, 4
   importatori runtime, text specific României. Argumentul pentru mutare e curat.
   Contra-argumentul e al pieței tale: instalările izolate trebuie să vadă ce pot
   instala. **Compromis propus:** catalogul rămâne, dar ca **date versionate
   livrate**, nu ca sursă TypeScript compilată în engine.

2. **`KNOWN_EXTENSION_RESOURCES`.** Redus deja la o plasă; reconcilierea citește
   manifestele. Rămâne de decis dacă lista mai are rost.

3. **`DB_POOL_MAX`.** Implicitul e 25. Ridicarea la 40 mută `p95` de la secunde la
   214 ms la c=30 — dar schimbă concurența per instanță pe numărul de instanțe care
   încap în `max_connections`. Reglaj de deployment, decizie de proprietar.

---

## Blocul F — indexurile urmează tiparele de acces, nu coloanele

### De ce există

Sfat venit din afară și confirmat de măsurătorile proprii: *proiectezi schema după
cine cere ce date, iar fiecare tipar de acces își primește indexul lui.* Din trei
recomandări externe, singura care atinge ceva ce planul ăsta nu acoperea.

Mecanismul e deja dovedit în repo, pe **un singur** tipar — `57913f41`, măsurat pe
300 000 de rânduri și 63 de firme:

| | timp | rânduri aruncate ca să întoarcă 25 |
|---|---|---|
| politica singură | 1,94 ms | 6 408 |
| politica + egalitate explicită, index `(tenant_id, created_at DESC)` | **0,08 ms** | 0 |

Cauza e structurală și nu dispare: predicatul e
`tenant_id = ANY ((SELECT zveltio_visible_tenants())::uuid[])`, iar un `= ANY`
peste un tablou pe care planificatorul nu-l vede până la execuție **nu poate
conduce o scanare ordonată de index**. Forma nu e o greșeală — **ierarhia o cere**,
fiindcă o citire de subarbore nu se reduce la o egalitate scalară. Tensiunea e deci
permanentă: ierarhia cere tabloul, tabloul ucide scanarea ordonată, iar egalitatea
explicită de lângă politică e singurul lucru care le împacă.

Costul crește cu numărul de firme din tabelă. La forma de piață din secțiunea de
sus — un holding cu filiale, o instituție cu unități subordonate — asta nu e o
scară teoretică.

### Constatarea care deschide blocul — măsurată 2026-08-29

**Egalitatea explicită nu se aplică pentru nicio cerere autentificată.**

`setSingleTenantScope(scope === null)` (`tenant-manager.ts:867`) — dar
`resolveTenantScope` **nu întoarce niciodată `null`**: întoarce un obiect pe fiecare
ramură, inclusiv `{ visible: [tenantId] }` pentru `read_scope='self'`. Iar `userId`
e pasat pentru orice cerere cu sesiune (`middleware/tenant.ts:144`).

Sondă pe o firmă **fără** ierarhie, utilizator cu `read_scope='self'`, implicitul:

```
fara userId (cheie API / fundal):  egalitate pe 0000...0001
cu userId  (cerere autentificata): NULL — fara egalitate
```

Calea rapidă e activă exact pentru traficul care n-are nevoie de ea, și inactivă
pentru cel care are. **Nu ierarhia costă optimizarea — autentificarea o costă.**

`tenant-scope-filter.test.ts` nu poate prinde asta: acceptă deliberat ambele
rezultate (`seen === null || seen === ROOT`), deci rămâne verde în ambele lumi.

### Restul tiparelor — citite, nu măsurate

La crearea unei colecții se creează azi:

| tipar de acces | index | prefixat cu `tenant_id`? |
|---|---|---|
| `ORDER BY created_at DESC` | `(tenant_id, created_at DESC)` | ✅ #358 |
| filtru pe `status` | `(status)` | ❌ |
| filtru pe câmp indexat de utilizator | `("<câmp>")` | ❌ |
| căutare | GIN pe `search_vector` | ❌ |

Iar `reconcileExtensionTenantRLS` creează doar `(tenant_id)`, fără compusul pe care
`applyTenantRLS` îl creează lângă el — aceeași asimetrie ca cea reparată în #336, un
nivel mai adânc, pe tabelele extensiilor.

**Tabelul ăsta e derivat prin citire.** Repo-ul are două ocoluri greșite pe exact
predicatul ăsta, iar un audit prin citire a ratat o scurgere reală acum două zile.
Pasul 1 măsoară; nu confirmă lista de mai sus.

### Pași

| # | Pas | Criteriu de ieșire |
|---|---|---|
| 1 | Măsoară fiecare tipar din tabel cu politica APLICATĂ, la 1 / 10 / 100 de firme | cifre, nu lista de mai sus |
| 2 | **Pragul:** de la câte firme începe fiecare tipar să coste? Sub prag, tiparul iese din bloc | un număr scris pentru fiecare |
| 3 | `singleTenant` să însemne „raza e exact firma asta", nu „n-a ieșit obiect de scope" | un test care DISTINGE, nu unul care acceptă ambele |
| 4 | Egalitatea explicită pe calea extensiilor, sau motiv scris de ce nu | decis, nu omis |
| 5 | Compusul lipsă din `reconcileExtensionTenantRLS` | simetrie cu `applyTenantRLS` |
| 6 | Poartă: un index nou pe o tabelă de firmă declară tiparul pe care-l servește | dovedită prin plantare |
| 7 | **VALIDARE** — plafonul s-a mutat la **ambele** capete: o firmă și N firme? | măsurat, amândouă |

**Criteriul de oprire:** dacă pasul 2 arată că niciun tipar nu costă sub o mie de
firme, blocul se închide acolo și rămâne doar pasul 3 — care e o corecție de o linie
plus un test, și se face oricum.

**Ce NU se atinge:** forma predicatului RLS. S-a schimbat de trei ori, ultima dată în
`005_rls_initplan_predicate.sql`, și e acum cea corectă. Blocul adaugă egalități și
indexuri **lângă** politică; o egalitate poate doar să îngusteze setul pe care
politica îl permite, niciodată să-l lărgească, deci suprafața de securitate rămâne
neschimbată și RLS continuă să decidă.

---

## Ordinea recomandată

**1. Blocul C — porțile.** Primul, deși e cel mai puțin spectaculos. Blocul A trece
prin terenul unde un `finally` sincron a lăsat odată 302 politici inerte **cu testele
verzi**. Nu se începe fără plasa. Fără C, o regresie din A nu se vede.

**2. Blocul B — granița per-firmă / instanță.** Ieftin, și neclaritatea lui a produs
deja două concluzii greșite ale mele într-o singură săptămână: o poartă care raporta
cod corect drept violare, și premisa falsă a unui branch întreg. Trebuie făcut
înainte de A, fiindcă A mută exact codul care depinde de distincția asta.

**3. Blocul F — indexurile pe tiparele de acces.** După B, fiindcă B e cel care
spune care tabele sunt per firmă — adică pe care are sens un index compus. Înainte
de A, fiindcă A mută exact codul care decide raza cererii, iar pasul 3 al lui F îl
corectează întâi.

**4. Blocul A — contextul explicit.** La urmă, cu tot timpul din lume, și cu
libertatea declarată de a se opri la pasul 1 dacă măsurătoarea nu confirmă că
plafonul se mută.

**D și E oricând** — nu blochează nimic și nu sunt blocate de nimic.

### De ce ordinea asta și nu ordinea valorii

A e cea mai valoroasă și e ultima. Nu din prudență: din faptul că e singura care
poate rupe izolarea tăcut. C și B costă puțin și transformă o eventuală greșeală din
A dintr-una tăcută într-una zgomotoasă. Ordinea e aleasă după **ce se întâmplă dacă
greșim**, nu după ce câștigăm dacă reușim.

---

## Ce validează planul ăsta ca fiind onest

Fiecare afirmație de aici are un număr sau un test în spate, iar cele care nu au sunt
marcate ca observații. Lista „ce NU e în plan" e mai lungă decât lista de făcut,
pentru că săptămâna care a produs-o a fost în mare parte o listă de idei bune care
n-au supraviețuit măsurării — inclusiv trei ale mele care ajunseseră deja în rapoarte
scrise înainte să fie infirmate.

### Blocul G — activarea extensiilor per firmă (2026-08-30) — **4/4**

God instalează pe instanță; adminul firmei decide dacă acționează la el.
A doua jumătate nu era doar nefăcută, era **imposibilă**: `UNIQUE (name)` pe
`zv_extension_registry` dădea o extensie un singur rând, deci `tenant_id` putea
reține doar cine a instalat ultimul. Migrația `007` o deschide cu
`UNIQUE NULLS NOT DISTINCT (tenant_id, name)`.

**Poarta nu stă pe cale, ci pe mâner.** `mountStrategy: 'global'` — implicitul —
predă extensiei app-ul motorului; o poartă pe `/ext/*` n-ar fi păzit nimic.
Detalii, limite și cele două lucruri pe care le acoperă doar parțial (cron,
`app.route()`): `docs/private/BLOCK-G-PER-TENANT-ACTIVATION-STATE.md`.
