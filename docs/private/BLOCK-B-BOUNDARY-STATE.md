# Stare — Blocul B: granița dintre „per firmă" și „de instanță"

> **Se citește la începutul fiecărui pas. Se actualizează după fiecare pas.**
> Branch: `block-b/boundary` · pornit din `b2dabd27` (master, post-#364)
> Plan: `MATURITY-REFACTOR-PLAN.md` §Blocul B. Ordinea: C → **B** → F → A.
> Regula care le guvernează pe toate: **nu se construiește nimic înainte ca o
> măsurătoare să arate că merită.** Un bloc are voie să se încheie cu „nu merită" —
> Blocul C tocmai s-a închis cu 3 criterii din 4, fără să-și rescrie criteriul.

---

## De ce există blocul

**Prefixul nu spune de care parte e o tabelă, iar asta a produs deja concluzii false.**

`zvd_collections`, `zvd_relations`, `zvd_rls_policies`, `zvd_permissions`,
`zvd_push_tokens` **nu au** `tenant_id` — sunt resurse de instanță, partajate între
firme. `zvd_webhooks` **are**. Același prefix, părți opuse ale graniței.

Ce a costat neclaritatea asta, măsurat, în două săptămâni:

- o poartă scrisă pe presupunerea că `zvd_` înseamnă „legat de firmă" a raportat
  **trei bucăți de cod corect** drept violări;
- **premisa unui branch întreg** (`perf/casbin-scaling`) a fost falsă din același
  motiv — politicile Casbin „cresc cu numărul de firme" doar dacă resursele sunt per
  firmă, iar colecțiile sunt partajate. Blocul 2 al acelui branch nu s-a mai deschis.

Și consecința de izolare: din tabelele cu `tenant_id`, o parte **nu au deloc RLS** —
izolarea lor trăiește doar în cod. E testată, deci nu e scurgere. Dar pe o tabelă cu
politică, un `where` uitat e prins de Postgres; pe celelalte e scurgere imediată, fără
a doua linie de apărare.

**B trebuie făcut înaintea lui A și F**: A mută exact codul care depinde de distincția
asta, iar F are nevoie să știe care tabele sunt per firmă ca să știe pe care are sens un
index compus.

---

## Criteriile punctului de validare — SCRISE ÎNAINTE DE MĂSURARE

Blocul se închide ca reușit **doar dacă toate patru** sunt adevărate:

1. **Fiecare tabelă din ambele repo-uri e clasificată** — per firmă, de instanță, sau
   cu motiv scris de ce nu se poate decide. Zero nedecise.
2. **Clasificarea e derivabilă din cod, dintr-o singură sursă.** Nu un wiki, nu un
   document care se învechește: un fișier pe care o poartă îl poate citi.
3. **O tabelă nouă nu poate intra fără să declare partea** — dovedit prin plantare, nu
   prin citirea porții.
4. **Clasificarea derivată se potrivește cu realitatea**, verificată pe o bază instalată
   complet. Dacă nu se potrivește, sursa unică e greșită și criteriul 2 cade cu ea.

**Criteriu de oprire:** dacă pasul 1 arată că distincția **nu** e derivabilă din cod —
că adevărul stă doar într-o bază vie — blocul se închide acolo. O clasificare care cere
o bază de date e o clasificare pe care nicio poartă n-o poate folosi, iar Blocul C a
măsurat exact ce se întâmplă cu porțile care nu-și pot obține corpusul.

**Ce NU e criteriu:** numărul de tabele cu RLS. Blocul nu urmărește să pună politici
peste tot — `TENANCY-COVERAGE-CLASSIFICATION.md` a stabilit deja, caz cu caz, că pentru
11 tabele o politică **ar stinge tăcut funcția**, fiindcă unicul lor cititor e un
lucrător de fundal pe pool, fără GUC.

---

## Pași

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul ăsta | — | (la fiecare pas) |
| 1 | **E derivabilă din cod?** Clasifică din SQL-ul ambelor repo-uri, fără bază vie | ✅ **FĂCUT** | **DA** — 384 tabele, 332/52 |
| 2 | O singură sursă, citibilă de mașină | ✅ **FĂCUT** | `quality-gates/tenant-boundary.json` |
| 3 | Poartă: o tabelă nouă declară partea | ✅ **FĂCUT** | dovedită prin plantare |
| 4 | Confruntă derivarea cu o bază instalată complet | ✅ **FĂCUT** | **362 din 362 se potrivesc** |
| 5 | Cele fără RLS: decizie sau motiv scris pentru fiecare | ✅ **FĂCUT** | **zero nedecise**; 8 marcate plauzibile-necitite |
| 6 | **PUNCT DE VALIDARE** | DE FĂCUT | — |

---

### Pașii 1–3 — rezultatul (2026-08-29)

**Răspunsul la întrebarea care putea închide blocul: DA, e derivabilă din cod.** O
tabelă își declară partea prin faptul că poartă sau nu `tenant_id`, iar asta se citește
din SQL-ul ambelor repo-uri, **fără bază de date** — deci o poartă o poate folosi.

| | |
|---|---:|
| tabele create în SQL | **384** |
| per firmă (`tenant_id`) | **332** |
| de instanță | **52** |
| **dintre care copii ai unei tabele per-firmă** | **9** |

**Validat înainte de a fi crezut:** derivarea a fost confruntată cu zece tabele a căror
parte era deja cunoscută din `TENANCY-COVERAGE-CLASSIFICATION.md` — `zvd_collections`,
`zvd_relations`, `zvd_rls_policies`, `zvd_permissions`, `zvd_push_tokens` de instanță;
`zvd_webhooks`, `zvd_webhook_deliveries`, `zv_flows`, `zv_dashboards`, `zv_revisions`
per firmă. **10 din 10.** Și a fost scrisă de două ori, independent (Python de analiză,
apoi TypeScript pentru poartă): aceleași 52.

**Capcană găsită la derivare:** 258 de tabele primesc `tenant_id` printr-un `ALTER` aflat
în ALT fișier decât `CREATE`-ul lor. Un clasificator care se uită doar la `CREATE` greșește
pentru majoritatea corpusului.

### Cele nouă — constatarea centrală a blocului

| tabelă | părinte per-firmă |
|---|---|
| `zv_flow_runs`, `zv_flow_steps`, `zv_flow_dlq` | `zv_flows` |
| `zvd_dashboard_shares`, `zvd_dashboard_subscriptions`, `zv_panels` | `zv_dashboards` |
| `zv_media_shares`, `zv_media_versions` | `zv_media_files`, `zv_media_folders` |
| `zv_api_key_access_log` | `zv_api_keys` |

**Nu sunt scurgeri.** Verificat pe `zv_flow_runs`: ambele situri din `routes/flows.ts`
fac `innerJoin` pe `zv_flows` și filtrează `f.tenant_id`. Corect, scris de mână, în
ambele locuri.

Sunt **izolare fără a doua linie**: neavând `tenant_id`, RLS n-are coloană pe care să se
lege, deci un join uitat e o citire inter-firme cu nimic în spate. Pe o tabelă cu
politică, aceeași scăpare e prinsă de Postgres.

### Poarta, dovedită prin plantare — și ce a găsit plantarea

`scripts/check-tenant-boundary.ts` + `quality-gates/tenant-boundary.json`. O tabelă fără
`tenant_id` care nu e declarată pică poarta; o intrare rămasă după ce tabela a primit
`tenant_id` o pică la fel.

**Prima versiune a porții avea un punct orb, găsit de sondă, nu de citire:** regexul cerea
paranteza de închidere pe linie proprie, deci un `CREATE TABLE` scris pe **o singură
linie** era invizibil. Sonda a rămas verde. Corpul se ia acum numărând paranteze, fiindcă
un regex nu le poate echilibra. A cincea oară în lucrarea asta când plantarea a găsit ce
citirea n-ar fi arătat.

**Onestitate despre baseline:** din cele 52 de rânduri, **30 au motiv verificat** și
**22 sunt marcate NEVERIFICAT**. Un rând NEVERIFICAT nu e o justificare, e o sarcină —
scris așa tocmai ca să nu devină „scuza care arată a revizie". Ăsta e restul pasului 5.

### Pasul 4 — REUȘIT, după ce am corectat o explicație greșită a mea

**CORECȚIE.** Am scris mai jos, cu convingere, că baza de referință eșua fiindcă
`ON_ERROR_STOP=1` oprește la prima eroare și lasă migrația pe jumătate aplicată.
**Explicația aia era greșită.**

Cauza reală: **81 de migrații de extensii au o secțiune `-- DOWN`**, iar motorul taie
fișierul pe marcajul ăla (`lib/extensions/extension-utils.ts:178`) și rulează doar
jumătatea UP. `psql -f` rulează fișierul întreg — deci crea tabelele și apoi **le
ștergea**. De aceea `zv_ai_chats` lipsea deși migrația raporta `rc=0`.

Aplicând doar jumătatea UP (`awk '/^-- DOWN[[:space:]]*$/{exit}'`):

```
trecerea 1: UP aplicate=199 eșuate=0
trecerea 2: UP aplicate=199 eșuate=0
```

**199 de migrații, zero eșecuri** — față de „160 aplicate, 38 eșuate" cu metoda greșită.
363 de tabele.

**Rezultatul confruntării: 362 din 362 se potrivesc. Zero nepotriviri.** (A 363-a e
`spatial_ref_sys`, a PostGIS-ului, exclusă ca nefiind a noastră.)

**Criteriul 4 e îndeplinit.** Iar cele 245 de „nepotriviri" de la prima încercare erau,
cum bănuiam, artefact — doar că motivul pe care îl scrisesem era el însuși greșit.
Lecția e mai ascuțită decât credeam: nu doar că **o bază construită prost dă cifre false**,
ci și că **explicația plauzibilă a unui eșec poate fi greșită** dacă e scrisă fără s-o
verifici. `rc=0` de la `psql` ar fi trebuit să mă oprească atunci.

### Prima încercare, păstrată pentru pistele eliminate (2026-08-29)

Criteriul cerea confruntarea derivării cu o bază instalată complet. Am construit una:
bază virgină → migrațiile engine-ului (72 de tabele) → toate migrațiile de extensii
aplicate cu `psql -f`, în bucle repetate până la stagnare → **345 de tabele**.

Comparația a dat **245 de nepotriviri din 345**, toate în aceeași direcție: derivarea
spune că tabela are `tenant_id`, baza vie spune că nu.

**Cifra aia nu e un rezultat. E un artefact, și baza e de vină.**

38 de migrații eșuau constant, iar reluarea lor nu ajuta — deci nu era ordinea. Cauza:
`psql -v ON_ERROR_STOP=1` oprește la **prima** eroare din fișier, lăsând migrația **pe
jumătate aplicată**. Proba: `zvd_collections` avea `ai_embed_excluded_fields` (linia 233
din `ai/001_initial.sql`) dar **nu** `ai_search_enabled` (linia 154), iar `zv_ai_chats`
nu exista deloc. O schemă incoerentă, nu una incompletă.

Deci: cele 245 de „nepotriviri" spun ceva despre metoda mea de instalare, **nimic**
despre derivare. Le raportez ca eșec de instrument, nu ca finding — e aceeași capcană
care a produs „364 ms", într-un costum nou: **o bază construită prost dă cifre
credibile și false.**

**Ce ar cere un pas 4 corect:** baza de referință construită pe calea pe care proiectul
o folosește el însuși — suita de teste a repo-ului soră peste o bază virgină cu schema
engine, apoi un al doilea boot ca să ruleze reconcilierile (`project_ext_contract_suite_recipe`).
Nu `psql -f` într-o buclă. E o lucrare în sine, nu un pas de zece minute.

**Ce rămâne totuși dovedit despre derivare, fără baza aia:**
- **10 din 10** pe tabele a căror parte era cunoscută independent
- **două implementări scrise separat** (analiză în Python, poartă în TypeScript) dau
  aceleași 52 de tabele de instanță
- poarta e dovedită prin plantare, iar plantarea i-a găsit deja un punct orb real

Nu e criteriul 4, și n-am de gând să-l declar îndeplinit. E ce se poate afirma azi.

### Pasul 5 — citit tabelă cu tabelă (2026-08-29)

Din cele 22 marcate `NEVERIFICAT`, **12 au primit acum un motiv din cod**; 8 sunt
clasificate plauzibil din natura operației dar **fără să le fi citit codul**, marcate ca
atare; **10 rămân nedecise**.

**O problemă găsită: `zv_prompt_templates`.** Șabloane la nivel de instanță, dar scrise
printr-o rută păzită de `checkPermission(user.id, 'admin', '*')` — care trece pentru un
`tenant_admin`, fiindcă domeniul vine din ALS. Deci **administratorul firmei A poate crea
șabloane pe care le vede toată instanța**, iar `name` fiind **UNIQUE global**, firma A
poate ocupa un nume pe care firma B nu-l mai poate folosi. Nu e scurgere de date de
afaceri; e vizibilitate inter-firme a configurației plus un spațiu de nume comun. Decizie
de proprietar: `tenant_id` + unicitate compusă, sau ruta se restrânge la admin de instanță.

**Două clasificate corect, care merită notate:** `zvd_panel_cache` e apărat — cache-ul se
citește DUPĂ `canReadDashboard` și e cheiat pe un panou care aparține unui dashboard
per-firmă. Iar `zv_rag_documents` are **două referințe în tot codul ambelor repo-uri**,
niciuna o interogare de rulare: pare tabelă moartă, iar o tabelă moartă n-are graniță de
apărat.

### Descoperire colaterală: `admin-gate-check` nu se uită în repo-ul soră

Poarta interzice `checkPermission(<user>, 'admin', '*')` în `packages/engine/src/routes`.
Măsurat:

| | situri de COD (fără comentarii) |
|---|---:|
| `packages/engine/src/routes` | **0** — cele 5 potriviri sunt comentarii care explică de ce să n-o faci |
| `../zveltio-extensions` | **111**, în **46 de fișiere** |

Poarta păzește locul unde nu se întâmplă și ignoră locul unde se întâmplă de o sută și
ceva de ori. E o constatare de Blocul C, ieșită la iveală în Blocul B — și e chiar
mecanismul care face problema lui `zv_prompt_templates` posibilă.

**REPARAT:** poarta scanează acum și sora, **pe ratchet**, nu cu toleranță zero. Numărul
ei propriu, mai riguros decât `grep`-ul meu: **113 situri în 47 de fișiere**, înghețate
per fișier. Pot scădea, nu pot crește.

De ce ratchet și nu interdicție: antetul porții spune singur că **nu există răspuns în
masă** — fiecare sit e ori o operație de instanță, ori o suprascriere la nivel de firmă,
și doar autorul lui știe care. O poartă care ar cere repararea tuturor celor 113 dintr-o
dată ar fi oprită, nu respectată.

**Și are ieșire, verificat înainte de a o construi:** `isTenantAdmin` și
`requireInstanceAdmin` sunt pe contextul extensiei (`sdk/src/extension/index.ts:428,438`,
`lib/extensions/internals.ts:28`), iar **patru extensii le folosesc deja**. Un ratchet
fără cale de ieșire ar fi o fundătură.

Dovedită prin plantare, cu etichetă proprie (`admin-gate-check (sibling ratchet)`), ca să
se distingă de cazul care păzește calea engine-ului. Fail-closed fără soră — verificat cu
scriptul NOU, după ce prima verificare rulase din greșeală versiunea veche dintr-un
worktree detașat.

*(Prima mea numărătoare a dat 112 și 5 „în engine". Erau comentarii — poarta le sare
corect, `grep` nu. Fals pozitiv al meu, prins citind ce sare poarta.)*


### Pasul 5 — încheiat, plus reparația care a ieșit din el

**Zero nedecise.** Din cele 52 de rânduri: motiv verificat în cod pentru majoritatea, **8
marcate explicit „plauzibile din natura operației, codul NU a fost citit"** (copii de
siguranță, PITR, observabilitate) — un motiv onest, nu o verificare pretinsă — și **3
tabele care par moarte**: `zv_rag_documents`, `zv_doc_templates`,
`zvd_branch_review_requests` au **zero interogări de rulare** în ambele repo-uri. O tabelă
moartă n-are graniță de apărat, dar are nevoie de o confirmare înainte să fie ștearsă.

