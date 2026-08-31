# Stare — Blocul K: regulile de rând ajung în bază

> **Se citește la începutul fiecărui pas.** Branch: `block-k/row-rules-in-db`.
> Continuă criteriul 4 rămas neîndeplinit la blocul J, cu forma deja aleasă prin
> măsurare acolo.

---

## De ce, în cifre

Cu regula `created_by eq user_id`, în cazul pentru care există linia a doua —
**aplicația a uitat filtrul**, deci singura gardă e politica:

| | filtrul aplicației prezent | filtrul uitat |
|---|---:|---:|
| fără regulă în bază (azi) | 6,53 ms | **0,068 ms — și SCURGE** |
| politici generate | 6,17 ms | **0,983 ms** |
| o politică generică, funcție per rând | 7,61 ms | 13,232 ms |

Politici generate. Măsurat în blocul J, nu ales din preferință.

---

## Semantica pe care trebuie s-o reproducă EXACT

Din `getRlsFilters`, citită linie cu linie. Dacă predicatul generat înseamnă
altceva, n-am făcut o a doua linie de apărare, am făcut **a doua sursă de adevăr**
— iar două surse care nu sunt de acord sunt mai rele decât una singură.

1. **Scutire:** cheie de API cu `rlsBypass === true`, SAU permisiunea
   `data:view_all` (pe care god o are). Nu o comparație cu numele rolului — asta
   a fost deja o dată cod mort, ani la rând.
2. **Potrivire de rol:** `policy.role = '*'` sau rolul e printre rolurile Casbin
   ale utilizatorului (plus rolul lui direct).
3. **Valoare nerezolvabilă ⇒ regula se SARE** — fail-open pentru regula aceea.
   Nu „nu vede nimic".
4. **Operatori:** `eq`, `neq`, `in`, `not_in`. `neq` e `<>`, nu
   `IS DISTINCT FROM`: pe un câmp NULL motorul exclude rândul, și baza trebuie
   să facă la fel.
5. **Despicare pe virgulă doar pentru `static:`**, și doar la `in`/`not_in`.
6. Regulile se combină cu **ȘI**.

---

## Criteriile punctului de validare — SCRISE ÎNAINTE

1. **Un `WHERE` uitat nu mai scurge**, dovedit prin plantare: aceeași interogare
   care azi întoarce rândurile altcuiva întoarce zero.
2. **Predicatul generat înseamnă exact ce înseamnă cel din motor** — comparat
   rând cu rând, pe toți cei patru operatori și toate cele patru surse, inclusiv
   cazurile în care motorul SARE regula.
3. **Costul e re-măsurat** după implementare, pe aceleași date, și scris.
4. **O regulă pe care baza nu o poate exprima nu e aplicată tăcut pe jumătate:**
   ori se generează întreagă, ori nu se generează deloc și se spune care și de ce.

**CRITERIU DE OPRIRE:** dacă predicatul nu poate fi făcut să însemne același
lucru pentru vreun operator sau vreo sursă, acela nu se generează. O politică
aproape-corectă pe o cale de securitate e mai rea decât niciuna, fiindcă arată
ca și cum ar fi întreagă.

---

## Pași

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul ăsta | — | — |
| 1 | Generatorul de predicat + teste de echivalență | ✅ | 18 teste, inclusiv ce refuză să genereze |
| 2 | Motorul publică identitatea în variabile de sesiune | ✅ | în același dus-întors, zero interogări în plus |
| 3 | Aplicarea politicii | ✅ | un singur punct: `invalidateRlsCache` |
| 4 | Plantare: `WHERE` uitat nu mai scurge | ✅ | 10 teste, toate cu filtrul uitat intenționat |
| 5 | Re-măsoară costul | ✅ | **+0,03 ms** pe calea normală |
| 6 | **PUNCT DE VALIDARE** | ✅ | **4 din 4** |

---

## Decizii de formă, luate înainte de a scrie

- **`AS RESTRICTIVE`**, fiindcă politicile permisive se combină cu SAU, iar
  regulile de rând trebuie să se adauge la izolarea pe firmă, nu s-o lărgească.
- **Scutirea e o variabilă**, nu o verificare de rol în predicat: motorul decide
  deja (cheie de API sau `data:view_all`) și publică rezultatul.
