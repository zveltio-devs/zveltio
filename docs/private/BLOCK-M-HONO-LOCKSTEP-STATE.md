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

## PASUL 1, FĂCUT — și răstoarnă calculul: 4.13.5 e o versiune de SECURITATE

Criteriul de oprire spunea „dacă 4.13.5 nu aduce nimic necesar, închide cu «nu
merită»". Nu se activează. `v4.13.5` conține trei avize:

| aviz | ne atinge? |
|---|---|
| parserul de query citește parametri DUPĂ fragmentul URL — diferențe de interpretare între aplicație și proxy/WAF (GHSA-crvj-82cr-hjcx) | **DA, prin forma de instalare** |
| `toSSG()` scrie în afara directorului de ieșire (GHSA-gqvv-2mrq-wpjv) | nu — `toSSG` nefolosit |
| `parseBody()` cu notație cu puncte → epuizare de memorie (GHSA-g6gw-c38x-mqfc) | nu — `parseBody` nefolosit |

Verificat prin grep în cod scris de noi: **niciun `hono/cache`, niciun `toSSG`,
niciun `parseBody`**. Dar primul aviz spune „*și aplicații în spatele unui proxy,
WAF sau strat de jurnalizare care inspectează query-ul*" — care e exact forma
self-hosted a Zveltio, iar `?filter=` și `?as_of=` sunt parametri pe care se iau
decizii de acces.

**Deci blocul se face.**

## CONSTATARE DE SISTEM — mai mare decât blocul

O reparație de securitate într-o dependență INCLUSĂ nu ajunge nicăieri unde e
inclusă, și **nicio poartă nu observă**.

`hono` e încorporat în trei locuri:

```
node_modules                                        se ridică la bump          ✅
packages/engine/src/lib/worker-extension-runtime-source.generated.ts   inline   ❌
57 × <ext>/engine/index.js                                             inline   ❌
```

Ambele porți de prospețime — `check-worker-source-fresh.ts` și
`check-bundle-sources.ts` — hașuiează **SURSA**, nu dependențele, și spun asta în
propriile comentarii. Sunt corecte pentru ce au fost scrise (o editare de sursă
care n-a fost repachetată), dar oarbe la un bump de dependență.

Consecința: după merge pe #373, motorul rulează hono 4.13.5, iar runtime-ul de
worker și cele 57 de extensii rulează 4.13.3 — **cu problema de parsare a
query-ului** — până când cineva regenerează și repachetează. Fără niciun semnal.

Asta ridică repack-ul din „decizie de igienă" în „parte din reparația de
securitate", și e argumentul care lipsea când documentul a fost scris prima dată.

**Poartă nouă — FĂCUTĂ:** `scripts/check-embedded-deps-fresh.ts` compară
versiunea dependenței INCLUSE în fiecare artefact generat cu `bun.lock`, citind
comentariile de cale lăsate de bundler — deci ce a intrat efectiv, nu ce declară
un manifest. 45 de artefacte acoperite; dovedită prin plantare, `audit:gates`
41/41.

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
| 1 | Citește ce e între 4.13.3 și 4.13.5 — decide dacă merită | ✅ **FĂCUT** — versiune de SECURITATE, se face |
| 2 | Merge #373 în motor (CI deja verde) | DE FĂCUT |
| 3 | Ridică pin-ul la `"hono": "4.13.5"` în extensii, verifică poarta + typecheck | DE FĂCUT |
| 3b | **Regenerează runtime-ul de worker** — include hono inline | DE FĂCUT |
| 4 | **Decizie de proprietar:** repack | ✅ **DA** — argument de securitate |
| 5 | Repack + bump de versiuni | ✅ **FĂCUT** — 44 de bundle-uri, toate pe 4.13.5 |
| 6 | Poarta care închide clasa | ✅ **FĂCUT** — `check-embedded-deps-fresh` |
| 7 | **PUNCT DE VALIDARE** | ✅ **TRECUT** — vezi mai jos |

## Punct de validare — trecut

1. `check-dep-lockstep` verde în extensii ✅
2. `typecheck` verde în extensii ✅ — plus un defect PREEXISTENT reparat pe drum
   (shim-ul `bun` nu declara `SQL`, folosit de `pool-autosize.ts` al motorului)
3. CI verde în ambele repouri, motorul întâi ✅
4. Fiecare extensie repachetată are versiune ridicată ✅ — 44 de patch-uri

**Măsurat, înainte și după:**

```
înainte:  hono@4.13.3 în majoritatea bundle-urilor
          hono@4.12.28 în auth/saml, compliance/gdpr, data/export
după:     hono@4.13.5 peste tot — singura versiune rămasă
```

**Capcana care a costat două încercări:** primul repack a produs tot 4.13.3.
`node_modules` al extensiilor avea 4.13.5, dar bundler-ul rezolvă prin cel al
MOTORULUI, unde se făcuse `git pull` fără `bun install`. Verifică artefactul, nu
ieșirea comenzii — `pack` a spus „✓ complete" în ambele cazuri.

## Capcane cunoscute

- Poarta citește `../zveltio/bun.lock` — calea e **relativă la repo-ul de
  extensii**, deci sora trebuie clonată alături și trebuie să fie versiunea
  ridicată, nu un worktree vechi. Un worktree pe alt commit dă un verde fals.
- Ordinea contează: motorul întâi. Invers, poarta din extensii compară cu un lock
  care încă are versiunea veche și pică pe bună dreptate.