**`zv_prompt_templates` — reparat**, cu aprobarea proprietarului.
`ai/engine/migrations/007_prompt_templates_tenant.sql`: `tenant_id` cu implicit din GUC,
umplere la firma implicită, index compus `(tenant_id, created_at DESC)`, iar cheia unică
lărgită de la `(name)` la `(tenant_id, name)`.

Nu e un design nou: `004_tenant_rls.sql` a dat `tenant_id` la opt tabele ale extensiei și
`005_tenant_scoped_unique_keys.sql` a lărgit cheile lor. **`zv_prompt_templates` n-a fost
în niciuna.** Aceeași campanie, aceeași formă, o tabelă sărită.

Nicio schimbare de rută: handlerele folosesc `ctx.db`, proxy-ul request-scoped, deci
politica pusă de reconcilierul gazdei filtrează citirile singură, iar implicitul coloanei
pune `tenant_id` la inserare.

**Dovadă cu două capete, pe baza de referință:**

| | rezultat |
|---|---|
| cu cheia veche `(name)` | `ERROR: duplicate key … Key (name)=(raport-lunar) already exists` — iar RLS i-ar fi ascuns firmei B rândul despre care primea eroarea |
| cu cheia nouă `(tenant_id, name)` | ambele inserturi reușesc |

