# Stare — Blocul G: activarea extensiilor per firmă

> **Se citește la începutul fiecărui pas. Se actualizează după fiecare pas.**
> Branch: `block-g/per-tenant-activation`, ramificat din `block-a/explicit-context`
> (PR #367) fiindcă atinge aceleași rute de marketplace. **PR-ul depinde de #367.**
> Metoda: criterii scrise ÎNAINTE de măsurare; un bloc are voie să se închidă cu
> „nu merită". C s-a închis cu 3 din 4, B cu 4 din 4, F cu 3 din 4 plus unul anulat.

---

## De ce există blocul

Modelul cerut de proprietar: **un singur `god` pe instanță, care instalează extensiile;
administratori per firmă, care le pot activa pentru firma lor.**

Prima jumătate e livrată în #367 — zece operații de marketplace au trecut pe `isGodUser`.
A doua nu există, și nu doar că nu e implementată: **era imposibilă.**

`zv_extension_registry` are `UNIQUE (name)`, iar `onConflict` e chiar pe `name`. Deci o
extensie are exact un rând, iar `tenant_id` — adăugat de migrația `070` cu comentariul
„setat = doar acea firmă" — putea reține doar cine a instalat ultimul. Dovedit:

```
INSERT ai pentru firma-A  → ok
INSERT ai pentru firma-B  → ERROR: duplicate key ... Key (name)=(ai) already exists
```

Iar listarea din marketplace **respecta** `tenant_id`, deci arăta unei firme o extensie ca
absentă în timp ce codul ei rula pentru toată lumea. Reparat în #367, tot acolo: listarea
spune acum ce face runtime-ul.

---

## Criteriile punctului de validare — SCRISE ÎNAINTE DE MĂSURARE

1. **O extensie oprită pentru firma B chiar nu acționează pentru B** — dovedit prin
   plantare pe fiecare graniță pe care blocul o acoperă, nu prin citirea codului.
2. **Fiecare graniță acoperită e enumerată, și fiecare graniță NEacoperită e scrisă** ca
   limitare cunoscută. O activare „completă" cu o gaură e minciuna pe care tocmai am
   scos-o din listare, întoarsă pe altă ușă.
3. **Calea de upgrade nu schimbă comportamentul.** Ce e activ azi rămâne activ pentru
   toate firmele după migrație.
4. **Instalarea rămâne a lui god; activarea e a adminului firmei** — pentru firma lui și
   numai a lui, dovedit prin plantare.

**CRITERIU DE OPRIRE:** dacă pasul 2 arată că granițele nu sunt enumerabile — că un cod de
extensie poate acționa pentru o firmă pe căi pe care nu le putem număra — blocul se
închide, iar activarea rămâne **doar pe HTTP**, documentată explicit ca atare. Mai bine o
promisiune mică și adevărată decât una mare cu o gaură.

**Ce NU e criteriu:** ca încărcarea să devină per firmă. Extensiile își înregistrează
rutele, hook-urile și migrațiile într-un singur proces; „încarcă doar pentru firma B" nu
există. Activarea e o poartă la rulare, nu un filtru la încărcare.

---

## Pași

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul ăsta | — | (la fiecare pas) |
| 1 | **Poarta întâi:** test care dovedește că o extensie oprită pentru B nu răspunde pentru B — plantat, roșu | ✅ | 8 aserțiuni, roșii. Fișier: `ext-activation-per-tenant.test.ts` |
| 2 | **Enumeră granițele** prin care codul unei extensii poate acționa; ce nu se acoperă, se scrie | ✅ | **4, nu 3** — și niciuna nu e unde credeam |
| 3 | Migrația: `UNIQUE (name)` → `UNIQUE NULLS NOT DISTINCT (tenant_id, name)` | ✅ | `007`. A rupt 5 `onConflict` + 1 în teste — reparate |
| 4 | Poarta HTTP | ✅ | **nu pe cale, pe mâner** — vezi mai jos |
| 5 | Poarta pe hook-uri | ✅ | un singur loc (`ctx.events.on`), nu două bucle |
| 6 | Cron — sau motiv scris de ce rămâne pe dinafară | ✅ | motiv scris; se aplică doar „activă undeva" |
| 7 | Rutele: instalarea rămâne a lui god, activarea e a firmei | ✅ | + firma se ia din cererea REZOLVATĂ, nu din antet |
| 8 | **PUNCT DE VALIDARE** | ✅ | **4 din 4** |

---

## Modelul, decis înainte de a scrie cod

| rând | cine îl scrie | ce înseamnă |
|---|---|---|
| `tenant_id IS NULL` | **god** | codul e instalat pe instanță; `is_enabled` = pornit implicit pentru toate firmele |
| `tenant_id = X` | **adminul firmei X** | suprascrie pentru firma lui, pornit sau oprit |

Rândurile de azi devin rândul global, deci **calea de upgrade e gratuită**: ce e activ
rămâne activ. Asta e și criteriul 3.

`NULLS NOT DISTINCT` e obligatoriu: fără el, `NULL` e distinct de el însuși într-un index
unic, deci ar putea exista mai multe rânduri globale pentru aceeași extensie. Postgres 18
îl suportă.

---

## Granițele — pasul 2, măsurat (2026-08-30)

Enumerarea de dinainte era **greșită în ambele direcții**: trei granițe, dintre care una
inexistentă și una la locul nepotrivit. Sursa corectă nu e `index.ts`, ci **`register.ts`**,
fiindcă acolo primește fiecare extensie uneltele cu care poate acționa — și acolo îi știm
numele. Contractul nu e un obiect cu câmpuri (`mod.routes`, `mod.hooks`); o extensie
lucrează prin `ctx`, deci granițele sunt punctele unde `ctx` i se predă.

| # | graniță | unde | de ce acolo |
|---|---|---|---|
| 1 | rutele montate | `register.ts:467` `mountExtensionRoutes` | per extensie, nu pe cale |
| 2 | **rutele publice** | `register.ts:406` `registerPublicRoute` | **montează pe app-ul GLOBAL, în afara `/ext/<nume>/`** |
| 3 | ascultătorii de evenimente | `register.ts:346` — `ctx.events.on` e deja împachetat pentru dezabonare | un singur loc, nu două bucle în `event-bus.ts` |
| 4 | programările | `register.ts:704` și `:802` → `cron-runner.ts:233` | vezi mai jos |

**Granița 2 e cea care ar fi făcut gaura.** Planul dinainte era o poartă pe `app.use('/ext/*', …)`.
O extensie pe `mountStrategy: 'subapp'` are voie să-și pună rute în afara acelui prefix —
link-uri publice, capete desfășurate de utilizator — iar poarta de cale nu le-ar fi atins
niciodată. Am fi anunțat „oprită pentru firma B" în timp ce ruta ei publică răspundea.
Exact minciuna scoasă din listare în #367, întoarsă pe altă ușă. Se vede citind
`register.ts`, nu `index.ts`; de-asta pasul 2 e pas, nu presupunere.

### Cron — nu se acoperă, și motivul e scris

`cron-runner.ts:233` cheamă `entry.schedule.handler(this.ctx, runId)`: **o dată, fără nicio
firmă în domeniu.** Programările nu sunt azi „pentru firma X" — nici nu au cum să fie, n-au
context de firmă. Deci nu există poartă de activare de pus acolo: n-ai pe cine s-o întrebi.

A le face per firmă nu e o poartă, e **o schimbare a înțelesului unei programări** pentru
fiecare extensie existentă — un job care rulează o dată pe noapte ar rula de N ori.

Ce se face în schimb, fiindcă e ieftin și adevărat: **dacă extensia nu e activă pentru
NICIO firmă, programarea ei nu rulează.** Atât se promite. Fan-out-ul per firmă rămâne
non-obiectiv declarat, nu o gaură tăcută — criteriul 2.

---

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-30 | setup | Document scris, criterii fixate ÎNAINTE. Granițele numărate în avans: 3, dintre care una e o singură linie. Criteriul de oprire scris: dacă nu sunt enumerabile, se livrează doar HTTP, spus explicit. |

---

## Context care nu trebuie re-descoperit

- **`UNIQUE (name)` e cauza**, nu încărcătorul. Încărcătorul care ignora `tenant_id` avea
  din întâmplare singurul comportament corect.
- **Nu opri motoare cu `pkill -f`** — după PID.
- **Baza de referință:** schema engine + jumătățile UP ale migrațiilor de extensii
  (`awk '/^-- DOWN[[:space:]]*$/{exit}'`). 81 au secțiune DOWN.
- **`return` dintr-o tranzacție COMITE** — m-a prins azi, la crearea firmei. Se aruncă.
- **Poarta `import-boundaries`** refuză importuri directe peste barrel-ul unui subsistem.


---

## Punct de validare — 4 din 4 (2026-08-30)

| # | Criteriu | Verdict |
|---|---|---|
| 1 | O extensie oprită pentru B nu acționează pentru B, dovedit prin plantare | ✅ 5 aserțiuni plantate, ambele strategii de montare |
| 2 | Fiecare graniță acoperită enumerată; fiecare neacoperită, scrisă | ✅ 5 acoperite, 2 scrise ca limite |
| 3 | Calea de upgrade nu schimbă comportamentul | ✅ rândurile vechi au `tenant_id IS NULL` = rândul global |
| 4 | Instalarea a lui god, activarea a firmei, dovedit prin plantare | ✅ prin HTTP, nu doar la nivel de funcție; instalarea nu mai scrie firma cerută prin antet |

**Măsurat:** unit 2549/0, harness 906/0, `audit:gates` 18/18, lint rc=0, typecheck rc=0,
acoperire `lib` 97,1% (poarta cere să nu scadă cu peste 0,5 puncte).

### Ce s-a dovedit că era greșit în planul propriu

Enumerarea făcută înainte de pasul 2 avea trei granițe. **Două din trei erau
greșite**, iar felul în care erau greșite conta:

- „poartă pe `app.use('/ext/*', …)`" — `mountStrategy: 'global'`, **care e
  IMPLICITUL**, predă extensiei app-ul motorului însuși; extensia își alege
  singură căile. O poartă pe prefix n-ar fi păzit nimic acolo. Poarta stă acum
  pe *mânerul* predat: un Proxy peste metodele de rutare, care împachetează
  fiecare handler — inclusiv pe cele înlănțuite, fiindcă Hono întoarce app-ul
  și un proxy care întoarce ținta ar fi lăsat al doilea `.get()` nepăzit.
- „două bucle în `event-bus.ts`" — `register.ts` împachetează deja `ctx.events.on`
  ca să poată dezabona la descărcare. **Un singur loc**, și acolo se știe numele
  extensiei.

Am încercat totuși poarta pe prefix, ca al doilea strat. **A picat 3 teste**:
`routes/index.ts` înregistrează limitatoare pre-auth pe `/ext/forms/public/*`
*după* lanțul din `index.ts`, deci poarta răspundea 404 înaintea limitatorului
și scotea plafonul de pe o cale neautentificată. A fost scoasă. Granița worker
e închisă acolo unde e montată de fapt — în `worker-extension-host.ts`.

### Granițele acoperite

| graniță | unde | cum |
|---|---|---|
| rute `subapp` | `register.ts` | `use('*')` pe sub-app, nu pe părinte |
| rute `global` | `register.ts` | Proxy peste metodele de rutare |
| rute publice | `register.ts` | handler împachetat |
| ascultători de evenimente | `register.ts` | handler împachetat |
| worker izolat | `worker-extension-host.ts` | `use('*')` pe sub-app-ul proxy |

### Cele două limite, scrise fiindcă există

1. **Cron nu e per firmă.** `cron-runner.ts` cheamă handler-ul o dată, fără nicio
   firmă în domeniu. Se aplică doar regula slabă: dacă nicio firmă n-a pornit
   extensia, programarea nu rulează. Fan-out per firmă = non-obiectiv declarat.
2. **`app.route()` / `mount()` nu sunt împachetate.** O extensie `global` care
   montează un sub-router întreg trece pe lângă proxy. Nicio extensie din cele
   57 nu face asta azi; dacă vreuna o face, poarta n-o vede.

### Întrebarea nu e mereu aceeași, și asta e intenționat

- cererea numește o firmă → e pornită pentru firma aia?
- cererea nu numește niciuna → e pornită pentru vreo firmă?

A doua nu e o slăbire de comoditate. Rutele publice există tocmai ca un IdP să
aibă `/scim/v2/Users`, unde **jetonul ESTE identitatea firmei** — nu se poate
ști firma înainte ca extensia însăși s-o rezolve. A refuza acolo n-ar aplica
alegerea unei firme, ar șterge funcția.

### Ce face poarta când baza nu răspunde: **cade DESCHIS**

Deliberat, și e singura decizie din bloc care merită contestată. Activarea e
preferința unei firme despre o funcție, nu o decizie de autorizare — codul
extensiei e încărcat oricum, iar toate verificările de drepturi de dedesubt
rulează neatinse. O bază care nu poate răspunde nu trebuie să stingă produsul
pentru toată lumea. Se strigă în log și **nu se memorează** nimic.

### Costul, măsurat înainte de a-l plăti

Căutarea rulează pe pool **în timp ce tranzacția cererii e deschisă** — a doua
conexiune ținută simultan, exact forma care a dus `/api/insights` la
`DB_POOL_MAX`. De-aia există și cache (10 s) și **dedup pe cererile în zbor**:
fără al doilea, `c` cereri reci simultane ar costa `c` conexiuni deodată, adică
bug-ul acela din nou.

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-30 | 1–2 | Testul roșu întâi. Enumerarea propriilor granițe: 2 din 3 greșite. |
| 2026-08-30 | 3 | Migrația a rupt 5 `onConflict(name)` — invizibile până la rulare (`42P10`). |
| 2026-08-30 | 4–6 | Poarta pe mâner. Prefixul, încercat ca al doilea strat, a scos un limitator pre-auth: retras. |
| 2026-08-30 | 7 | Instalarea scria firma din **antet**; acum scrie rândul global. Testul care fixa vechiul comportament, rescris. |
| 2026-08-30 | 8 | 4/4. `zveltio_test` avea lanț de migrații divergent — bază proprie per sesiune. |
| 2026-08-30 | CI | Trei porți pe care rularea locală nu le atinge: migrația nu era în binar, importul sărea barrel-ul, snapshotul de schemă era vechi. |
| 2026-08-30 | CI | Poarta de acoperire a arătat că **ruta prin care adminul firmei activează nu era atinsă de niciun test** — o gaură în criteriul 4, nu doar în procente. Acoperită prin HTTP. |
