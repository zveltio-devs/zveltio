# Hardening — Handoff / Progress Snapshot

> Written 2026-07-07 to hand this work off to a fresh Claude session (different
> account, no memory of the prior chat). Everything here is on the branch and PR
> below — `git pull` and you have all the context that matters. The authoritative
> backlog with full per-item detail is **`docs/HARDENING-9-PLAN.md`** (its Status
> column is kept current). This file is the 60-second orientation + the
> operational gotchas that aren't in the plan.

## Where the work lives

- **Branch:** `hardening/wave-1-gates` (pushed to `origin`).
- **PR:** #23 (draft) on `github.com/zveltio-devs/zveltio` — ~48 commits, **CI green**.
- **Not merged, not deployed.** Live `/opt/zveltio` is still on beta.28; none of
  this (nor the beta.29 IP-hostname fix) is deployed yet.

## Progress: H-01 … H-10 DONE · H-11 … H-16 TODO

| ID | Title | Status |
|----|-------|--------|
| H-01 | biome `noExplicitAny: error` + suppression ratchet | ✅ DONE — `scripts/any-ratchet.ts` + `refactoring/any-baseline.json` (per-bucket), wired into CI Lint. Baseline currently **1690**. |
| H-02 | Coverage measurement + CI ratchet | ✅ DONE — `scripts/coverage-gate.ts` + `refactoring/coverage-baseline.json`. Gates `lib/` line coverage; baseline **24%**, currently ~24.2%. |
| H-03 | Windows CI or WSL/Linux-only policy | ✅ DONE — soft docs policy (WSL is the test oracle; no Windows CI). |
| H-04 | Split `extension-loader.ts` god file + de-any | ✅ DONE — 1773→<500 L across `lib/extensions/*`. |
| H-05 | Split `data.ts` god file + de-any | ✅ DONE — 1734→63 L across `lib/data/*`. |
| H-06 | De-any approvals/insights/marketplace routes | ✅ DONE — 98→2. |
| H-07 | Split `admin.ts` + collections detail Svelte page | ✅ DONE — admin.ts 1347→244; collections page 1678→390 across 4 components + shared `types.ts`/`field-helpers.ts`. |
| H-08 | Subsystem boundaries in `lib/` + import-boundary check | ✅ DONE — `lib/` 67→26 flat files + 8 barrel-sealed subsystems (flows, security, runtime, data, extensions, tenancy). `scripts/import-boundaries.ts` enforces (in CI Lint). |
| H-09 | Adversarial multi-tenant suite over OpenAPI | ✅ DONE — `tests/integration/tenant-adversarial.integration.test.ts`. Seeds tenant B w/ sentinel, walks OpenAPI as tenant A, asserts no cross-tenant read/write. |
| H-10 | Property/fuzz: filter parser + field-type conversions | ✅ DONE — `fast-check@4.8.0` + `query-parse.property.test.ts` + `field-type-conversions.property.test.ts`. ~7,900 assertions. |
| **H-11** | **Upgrade-path test in CI** (🔴) | **TODO** — release N-1 binary → HEAD migration → smoke. New workflow `upgrade-path.yml`. Spec: HARDENING-9-PLAN.md §H-11. |
| **H-12** | **Tenant-scope extension `ctx.db`** (🔴) | **TODO** — the last known multi-tenant hole (extension DB handle isn't tenant-scoped). Highest security value. Spec: §H-12. |
| **H-13** | Unified error envelope (RFC 9457 problem+json) in SDK | TODO — §H-13. |
| **H-14** | Failure-injection integration tests (PG/registry/S3 down) | TODO — §H-14. |
| **H-15** | Nightly soak job with memory-monitor assertions | TODO — §H-15. |
| **H-16** | `scripts/release-gate.ts` — codified 3.0.0-stable criteria | TODO — §H-16. |

**Recommended next:** H-12 (close the ctx.db tenant hole — biggest security win) or
H-11 (upgrade safety). H-13→H-16 are lower urgency.

## How to work here (operational context)

- **WSL is the green test oracle.** Native-Windows `bun test` throws spurious
  EACCES on `node_modules/.bun` symlinks. Always run tests via WSL:
  `wsl bash -c "cd /mnt/c/Users/Liviu/zveltio-ecosystem/zveltio/packages/engine && bun test src/tests/unit"`
  → expect **427 pass / 0 fail** currently.
- **Integration / HTTP tests need a live engine + Postgres.** WSL has a cluster at
  `~/zvpg` (pg 18, port 5433, db `zveltio_test`, user `liviu`). Boot pattern is in
  `~/run-integration.sh` (and the adversarial one was run via a scratch
  `run-adv.sh`): start PG with `/usr/lib/postgresql/18/bin/pg_ctl -D ~/zvpg start`,
  export `DATABASE_URL=postgresql://liviu@localhost:5433/zveltio_test`,
  `TEST_DATABASE_URL=$DATABASE_URL`, `TEST_PORT=3099`,
  `BETTER_AUTH_SECRET=dev-secret-minimum-32-characters-long-xx`, start the engine
  `PORT=3099 bun packages/engine/src/index.ts &`, wait for `/api/health`, then run
  the test.
- **The gates (run before pushing):** `bun run lint` (biome + any-ratchet +
  import-boundaries + format:check), `bun run any:ratchet`, `bun run coverage:gate`
  (needs a fresh lcov: run `test:unit:coverage` in WSL first),
  `bun run scripts/import-boundaries.ts`. Engine typecheck: `cd packages/engine && bun run typecheck`.
- **CI reality:** `ci.yml` runs on `pull_request → master` (a feature-branch push
  alone does NOT trigger CI — the PR does). Jobs: Type Check, Lint, Unit,
  Integration (Postgres service), Perf Smoke, Studio build. Watch with
  `gh pr checks 23`.

## Gotchas already paid for (don't re-learn these)

1. **CRLF vs biome.** Windows working tree is CRLF; biome wants LF. `bun run
   format:check` fails locally on ~dozens of files that are actually fine (CI-Linux
   is LF and passes). Only trust format:check on committed content / via
   `git diff` (autocrlf hides the line-ending diff).
2. **`git status` rename trap when formatting.** `git status --short` prints
   `R old -> new` for renames; `awk '{print $2}'` grabs the OLD path → renamed
   files silently skip formatting → CI format:check fails. Use
   `git diff --name-only --diff-filter=ACMR` to list files to format.
3. **Dynamic-import gotcha.** When relocating a module, a static `from`-grep
   misses `await import('...')` sites. Always grep `import(` too — or just let
   `tsc --noEmit` enumerate every broken importer (it's exhaustive; the H-08
   codemods relied on this).
4. **Barrel `export *` eager-loads the whole subsystem** → inflates the unit
   coverage denominator → can fail coverage:gate on a pure move. Fix was real
   tests (H-10-style), not a re-baseline. Do NOT fold heavy modules
   (write-pipeline, handlers) into a barrel that ~40 files import — keep them deep
   and exempt the owning route in `import-boundaries.ts` (`OWNER_EXEMPTIONS`).
5. **Pipe exit-code lies:** `script | tail; echo $?` reports `tail`'s exit, not the
   script's. Use `${PIPESTATUS[0]}` or drop the pipe.
6. **New dep → commit `bun.lock`** or CI's `bun install --frozen-lockfile` fails.
7. **Superuser RLS bypass:** CI (and WSL) run the engine as a DB superuser, so
   Postgres RLS is bypassed. Tenant isolation still holds via app-level scoping +
   RBAC (that's what H-09 proves). The RLS-bound proof lives in
   `tenant-rls.integration.test.ts` under a `SET LOCAL ROLE` non-superuser.
8. **Studio build re-dirties `lib/ext/*`** via the extension-sync prebuild — if you
   see those modified after `bun run build`, it's that, not real work.

## Uncommitted, intentionally left alone

- Root `package.json` has a `studio:dev` convenience script + `messages/*.json`
  i18n (ANSVSA) — pre-existing, unrelated to hardening. Don't fold into hardening
  commits.
