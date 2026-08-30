# Stare — Blocul H: `?as_of=` citește tot ca să întoarcă o pagină

> **Se citește la începutul fiecărui pas. Se actualizează după fiecare pas.**
> Branch: `block-d/row-conditions` (blocul D s-a închis fără cod; H merge pe
> același branch, ca PR-ul să conțină constatarea și reparația ei).
> Metoda: criterii scrise ÎNAINTE; un bloc are voie să se închidă cu „nu merită".

---

## De unde vine

Blocul D a măsurat calea de *time travel* ca să afle cât costă filtrarea în
memorie. Răspuns: **2,2 ms din 336** — nimic. Dar măsurătoarea a arătat altceva:

`list.ts` face `SELECT DISTINCT ON (record_id) … FROM zv_revisions` **fără
LIMIT**, parsează fiecare snapshot în proces, filtrează, apoi `slice(offset,
offset + limit)`.

| | total | pagina | numărătoarea |
|---|---|---|---|
| așa cum e scris | **336 ms** | — | — |
| aceeași pagină, cerută bazei | 191 ms | **2 ms** | 190 ms |

Măsurat pe 200 000 de înregistrări cu 2 revizii fiecare. Liniar: la 20 000 e
36 ms față de 1 ms. **Pagina e de 168 de ori mai ieftină**, iar ce rămâne scump
— `total` — cere `DISTINCT ON` peste tot istoricul oricum, deci e o *opțiune*.

Și nu e doar timp: fiecare cerere materializează în proces tot setul (~50 MB la
măsurătoarea asta), în procesul care servește restul.

---

## Capcana, știută dinainte

Traducerea naivă a lui `eq` spre JSON **schimbă ce vede apelantul**:

```
în memorie:  r['x'] === '5'          → 5 !== '5'  → rândul e ASCUNS
SQL naiv:    data->>'x' = '5'        → '5' = '5'  → rândul e ARĂTAT
SQL corect:  data->'x' = to_jsonb('5'::text)      → rândul e ASCUNS
```

`->>` scoate textul indiferent de tipul din JSON. Sursele de valoare sunt toate
șiruri (`user_id`, `user_email`, `user_role`, `static:VAL`), deci comparația pe
**jsonb**, nu pe text, e cea care se potrivește cu `===`.

Greșeala ar fi în direcția rea: arată un rând pe care politica îl ascundea.

---

## Criteriile punctului de validare — SCRISE ÎNAINTE

1. **Pagina vine din bază**, nu din memorie — dovedit prin **numărul de rânduri
   citite**, nu prin cronometru: o cerere cu `limit=25` nu are voie să aducă în
   proces mai mult decât are nevoie.
2. **Traducerea celor patru operatori e EXACTĂ**, dovedită prin plantare pe
   cazul care desparte traducerea corectă de cea naivă (numărul `5` față de
   șirul `'5'`), pentru fiecare operator, nu doar pentru `eq`.
3. **Apelantul nu vede nicio diferență** în afară de viteză: aceleași rânduri,
   aceeași ordine, același `total`, aceleași coloane ascunse. Fixat cu teste
   care compară cele două căi pe aceleași date.
4. **Costul rămas e scris**, nu ascuns: dacă `total` rămâne scump, se spune cât
   și de ce, și se spune dacă devine opțional.

**CRITERIU DE OPRIRE:** dacă traducerea exactă nu se poate face pentru toți cei
patru operatori, **nu se face pe jumătate**. Se împinge doar paginarea, și numai
când nu există nicio politică — caz în care nu e nimic de tradus — iar restul se
scrie ca limită cunoscută. O traducere parțială pe o cale de securitate e mai
rea decât niciuna, fiindcă arată ca și cum ar fi întreagă.

---

## Pași

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul ăsta | — | (la fiecare pas) |
| 1 | **Testele întâi**, roșii | ✅ | 14 aserțiuni; **două au trecut din motive greșite** înainte de a fi corecte |
| 2 | Traducerea celor patru operatori spre jsonb | ✅ | `rlsJsonConditions`, lângă celelalte două aplicatoare |
| 3 | Paginarea și `action <> 'delete'` împinse în SQL | ✅ | + normalizarea formei snapshot-ului |
| 4 | Măsoară din nou | ✅ | **49 de rânduri citite în loc de 400 000** |
| 5 | **PUNCT DE VALIDARE** | ✅ | **4/4** |

---

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-30 | setup | Deschis din constatarea blocului D. Capcana traducerii scrisă ÎNAINTE de a scrie codul, fiindcă e singurul loc unde reparația poate deveni scurgere. |

---

## Context care nu trebuie re-descoperit

- Ambele aplicatoare (`applyRlsFilters`, `matchesRlsFilters`) **cad închis** pe
  un operator necunoscut, și trebuie să rămână așa. Al treilea aplicator ar fi o
  a treia șansă de a devia — de-aia traducerea stă lângă celelalte două.
