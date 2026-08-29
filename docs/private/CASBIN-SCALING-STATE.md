# Stare — scalarea autorizării Casbin

> **Se citește la începutul fiecărui pas. Se actualizează după fiecare pas.**
> Branch: `perf/casbin-scaling` · pornit din `422377b2` (3.0.0-beta.64)
> Metodă: blocuri de 5–7 pași, cu punct de validare între blocuri.
> Regula care le guvernează pe toate: **nu se construiește nimic înainte ca o
> măsurătoare să arate că merită.** Un bloc are voie să se încheie cu „nu merită".

---

## De ce există branch-ul ăsta

Auditul din 27–29 august a redus o decizie de autorizare de la 364–885 ms la 4,7 ms
rece și 0,115 ms cald. Asta a rezolvat **latența unei verificări**.

Ce n-a rezolvat, și ce am clasificat greșit ca „nu mai e pe calea critică":
**rezolvarea scalează cu mărimea instanței.**

| Politici `p` | Rezolvare rece per (utilizator, firmă) |
|---|---|
| 7 208 | 4,70 ms |
| 23 978 | **9,96 ms** |

Cauza structurală, măsurată: **toate cele 23 978 de reguli `p` au `dom = '*'`.**
Niciuna nu e legată de o firmă. Deci rezolvarea fiecărui utilizator parcurge
politicile întregii instanțe — colecțiile tuturor firmelor plus toate resursele de
extensii. 5 957 de resurse distincte în instanța de măsurare.

Extrapolat: 100 de firme × 20 de colecții ⇒ zeci de mii de reguli, iar prima
verificare a fiecărui utilizator în fereastra de TTL le parcurge pe toate.

**Taxa asta crește cu succesul produsului.** Taxa de tranzacție (0,19 ms per cerere)
e constantă. Pentru un „Business OS multi-tenant", asta e plafonul care contează.

---

## Blocul 1 — MĂSURARE. Nu se scrie cod de producție.

| # | Pas | Stare | Rezultat |
|---|---|---|---|
| 0 | Citește documentul ăsta | — | (la fiecare pas) |
| 1 | Banc de scalare controlat pe bază proprie `zv_casbin` | ✅ **FĂCUT** | vezi §Curba |
| 2 | Curba rezolvării — formă, nu două puncte | ✅ **FĂCUT** | **liniară, ușor supra-liniară** |
| 3 | Fezabilitatea `loadFilteredPolicy` cu enforcer singleton partajat între firme | **ÎN LUCRU** | |
| 4 | Ce s-ar rupe dacă regulile `p` ar fi legate de domeniu în loc de `dom='*'` | DE FĂCUT | |
| 5 | Creșterea regulilor `g` (958 acum) cu utilizatori × firme | DE FĂCUT | |
| 6 | **PUNCT DE VALIDARE** — vezi criteriile de mai jos | DE FĂCUT | |

### Criteriile punctului de validare (scrise ÎNAINTE de măsurare)

Blocul 2 se deschide **doar dacă** cel puțin una dintre condiții e adevărată:

- Curba e cel puțin liniară în numărul de politici **și** o cale identificată o
  reduce la sub-liniar sau la constant per firmă.
- `loadFilteredPolicy` e fezabil fără a rupe semantica multi-firmă a enforcer-ului
  singleton.

Dacă niciuna nu e adevărată: **blocul 2 nu se deschide.** Se scrie concluzia aici și
se raportează. Un „nu merită" măsurat e un rezultat, nu un eșec.

### Ce NU se atinge în blocul 1

Cod de producție. Politica RLS. Enforcer-ul. Nimic din `packages/engine/src` în
afară de fișiere de măsurare aruncate după.

### Curba (pașii 1–2, măsurat 2026-08-29)

Bancul imită forma reală: politici pe ROL, una per (rol, resursă, acțiune), toate
`dom='*'`. În instanța de audit: `tenant_member` × 3 acțiuni + `tenant_viewer` × 1,
peste 6 161 de resurse = 24 644 de reguli.

| Resurse | Politici | Rezolvare (cu rol) | Rezolvare (fără rol) |
|---|---|---|---|
| 1 500 | 6 000 | 3,57 ms | 1,17 ms |
| 3 000 | 12 000 | 7,26 ms | 2,50 ms |
| 6 000 | 24 000 | 16,32 ms | 7,01 ms |
| 12 000 | 48 000 | 28,50 ms | 10,70 ms |
| 24 000 | 96 000 | **62,33 ms** | 26,55 ms |

**De 16× mai multe politici ⇒ de 17,5× mai mult timp.** Liniar, ușor supra-liniar.

Extrapolat la 1 000 de firme × 24 de colecții: **62 ms** pentru fiecare rezolvare
(utilizator, firmă), plătită la prima verificare din fiecare fereastră de TTL de 60 s.

Cazul „fără rol" e mai ieftin dar crește la fel — și el e cazul refuzului, adică cel
pe care îl cere un atacator.

**Prima jumătate a criteriului de validare e îndeplinită:** curba e cel puțin
liniară. Rămâne de arătat că există o cale care o reduce.

---

## Blocul 2 — (se definește abia după validarea blocului 1)

---

## Jurnal

| Când | Pas | Ce s-a întâmplat |
|---|---|---|
| 2026-08-29 | setup | Branch creat din `422377b2`. Document de stare scris. Blocul 1 definit cu criterii de validare stabilite înainte de măsurare. |
| 2026-08-29 | 1–2 | Banc pe bază proprie `zv_casbin`, cinci puncte de măsurare. Curba e liniară: 6 000 → 96 000 de politici mută rezolvarea de la 3,57 la 62,33 ms. Prima jumătate a criteriului e îndeplinită. |

---

## Context care nu trebuie re-descoperit

- **Mediul:** worktree izolat `/home/liviu/zveltio-audit-ba/zveltio`, bază proprie
  `zv_audit_ba`, port `:3400`. Ocupate de alții: `:3000`, `:3200`, `:3201`, `:3300`.
- **Env fără de care testele mint:** `ZVELTIO_REGISTRATION_ENABLED=1`,
  `FIELD_ENCRYPTION_KEY=<64 hex>`, `TEST_PORT`, `TEST_DATABASE_URL` **pe linie
  separată** (`export A=1 B=$A` expandează `$A` înainte de atribuire).
- **Nu contamina baza de măsurare.** `pg_stat_statements` adaugă coloane `rows`,
  `calls`, `wal_*` în `public` și lărgește corpusul porții numerice.
- **CI ≠ local.** De patru ori în auditul precedent, un test a trecut local și a
  picat în CI: suita `unit` rulează fără bază de date; suita partajează procesul,
  deci un fișier anterior poate lăsa un cache în urmă; primul rând din `user` poate
  fi contul god, iar `checkPermission` iese pe scurtătură înainte de memo.
- **Casbin:** modelul e `r = sub, dom, obj, act`; `dom` e firma. Obiectele se compară
  prin **egalitate simplă**, fără `keyMatch`. `getImplicitRolesForUser` e de
  încredere; `getImplicitPermissionsForUser` **NU** — filtrează pe domeniu exact și
  întoarce zero pentru un `tenant_admin`, fiindcă regulile `p` au `dom='*'`.
