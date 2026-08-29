# Stare — Blocul C: porțile înainte de cod

> **Se citește la începutul fiecărui pas. Se actualizează după fiecare pas.**
> Branch: `block-c/gates` · pornit din `dfe3ab99` (master, post-#359)
> Plan: `MATURITY-REFACTOR-PLAN.md` §Blocul C. Ordinea: **C → B → F → A**.
> Regula care le guvernează pe toate: **nu se construiește nimic înainte ca o
> măsurătoare să arate că merită.** Un bloc are voie să se încheie cu „nu merită".

---

## De ce există blocul

Nu pentru că porțile ar fi puține. Pentru că **o poartă care nu verifică nimic nu
dă un test roșu — dă o liniște falsă**, iar auditul din 27–29 august a găsit trei
forme distincte ale aceluiași lucru:

- `check-numeric-string-arithmetic` ieșea cu **0 în patru feluri diferite**, niciunul
  însemnând „am verificat și e curat".
- Jobul de CI care o rula era **singurul care nu clona repo-ul soră**, deci o hrănea
  cu un corpus gol.
- Suita lăsa **5 colecții per rulare**; 30 de rulări au produs o bază în care o
  măsurătoare a raportat autorizarea la **364 ms** când realitatea era **0,93 ms**.
  Cifra a ajuns în două rapoarte scrise.
- `scripts/dr-drill.sh` a fost citat ca dovadă pentru un P0 **două luni**, murind pe
  prima lui comandă, cu rândul din TECHNICAL-GAPS pe DONE tot timpul.

Și proba cea mai recentă, din chiar ziua deschiderii blocului: poarta
`check:test-leftovers`, adăugată de #359, **a picat la primul ei tur de CI** pe o
rămășiță pe care verificarea manuală a aceleiași sesiuni o declarase curată. Poarta
a prins ce omul ratase. Ăsta e argumentul blocului, livrat de la sine.

**Blocul A trece prin terenul unde un `finally` sincron a lăsat odată 302 politici
inerte, cu testele verzi.** Fără plasa asta, o regresie de acolo nu se vede.

---

## Criteriile punctului de validare — SCRISE ÎNAINTE DE MĂSURARE

Blocul se închide ca reușit **doar dacă toate patru** sunt adevărate:

1. **Zero porți trec pe o violare plantată.** Nu „11 din 11 verzi" — zero eșecuri
   ale plantării, pe mulțimea completă de porți, nu pe cea de care ne amintim.
2. **Fiecare poartă din repo are ori un caz în `audit-gates.ts`, ori un motiv scris
   de ce nu poate avea.** Un motiv scris e un rezultat acceptabil; absența unei
   mențiuni nu e.
3. **Nicio poartă nu iese cu 0 când nu a putut verifica.** Corpus gol, repo soră
   lipsă, bază de date absentă, fișier de referință inexistent — toate ies non-zero.
4. **O poartă nouă fără caz în meta-poartă nu se poate comite** — dovedit prin
   plantare, nu prin citirea codului meta-porții.

Dacă pasul 1 arată că mulțimea de porți neacoperite e mică și fiecare are un motiv
legitim de a rămâne așa, **blocul se poate închide devreme** — cu motivele scrise.
Un „nu merită" măsurat e un rezultat, nu un eșec.

**Ce NU e criteriu:** numărul de porți. O poartă în plus care nu e dovedită prin
plantare nu îmbunătățește nimic, iar blocul nu are ca scop să le înmulțească.

---

## Pași

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul ăsta | — | (la fiecare pas) |
| 1 | **Inventar + acoperire:** enumeră TOATE porțile (scripts/ + CI, nu package.json), cross-referă cu cazurile din `audit-gates.ts` | ✅ **FĂCUT** | **9 din 31, nu 11/11** — vezi §Pasul 1 |
| 2 | Rulează meta-poarta: chiar pică fiecare caz pe violarea plantată? | ✅ **FĂCUT** | **11/11 prind** — cele acoperite chiar funcționează |
| 2.5 | **Meta-poarta să ruleze automat** — descoperit la pasul 1, nu era în lista inițială | ✅ **FĂCUT** | `audit:gates` + `check:pooldb-txn` în lane-ul Lint |
| 3 | Fiecare poartă neacoperită: caz nou, sau motiv scris de ce nu se poate | 🟡 **ÎN LUCRU** | **9 → 14 dovedite**; 23 rămase cu motiv |
| 4 | Fail-closed: nicio poartă nu iese cu 0 când nu poate verifica | ✅ **FĂCUT** (toate dimensiunile) | **7 porți fail-open**, reparate — vezi §Pasul 4 |
| 5 | Meta-poartă asupra meta-porții: o poartă nouă fără caz nu se comite | ✅ **FĂCUT** | `check-gate-coverage`, dovedită prin plantare |
| 6 | `check-tenant-table-on-pool` extinsă la `lib/`, cu excepții motivate | ⛔ **ANULAT** | **nu merită** — vezi §Pasul 6 |
| 7 | **PUNCT DE VALIDARE** | ⚠️ **3 din 4** | criteriul 1 NEîndeplinit — blocul rămâne deschis |

### Pasul 1 — acoperirea reală (măsurat 2026-08-29)

**Planul spunea „100% acoperire, azi 11/11". Cifra aia era greșită**, și greșeala e
instructivă: 11 e numărul de **cazuri** din `audit-gates.ts`, nu numărul de porți.
Cele 11 cazuri vizează **9 fișiere de poartă** (două porți au câte două cazuri).

Enumerat din `scripts/` **și** din workflow-urile CI, nu din `package.json` — un
script pe care CI nu-l rulează nu apără nimic, iar `package.json` conține și scripturi
care nu sunt porți:

| | număr |
|---|---:|
| scripturi-poartă care rulează în CI | **31** |
| dovedite prin plantare | **9** |
| **rulează în CI, NEdovedite** | **22** |
| există, dar CI nu le rulează deloc | **1** |

Cele 22 includ porți deloc periferice: `check-migration-safety`, `check-atomic-writes`,
`check-insert-schema-match` (`ext:seam`), `coverage-gate`, `release-gate`,
`route-collision-check`, `schema-drift-check`, `import-boundaries` — și
`check-test-leftovers`, adăugată chiar de #359.

**Cea care nu rulează în CI: `check-pooldb-txn-skip.ts`.** Apare o singură dată, în
scriptul `prepush`. Iar `prepush` **nu e legat de niciun hook**: nu există `.husky/`,
`core.hooksPath` e nesetat, iar în `hooks/` nu e decât `.sample`. Deci rulează numai
dacă tastează cineva `bun run prepush`. Șapte porți depind exclusiv de disciplina aia.

### Pasul 4 — șase porți raportau OK fără corpus (măsurat 2026-08-29)

**Metoda:** un worktree temporar al engine-ului la o cale unde **nu există soră lângă
el**, apoi fiecare poartă care citește sora, rulată acolo. Condiția e reală, nu
teoretică: jobul de CI care rula poarta numerică era singurul care nu clona sora, și
exact așa a raportat curat un corpus gol.

*(Prima măsurătoare a fost falsă: `rc=$?` după un pipe dă codul lui `tail`, nu al
porții, deci toate arătau `rc=0`. Refăcută corect. A patra oară în ziua asta când o
măsurătoare a trebuit refăcută fiindcă instrumentul măsura altceva.)*

| poartă | fără soră, ÎNAINTE | ce spunea |
|---|---|---|
| `check-raw-sql-identifiers` | **rc=0** | „every identifier is escaped" — **fără să deschidă repo-ul pe care antetul lui zice că e scoped anume** |
| `check-atomic-writes` | **rc=0** | „OK — 5 handler(s)" (cu soră: **32**) |
| `check-duplicate-table-creators` | **rc=0** | „OK — 73 tables" (cu soră: **384**) |
| `check-fabricated-success` | **rc=0** | „OK — 0 site(s)", scanând nimic |
| `check-insert-schema-match` | **rc=0** | „SKIP", cinstit și totuși verde |
| `check-extension-sdui-schemas` | **rc=0** | „skip", la fel |

Celelalte cinci ieșeau deja non-zero — trei dintre ele însă **prin prăbușire**, nu prin
decizie. Fail-closed din accident, nu din proiectare; de reținut, nu de reparat acum.

**Reparat** cu `scripts/lib/require-sibling.ts`: un corpus absent nu e un corpus curat.
Opt-out îngust și deliberat — `ZVELTIO_ALLOW_MISSING_SIBLING=1` dă un avertisment în loc
de refuz, pentru cine lucrează fără soră. **CI nu-l setează niciodată**: joburile clonează
sora, iar unul care uită trebuie să devină roșu, nu tăcut.

Verificat în ambele direcții: cu soră toate trec (și numărul crește — 32 în loc de 5, 384
în loc de 73, care e chiar mărimea găurii); fără soră toate șase pică; cu opt-out, avertisment.

#### Celelalte trei dimensiuni, măsurate (2026-08-29)

**Bază de date.** Două condiții: fără nicio variabilă, și cu o adresă configurată dar
inaccesibilă — port fără nimic în ascultare, adică exact un serviciu Postgres care n-a
pornit în CI.

| poartă | fără bază | inaccesibilă |
|---|---|---|
| `check-test-leftovers` | rc=1 | rc=1 |
| `check-numeric-string-arithmetic` | rc=1 | rc=1 |
| **`check-insert-schema-match` (`ext:seam`)** | rc=0 | **rc=0 — „SKIP"** |

`ext:seam` compară **474 de instrucțiuni INSERT din 54 de extensii** cu forma reală a
tabelelor. Fără bază nu compară niciuna — și tocmai atunci nu are voie să spună că n-a
găsit nimic. Reparat cu același opt-out îngust (`ZVELTIO_ALLOW_MISSING_DB=1`), verificat
pe toate trei căile.

**Baseline lipsă — nicio poartă vinovată, și merită spus de ce.** Contează *direcția*,
nu codul de ieșire: la toate ratchet-urile un baseline absent înseamnă **nu permit
nimic** (`baseline = {}` sau `= 0`), deci poarta devine mai STRICTĂ, nu mai slabă. Trei
ies non-zero explicit; `ambient-authority`, `fabricated-success` și `i18n-core` trec
fiindcă repo-ul chiar e la zero. **Dacă mă uitam doar la `rc`, raportam trei porți bune
drept fail-open.**

**Artefacte de build — nici aici.** `check-studio-embed-freshness` sare verificarea
markerului fără dist, dar numai când `REQUIRE_STUDIO_DIST` lipsește — iar `studio.yml:84`
chiar îl setează. E exact tiparul cerut de pasul 3 din plan: *poarta declară de ce are
nevoie, CI îi dă exact aia.* `check-worker-source-fresh` citește fișierul generat direct,
deci absența lui aruncă.

**Bilanț pasul 4: 7 porți erau fail-open** — 6 pe repo-ul soră, una pe bază de date.
Toate reparate. Celelalte două dimensiuni: măsurate, curate.

### Pasul 3 — patru porți convertite, și ce a ieșit din plantare (2026-08-29)

Dovedite acum prin plantare: `admin-gate-check`, `import-boundaries`, `any-ratchet`,
`check-duplicate-table-creators`. Cu `check-gate-coverage`, **9 → 14**.

**Trei sonde din cinci au fost greșite la prima încercare.** Fiecare ar fi raportat o
poartă care funcționează drept decor — exact avertismentul din antetul meta-porții,
întâlnit de trei ori într-o oră:

| poartă | de ce prima sondă n-a declanșat | ce spune asta despre poartă |
|---|---|---|
| `import-boundaries` | enumeră prin `git ls-files` ⇒ **un fișier neurmărit e invizibil** | corectă; în CI totul e urmărit. Sonda trebuie să fie `append` pe un fișier urmărit |
| `check-duplicate-table-creators` | `add()` cheie pe **proprietar** ⇒ două migrații ale engine-ului = UN creator, deliberat | corectă; doar proprietari diferiți se umbresc. Sonda trebuie plantată în **sora** |
| `check-migration-safety` | selectează prin `git diff --diff-filter=AM origin/master...HEAD` ⇒ **o sondă nestagiată e invizibilă** | corectă; nu poate fi dovedită de meta-poarta de azi — trecută înapoi în baseline **cu motivul măsurat** |

**Și una structurală, găsită a patra oară pe aceeași cauză:** `any-ratchet` enumeră
tot prin `git ls-files`. Deci **`mode: 'create'` din meta-poartă e orb la orice poartă
care enumeră prin git** — și astea sunt majoritatea. Pentru fiecare dintre cele 23
rămase, prima întrebare e „enumeră prin git?"; dacă da, cazul trebuie `append` pe un
fișier urmărit, ori plantat în soră.

Cazul `any-ratchet` a fost, la prima încercare, **verde din motivul greșit**: sonda nu
declanșa nimic, dar `audit-gates.ts` ajunsese el însuși peste baseline fiindcă purta
marcajul literal în corpul sondei. A raportat răspunsul corect din cauza greșită, ceea
ce e mai rău decât un răspuns greșit. Marcajul se construiește acum din bucăți, exact
cum face `INTERP` de deasupra lui, pentru același motiv cu o regulă mai încolo.

**Îmbunătățire evidentă, nefăcută încă:** meta-poarta ar putea face `git add -N` pe
sondă înainte de a rula comanda, și atunci `create` ar merge și pentru porțile care
enumeră prin git. Mută indexul, deci cere grijă într-un repo cu worktree-uri partajate
— de cântărit la pasul 4.

Morala, pentru cine continuă: **o sondă care nu declanșează nu e o poartă moartă până
nu citești de ce.** Diferența dintre „poarta e decor" și „sonda e greșită" e o lectură
de cinci minute, iar planul are deja două ocoluri greșite luate exact prin sărirea
lecturii ăleia.

### Pasul 5 — poarta asupra porților (2026-08-29)

`scripts/check-gate-coverage.ts` + `quality-gates/gate-coverage.json`. O poartă nouă
care intră în CI trebuie să vină ori cu un caz plantat, ori cu un rând scris care
spune de ce nu poate avea unul. Lista înregistrată **poate doar să scadă**.

**Allowlist, nu denylist:** orice `scripts/*.ts` pe care un workflow îl invocă e
tratat ca poartă până când `not_a_gate` spune altfel, cu motiv. Inversul — o listă de
nume cunoscute — e chiar ce lasă următoarea să scape sub un nume la care nu s-a gândit
nimeni; `check-pooldb-txn-skip` a stat în afara CI tocmai fiindcă trăia doar în
`prepush`.

**Dovedită prin plantare**, nu prin citire: cazul adaugă un pas de workflow care
cheamă un script inexistent, iar poarta trebuie să pice. `mode: 'append'`, deci
`ci.yml` e restaurat octet cu octet — verificat cu `git diff` după rulare.

Plantarea a scos la iveală și o slăbiciune a porții pe care citirea n-o arătase:
regexul prindea invocări din **liniile de comentariu** ale workflow-ului, deci un
comentariu despre trecut ar fi adăugat un script pe listă. Reparat în același pas.
Ăsta e argumentul pentru plantare, în miniatură.

Stare: **40 de scripturi rulate de CI — 10 dovedite prin plantare, 27 înregistrate cu
motiv, 3 declarate ne-porți.** `audit:gates` raportează **12/12**.

**Ce rămâne, spus cinstit:** din cele 27, multe au ca motiv „plantare ușoară" — ceea
ce nu e un motiv pentru care *nu pot* avea un caz, ci constatarea că încă n-au unul.
Ratchet-ul oprește hemoragia; conversia lor e restul pasului 3.

### Pasul 2 — cele acoperite chiar prind (măsurat 2026-08-29)

`bun run audit:gates` → **11/11 prind violarea plantată.** Nicio decorațiune printre
cele acoperite. Problema nu e calitatea cazurilor existente, ci câte lipsesc.

### Pasul 2.5 — descoperit la pasul 1: meta-poarta nu rulează nicăieri

**`audit:gates` nu e în niciun workflow CI și nici în `prepush`.** Există doar ca
script în `package.json`, deci rulează exclusiv când își amintește cineva.

Ăsta e exact tiparul pe care meta-poarta a fost construită să-l vâneze — `dr-drill.sh`
citat două luni ca dovadă în timp ce murea pe prima comandă — aplicat **instrumentului
însuși**. Cât timp nimeni n-o rulează, orice caz adăugat la pașii 3–6 e decorațiune la
pătrat: dovedit o dată, la scriere, și niciodată după.

**De aceea pasul ăsta trece înaintea lui 3.** Nu are rost să crești acoperirea unui
instrument care nu se execută.

**Făcut:** `audit:gates` rulează acum ca ultim pas al lane-ului Lint — ultim fiindcă e
o verificare ASUPRA porților dinaintea lui, și fiindcă are nevoie de sora pe care
jobul deja o clonează. Odată cu el, `check:pooldb-txn`, singura poartă din `prepush`
pe care CI n-o rula: apără prăbușirea măsurată la `c=DB_POOL_MAX` (10 ms p50 la c=5,
12 000 ms și 55 din 60 eșecuri la c=10, cu zece conexiuni `idle in transaction` și
zero `active`). Trece azi — deci a fost adăugată ca plasă, nu ca reparație.

Pasul 6 e singurul rezultat acționabil rămas din blocul 4 al
`CASBIN-SCALING-STATE.md`, care a decis **măsurat** că rolul de conectare al
engine-ului nu se schimbă.

---

## Ce NU se atinge în blocul ăsta

- **Codul de producție**, cu excepția strictă a pasului 6 (o poartă, nu o rută).
- **Politica RLS, enforcer-ul, forma predicatului.** Predicatul s-a schimbat de trei
  ori și e acum cel corect; blocul F îl atinge, nu ăsta.
- **Numărul de porți ca scop în sine.** O poartă nouă se adaugă doar dacă acoperă o
  clasă dovedită, nu ca să crească o cifră.
- **Suita de teste.** Curățenia ei s-a făcut în #359.

---

### Pasul 6 — ANULAT, măsurat (2026-08-29)

Recomandarea venea din blocul 4 al `CASBIN-SCALING-STATE.md` și a intrat în plan ca pas.
**Fusese însă deja încercată și revenită**, iar motivul e scris în chiar antetul porții:
în `lib/`, mânerul neîngrădit se numește `db` — același nume sub care se pasează și o
tranzacție — deci o poartă ori nu prinde nimic (căutând `poolDb`), ori se îneacă în
fals-pozitive (căutând `db`).

**Verificat, nu crezut pe cuvânt:**

| | apariții ale identificatorului `poolDb` |
|---|---:|
| `routes/` | **19** |
| `lib/` (fără teste) | **1 — și aceea într-un comentariu** |

Deci extinderea ar produce o poartă care nu poate prinde nimic, niciodată. Prima
încercare a livrat exact asta, plus patru „excepții motivate" pentru violări care nu
puteau apărea. **O poartă a cărei listă de excepții e singurul lucru pe care-l produce e
mai rea decât nicio poartă**, fiindcă scuza arată a revizie.

**Expunerea rămâne reală** și e inventariată: `repairUnsignedWebhooksAtBoot` citește
webhook-urile tuturor firmelor, `flow-executor` caută firma unui flow ca să afle în ce
firmă rulează, reconcilierile de la boot trec peste tabelele tuturor. Toate au nevoie
**structurală** de vedere globală — de aceea rolul engine-ului nu se restrânge.

**Observație, nu plan:** singura cale care ar deosebi cele două cazuri e la **runtime**,
nu la build — o aserțiune care, sub `NODE_ENV=test`, semnalează o interogare pe o tabelă
de firmă fără GUC de firmă setat. Ar deosebi ce numele nu poate. Dar atinge calea
fierbinte și e o proiectare, nu o extindere; nu se face pe impuls, în coada altui bloc.

Al cincilea rezultat „nu merită" al lucrării. Consistent cu statistica propriului plan.

## PUNCT DE VALIDARE — verdict: 3 criterii din 4. Blocul NU se închide.

Rulat 2026-08-29 pe `fdf78b4b`, împotriva criteriilor scrise la începutul documentului,
înainte de orice măsurătoare.

| # | criteriu | verdict |
|---|---|---|
| 1 | Zero porți trec pe o violare plantată, **pe mulțimea completă** | ❌ **NU** |
| 2 | Fiecare poartă: caz în `audit-gates.ts` **sau** motiv scris | ✅ da |
| 3 | Nicio poartă nu iese cu 0 când n-a putut verifica | ✅ da |
| 4 | O poartă nouă fără caz nu se poate comite, dovedit prin plantare | ✅ da |

**Criteriul 1 pică, și pică pe litera lui.** `audit:gates` dă 16/16 — dar 16 e numărul
de cazuri, iar cazurile acoperă 14 scripturi din cele 40 pe care CI le rulează. Pentru
celelalte 26 (23 neacoperite + 3 declarate ne-porți) nu există violare plantată, deci
afirmația „zero porți trec" **nu poate fi făcută despre ele**. Exact distincția pe care
criteriul o cerea explicit: *nu „11 din 11 verzi", ci pe mulțimea completă.*

Documentul prevedea și o ieșire devreme: *blocul se poate închide dacă mulțimea
neacoperită e mică și fiecare are motiv legitim.* **23 nu e mică**, și multe dintre
motive nu sunt „nu poate avea caz", ci „încă n-are". Deci ieșirea aia nu se aplică.

**Ce NU fac:** să rescriu criteriul acum că văd cifra. Un criteriu ajustat după
măsurătoare nu mai e criteriu, e justificare — și e chiar regula pe care blocul ăsta a
fost construit s-o apere.

### Ce s-a câștigat totuși, și de ce blocul nu e un eșec

- meta-poarta **rula nicăieri**; rulează la fiecare Lint
- acoperirea dovedită: **9 → 14**, iar cifra din plan („11/11") era greșită
- **7 porți fail-open** reparate, pe trei dimensiuni de input măsurate
- un ratchet care face ca numărul să nu mai poată **scădea**: o poartă nouă vine cu caz
  sau cu motiv, iar un motiv rămas după ce cazul există pică poarta
- pasul 6, anulat măsurat, cu recomandarea corectată la sursă

Blocul rămâne **deschis la pasul 3**. Nu e o datorie tăcută: e o listă de 23 de rânduri,
fiecare cu un motiv scris și cu ce s-a măsurat despre el, păzită de o poartă.

## Anexă — instrumentarea lui `0A000` (nu e pas al blocului)

Nu face parte din Blocul C, dar defectul pică lane-ul de integrare la ~2 din 3 rulări
și face imposibil de deosebit o regresie de zgomot, deci instrumentul merită ținut aici.

**Prima rulare eșuată sub jurnalul de instrucțiuni (2026-08-29, 18:44):**

| | |
|---|---|
| `Run migrations` | 18:44:55.45 |
| 4× `ALTER TABLE zvd_collections ADD COLUMN` | 18:44:55.66 – .716 |
| `Start engine` | 18:44:56.14 |
| testele, și eșecul | 18:45:24 → |

**Zero DDL pe `zvd_collections` după pornirea motorului.** Zero `CREATE SCHEMA`. Nicio
a doua relație cu acel nume. Deci nici „s-a schimbat forma", nici „numele s-a rezolvat
la altă tabelă" — ambele ipoteze, infirmate de aceeași rulare.

**Dar instrumentul are un punct orb**, găsit imediat după: `log_statement='ddl'`
înregistrează doar instrucțiuni de nivel superior. **DDL emis dintr-un bloc
`DO $$ ... EXECUTE ... $$` nu apare deloc** — iar engine-ul are exact așa ceva,
`applyTenantRLS` (`tenant-manager.ts:198`) își construiește indexul în felul ăsta.
„Niciun DDL" și „DDL pe care nu-l pot vedea" arată identic din afară.

Adăugat `scripts/sql/ddl-watch.sql`: un event trigger pe `ddl_command_end`, care se
declanșează pentru orice comandă, indiferent cine a emis-o. **Dovedit local, nu presupus** —
prinde și `CREATE TABLE` direct, și `CREATE INDEX` dintr-un bloc `DO`.

**Și a răspuns din prima rulare — cauza e găsită.**

| oră | pid | ce |
|---|---|---|
| 18:52:54.70–54.87 | 119 | migrațiile engine-ului creează/alterează `zvd_collections` |
| **18:52:55.23** | — | **`Start engine` — pool deschis, planuri pregătite** |
| **18:52:56.51** | **144** | **`ALTER TABLE zvd_collections` ×2, +3 coloane** |

Cele trei coloane sunt `ai_search_enabled`, `ai_search_field`,
`ai_embed_excluded_fields` — din `zveltio-extensions/ai/engine/migrations/001_initial.sql`.
**Migrațiile extensiilor rulează după ce motorul și-a deschis pool-ul, iar extensia `ai`
alterează tabela de metadate a ENGINE-ului.**

Lanțul: o conexiune pregătește `select * from zvd_collections where name = $1` cu tip de
rezultat de 19 coloane; 1,3 secunde mai târziu tabela are 22; următoarea cerere care ia
acea conexiune primește `0A000`. În tranzacția lui `tenantMiddleware`, dialectul refuză
deliberat să reîncerce ⇒ 500. Intermitent fiindcă depinde de fereastra aia de 1,3 s.

**De ce a contat instrumentul:** `log_statement='ddl'` nu l-a arătat — instrucțiunile SQL
sunt pe mai multe linii, iar DDL-ul din blocuri `DO` nu apare deloc. Event trigger-ul dă
`object_identity` pe o singură linie, pentru orice comandă.

**Remediul nu e ales** — sunt patru variante plauzibile (migrațiile extensiilor înaintea
pool-ului; reciclarea conexiunilor după migrații; interzicerea alterării tabelelor
engine-ului de către extensii; coloane numite în `getCollection`) și e decizie de owner,
nu de strecurat într-un PR despre porți.

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-29 | **7 VALIDARE** | **3 criterii din 4.** 1 pică pe litera lui: 16/16 sunt CAZURI, acoperind 14 scripturi din 40 — despre celelalte 26 afirmația nu se poate face. Ieșirea devreme nu se aplică (23 nu e „mic"). **Criteriul NU se rescrie.** Blocul rămâne deschis la pasul 3. |
| 2026-08-29 | 6 | **ANULAT, măsurat.** `lib/` conține identificatorul `poolDb` o singură dată, într-un COMENTARIU; `routes/` de 19 ori. Poarta extinsă n-ar putea prinde nimic — fusese deja încercată și revenită, cu motivul în antetul ei. Expunerea rămâne reală dar cere o aserțiune de runtime, nu o poartă de build; notată ca observație. |
| 2026-08-29 | 4 (rest) | Celelalte trei dimensiuni măsurate. **`ext:seam` ieșea cu 0 cu baza inaccesibilă** — 474 de INSERT-uri necomparate, raportate curat; reparat. Baseline lipsă: **nicio poartă vinovată**, fiindcă toate tratează absența ca „nu permit nimic" — uitându-mă doar la `rc`, aș fi raportat trei porți bune drept fail-open. Artefacte de build: curat, `studio.yml` chiar setează `REQUIRE_STUDIO_DIST`. |
| 2026-08-29 | 4 | **6 porți raportau OK fără repo-ul soră**, între ele `check-raw-sql-identifiers`, care e scoped ANUME pe el. Corpusul tăcut: 5 handler-e în loc de 32, 73 tabele în loc de 384. Reparat cu `require-sibling.ts`, opt-out îngust pe care CI nu-l setează. Prima măsurătoare a fost falsă (`rc=$?` după pipe) și refăcută. |
| 2026-08-29 | 3 | Patru porți convertite (`admin-gate-check`, `import-boundaries`, `any-ratchet`, `check-duplicate-table-creators`): **9 → 14 dovedite, 23 rămase**. **3 sonde din 5 greșite la prima încercare** — `git ls-files`, cheia pe proprietar, `git diff` — fiecare ar fi raportat o poartă bună drept decor. `check-migration-safety` trecută înapoi în baseline cu motivul măsurat. Ratchet-ul dovedit că se și STRÂNGE: pică dacă un rând rămâne după ce cazul lui există. |
| 2026-08-29 | 5 | `check-gate-coverage` + baseline, legată de CI, **dovedită prin plantare** (12/12). Plantarea a găsit o slăbiciune pe care citirea n-o arătase: regexul prindea și comentariile din workflow. 40 de scripturi în CI: 10 dovedite, 27 cu motiv, 3 ne-porți. |
| 2026-08-29 | 2.5 | `audit:gates` legat de lane-ul Lint, ca ultim pas. Plus `check:pooldb-txn`, singura poartă din `prepush` absentă din CI — trece azi, deci e plasă, nu reparație. YAML validat. |
| 2026-08-29 | 1–2 | **Acoperirea reală e 9 din 31, nu 11/11** — cifra din plan număra cazuri, nu porți. 22 de porți rulează în CI nedovedite; `check-pooldb-txn-skip` nu rulează în CI deloc, iar `prepush`, singurul lui apelant, nu e legat de niciun hook. Meta-poarta prinde 11/11 pe violări plantate, deci cazurile existente sunt bune. **Dar `audit:gates` nu e nici în CI, nici în prepush** — instrumentul care dovedește că porțile nu-s decor e el însuși nerulat. Pas 2.5 inserat înaintea lui 3. |
| 2026-08-29 | setup | Branch `block-c/gates` din `dfe3ab99`. Document scris, cu criteriile de validare stabilite ÎNAINTE de orice măsurătoare. Orientare: 11 cazuri în `audit-gates.ts` acoperind 9 porți distincte; `package.json` listează ~22 de scripturi care arată a poartă. Cifrele astea sunt orientative — pasul 1 le înlocuiește cu enumerarea reală. |

---

## Context care nu trebuie re-descoperit

- **Mediul:** worktree `/home/liviu/zveltio-audit-ba/zveltio`, sora în
  `../zveltio-extensions`. Bazele mele: `zv_audit_ba`. Portul `:3400`.
  Ocupate de alții: `:3000`, `:3200`, `:3201`, `:3300`.
- **Env fără de care testele mint:** `ZVELTIO_REGISTRATION_ENABLED=1`,
  `FIELD_ENCRYPTION_KEY=<64 hex>`, `TEST_PORT`, `TEST_DATABASE_URL`, fiecare pe
  **linie separată** (`export A=1 B=$A` expandează `$A` înainte de atribuire).
- **`bun --cwd X run Y` NU rulează scriptul** — se face `cd X && bun run Y`.
- **`typecheck` poate fi verde din cache-ul turbo.** `cd packages/engine && bun run
  typecheck` ocolește cache-ul.
- **Porțile care scanează repo-ul soră au calea `../zveltio-extensions` HARDCODATĂ**
  și ignoră `argv`. `check-i18n-core` NU citește sora, deci eșecurile lui sunt reale.
- **`audit-gates.ts` refuză să pornească dacă vreo cale de plantare există deja** —
  o probă nu poate fi confundată cu fișierul cuiva.
