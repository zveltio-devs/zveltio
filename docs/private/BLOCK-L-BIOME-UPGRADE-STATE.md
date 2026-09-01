# Stare — Blocul L: ridicarea biome la 2.5.11

> **Se citește la începutul fiecărui pas. Se actualizează după fiecare pas.**
> PR deschis: **#381** (dependabot). Metodă: `MATURITY-REFACTOR-PLAN.md` §Metoda.
> Scris 2026-09-01, după ce scopul a fost **măsurat**, nu estimat.

---

## De ce e bloc, și nu un merge de dependență

Arată ca `chore(deps-dev): Update @biomejs/biome from ^2.0.0 to ^2.5.11`. Nu e.

Costul nu-l dau regulile noi. Îl dă **promovarea**: 2.5.11 ridică la nivel de
EROARE reguli care erau avertismente, deci datoria de lint ținută sub control de
cremalieră devine dintr-odată blocantă. `bun run lint` iese 1, și cu el tot CI-ul.

## Scopul, măsurat

`bun x biome lint --max-diagnostics=400` pe ramura dependabot, după ce reparațiile
independente au fost deja scoase (vezi mai jos):

```
35  suppressions/unused          2.5.11 detectează mai bine suprimările moarte
35  noExplicitAny                promovat la eroare
15  noUselessConstructor         regulă nouă
11  noUnsafeOptionalChaining     promovat
 9  noTemplateCurlyInString
 5  noAssignInExpressions
 ──
77  situri, dintre care 74 în `*.test.ts`, `/tests/` și `scripts/archive/`
```

**Numai 3 sunt în cod de produs.** Asta e argumentul pentru care blocul e ieftin
ca risc și scump ca volum — exact inversul lucrurilor făcute până acum.

## Ce s-a făcut deja și NU mai trebuie refăcut

Reparațiile valide indiferent de versiunea de biome au fost desprinse și duse
separat, pe biome-ul actual (2.4.16) — vezi PR-ul `fix/lint-debt-before-biome-bump`:

| ce | efect |
|---|---|
| `noUndeclaredEnvVars` — 28 de variabile în `turbo.json` | repară o clasă reală de cache fals |
| `noUnsafeOptionalChaining` × 2 | situri reale în `publisher-tier.test.ts` |
| `noGlobalIsNan` × 5 | `Number.isNaN` |
| `noAssignInExpressions` × 9 | `matchAll` / instrucțiuni separate |
| suprimări moarte × 8 | scoase |
| `ghost-ddl.ts` — 4 `String.raw` inutile | cu avertisment scris de ce amestecul e intenționat |

**Avertismente 81 → 51**, cremalieră coborâtă. Reparații reale, nu suprimări.

Rămâne, strict pentru bloc: `biome.json` (schema `2.0.0` → `2.5.11`, cheia
`recommended` → `preset`) și cele 77 de situri.

## CAPCANA — costă timp dacă nu e știută

**`biome lint --write` STRICĂ fișiere Svelte.** Măsurat pe
`packages/studio/src/lib/components/admin/SnippetGenerator.svelte`: a schimbat
`<\/script>` în `</script>` **înăuntrul unui template literal**. Escape-ul e
obligatoriu acolo — un `</script>` neescapat închide elementul devreme. Apoi
propriul parser al biome s-a înecat în rezultatul propriei reparații și a
raportat o eroare de parsare.

Din aceeași familie cu nota veche: parserul Svelte al biome moare la `<script>`
într-un comentariu.

**Deci: NU rula `--write` global.** Fișier cu fișier, și verifică diff-ul pe
`.svelte` de fiecare dată.

## Criteriile punctului de validare — SCRISE ÎNAINTE

1. `bun run lint` iese 0 pe tot repo-ul, cu 2.5.11.
2. **Zero suprimări noi.** Un sit reparat prin `biome-ignore` nu contează ca
   reparat — cremaliera `suppressions/unused` l-ar prinde oricum mai târziu.
3. Cremaliera coborâtă, nu ridicată. Fișierul spune singur regula:
   *„never raise them to make CI pass"*.
4. `bun run prepush` curat, harness și unitare verzi pe **bază virgină**.
5. Diff-ul pe `.svelte` citit manual, din cauza capcanei de mai sus.

**CRITERIU DE OPRIRE:** dacă reparațiile din teste cer schimbarea a ceea ce
TESTEAZĂ un test, nu doar cum e scris — blocul se oprește și întreabă. O regulă
de linter nu e un motiv să schimbi o aserțiune.

## Pași

| # | pas | stare |
|---|---|---|
| 0 | Citește documentul ăsta | — |
| 1 | Desprinde reparațiile independente de versiune | ✅ **FĂCUT** |
| 2 | `biome.json`: schema + `preset` | ✅ **FĂCUT** (pe ramura #381) |
| 3 | `suppressions/unused` × 35 — scoase, nu rescrise | DE FĂCUT |
| 4 | `noExplicitAny` × 35 — tipuri reale unde se poate, altfel motivate | DE FĂCUT |
| 5 | `noUselessConstructor` × 15 — auto-reparabile, în teste | DE FĂCUT |
| 6 | `noUnsafeOptionalChaining` × 11 + restul | DE FĂCUT |
| 7 | **PUNCT DE VALIDARE** | DE FĂCUT |

## Cum se reia

```
git fetch origin
git checkout -B tmp381 origin/dependabot/npm_and_yarn/biomejs/biome-tw-2.5.11
git merge origin/master --no-edit
bun install
bun x biome lint --max-diagnostics=400 2>&1 | grep -oE "lint/[a-z]+/[a-zA-Z]+|suppressions/unused" | sort | uniq -c | sort -rn
```