- **Tipul coloanei contează.** `current_setting()` întoarce text; pe o coloană
  `integer` asta e o eroare de tip, nu o comparație. Se citește tipul la
  generare și se toarnă valoarea în el. Pentru un tip pe care nu-l putem turna
  în siguranță, regula **nu se generează** și se spune care.

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-31 | setup | Semantica din `getRlsFilters` transcrisă în șase puncte înainte de a scrie o linie de generator. |


---

## Cum arată, pe scurt

O politică **RESTRICTIVĂ** per colecție, generată din reguli, pe care Postgres o
combină prin ȘI cu izolarea pe firmă. Permisivă ar fi LĂRGIT ce lasă politica de
firmă, adică exact pe dos.

Identitatea apelantului se publică în același `set_config` cu variabilele de
firmă — deci **zero interogări în plus**: middleware-ul are deja sesiunea, iar
rolurile și permisiunea de scutire sunt amândouă din cache.

**Un singur punct de sincronizare:** `invalidateRlsCache`. Prin el trec toate
schimbările de reguli — creare, modificare, ștergere. Cârligele puse pe cele trei
rute ar fi lăsat orice alt apelant să scrie reguli pe care baza nu le cunoaște,
adică exact eșecul pe care politica îl previne, reintrodus câte un apelant o dată.

La boot se reconciliază toate colecțiile cu reguli: o instalare care se
actualizează are deja reguli și nicio politică, iar o funcție care ar apăra doar
colecțiile create de-acum înainte le-ar apăra pe cele fără date în ele.

---

## Costul, măsurat (2026-08-31)

300 000 de rânduri, index compus, regula `created_by eq user_id`, mediane din 9
rulări după încălzire.

| | calea normală (aplicația adaugă filtrul) | **filtrul uitat** |
|---|---:|---:|
| fără politică | 0,215 ms | **0,060 ms — și SCURGE** |
| cu politica generată | **0,245 ms** | **0,775 ms — corect** |

**+0,03 ms pe calea normală.** Ăsta e prețul liniei a doua, și e mic fiindcă
predicatul e sargabil: comparație directă pe coloană, nu o funcție per rând
(forma aceea măsura 13,2 ms în blocul J).

### O cifră falsă, prinsă la timp

Prima măsurătoare a dat **5,85 ms** pe calea normală — de 26 de ori. Nu era
adevărată: scriptul meu de probă inserase regula de **trei ori**, iar generatorul
o emitea fidel de trei ori. Predicatul scris de mână, cu un singur termen, dădea
0,244 ms.

Două lucruri de reținut: nimic din produs nu împiedică două rânduri identice în
`zvd_rls_policies`, iar generatorul **deduplică** acum; și o cifră care nu se
reproduce când o scrii de mână merită citită, nu raportată.

---

## Ce refuză să facă, și spune care

O regulă pe o coloană într-un tip pe care nu-l poate turna în siguranță din text
— `jsonb`, de pildă — **nu se generează**, iar colecția și motivul se strigă la
aplicare. Regula rămâne aplicată de motor, singurul enforcer, ceea ce e exact
situația pe care schimbarea asta o încheie — deci nu are voie să fie descoperită
citind cod.

La fel pentru: un câmp care nu e identificator, o coloană inexistentă, un operator
necunoscut, o listă statică goală. Iar o regulă pe care n-o poate exprima **nu le
ia cu ea** pe cele pe care le poate.

---

## Punct de validare — 4 din 4 (2026-08-31)

| # | Criteriu | Verdict |
|---|---|---|
| 1 | Un `WHERE` uitat nu mai scurge | ✅ 10 teste, toate cu filtrul uitat intenționat |
| 2 | Predicatul înseamnă ce înseamnă motorul | ✅ toți operatorii, toate sursele, inclusiv regulile SĂRITE |
| 3 | Costul re-măsurat și scris | ✅ +0,03 ms, plus cifra falsă explicată |
| 4 | O regulă neexprimabilă nu e aplicată pe jumătate | ✅ nu se generează, și se spune care |

**Măsurat:** harness 952/0, unit 2575/0, `audit:gates` 39/39, typecheck și lint curate.

Cu asta se închide și criteriul 4 rămas deschis la **blocul J**.

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-31 | 1 | Semantica transcrisă din `getRlsFilters` în șase puncte înainte de prima linie de generator. |
| 2026-08-31 | 5 | 5,85 ms s-a dovedit artefact: regula inserată de trei ori de propriul meu script. Generatorul deduplică acum. |
| 2026-08-31 | 6 | 4/4. Blocul J se poate închide și el. |
