# Planul de maturizare — ce aș schimba dacă aș reconstrui Zveltio

> **Scris:** 2026-08-29, după o săptămână de audit măsurat pe `3.0.0-beta.64`.
> **Premisa proprietarului:** ieșirea din beta nu e grabă. Maturitatea întâi.
> **Metodă:** blocuri de 5–7 pași, criterii de validare scrise ÎNAINTE de măsurare,
> document de stare citit la începutul fiecărui pas.
>
> **Regula care le guvernează pe toate:** un bloc are voie să se încheie cu „nu
> merită". În săptămâna care a produs documentul ăsta, **patru din cinci blocuri
> s-au încheiat exact așa** — și de fiecare dată măsurătoarea a găsit ceva mai bun
> decât planul pe care îl aveam în cap.


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
| 5 | **VALIDARE** — există vreo poartă care trece pe o violare plantată? | zero |

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

## Ordinea recomandată

**1. Blocul C — porțile.** Primul, deși e cel mai puțin spectaculos. Blocul A trece
prin terenul unde un `finally` sincron a lăsat odată 302 politici inerte **cu testele
verzi**. Nu se începe fără plasa. Fără C, o regresie din A nu se vede.

**2. Blocul B — granița per-firmă / instanță.** Ieftin, și neclaritatea lui a produs
deja două concluzii greșite ale mele într-o singură săptămână: o poartă care raporta
cod corect drept violare, și premisa falsă a unui branch întreg. Trebuie făcut
înainte de A, fiindcă A mută exact codul care depinde de distincția asta.

**3. Blocul A — contextul explicit.** La urmă, cu tot timpul din lume, și cu
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
