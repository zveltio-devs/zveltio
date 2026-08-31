# Stare — Blocul J: a doua linie de apărare stă în bază

> **Se citește la începutul fiecărui pas. Se actualizează după fiecare pas.**
> Branch: `block-j/db-second-line`, din master.
> Metoda: criterii scrise ÎNAINTE de măsurare; un bloc are voie să se închidă cu
> „nu merită". C 4/4, B 4/4, D 4/4 („nu merită"), E decis, F 3/4, G 4/4, H 4/4,
> A pasul 2.

---

## Ce a cerut proprietarul, în cuvintele lui

> „God user trebuie să fie și în bază. Prima linie de apărare este engine-ul,
> iar a doua trebuie să fie RLS-ul din bază. Și, încă ceva: **același lucru
> trebuie să fie la orice utilizator**. Engine-ul filtrează, stabilește politici,
> dar trebuie să existe gardă și pe baza de date."

Sunt două cereri, nu una, și a doua e mult mai mare decât prima.

---

## Ce e adevărat azi — măsurat, nu presupus

| | unde e apărat |
|---|---|
| izolarea pe firmă (`tenant_id`) | **și în bază** — politici `FORCE RLS` care citesc `zveltio_visible_tenants()` din variabile de sesiune |
| cine e god | **doar în engine** — `user.role = 'god'`, citit de `isGodUser`; nicio politică nu știe de el |
| regulile de rând ale produsului (`zvd_rls_policies`) | **doar în engine** — `applyRlsFilters` adaugă un `WHERE`; baza nu știe că regula există |

Iar felul în care god vede totul azi e **ieșirea din RLS**: rutele care au nevoie
primesc `poolDb`, iar pool-ul se conectează ca `postgres`, superutilizator cu
`rolbypassrls`. Adică privilegiul nu e exprimat, e o portiță.

