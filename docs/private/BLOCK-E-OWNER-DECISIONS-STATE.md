# Stare — Blocul E: decizii de proprietar, executate

> Branch: `block-e/owner-decisions`, din master (după #368).
> Blocul ăsta e singurul din plan care **nu era muncă de inginerie**: trei
> întrebări pe care nu aveam dreptul să le răspund singur. Au fost puse cu
> cifrele lângă pe 2026-08-30 și răspunse pe loc.

---

## Decizia 1 — `DB_POOL_MAX`: **se ridică la 40 ȘI se face blocul A**

Ce s-a pus pe masă:

> Plafonul de concurență e exact la `DB_POOL_MAX`. La `c = pool` serviciul nu se
> degradează, **se oprește**, cu toate conexiunile `idle in transaction` și una
> singură activă. Măsurat la pool 10 și din nou la 25.

| opțiune | ce dă | ce costă |
|---|---|---|
| 40 în loc de 25 | p95 la c=30: de la secunde la **214 ms** | 5 instanțe pe un Postgres cu `max_connections=200`, nu 8 |
| tranzacții scurte (blocul A) | ~**2,3×** — nu „plafonul dispare" | muncă mare, pe o cale de securitate |

**Răspuns: amândouă.** Se compun; niciuna nu o înlocuiește pe cealaltă.

**Executat aici:** `DEFAULT_DB_POOL_MAX` 25 → 40, plus documentația și nota de la
boot. Comentariul din `startup-guards.ts` spunea explicit *„implicitul NU se
ridică — un implicit e moștenit de fiecare instalare"*; acum spune că s-a ridicat
și **ce s-a plătit**, fiindcă argumentul lui era corect și nu a dispărut, doar a
fost cântărit împotriva măsurătorii. Poarta `pool-max-single-source` confruntă
oricum numărul din cod cu cel din documentație.

**Blocul A rămâne de făcut.**

---

## Decizia 2 — catalogul: **date versionate livrate**

749 de linii, 60 de intrări, **un singur consumator la rulare**
(`extension-download.ts`, care le unește cu registry-ul).

Problema nu era mărimea, era că **o extensie nouă în catalog cerea o versiune
nouă de motor** — pentru o listă al cărei rost e să se schimbe mai des decât
motorul.

**Executat:** intrările au trecut în `catalog.json` (extrase mecanic, nu
transcrise), iar `extension-catalog.ts` a rămas 193 de linii de tipuri și
încărcare. Ordinea surselor:

1. `ZVELTIO_CATALOG_PATH`, dacă e setat
2. `<EXTENSIONS_DIR>/catalog.json`, dacă există
3. copia din pachet, importată

**Copia din pachet e verificată în binarul compilat**, nu presupusă: `catalog_version`
și intrările apar în `dist/zveltio`. O instalare fără fișier și fără registry are
în continuare un catalog — ceea ce e chiar piața țintă.

Un fișier stricat **nu cade tăcut** pe catalogul din pachet: spune ce nu a putut
citi și abia apoi cade. Un operator care a editat un fișier și n-a văzut niciun
efect n-are altfel de unde afla.

---

## Decizia 3 — `KNOWN_EXTENSION_RESOURCES`: **se scoate, cu minim declarat**

Lista înghețată de 28 de nume acoperea instalările dinainte ca resursele să fie
citite din manifeste — legătură apărută în **3.0.0-beta.63 (2026-08-28)**.

**Executat:** lista a dispărut, iar minimul e scris în cod: o extensie trebuie
să declare `manifest.resources`.

**Jumătatea care contează:** ștergerea unei plase de siguranță în tăcere ar fi
fost partea greșită a deciziei. Un nume lipsă înseamnă că
`materializeDefaultGrants` nu deschide resursa, iar deny-by-default refuză accesul
**fără să arate spre nimic**. Așa că o extensie instalată care nu declară nimic e
acum **numită la boot**, cu versiunea minimă în mesaj.

Două teste s-au dovedit că se sprijineau pe listă ca să aibă ce număra:
- *„still returns the built-in floor"* — verifica lista, nu citirea;
- *„survives an extension whose manifest is missing"* — cerea `length > 0`, pe
  care lista îl garanta gratis, deci nu dovedea nimic despre supraviețuire.

Amândouă rescrise pe ce voiau să verifice.

---

## Măsurat

unit **2557/0**, harness **907/0**, `audit:gates` **18/18**, lint curat,
binarul compilează și conține catalogul.

## Ce rămâne după blocul ăsta

- **Blocul A** — tranzacții scurte. Decis („amândouă"), nefăcut.
- **Blocul C** — rămâne deschis: 23 de porți din 41 nedovedite prin plantare.

## Jurnal

| Când | Ce s-a întâmplat |
|---|---|
| 2026-08-30 | Trei întrebări puse cu măsurătorile lângă; trei răspunsuri; toate trei executate în aceeași zi. |