Versiunea extensiei `ai` urcată 1.0.8 → 1.0.9: fără bump, instalările refuză aceiași
octeți la aceeași versiune.

**Iar ratchet-ul de graniță a prins propria mea schimbare** — a cerut ca
`zv_prompt_templates` să iasă din lista de instanță, fiindcă acum poartă `tenant_id`.
Exact pentru asta a fost scrisă direcția a doua a porții.

## Ce NU se atinge în blocul ăsta

- **Politicile RLS existente și forma predicatului.** S-a schimbat de trei ori și e
  acum cea corectă (`005_rls_initplan_predicate.sql`).
- **Indexurile.** Alea sunt Blocul F, care are nevoie de rezultatul lui B ca intrare.
- **Rolul de conectare al engine-ului.** Decis măsurat că nu se schimbă.
- **Ierarhia de firme.** `feat/tenancy-hierarchy` e o lucrare separată, necomisă.

---

## Lucrare anterioară de care se ține cont

- `docs/private/TENANCY-COVERAGE-CLASSIFICATION.md` — a împărțit deja tabelele fără
  politică: **11 legitim inter-firme** (cu motiv verificat în cod pentru fiecare), **5
  care intră în migrație**, iar patru care păreau lipsă **nu există pe instalare curată**.
  Blocul ăsta nu reface munca aia; o folosește și o extinde la mulțimea completă.