**Și nimic nu impune un singur god.** Modelul cerut („unul singur pe instanță")
nu e apărat nicăieri: `user.role` acceptă `'god'` pe oricâte rânduri.

---

## De ce a doua cerere e cea grea

O regulă de rând e un rând în `zvd_rls_policies`: un câmp, un operator din
patru, o sursă de valoare din patru. Ca s-o aplice **baza**, îi trebuie
identitatea apelantului în variabile de sesiune — asta e ieftin. Partea scumpă e
forma predicatului: regulile sunt **dinamice**, un admin le schimbă la rulare.

Două forme, amândouă cu un cost care trebuie măsurat, nu ghicit:

1. **Politici generate** — motorul emite `CREATE POLICY` la fiecare schimbare de
   regulă. Predicat simplu, plan bun, dar DDL pe o cale de administrare și o
   mulțime de politici de întreținut.
2. **O politică generică** care consultă `zvd_rls_policies` la interogare,
   printr-o funcție. Zero DDL, dar o funcție per rând — și proiectul are deja
   scrisă lecția că forma predicatului RLS a mutat un timp de la 415 la 204 ms.

---

## Criteriile punctului de validare — SCRISE ÎNAINTE DE MĂSURARE

1. **God e exprimat în bază, nu printr-o portiță.** Dovedit prin plantare: o
   cerere care sare peste verificarea din engine tot nu poate citi rândurile
   altei firme, iar una a lui god poate — fără să iasă pe conexiunea de
   superutilizator.
2. **Costul de plan e MĂSURAT pe o tabelă populată**, pentru amândouă căile:
   apelantul obișnuit și god. Scris în cifre, nu în adjective.
3. **Un singur god pe instanță, impus de bază.**
4. **Regulile de rând: ori aplicate în bază cu un cost măsurat, ori un motiv
   scris** de ce nu, care numește ce ar trebui să se schimbe ca să devină
   posibil. „Rămâne în engine" e un rezultat valid dacă e apărat cu cifre.

**CRITERIU DE OPRIRE:** dacă clauza de god costă calea OBIȘNUITĂ mai mult decât
**10%** din timpul unei listări paginate, nu se livrează în forma aceea. Costul
ar fi plătit de fiecare cerere ca să apere un caz rar, iar asta e o proastă
afacere indiferent cât de elegantă e ideea.

**Ce NU e criteriu:** să dispară verificările din engine. Prima linie rămâne
prima linie; asta adaugă a doua.

---

## Pași

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul ăsta | — | (la fiecare pas) |
| 1 | **Măsoară** costul clauzei de god pe predicatul existent | ✅ | trei forme măsurate; **cea elegantă costă de 7 ori** |
| 2 | Măsoară cele două forme pentru regulile de rând | ✅ | **13,2 ms față de 0,98 ms** — decisiv |
| 3 | Decide forma, în scris, pe baza cifrelor | ✅ | god: publicat din motor; reguli: politici generate |
| 4 | God în bază + un singur god, impus | ✅ | zero cost pe calea obișnuită |
| 5 | Regulile de rând — implementate sau refuzate motivat | ⬜ **RĂMÂNE** | măsurat și decis, neimplementat |
| 6 | **PUNCT DE VALIDARE** | ⚠️ **3 din 4** | criteriul 4 nu e îndeplinit, și nu-l rescriu |

---

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-31 | setup | Criterii fixate ÎNAINTE. Criteriu de oprire numeric (10% pe calea obișnuită), fiindcă tentația aici e să plătească toată lumea pentru un caz rar. |

---

## Context care nu trebuie re-descoperit

- **Forma predicatului decide planul.** `project_rls_plan_quality_2026_08_27`:
  415 → 204 ms doar din marcaj, iar forma scalară ajunge la 129. „Politicile nu
  pot folosi indexul" e FALS — s-a greșit de două ori, în direcții opuse.
- Motorul se conectează ca `postgres` (sare RLS) și pune `SET LOCAL ROLE
  zveltio_rls` în tranzacția cererii. Acolo se aplică politicile.
- `zveltio_visible_tenants()` citește `zveltio.visible_tenants`, apoi
  `zveltio.current_tenant`, apoi `zveltio.fail_closed_tenant`.
- `DEFAULT false` pe un overload rupe toate politicile la rulare — deja pățit.
- Bază proprie per sesiune; `zveltio_test` are lanț de migrații divergent.


---

## Pasul 1 — costul clauzei de god, măsurat (2026-08-31)

Bază proprie, 400 000 de rânduri în două firme reale, index compus
`(tenant_id, created_at DESC)`, listare paginată de 25. Mediane din 9 rulări.

| formă | calea obișnuită |
|---|---:|
| cum e azi | **0,060 ms** |
| `OR zveltio_is_god()` în față, în fiecare politică | 0,066 ms |
| `... OR (SELECT zveltio_is_god())` la coadă | 0,068 ms |
| **`zveltio_visible_tenants()` învățată să se extindă la toate firmele** | **0,434 ms** |

Ultima e forma **elegantă** — o singură funcție schimbată, 300+ politici o
moștenesc, nicio migrație pe politici. **Costă de șapte ori.** Cauza: subinterogarea
`ARRAY(SELECT id FROM zv_tenants)` face funcția neinlineabilă, deci nu mai e
pliată o dată la plan, ci chemată de-adevăratelea. Verificat și cu variabila
citită direct, fără apel imbricat: 0,428 ms. Nu apelul era problema, subinterogarea.

**Criteriul de oprire (10% pe o listare) o respinge.** Ar fi fost ușor de livrat
și greu de observat: 0,37 ms în plus pe fiecare cerere a fiecărei firme, ca să
apere un caz rar.

### Forma aleasă: motorul publică, baza aplică

Costă **zero**, fiindcă nu schimbă nimic pe calea obișnuită: motorul scria deja
`zveltio.visible_tenants` la fiecare cerere, într-un singur dus-întors cu
celelalte trei variabile. Pentru un god scrie toate firmele.

Ce se câștigă: god **nu mai iese** din RLS pe `poolDb`. Până acum privilegiul lui
nu era exprimat nicăieri — era o **portiță pe lângă** lucrul care exprimă
privilegii, iar un handler care își uita verificarea pe conexiunea aia citea
rândurile tuturor firmelor fără ca nimic din aval să poată observa.

Ce **nu** se câștigă, spus limpede: decizia „cine e god" rămâne a motorului.
Baza primește o afirmație de identitate, nu o autentifică — așa funcționează RLS
cu utilizatori de aplicație, mereu. Ce s-a schimbat e că **granița o aplică baza**,
pe aceeași cale ca pentru toți ceilalți.

---

## Pasul 2 — regulile de rând, măsurate

Regulă: `created_by eq user_id`. Două forme, aceleași date.

| | aplicația adaugă filtrul (calea normală) | **aplicația a UITAT filtrul** |
|---|---:|---:|
| fără regulă în bază | 6,53 ms | **0,068 ms — și SCURGE** |
| politici generate (predicat simplu) | 6,17 ms | **0,983 ms** |
| o politică generică, funcție per rând | 7,61 ms | **13,232 ms** |

Coloana a doua e singura care contează: e cazul pentru care există linia a doua.
**Funcția generică e de 13 ori mai scumpă exact acolo.** Politicile generate sunt
răspunsul, și pe calea normală nu costă nimic (6,17 față de 6,53 — sub zgomot).

Azi, în cazul acela, baza răspunde în 0,068 ms **cu rândurile greșite**.

---

## Pasul 4 — livrat

- **God publicat în `zveltio.visible_tenants`**, deci aplicat de politici.
  Dovedit prin plantare: un god vede două firme prin politică, un utilizator
  obișnuit una, o cerere fără utilizator numit — una. Și se întreabă baza direct
  ce consideră vizibil, ca proba să nu fie despre handler.
- **Un singur god pe instanță, impus de bază** (migrația 008, declanșator).
  **Nu index unic**, fiindcă acela ar pica migrația pe orice instalare care are
  deja doi — iar alegerea cui i se ia rolul nu e a unei migrații. Declanșatorul
  refuză un al doilea de acum înainte, iar instalările cu mai mulți primesc un
  avertisment și continuă să funcționeze.

### Trei consecințe pe care le-a scos la iveală invariantul

1. **248 de teste au picat** la prima rulare: harness-ul făcea un god per fișier.
   Acum îl coboară pe cel dinainte — modelează produsul, nu-l ocolește.
2. **Fluxul de recuperare adăuga un god.** Cu invariantul, s-ar fi refuzat singur
   exact în situația pentru care există. Acum **transferă** rolul: cine deține un
   jeton valid, necheltuit și rotit îl ia, iar rândul de audit o consemnează.
   Asta e ce înseamnă recuperare.
3. Două suite își făceau propriul god presupunând că pot fi mai mulți.

---

## Punct de validare — 3 din 4, blocul rămâne deschis

| # | Criteriu | Verdict |
|---|---|---|
| 1 | God exprimat în bază, nu printr-o portiță | ✅ dovedit prin plantare |
| 2 | Costul de plan măsurat, în cifre | ✅ trei forme; cea elegantă respinsă de propriul criteriu |
| 3 | Un singur god, impus de bază | ✅ declanșator, cu motivul pentru care nu e index unic |
| 4 | Regulile de rând: aplicate în bază, sau motiv scris | ⬜ **măsurate și decise, NEIMPLEMENTATE** |

**Criteriul 4 nu e îndeplinit și nu-l rescriu ca să încapă** — e exact ce am
refuzat să fac la blocul C. Măsurătoarea e făcută și forma e aleasă; ce rămâne e
munca: motorul să emită `CREATE POLICY` din `zvd_rls_policies` și să le țină în
pas cu regulile, inclusiv rolul apelantului într-o variabilă de sesiune.

**Măsurat:** harness 942/0, unit 2557/0, typecheck curat, lint curat,
`check-migration-safety` fără pericole pe 008.

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-31 | 1 | Forma elegantă costă de 7 ori. Respinsă de criteriul de oprire scris înainte. |
| 2026-08-31 | 2 | Funcția generică: 13,2 ms față de 0,98 ms exact în cazul care contează. |
| 2026-08-31 | 4 | Invariantul a picat 248 de teste și a scos la iveală că recuperarea adăuga un god în loc să-l transfere. |
| 2026-08-31 | 5–6 | 3/4. Criteriul 4 rămâne neîndeplinit, scris ca atare. |
