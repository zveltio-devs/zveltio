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
| 4 | Confruntă derivarea cu o bază instalată complet | ⚠️ **ÎNCERCAT, NEÎNCHEIAT** | baza de referință naivă e inutilizabilă — vezi §Pasul 4 |
| 5 | Cele fără RLS: decizie sau motiv scris pentru fiecare | 🟡 **PARȚIAL** | 30 motivate, **22 NEVERIFICAT** |
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

### Pasul 4 — încercat, și eșecul e rezultatul (2026-08-29)

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
