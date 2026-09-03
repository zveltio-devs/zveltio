# State — Block M: raising `hono` in lockstep with the extensions

> **Read at the start of every step. Update after every step.**
> Open PR: **#373** (dependabot, `hono ^4.13.3 → ^4.13.5`), CI green on the engine.
> Written 2026-09-01, with the scope measured in both repositories.

---

## Why it cannot be merged on its own

`hono` is one of the seven dependencies the extensions must pin **exactly**, and
which must match the engine's `bun.lock`:

```ts
// zveltio-extensions/scripts/check-dep-lockstep.ts
const LOCKSTEP_DEPS = ['kysely', 'hono', 'zod', '@hono/zod-validator', 'aws4fetch', 'pg', 'typescript'];
```

The reason is written into the gate: the extensions repository ignores
`bun.lock` deliberately, so CI resolves dependencies fresh from npm. TypeScript
deduplicates two copies of a package **only on an exact match** — a divergence
makes the two classes nominally incompatible (`#private`) and floods typecheck
with ~77 cryptic errors in unrelated extensions. **It has happened twice**,
`2026-07-08` and `2026-07-17`, the second time because `kysely 0.29.4` was
published hours after a green run.

So: merging #373 without the extensions-side move ⇒ red CI in the extensions.

## The state, measured

```
zveltio-extensions/package.json   "hono": "4.13.3"     exact pin
zveltio/bun.lock                  hono@4.13.3
#373 brings                       hono@4.13.5
```

Gate run just now: `✓ @hono/zod-validator 0.9.0 == engine`, `✓ pg`,
`✓ typescript` — all in lockstep. Nothing broken today.

## The three consequences — which is mandatory and which is not

The old note says a dependency bump has THREE consequences in the extensions.
Measured now, only one is forced by a gate:

| # | Consequence | Forced? |
|---|---|---|
| 1 | exact pin raised in `zveltio-extensions/package.json` | **YES** — `check-dep-lockstep` |
| 2 | repack of the bundles that embed hono | **NO** — see below |
| 3 | version bump for every repacked extension | only if 2 is done |

**hono is EMBEDDED in the bundles, not referenced** — measured: `class Hono`
appears twice in a 699 KB bundle (`analytics/dashboard/engine/index.js`), and 76
files import it directly. So without a repack, the 57 extensions run hono 4.13.3
inline while the engine runs 4.13.5.

But the gate that guards freshness, `check-bundle-sources.ts`, hashes the
**SOURCE**, not the dependencies — and its comment says why: repacking for a
byte comparison would fail for reasons unrelated to the author, because the
bundler's output is not stable across Bun versions.

**So the repack is a DECISION, not an obligation.** What it buys: real parity
between engine and extensions. What it costs: 57 repacks and 57 version bumps,
because the registry refuses the same bytes at the same version.

## STEP 1, DONE — and it overturns the calculation: 4.13.5 is a SECURITY release

The stop criterion said "if 4.13.5 brings nothing we need, close with 'not worth
it'". It does not trigger. `v4.13.5` carries three advisories:

| Advisory | Does it touch us? |
|---|---|
| the query parser reads parameters AFTER the URL fragment — interpretation differences between application and proxy/WAF (GHSA-crvj-82cr-hjcx) | **YES, through the deployment shape** |
| `toSSG()` writes outside the output directory (GHSA-gqvv-2mrq-wpjv) | no — `toSSG` unused |
| `parseBody()` with dot notation → memory exhaustion (GHSA-g6gw-c38x-mqfc) | no — `parseBody` unused |

Verified by grep across code we wrote: **no `hono/cache`, no `toSSG`, no
`parseBody`**. But the first advisory says "*and applications behind a proxy, WAF
or logging layer that inspects the query*" — which is exactly Zveltio's
self-hosted shape, and `?filter=` and `?as_of=` are parameters that access
decisions are made on.

**So the block goes ahead.**

## SYSTEMIC FINDING — larger than the block

A security fix in an EMBEDDED dependency reaches nowhere it is embedded, and
**no gate notices**.

