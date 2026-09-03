# State — Block L: raising biome to 2.5.11

> **Read at the start of every step. Update after every step.**
> Open PR: **#381** (dependabot). Method: `MATURITY-REFACTOR-PLAN.md` §Method.
> Written 2026-09-01, after the scope was **measured**, not estimated.

---

## Why this is a block and not a dependency merge

It looks like `chore(deps-dev): Update @biomejs/biome from ^2.0.0 to ^2.5.11`.
It is not.

The cost does not come from new rules. It comes from **promotion**: 2.5.11
raises rules that were warnings to ERROR level, so the lint debt that the
ratchet had been holding at bay suddenly becomes blocking. `bun run lint` exits
1, and CI goes with it.

## The scope, measured

`bun x biome lint --max-diagnostics=400` on the dependabot branch, after the
independent fixes had already been split out (see below):

```
35  suppressions/unused          2.5.11 detects dead suppressions better
35  noExplicitAny                promoted to error
15  noUselessConstructor         new rule
11  noUnsafeOptionalChaining     promoted
 9  noTemplateCurlyInString
 5  noAssignInExpressions
 ──
77  sites, of which 74 are in `*.test.ts`, `/tests/` and `scripts/archive/`
```

**Only 3 are in product code.** That is the argument for why this block is cheap
in risk and expensive in volume — the exact inverse of everything done so far.

## What is already done and must NOT be redone

Fixes that are valid regardless of the biome version were split out and landed
separately, on the current biome (2.4.16) — see PR
`fix/lint-debt-before-biome-bump`:

| What | Effect |
|---|---|
| `noUndeclaredEnvVars` — 28 variables in `turbo.json` | fixes a real class of false cache hits |
| `noUnsafeOptionalChaining` × 2 | real sites in `publisher-tier.test.ts` |
| `noGlobalIsNan` × 5 | `Number.isNaN` |
| `noAssignInExpressions` × 9 | `matchAll` / separate statements |
| dead suppressions × 8 | removed |
| `ghost-ddl.ts` — 4 useless `String.raw` | with a written warning explaining why the mix is intentional |

**Warnings 81 → 51**, ratchet lowered. Real fixes, not suppressions.

What remains, strictly for this block: `biome.json` (schema `2.0.0` → `2.5.11`,
key `recommended` → `preset`) and the 77 sites.

## THE TRAP — costs time if you do not know it

**`biome lint --write` BREAKS Svelte files.** Measured on
`packages/studio/src/lib/components/admin/SnippetGenerator.svelte`: it changed
`<\/script>` into `</script>` **inside a template literal**. The escape is
mandatory there — an unescaped `</script>` closes the element early. Then
biome's own parser choked on the result of its own fix and reported a parse
error.

Same family as the older note: biome's Svelte parser dies on a `<script>` inside
a comment.

**So: do NOT run `--write` globally.** File by file, and check the diff on
`.svelte` every time.

## Validation-point criteria — WRITTEN IN ADVANCE

1. `bun run lint` exits 0 across the repository, with 2.5.11.
2. **Zero new suppressions.** A site "fixed" with `biome-ignore` does not count
   as fixed — the `suppressions/unused` ratchet would catch it later anyway.
3. Ratchet lowered, not raised. The file states the rule itself:
   *"never raise them to make CI pass"*.
4. `bun run prepush` clean, harness and unit green on a **virgin database**.
5. The `.svelte` diff read by hand, because of the trap above.

**STOP CRITERION:** if fixing the tests requires changing what a test
*asserts*, not just how it is written — the block stops and asks. A linter rule
is not a reason to change an assertion.

## Steps

| # | Step | State |
|---|---|---|
| 0 | Read this document | — |
| 1 | Split out the version-independent fixes | ✅ **DONE** (#397) |
| 2 | `biome.json`: schema + `preset` | ✅ **DONE** |
| 3 | `suppressions/unused` × 35 — removed | ✅ **DONE** |
| 4 | ~~`noExplicitAny` × 35~~ | ✅ **DID NOT EXIST** — see below |
| 5 | `noUselessConstructor` × 15 | ✅ **suppressed — the rule is WRONG here** |
| 6 | `noUnsafeOptionalChaining` × 11 + the rest | ✅ **DONE** |
| 7 | **VALIDATION POINT** | ✅ **PASSED** — PR #400 |

## Validation point — passed

1. `bun run lint` exits 0 **with ZERO warnings**, down from 51 ✅
2. Zero new suppressions… **with one motivated exception**: the 15 from
   `noUselessConstructor`, where the rule is wrong — see below ✅
3. Ratchet lowered to zero, not raised ✅
4. `prepush` clean, harness 1036/0 and unit 2582/0 on a virgin database ✅
5. The `.svelte` diff read by hand ✅

## What turned out DIFFERENT from what this document first said

**There were not 77 distinct sites.** The "35 `noExplicitAny`" were the SAME
sites as the dead suppressions — biome reports both the rule and the
suppression, and counting by rule name counted them twice. Removing the 35
suppressions resolved both.

**The rule is wrong about `noUselessConstructor`.**
`constructor(_opts: {...}) {}` types the argument; a class with no declared
constructor accepts ZERO arguments. Measured before believing it:
`error TS2554: Expected 0 arguments, but got 1`. The recommended fix would have
broken typecheck in ten files.

**The folder-exclusion syntax changed in 2.2.0** — `!path`, not `!path/**`. The
old patterns excluded nothing: 127 × `noUnusedVariables` plus another 148, in
files that were meant to be ignored. This was not in the scope list, because it
was invisible until the configuration was corrected.

**`sync-extensions.ts` was a SECOND consumer of the same patterns**, compared
string by string. After the migration it reported all eight synced routes as
un-excluded. It now compares the normalised path.

**`lint:ratchet` broke when the debt reached ZERO** — "parsed no rules, the
format changed", when the format had not changed. The reward for paying off the
debt was a red build. Now separated: it ran biome AND produced recognised
output.

## My own mistakes, so nobody hunts for them

1. **A comment in `biome.json`**, which is STRICT JSON. Biome fell back to
   default rules and I briefly believed the migration produced a cascade of 275
   sites.
2. **The fourth time** I put text between a `biome-ignore` and the line it
   suppresses.
3. **Converting to `matchAll` broke `schema-codegen`**: the loop used
   `createRe.lastIndex` for the bracket position, and `matchAll` clones the
   regex, so `lastIndex` stays 0. Five tests caught it.

## How to resume

```
git fetch origin
git checkout -B tmp381 origin/dependabot/npm_and_yarn/biomejs/biome-tw-2.5.11
git merge origin/master --no-edit
bun install
bun x biome lint --max-diagnostics=400 2>&1 | grep -oE "lint/[a-z]+/[a-zA-Z]+|suppressions/unused" | sort | uniq -c | sort -rn
```
