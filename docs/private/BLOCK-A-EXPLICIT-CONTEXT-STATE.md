# Stare — Blocul A: contextul de firmă devine explicit

> **Se citește la începutul fiecărui pas. Se actualizează după fiecare pas.**
> Branch: `block-a/explicit-context` · Plan: `MATURITY-REFACTOR-PLAN.md` §Blocul A.
> Ordinea C → B → F → **A**, aleasă după **ce se întâmplă dacă greșim**.
> C s-a închis cu 3 din 4, B cu 4 din 4, F cu 3 din 4 plus unul anulat — **niciunul cu
> criteriile rescrise după ce s-au văzut cifrele.**

---

## De ce e ultimul, și de ce e cel mai periculos

E **singurul bloc care poate rupe izolarea tăcut.** C și B au fost făcute înainte tocmai
ca o greșeală de aici să devină zgomotoasă în loc de invizibilă:

- un `finally` **sincron** a golit odată tranzacția devreme și a lăsat **302 politici
  inerte, cu testele verzi**;
- `zveltio_rls` a rămas odată cu 11 tabele din 378, și verdele venea din `NODE_ENV=test`.

Ambele s-au întâmplat în acest cod. Blocul trece prin exact același teren.

## Problema, așa cum e descrisă în plan

`registerCoreRoutes(app, { db: scopedDb, poolDb: db, auth })`. Acel `scopedDb` e un
`Proxy` al cărui `get` citește `getCurrentTenantTrx()` **la fiecare acces de proprietate**.
Un `Proxy.get` e **sincron** — nu poate aștepta deschiderea unei tranzacții. De aici, în
lanț: tranzacția se deschide înainte de handler, ține toată cererea, fixează o conexiune
din pool, iar la `DB_POOL_MAX` concurența se blochează.

---

## Criteriile punctului de validare — SCRISE ÎNAINTE DE MĂSURARE

1. **Plafonul de concurență s-a mutat, măsurat la aceeași `DB_POOL_MAX`** — aceeași bază,
   aceeași rută, aceeași sarcină. Nu „pare mai rapid": p95 la concurență peste pool.
2. **Nicio regresie de izolare.** Suita completă verde ȘI o probă care arată că o cerere
   fără context de firmă **nu** poate citi date de firmă.
3. **Orice sit ratat e eroare de compilare**, nu scurgere la rulare — asta e diferența
   dintre refactorizarea asta și cele două incidente de mai sus.
4. **Contractul SDK rămâne valid** pentru extensiile existente, sau are perioadă de
   tranziție scrisă.

**CRITERIU DE OPRIRE, scris acum:** dacă **pasul 1** arată că plafonul **nu se mută** —
că timpul în care conexiunea e ținută degeaba e mic față de durata cererii — blocul se
închide acolo. Restul pașilor nu se fac. Planul spune asta explicit, și e singurul bloc
căruia i s-a scris dinainte dreptul de a se opri la prima măsurătoare.

**Ce NU e criteriu:** eleganța. Un `db` explicit e mai verbos; asta nu e un argument nici
pentru, nici împotriva.

---

## Pași

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul ăsta | — | (la fiecare pas) |
| 1 | **Măsoară** cât e ținută efectiv o conexiune pe o cerere reală, față de cât ar fi cu tranzacții scurte | ✅ **FĂCUT** | plafonul e real; câștigul e ~2,3×, **nu „dispare”** |
| 2 | Inventar: siturile `reqDb`, `?? db`, și codul de extensie pe `ctx.db` | DE FĂCUT | — |
| 3 | Accesorul explicit, `async`, ca TypeScript să prindă siturile ratate | DE FĂCUT | — |
| 4 | Poartă: nicio interogare pe date de firmă în afara tranzacției | DE FĂCUT | — |
| 5 | Migrarea rutelor nucleu, bucăți de ~10, suita verde între ele | DE FĂCUT | — |
| 6 | Contractul SDK pentru extensii, cu tranziție | DE FĂCUT | — |
| 7 | **PUNCT DE VALIDARE** | DE FĂCUT | — |

---

## Măsurătoarea (pasul 1, 2026-08-30)

Motor viu pe `:3400`, colecție cu 50 000 de rânduri, `/api/data/benchrows?limit=25`,
sarcină reală prin HTTP cu sesiune god. Probe din `pg_stat_activity` în timpul sarcinii.

### Plafonul există, e exact la `DB_POOL_MAX`, și deasupra lui serviciul SE OPREȘTE

| `DB_POOL_MAX` | c | cereri | erori | p95 | stări în pool |
|---:|---:|---:|---:|---:|---|
| 10 | 5 | 2 146 | 0 | 19,6 ms | `idle in transaction×4` |
| 10 | **10** | **10** | **10** | **9 724 ms** | **`idle in transaction×10`, `active×1`** |
| 10 | 15 / 20 / 30 | = c | toate | ~11 975 ms | identic |
| 25 | 20 | 2 603 | 0 | 59,6 ms | — |
| 25 | **25** | **25** | **25** | **10 489 ms** | — |