`hono` is embedded in three places:

```
node_modules                                        rises with the bump        ✅
packages/engine/src/lib/worker-extension-runtime-source.generated.ts   inline   ❌
57 × <ext>/engine/index.js                                             inline   ❌
```

Both freshness gates — `check-worker-source-fresh.ts` and
`check-bundle-sources.ts` — hash the **SOURCE**, not the dependencies, and say
so in their own comments. They are correct for what they were written for (a
source edit that was not repacked), but blind to a dependency bump.

The consequence: after #373 merges, the engine runs hono 4.13.5 while the worker
runtime and the 57 extensions run 4.13.3 — **with the query-parsing issue** —
until somebody regenerates and repacks. With no signal at all.

That lifts the repack from "hygiene decision" to "part of the security fix", and
it is the argument that was missing when this document was first written.

**New gate — DONE:** `scripts/check-embedded-deps-fresh.ts` compares the version
of the EMBEDDED dependency in every generated artifact against `bun.lock`,
reading the path comments the bundler leaves behind — so, what actually went in,
not what a manifest declares. 45 artifacts covered; proved by planting,
`audit:gates` 41/41.

## Validation-point criteria — WRITTEN IN ADVANCE

1. `bun run scripts/check-dep-lockstep.ts` green in the extensions, with the new
   pin.
2. `bun run typecheck` green in the extensions — **this is the test that
   matters**, because a version divergence surfaces exactly there, as TS2345.
3. CI green in BOTH repositories, in this order: engine first, extensions after.
4. If a repack is done: every touched extension has its version raised, and
   `check-bundle-sources` stays green.

**STOP CRITERION:** if `4.13.5` brings nothing we need, the block may close with
"not worth it" — a hono patch does not on its own justify 57 repacks. Check
hono's CHANGELOG between 4.13.3 and 4.13.5 BEFORE step 3.

## Steps

| # | Step | State |
|---|---|---|
| 0 | Read this document | — |
| 1 | Read what is between 4.13.3 and 4.13.5 — decide whether it is worth it | ✅ **DONE** — SECURITY release, going ahead |
| 2 | Merge #373 into the engine (CI already green) | TO DO |
| 3 | Raise the pin to `"hono": "4.13.5"` in the extensions, check the gate + typecheck | TO DO |
| 3b | **Regenerate the worker runtime** — it embeds hono inline | TO DO |
| 4 | **Owner decision:** repack | ✅ **YES** — security argument |
| 5 | Repack + version bumps | ✅ **DONE** — 44 bundles, all on 4.13.5 |
| 6 | The gate that closes the class | ✅ **DONE** — `check-embedded-deps-fresh` |
| 7 | **VALIDATION POINT** | ✅ **PASSED** — see below |

## Validation point — passed

1. `check-dep-lockstep` green in the extensions ✅
2. `typecheck` green in the extensions ✅ — plus a PRE-EXISTING defect fixed on
   the way (the `bun` shim did not declare `SQL`, used by the engine's
   `pool-autosize.ts`)
3. CI green in both repositories, engine first ✅
4. Every repacked extension has its version raised ✅ — 44 patches

**Measured, before and after:**

```
before:  hono@4.13.3 in most bundles
         hono@4.12.28 in auth/saml, compliance/gdpr, data/export
after:   hono@4.13.5 everywhere — the only version left
```

**The trap that cost two attempts:** the first repack produced 4.13.3 again. The
extensions' `node_modules` had 4.13.5, but the bundler resolves through the
ENGINE's, where a `git pull` had happened without `bun install`. Check the
artifact, not the command's output — `pack` said "✓ complete" both times.

## Known traps

- The gate reads `../zveltio/bun.lock` — the path is **relative to the
  extensions repository**, so the sibling must be cloned alongside and must be
  the raised version, not an old worktree. A worktree on another commit gives a
  false green.
- Order matters: engine first. The other way round, the extensions gate compares
  against a lock that still has the old version and fails, correctly.