- `project_tenant_unique_keys_campaign` — 61 de chei unice scrise înainte de
  multi-tenancy, 60 reparate. Detectorul de acolo (`pg_constraint` fără `tenant_id` în
  `conkey`) e o rudă a ce cere pasul 3.

---

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-29 | 5 | Citit tabelă cu tabelă: 12 din 22 au primit motiv din cod, 8 plauzibile-necitite, 10 nedecise. **Găsit: `zv_prompt_templates`** — instanță, scrisă printr-o gardă care trece pentru `tenant_admin`, cu `name` UNIQUE global. **Colateral: `admin-gate-check` nu scanează sora — 0 situri de cod în engine, 111 în 46 de fișiere de extensie.** |
| 2026-08-29 | 4 | **Încercat, neîncheiat.** Baza de referință construită cu `psql -f` în buclă e **pe jumătate aplicată** (`ON_ERROR_STOP` oprește la prima eroare din fișier), deci incoerentă: `zvd_collections` avea o coloană `ai_*` dar nu și celelalte, `zv_ai_chats` lipsea. Comparația a dat 245 de „nepotriviri" care spun ceva despre instalarea mea și nimic despre derivare — artefact, nu finding. Un pas 4 corect cere calea din `project_ext_contract_suite_recipe`. |
| 2026-08-29 | 1–3 | **Derivabilă din cod: DA.** 384 tabele, 332 per firmă, 52 de instanță, **9 copii ai unor tabele per-firmă** — izolare fără a doua linie. Derivarea validată 10/10 pe adevăruri cunoscute și scrisă de două ori independent. Poarta `check-tenant-boundary` dovedită prin plantare; sonda i-a găsit un punct orb (CREATE pe o singură linie). Baseline: 30 motivate, 22 NEVERIFICAT. |
| 2026-08-29 | setup | Branch `block-b/boundary` din `b2dabd27`. Document scris, criterii fixate ÎNAINTE de măsurare. Pasul 1 pune întrebarea care poate închide blocul devreme: e distincția derivabilă din cod, sau adevărul stă doar într-o bază vie? |

---

## Context care nu trebuie re-descoperit

- **Mediul:** worktree `/home/liviu/zveltio-audit-ba/zveltio`, sora în
  `../zveltio-extensions`. Baze proprii; portul `:3400`.
- **Env fără de care testele mint:** `ZVELTIO_REGISTRATION_ENABLED=1`,
  `FIELD_ENCRYPTION_KEY=<64 hex>`, `TEST_PORT`, `TEST_DATABASE_URL`, fiecare pe **linie
  separată**.
- **Ordinea bazei de referință** (`project_ext_contract_suite_recipe`): bază virgină →
  schema engine → migrațiile extensiilor → **al doilea boot**, ca reconcilierile să
  ruleze. Ambele ordini greșite mint diferit.
- **`bun --cwd X run Y` NU rulează scriptul.** `typecheck` poate fi verde din cache-ul
  turbo — `cd packages/engine && bun run typecheck`.
- **Lecția Blocului C, direct aplicabilă:** o poartă care enumeră prin `git ls-files` nu
  vede un fișier neurmărit, iar o sondă `create` o lasă verde. Cinci porți din repo fac
  asta.