Nu e o degradare, e o oprire: la `c = DB_POOL_MAX` fiecare conexiune e ținută
`idle in transaction` și **una singură lucrează**. Motorul refuză în loc să aștepte
(garda `pool_busy`, din lucrarea de limită de tranzacție), deci răspunde cu eroare în loc
să atârne — dar răspunde cu eroare.

**Plafonul se mută liniar cu `DB_POOL_MAX`, și cu nimic altceva.**

### Cât din timpul ținut e muncă reală

Douăzeci de probe în timpul unei sarcini la c=5, `DB_POOL_MAX=10`:

| | conexiuni |
|---|---:|
| `active` — muncă reală | **2,20** |
| `idle in transaction` — ținute degeaba | **2,85** |
| **fracțiunea de muncă reală** | **44%** |

### Ce înseamnă, și de ce corectează planul

Planul spune că, prin tranzacții scurte, **„plafonul de concurență dispare, fiindcă o
conexiune e ținută microsecunde, nu milisecunde"**. Măsurătoarea nu susține asta.

56% din timpul în care o conexiune e ținută e petrecut `idle in transaction`. Cu tranzacții
scurte, capacitatea la același pool ar crește cu aproximativ **1 / 0,44 ≈ 2,3×** — de la
c≈10 la c≈23 pe un pool de 10. Real, dar **nu nemărginit**, și nu „dispare".

**Rezerva la propria mea cifră:** 44% vine dintr-o sarcină sub saturație, pe o rută simplă
(o listare de 25 de rânduri) cu baza locală. O cerere cu mai multă muncă per apel ar
deplasa raportul în oricare direcție. Cifra e un ordin de mărime, nu o promisiune.

### Alternativa ieftină, măsurată alături

`DB_POOL_MAX` mută același plafon, liniar, **fără nicio schimbare de cod**: de la 10 la 25
plafonul urcă de la c=10 la c=25. E limitat de `max_connections / instanțe`, și e chiar
decizia de proprietar din §Blocul E.

Deci întrebarea nu e „merită plafonul mutat" — e **„merită mutat cu 2,3× prin cel mai
riscant refactor din plan, când o linie de configurație îl mută liniar"**. Asta e o decizie
de proprietar, nu de inginerie, și blocul se oprește aici până când e luată.

**Criteriul de oprire NU s-a activat literal** — 56% nu e „mic". Dar cifra e destul de
departe de promisiunea planului cât să nu deschid pașii 2–7 fără ca proprietarul să vadă
comparația.

## Ce NU se atinge

- **Politica RLS, forma predicatului, clasificarea graniței.** B și F le-au închis.
- **Rolul de conectare al engine-ului.** Decis măsurat că nu se schimbă.
- **Ierarhia de firme.** Lucrare separată, necomisă.

---

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-30 | 1 | **Plafonul e real și exact la `DB_POOL_MAX`** — la c=pool serviciul se oprește, cu toate conexiunile `idle in transaction` și una activă; verificat la pool 10 și 25. **Dar doar 56% din timpul ținut e degeaba**, deci tranzacțiile scurte ar da ~2,3×, nu „plafonul dispare" cum spune planul. `DB_POOL_MAX` mută același plafon liniar, fără cod. **Blocul se oprește la pasul 1 până la decizia proprietarului.** |
| 2026-08-30 | setup | Document scris, criterii fixate ÎNAINTE de măsurare. Pasul 1 are dreptul declarat să închidă blocul. |

---

## Context care nu trebuie re-descoperit

- **Măsurătoarea de referință care există deja:** `/api/insights` încremenea la
  `c = DB_POOL_MAX` — 10 conexiuni `idle in transaction`, 0 `active`. Reparat prin mutarea
  rutelor pe `poolDb` (v. `project_transaction_boundary_2026_08_26`). Deci calea aia e deja
  scoasă din tranzacție; blocul ăsta e despre restul.
- **Nu opri motoare cu `pkill -f`** — după PID. `/opt/zveltio` (`:3000`) și sesiunile
  celorlalți rulează pe aceeași mașină. Portul meu e `:3400`.
- **Baza de referință:** schema engine + **jumătățile UP** ale migrațiilor de extensii
  (`awk '/^-- DOWN[[:space:]]*$/{exit}'`). 81 de migrații au secțiune DOWN; `psql -f` pe
  fișierul întreg creează tabelele și apoi le șterge, cu `rc=0`.
- **Env fără de care testele mint:** `ZVELTIO_REGISTRATION_ENABLED=1`,
  `FIELD_ENCRYPTION_KEY=<64 hex>`, `TEST_PORT`, `TEST_DATABASE_URL`, pe linii separate.
