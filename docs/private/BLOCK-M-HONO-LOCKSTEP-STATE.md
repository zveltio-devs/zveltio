# Stare — Blocul M: ridicarea `hono` în lockstep cu extensiile

> **Se citește la începutul fiecărui pas. Se actualizează după fiecare pas.**
> PR deschis: **#373** (dependabot, `hono ^4.13.3 → ^4.13.5`), CI verde pe motor.
> Scris 2026-09-01, cu scopul măsurat în ambele repouri.

---

## De ce nu se poate merge singur

`hono` e una dintre cele șapte dependențe pe care extensiile trebuie să le
pinuiască **exact** și care trebuie să corespundă cu `bun.lock` al motorului:

```ts
// zveltio-extensions/scripts/check-dep-lockstep.ts
const LOCKSTEP_DEPS = ['kysely', 'hono', 'zod', '@hono/zod-validator', 'aws4fetch', 'pg', 'typescript'];
```

Motivul e scris în poartă: repo-ul de extensii ignoră `bun.lock` dinadins, deci
CI-ul rezolvă dependențele proaspăt de la npm. TypeScript deduplică două copii
ale unui pachet **numai la potrivire exactă** — o divergență face cele două clase
nominal incompatibile (`#private`) și inundă typecheck-ul cu ~77 de erori
criptice în extensii fără legătură. **S-a întâmplat de două ori**, `2026-07-08` și
`2026-07-17`, a doua oară fiindcă `kysely 0.29.4` s-a publicat la ore după o
rulare verde.

Deci: merge pe #373 fără mișcarea din extensii ⇒ CI-ul extensiilor roșu.

## Starea, măsurată

```
zveltio-extensions/package.json   "hono": "4.13.3"     pin exact
zveltio/bun.lock                  hono@4.13.3
#373 aduce                        hono@4.13.5
```

Poarta rulată acum: `✓ @hono/zod-validator 0.9.0 == engine`, `✓ pg`, `✓ typescript`
— toate în lockstep. Nimic rupt azi.

## Cele trei consecințe — care e obligatorie și care nu

Nota veche spune că un dep-bump are TREI consecințe în extensii. Măsurate acum,
una singură e forțată de o poartă:

| # | consecință | forțată? |
|---|---|---|
| 1 | pin exact ridicat în `zveltio-extensions/package.json` | **DA** — `check-dep-lockstep` |
| 2 | repack la bundle-urile care includ hono | **NU** — vezi mai jos |
| 3 | bump de versiune pentru fiecare extensie repachetată | doar dacă se face 2 |

**hono e INCLUS în bundle-uri, nu referit** — măsurat: `class Hono` apare de două
ori într-un bundle de 699 KB (`analytics/dashboard/engine/index.js`), iar 76 de
fișiere îl importă direct. Deci fără repack, cele 57 de extensii rulează cu hono
4.13.3 inline, în timp ce motorul rulează 4.13.5.

Dar poarta care păzește prospețimea, `check-bundle-sources.ts`, hașuiește
**SURSA**, nu dependențele — și spune în comentariu de ce: reîmpachetarea pentru
comparație de octeți ar pica din motive care n-au legătură cu autorul, fiindcă
ieșirea bundler-ului nu e stabilă între versiuni de Bun.

**Deci repack-ul e o DECIZIE, nu o obligație.** Ce se câștigă: paritate reală
între motor și extensii. Ce costă: 57 de repack-uri și 57 de bump-uri de versiune,
fiindcă registry-ul refuză aceiași octeți la aceeași versiune.

## Criteriile punctului de validare — SCRISE ÎNAINTE

1. `bun run scripts/check-dep-lockstep.ts` verde în extensii, cu noul pin.
2. `bun run typecheck` verde în extensii — **acesta e testul care contează**,
   fiindcă divergența de versiune se manifestă exact acolo, prin TS2345.
3. CI verde în AMBELE repouri, în ordinea: motor întâi, extensii după.
4. Dacă se face repack: fiecare extensie atinsă are versiune ridicată, iar
   `check-bundle-sources` rămâne verde.

**CRITERIU DE OPRIRE:** dacă `4.13.5` nu aduce nimic de care avem nevoie, blocul
poate să se închidă cu „nu merită" — un patch de hono nu justifică singur 57 de
repack-uri. Verifică CHANGELOG-ul lui hono între 4.13.3 și 4.13.5 ÎNAINTE de
pasul 3.

## Pași

| # | pas | stare |
|---|---|---|
| 0 | Citește documentul ăsta | — |
| 1 | Citește ce e între 4.13.3 și 4.13.5 — decide dacă merită | DE FĂCUT |
| 2 | Merge #373 în motor (CI deja verde) | DE FĂCUT |
| 3 | Ridică pin-ul la `"hono": "4.13.5"` în extensii, verifică poarta + typecheck | DE FĂCUT |
| 4 | **Decizie de proprietar:** repack sau nu | DE FĂCUT |
| 5 | Dacă da: repack + bump de versiuni, câte un tur de CI | DE FĂCUT |
| 6 | **PUNCT DE VALIDARE** | DE FĂCUT |

## Capcane cunoscute

- Poarta citește `../zveltio/bun.lock` — calea e **relativă la repo-ul de
  extensii**, deci sora trebuie clonată alături și trebuie să fie versiunea
  ridicată, nu un worktree vechi. Un worktree pe alt commit dă un verde fals.
- Ordinea contează: motorul întâi. Invers, poarta din extensii compară cu un lock
  care încă are versiunea veche și pică pe bună dreptate.