- `?as_of=` a mai avut o gaură exact aici: întorcea rândurile pe care politica
  le ascundea, fiindcă injecția RLS nu atingea calea asta. Comentariul din
  `list.ts` o descrie.
- Coloanele se ascund DUPĂ tăierea paginii (`applyColumnAccess`) — se păstrează.


---

## Ce a ieșit la măsurătoarea finală (2026-08-30)

Aceleași date: 200 000 de înregistrări, 2 revizii fiecare, 400 000 de rânduri.

| | rânduri citite | timp |
|---|---|---|
| pagina, înainte | **400 000** (200 000 aduse în proces) | 336 ms |
| pagina, acum | **49** | **0,246 ms** |
| numărătoarea (`total`) | 400 000 | ~250 ms |

**Câștigul adevărat nu e în milisecunde, e în memorie.** Cererea nu mai
materializează tot setul (~50 MB la scara asta) în procesul care servește restul;
aduce 25 de rânduri. Pe timp, cererea întreagă trece de la 336 ms la ~250 ms —
1,3×, nu 168× — fiindcă **`total` a rămas scump și e inerent**: ca să știi câte
înregistrări existau la un moment din trecut, îți trebuie `DISTINCT ON` peste tot
istoricul, oricât de mică e pagina.

Ce s-a putut face acolo s-a făcut: când nu există nicio politică, numărătoarea nu
mai cară documentele JSON prin sortare (~18 ms). Restul e sortarea însăși.
Numărătoarea ar deveni ieftină doar dacă `total` ar deveni opțional — ceea ce e o
schimbare de API, nu o optimizare, deci **nu s-a făcut aici**.

---

## Trei lucruri care ar fi trecut drept verzi

1. **`data -> $1` cu parametru netipat** se rezolvă ca `jsonb -> integer`,
   operatorul de acces în tablou, care pe un obiect întoarce NULL pe fiecare
   rând. Interogarea reușește, pagina vine goală, iar toate aserțiunile de forma
   „rândurile astea rămân ascunse" **trec**. Patru teste din suită treceau exact
   așa. Reparat cu `$1::text`.
2. **`zv_revisions.data` e dublu-codificat**: coloana e `jsonb`, dar rândurile
   scrise de motor conțin un **șir** jsonb cu JSON serializat înăuntru, nu
   obiectul. De-aia codul vechi făcea `typeof r.data === 'string' ? JSON.parse`,
   și de-aia există o suită numită „time-travel string JSON". O căutare de cheie
   pe forma-șir nu găsește nimic, tăcut. Normalizat în CTE.
3. **Un câmp `integer` ajunge în snapshot ca șirul `"5"`**, nu ca numărul 5 —
   scriitorul de revizii redă scalarii ca text. Prima versiune a suitei presupunea
   contrariul și „trecea" din cauza punctului 1. Acum se testează amândouă: forma
   reală de azi, și un număr JSON scris direct, fiindcă scriitorul motorului nu e
   singurul lucru care poate pune un rând în `zv_revisions`.

---

## Punct de validare — 4 din 4 (2026-08-30)

| # | Criteriu | Verdict |
|---|---|---|
| 1 | Pagina vine din bază, dovedit prin rânduri citite | ✅ 49 în loc de 400 000, din `EXPLAIN ANALYZE` |
| 2 | Traducerea celor patru operatori e exactă, plantată | ✅ pe numărul JSON, pe cheia lipsă, pe fiecare operator |
| 3 | Apelantul nu vede nicio diferență în afară de viteză | ✅ echivalență live↔trecut pe toți patru operatorii |
| 4 | Costul rămas e scris | ✅ `total` ~250 ms, inerent, cu opțiunea numită și nefolosită |

**Măsurat:** unit 2549/0, harness 920/0, `audit:gates` 18/18, lint și
`import-boundaries` curate.

### Ce NU s-a atins, deși s-a văzut

- **Dubla codificare a snapshot-urilor.** Un `jsonb` care conține un șir cu JSON
  e o risipă de spațiu și o capcană pentru orice interogare viitoare. Reparația
  cere migrarea datelor existente — alt bloc.
- **Scalarii redați ca text.** `?as_of=` întoarce deja `"5"` unde tabela vie
  întoarce `5`; asta e o diferență între cele două căi care exista înainte de
  blocul ăsta și nu s-a schimbat.

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-30 | setup | Capcana traducerii scrisă înainte de cod. |
| 2026-08-30 | 1–3 | Suita a trecut de trei ori din motive greșite până a măsurat ce credea că măsoară. |
| 2026-08-30 | 4–5 | 49 de rânduri în loc de 400 000. Câștigul e memoria, nu timpul — scris ca atare. |
