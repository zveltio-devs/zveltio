# Stare — Blocul D: stratul de condiții pe rânduri

> **Se citește la începutul fiecărui pas. Se actualizează după fiecare pas.**
> Branch: `block-d/row-conditions`, ramificat din master (după #368).
> Metoda: criterii scrise ÎNAINTE de măsurare; un bloc are voie să se închidă cu
> „nu merită". C s-a închis cu 3/4 (rămas deschis), B 4/4, F 3/4 + unul anulat,
> A oprit la pasul 1, G 4/4.

---

## Ce spune planul, și ce NU spune

Blocul D e singurul din plan scris ca **observație, nu ca plan ferm**:

> `getRlsFilters()` traduce reguli în condiții de interogare — scris de mână. E
> exact ce face **CASL** bine. Nu propun schimbarea motorului de autorizare —
> Casbin rămâne alegerea bună. Dar partea de condiții pe rânduri e o bucată
> separabilă unde o bibliotecă matură ar putea plăti. **Merită un bloc de
> măsurare, nu o decizie acum.**

Și o constatare atașată, nemăsurată:

> Pe calea de *time travel*, filtrele se aplică **în memorie**
> (`matchesRlsFilters`), nu în SQL. O regulă care ascunde rânduri costă acolo tot
> setul citit înainte de filtrare.

Deci blocul ăsta nu are voie să se termine cu o rescriere. Are voie să se termine
cu **un număr și o decizie scrisă**, inclusiv „se rămâne cum e".

---

## Criteriile punctului de validare — SCRISE ÎNAINTE DE MĂSURARE

1. **Suprafața e numărată, nu estimată:** câte forme de predicat produce stratul,
   câți consumatori are, și care dintre ei aplică filtrele în SQL și care în
   memorie. Un tabel, derivat din cod, nu din amintiri.
2. **Costul căii din memorie e MĂSURAT**, pe date, la o dimensiune care contează
   — nu dedus din faptul că filtrarea e în memorie. Dacă nu costă, se scrie că
   nu costă.
3. **Întrebarea despre CASL primește un răspuns cu cifre:** ce fracțiune din
   formele găsite la pasul 1 le acoperă direct, ce ar rămâne scris de mână, și
   ce ar costa traducerea spre SQL pe care o avem deja.
4. **Decizia e scrisă și motivată de o măsurătoare**, nu de preferință. „Se
   rămâne cum e" e un rezultat valid și trebuie să poată fi apărat cu aceleași
   cifre ca alternativa.

**CRITERIU DE OPRIRE:** dacă pasul 2 arată că filtrarea în memorie nu costă la
scara reală a produsului, blocul se închide acolo. Restul ar fi o rescriere
căutându-și justificarea — exact tiparul pe care planul îl interzice.

**Ce NU e criteriu:** să se schimbe motorul de autorizare. Casbin rămâne.

---

## Pași

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul ăsta | — | (la fiecare pas) |
| 1 | **Măsoară suprafața:** forme de predicat, consumatori, SQL vs memorie | ✅ | 4 operatori, 1 câmp, ȘI plat — tot limbajul |
| 2 | **Măsoară costul căii din memorie** pe date reale | ✅ | **2,2 ms din 336** — criteriul de oprire s-a declanșat |
| 3 | Confruntă formele cu ce acoperă CASL | ✅ | acoperă tot, dar „tot" înseamnă patru operatori |
| 4 | Decizia, scrisă, cu cifra care o susține | ✅ | **NU se schimbă nimic aici** |
| 5 | **PUNCT DE VALIDARE** | ✅ | **4/4 — blocul se închide cu „nu merită"** |

---

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-30 | setup | Document scris, criterii fixate ÎNAINTE. Criteriu de oprire explicit la pasul 2, fiindcă blocul e cel mai expus la „rescriu pentru că e scris de mână". |

---

## Context care nu trebuie re-descoperit

- **Tabelul formelor de predicat RLS există deja**, din 2026-08-27:
  `project_rls_plan_quality_2026_08_27` — forma scalară ajunge la 129 ms unde
  `= ANY` face 204. „Politicile nu pot folosi indexul" e FALS.
- **Nu confunda cele două straturi:** politicile Postgres (RLS pe `tenant_id`)
  și regulile de rând ale produsului (`zvd_rls_policies` → `getRlsFilters`).
  Blocul ăsta e despre al doilea.
- **O bază poluată de teste dă cifre credibile și false** — „364 ms" a fost
  artefact, real 0,93 ms. Bază proprie, populată intenționat.
- Bază de sesiune: se creează una nouă; `zveltio_test` are lanț de migrații
  divergent. `ZVELTIO_REGISTRATION_ENABLED=1` sau harness-ul pică la înregistrare.


---

## Pasul 1 — suprafața, numărată (2026-08-30)

Stratul întreg de condiții pe rânduri e `packages/engine/src/lib/tenancy/rls.ts`,
334 de linii, din care **traducerea propriu-zisă e ~70**: `applyRlsFilters` (spre
Kysely) și `matchesRlsFilters` (în memorie), ținute lipite una de alta anume ca
să nu poată ajunge să nu fie de acord ce înseamnă o politică.

**Limbajul complet de politici, din `zvd_rls_policies` + validatorul rutei:**

| parte | valori posibile |
|---|---|
| câmp | **unul** (`filter_field`) |
| operator | **patru**: `eq`, `neq`, `in`, `not_in` — `z.enum` în `routes/rls.ts:25` |
| sursă de valoare | **patru**: `user_id`, `user_email`, `user_role`, `static:VAL` |
| combinare | **ȘI plat** — fiecare politică împinge o condiție în listă |
| domeniu | `collection` și `role`, fiecare literal sau `*` |

Nu există SAU, nici imbricare, nici traversare de relații, nici reguli pe câmp.

**Consumatorii, și pe ce cale aplică:**

| fișier | în SQL | în memorie |
|---|---|---|
| `data/handlers/single.ts` | 6 | 2 (*time travel*) |
| `data/handlers/list.ts` | 0 | 2 (*time travel*) |
| `data/handlers/bulk.ts` | 3 | 0 |
| `data/shape.ts` | 4 | 0 |
| `routes/sync.ts` | 4 | 0 |
| `lib/extensions/internals.ts` | 4 | 0 |
| `routes/realtime.ts` | 0 | 2 (per mesaj, nu pe set) |

Calea din memorie e **exact cea pe care o numea planul** — *time travel* — plus
difuzarea în timp real, care evaluează un mesaj, nu un set. Ambele aplicatoare
**cad închis** pe un operator necunoscut, cu un comentariu care spune de ce:
`in` și `not_in` erau acceptate de rută și tăcut ignorate aici, deci o politică
salvată, listată ca activă și crezută de administrator nu făcea nimic.

---

## Pasul 2 — costul, măsurat (2026-08-30)

Bază proprie, 200 000 de înregistrări cu câte 2 revizii (400 000 de rânduri),
`?as_of=` cu o politică `status = published` și pagină de 25.

| | total | SQL | parsare JSON | **filtrul de rânduri** |
|---|---|---|---|---|
| 200 000 înregistrări | **336 ms** | 322 ms | 12 ms | **2,2 ms** |
| 20 000 înregistrări | **36 ms** | 35 ms | 1 ms | **0,2 ms** |

**Filtrarea în memorie e 0,65% din timp la 200 000 și 0,55% la 20 000.**

Suspiciunea din plan — „o regulă care ascunde rânduri costă tot setul citit
înainte de filtrare" — e **măsurată și infirmată ca diagnostic**. Setul întreg
chiar se citește, dar nu filtrul îl cere: se citește oricum, cu politică sau
fără. Costul e în altă parte, și pasul ăsta l-a găsit — vezi mai jos.

---

## Pasul 3 — CASL, cu cifrele de la pasul 1

CASL acoperă **toate** formele găsite. Dar „toate" înseamnă patru operatori pe un
câmp, combinate cu ȘI. Ce aduce CASL în plus — arbori și/sau imbricați, tipuri de
subiect, reguli pe câmp, potrivire în stil MongoDB — **nu e cerut de nicio
politică pe care produsul o poate exprima**, fiindcă ruta validează împotriva
unui `z.enum` cu patru valori.

Iar partea grea rămâne oricum a noastră: CASL nu traduce spre **Kysely**. Ar
trebui scrisă exact aceeași funcție `applyRlsFilters`, doar că citind din
structura CASL în loc din a noastră.

Deci schimbul ar fi: **o dependență în plus, aceeași traducere scrisă de mână**,
ca să înlocuiască 70 de linii care nu pot devia (validatorul rutei și ambele
aplicatoare împart același enum, iar operatorul necunoscut cade închis în
amândouă).

---

## Pasul 4 — decizia

**Nu se schimbă nimic în stratul de condiții pe rânduri.** Casbin rămâne pentru
autorizare, iar traducerea rămâne scrisă de mână.

Se apără cu aceleași cifre ca alternativa: 70 de linii, 4 operatori, 0,65% din
timpul căii celei mai scumpe, și două aplicatoare care nu pot fi de acord greșit
fiindcă sunt lipite și cad închis.

---

## Ce a găsit blocul în schimb — și nu e subiectul lui

`?as_of=` **citește tot istoricul colecției ca să întoarcă o pagină.**
`list.ts:68-73` face `SELECT DISTINCT ON (record_id) … FROM zv_revisions` **fără
LIMIT**, parsează fiecare snapshot în proces, filtrează, și abia apoi taie
`slice(offset, offset + limit)`.

Aceeași pagină, cerută bazei de date:

| | total | pagina | numărătoarea |
|---|---|---|---|
| așa cum e scris | **336 ms** | — | — |
| împins în SQL | 191 ms | **2 ms** | 190 ms |

**Pagina însăși e de 168 de ori mai ieftină.** Ce costă e `total`-ul, care cere
`DISTINCT ON` peste tot istoricul oricum — deci partea scumpă e o *opțiune*, nu
o necesitate.

Și nu e doar timp: fiecare cerere `?as_of=` materializează în proces tot setul
(la măsurătoarea asta, ~50 MB), în același proces Bun care servește restul.

**Nu se repară aici.** E alt subiect decât condițiile pe rânduri, are altă
capcană (traducerea `eq` pe JSON: `data->>'câmp' = '5'` ar arăta un rând pe care
comparația din memorie îl ascunde, fiindcă `5 !== '5'` — traducerea corectă e
`data->'câmp' = to_jsonb('5'::text)`), deci merită criteriile lui scrise înainte.

---

## Punct de validare — 4 din 4, cu rezultat „nu se schimbă" (2026-08-30)

| # | Criteriu | Verdict |
|---|---|---|
| 1 | Suprafața numărată, nu estimată | ✅ 4 operatori, 1 câmp, 4 surse, ȘI plat; 7 consumatori clasificați |
| 2 | Costul căii din memorie MĂSURAT | ✅ 2,2 ms din 336 — și criteriul de oprire s-a declanșat |
| 3 | CASL, răspuns cu cifre | ✅ acoperă 4/4 forme; ar adăuga o dependență și ar cere aceeași traducere |
| 4 | Decizie scrisă, susținută de măsurătoare | ✅ nu se schimbă nimic |

Blocul se închide **fără nicio linie de cod de produs schimbată** — ceea ce era
un rezultat permis din prima zi, și e cel corect aici.

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-30 | setup | Criterii fixate ÎNAINTE, cu criteriu de oprire la pasul 2. |
| 2026-08-30 | 1 | Limbajul întreg de politici încape într-un tabel de 5 rânduri. |
| 2026-08-30 | 2 | Criteriul de oprire s-a declanșat: filtrul costă 0,65%. Dar măsurătoarea a scos la iveală citirea nemărginită din `?as_of=`. |
| 2026-08-30 | 3–5 | Închis cu „nu merită", 4/4. Constatarea adiacentă trimisă într-un bloc propriu. |
