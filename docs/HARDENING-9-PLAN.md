# Zveltio Hardening Plan — Path to 9/10 Engineering

> **Status**: Draft 2026-07-04 · **Owner**: platform-team · **Target**: 3.0.0 stable gate
>
> This document is the canonical hardening backlog that takes the platform from
> "very good for its age" to "a sceptical senior engineer finds nothing to
> object to after a full day of audit". It contains **no new features** — only
> type-safety, decomposition, test-depth, and reliability work. It is intended
> to be executed by Claude Code instances (or human developers) over multiple
> sessions. Each work item is self-contained: problem, change, files, and
> acceptance criteria.
>
> **How to use this document**:
> 1. Read *Context* for the measured baseline this plan was written against.
> 2. Pick a work item from the *Backlog* table, respecting the wave order —
>    Wave 1 items install the gates that keep later waves honest.
> 3. Implement by following the linked section. Do **not** skip acceptance
>    criteria.
> 4. Update the *Status* column when done. Do **not** delete completed items —
>    leave a `DONE (commit: <sha>)` marker so future sessions know history.
> 5. Each item is sized for a single Claude session (0.5–2 days). If you hit
>    scope creep, split into sub-items rather than blowing past the bounds.
> 6. **Zero behaviour change** is the default contract for every item unless
>    the item explicitly says otherwise. Existing integration tests are the
>    safety net — they must stay green.

---

## Context — measured baseline (2026-07-04, 3.0.0-beta.29)

> **Current state (2026-07-08, after H-01…H-16 + follow-ups):** all 16 items DONE; the numbers below are the ORIGINAL wave-1 baseline kept for the before/after record. Now: the 801 raw `any` are frozen behind a ratchet at **1690 suppressions** (0 new); every god-file is split (`extension-loader` 1773→422, `data.ts` 1734→54, `admin.ts` 1320→244; `openapi.ts` 1133→~1192 is the one that GREW, via H-13 — still a split candidate); **57 unit test files / ~573 tests**; engine `lib/` line coverage measured + ratcheted at **30.5%** (target 60%). See the Backlog table for per-item status.

Verified with commands, not estimated:

- ~120,000 lines of TS/Svelte across 566 tracked source files, 7 workspace
  packages. Engine: 39 route files, 70 flat modules in `src/lib/`, ~20 runtime
  dependencies (lean — keep it that way).
- `tsc --noEmit` on the engine passes clean; `strict: true` is on.
- **801 explicit `any` escapes** in engine non-test code: 384 `: any`
  annotations + 417 `as any` casts. Hotspots (count of `as any`):
  `lib/extension-loader.ts` (27), `lib/extension-marketplace-routes.ts` (25),
  `routes/data.ts` (23), `routes/insights.ts` (22), `routes/approvals.ts` (21).
- **God files**: `lib/extension-loader.ts` 1,773 lines, `routes/data.ts` 1,734,
  `routes/admin.ts` 1,320, `routes/openapi.ts` 1,133,
  `studio/src/routes/(admin)/collections/[name]/+page.svelte` 1,636.
- Tests: 66 files, ~10,100 lines (≈8% of product LOC). Unit suite:
  348 pass. Integration suite (22 files) runs in CI against real Postgres.
  **No coverage measurement exists anywhere.**
- CI (`.github/workflows/ci.yml`): typecheck, lint, unit, integration
  (Postgres service), perf-smoke. Plus `dr-smoke.yml` (weekly DR drill) and
  `migrate-safety.yml`. **No Windows runner** — unit tests currently fail on
  a Windows host with EACCES on `node_modules/.bun` junctions.
- Known architectural gap carried from the multi-tenant review: extension
  `ctx.db` is not tenant-scoped (Casbin domains + membership landed in
  migrations 008/009; the extension DB handle is the remaining hole).

The plan sequences 16 items into 5 waves. Waves 1–2 are the bulk of the
score improvement; waves 3–5 are what makes the score *defensible*.

---

## Backlog (wave order)

| ID | Title | Wave | Effort | Status |
|----|-------|------|--------|--------|
| H-01 | Biome `noExplicitAny: error` + suppression ratchet in CI | 1 | 0.5d | DONE (uncommitted) — rule flipped to `error`; codemod `scripts/suppress-existing-any.ts` froze 1931 legacy violations behind suppressions across 263 files (0 test files); ratchet `scripts/any-ratchet.ts` + `refactoring/any-baseline.json` (per-bucket) wired into CI lint job + `prepush`; shared scope in `scripts/lib/any-targets.ts`. |
| H-02 | Coverage measurement + CI ratchet | 1 | 0.5d | DONE (uncommitted) — `scripts/coverage-gate.ts` + `refactoring/coverage-baseline.json`; engine `lib/` line coverage measured **49%** (target 60%), gated in CI unit-tests job with `--coverage` lcov + `$GITHUB_STEP_SUMMARY` output. **Scope deviation (documented):** only `lib/` is line-gated, not `routes/` — integration tests drive a separately-spawned engine over HTTP, so route handlers run out-of-process and are invisible to `bun test` coverage. Routes stay gated by the integration HTTP contract + future H-09 suite. |
| H-03 | Windows CI job — or officially declare WSL/Linux-only | 1 | 0.5d | DONE (uncommitted) — chose **soft docs policy** (owner decision): "Supported platforms" table in `README.md` + "Supported & tested surface" note in `docs/SECURITY.md`. Deploy = Linux/macOS (only binaries built + CI-tested); dev = Linux/macOS/WSL2; native Windows = edit OK, run tests in WSL (Bun `.bun` symlink `EACCES` is a toolchain quirk, not a bug). **No** Windows CI job and **no** runtime/install nag — owner develops on native Windows daily. |
| H-04 | Split + de-`any` `extension-loader.ts` (manifest type from JSON schema) | 2 | 2d | DONE — **manifest cluster DONE** (6245aef) + **migration-runner DONE**: `ExtensionManifest` from `z.infer<ManifestSchema>` (deviation from json-schema-to-ts: the Zod validator is the real enforced contract), `manifest` typed, latent null-safety fixed. Migration runner: added real `down_sql` col to `ZvMigrationsTable` in `schema.ts`, removed all `zv_migrations` `as any`, replaced `(trx as any).executeQuery({sql})` with idiomatic `_sql.raw(sql).execute(trx)` (verified multi-statement raw works vs a real Postgres). + **ExtensionInternals DONE** (2877044): fields typed as `typeof <helper>`, casts dropped; `sendNotification` kept loose via `unknown` params (SDK contract, H-13). + **`loadExtension` decomposition DONE** (5/n): extracted `lib/extensions/manifest-schema.ts` (175 L — `ManifestSchema`, `ExtensionManifest`, `ManifestMeta`, `embedPageSchemas`; re-exported from the loader) to break the helper↔loader import cycle, then split the ~600-line `loadExtension` body into 3 pure phase helpers in `lib/extensions/load-phases.ts` (455 L — `resolveManifest`, `enforcePublisherTier`, `resolveEntryPath`). Phases are `this`-free + log-free; each failure returns an explicit `{ logLevel, logArgs, lastLoadError }` result the caller replays verbatim (no magic-string routing) → **zero behaviour change** (byte-identical log strings, error messages, early-return order). `loadExtension` body dropped ~600→~180 L; loader file 1596→**1192 L**. Both new modules < 500 L. Verified green: tsc 0, WSL 404 pass / 0 fail, real engine boot (health ok, `Extensions loaded: none` + cron started, no errors). + **de-`any` DONE** (f5a9933, 6/n): loader 15→**1** marker (survivor = `ctx.auth: any`, better-auth deep generic, documented). Removed stale `zv_extension_registry` casts (table already typed); Hono `reqDb`/`handler` → `Context`; `app[method]` dispatch via a `HonoRouteFn` index; cron `s as ExtensionSchedule`; wasm-handle + `regErr`/`body` typed. Engine any 896→**847**. + **internals extracted** (7/n): `ExtensionContext`/`ExtensionInternals`/`buildExtensionInternals` (+ its ~16 helper imports) → `lib/extensions/internals.ts` (148 L, re-exported). Loader **1192→1070 L**. All verified green (tsc/WSL 404-0/boot/lint/ratchet). + **SIZE tail DONE** (8/n): extracted the loader's imperative core into 4 new `lib/extensions/` modules, all `this`-free / loader-state-passed via a TYPE-ONLY `import type { ExtensionLoader }` (no runtime cycle); the class methods are thin delegators so all ~12 external call sites are unchanged. `register.ts` (299 L — shared `buildRestrictedContext` + `registerExtensionRoutes` + `finalizeExtensionLoad` + `reRegisterExtension`; the shared ctx-builder removes the biggest duplication: `loadExtension` register-core and `reRegisterExtension` both built it), `load.ts` (282 L — the full `loadExtension` pipeline: dir resolution, Studio-only short-circuit, the 3 validation phases, WASM-or-import, migrations/field-types, then finalize), `lifecycle.ts` (156 L — `unloadExtension`/`loadDynamic`/`reloadExtensionFromDisk`), `discovery.ts` (92 L — `topoSortExtensions`/`getActiveExtensionNames`/`discoverExternal`). **Zero behaviour change** (byte-identical console.* strings, error messages, branch order incl. the matcher-already-built swallow, cron registration, every state write). Loader **1070→465 L (< 500 TARGET MET)**; all 5 `lib/extensions/` split modules < 500. Verified green: tsc 0, WSL 404 pass / 0 fail (unmodified tests), real engine boot (health ok, `Extensions loaded: none` + cron started, no errors), `bun run lint` 0. **All H-04 acceptance criteria now MET.** (Note: `any:ratchet` engine 846→847 and `coverage:gate` lib 49%→23.9% are **pre-existing** red on branch HEAD 34b0f8b — identical before/after this work; this refactor adds zero `any` suppressions and is coverage-neutral.) |
| H-05 | Split + de-`any` `routes/data.ts` (typed `DynamicRow` + Zod boundary) | 2 | 2d | DONE — `data.ts` 1795→63 L; `any` 60→2 (better-auth survivors); 8 modules under `lib/data/` (types/shape/query-parse/write-pipeline/auth + handlers/{list,bulk,single}); integration contract 42/0 unmodified, unit 404/0, lint clean, ratchet lowered, coverage steady. |
| H-06 | De-`any` `extension-marketplace-routes.ts`, `insights.ts`, `approvals.ts` | 2 | 1d | DONE — combined markers **98 → 2** (well under ≤10 target; the 2 survivors are the documented better-auth `auth: any` in approvals + insights). Levers: (a) most casts were stale table/row casts — `zv_approval_*`/`zv_settings`/`zv_extension_registry` are already typed, and rows come from `selectAll`/`returningAll`, so `(x as any).field` and `.selectFrom('t' as any)` just dropped; (b) insights' 21× `c.get('user') as any` → typed Hono `Variables` env (one `InsightsEnv` type); (c) Hono `c: Context`, `catch (err: unknown)`, `onConflict((oc) => …)` inferred, request/response bodies → `Record<string, unknown>`/typed; (d) added `ZvLicenseAuditTable` to `schema.ts` (real cols, verified vs live DB) + fixed `ZvExtensionRegistryTable` accuracy (`category`/`version` → `Generated`, `author` → nullable) so the enable-all insert types without a cast. Engine any 789→**693**. Verified: tsc 0, WSL unit 404/0, integration contract 42/0, schema-drift-check 0, lint/coverage green. |
| H-07 | Split `routes/admin.ts` and the collections detail Svelte page | 2 | 1.5d | **DONE** (both halves). **Engine** (2188981, 1/2): `routes/admin.ts` **1347→244 L** — `adminRoutes()` body cut along its section seams into `routes/admin/{system-routes(565),permission-routes(310),config-routes(299)}.ts` (register-fn pattern, same call order → byte-identical paths). All <600. Verified: tsc 0, WSL 404/0, engine boot mounts every group, gates green. **Studio** (e7a03ca + 608c2bd, 2/2): `collections/[name]/+page.svelte` **1678→390 L**, decomposed into `lib/components/collections/`: `RecordDrawer.svelte` (367, create/edit slide-over), `CollectionDataTable.svelte` (438, owns records+pagination+search/sort/selection+realtime), `CollectionSchemaPanel.svelte` (588, owns fields+relation-builder+system-fields), `field-helpers.ts` (55, shared pure display helpers). Page keeps canonical collection/relations state; children coordinate via bind:this refs (openCreate/openEdit, openAddField/openRelForm, reload) + callback props (onSaved/onSchemaChanged). All <600. Verified LIVE (dev server + preview, auth'd seeded `contacts`): both tabs render; New Record→save→dataTable.reload() and Add Field→onSchemaChanged→reloadSchema→prop round-trips both hold (Svelte 5 prop-down reactivity, which svelte-check can't catch); svelte-check adds 0 errors in any collections file. |
| H-08 | Subsystem boundaries in `lib/` + import-boundary check | 2 | 1d | **DONE** (7cc729b + 6 subsystem commits). `engine/src/lib` 67 flat → 26 + 8 subsystem dirs; `flows`/`security`/`runtime`/`data`/`extensions`/`tenancy` each barrel-sealed via `index.ts`. `scripts/import-boundaries.ts` (git ls-files walk, auto-detects subsystems, resolves static+dynamic imports) wired into CI Lint — fails on any non-test deep import into a subsystem; verified 0 violations + a negative test. Pure moves; tsc 0, WSL unit 427/0. Coverage dip from barrel eager-load offset by new field-type-conversions + validation-engine tests (22.9%→24.6%). |
| H-09 | Adversarial multi-tenant suite parametrized over the OpenAPI spec | 3 | 1.5d | **DONE** (8dd9885). `tenant-adversarial.integration.test.ts`: seeds tenant B with an unguessable sentinel, then as a non-god user in tenant A walks the live `/api/openapi.json`, substitutes B ids into every fillable route, and asserts B's sentinel never appears in A's responses + B's data record is never 2xx'd or mutated. Explicit justified ALLOWLIST (health/openapi/sitemap/metrics/auth); every other route isolates or the build fails. Verified live (WSL+PG): 3/3 pass, 32 routes checked / 22 skipped-with-reason. Runs in CI integration (`test:integration` globs the dir), ~2s. **Caveats vs plan:** ~59% route coverage not ≥90% (non-data `{id}`/`{channel}`/`{keyPrefix}` params aren't type-fillable from B — all logged); engine runs as DB superuser in CI so RLS is bypassed — isolation held anyway via app-level tenant scoping + RBAC, but the RLS-bound proof stays in tenant-rls.test (non-superuser role). |
| H-10 | Property/fuzz tests: filter parser + field-type conversions | 3 | 1d | **DONE** (2588d32). fast-check@4.8.0 dev-dep + two suites: query-parse.property.test.ts (parseFilters never throws; emitted ops &#8712; canonical set + fields &#8712; allowlist = no operator/column injection; JSON round-trip; unknown field = typed 400. decodeCursor never throws, null-or-{id,val}, round-trips). field-type-conversions.property.test.ts (resolveConversion never throws; well-formed result, sqlType pass-through, column always quoted in USING; identical + relation types refused). ~7,900 assertions, <1s, in CI unit job. No counterexamples. |
| H-11 | Upgrade-path test in CI (release N-1 binary → HEAD migration → smoke) | 3 | 1d | **DONE** (PR #25) — new `.github/workflows/upgrade-path.yml` (on migration/engine PRs + nightly + dispatch): boots the latest published release binary, seeds a collection (text/number/boolean/json/date) + records with sentinels + a webhook + a flow via the public API, stops it, builds HEAD, boots HEAD against the SAME Postgres (auto-migrate), then asserts every seeded value reads back byte-for-byte, the auth session still signs in, and `/api/health` is green. Reverse guard: HEAD's migration `sql/` must be a strict superset of the release tag's (filename + sha256) — fails on any rename/renumber/delete. Reusable `scripts/upgrade-smoke.ts` (seed/verify, HTTP-only; seed records what N-1 actually returns so serialization coercion isn't a false positive). Runbook note added to `docs/DISASTER-RECOVERY.md` Scenario A. Verified locally (WSL+PG, non-superuser role): seed→verify green end-to-end; superset guard green vs `v3.0.0-beta.29`. |
| H-12 | Tenant-scope extension `ctx.db` (close the last multi-tenant hole) | 4 | 1.5d | **DONE** (PR #24) — `ctx.db` now resolves the current request/job tenant transaction via the ALS (`setCurrentTenantTrx`/`getCurrentTenantTrx` in `tenant-context.ts`, set by `middleware/tenant.ts`), so its queries run under the tenant GUC + FORCE RLS; falls back to the global pool only outside a tenant context (boot/migrations). `createRestrictedDb` takes a resolver `() => Database` (resolves per query). Capability-gated escape hatch `ctx.adminDb` (global pool) present only when the manifest declares `db:admin`; otherwise `createDeniedAdminDb` throws. SDK `extension/index.ts` (contract source of truth) documents both. New `extension-ctx-db-isolation.integration.test.ts` proves on real non-superuser PG: ctx.db under a tenant-A request sees only A's rows, WITH CHECK blocks forging tenant B, adminDb-without-capability throws (4/4). Audited all bundled + external extensions (none call `.transaction()` on ctx.db, none do intentional cross-tenant ctx.db reads → pure defense-in-depth). Live-booted non-superuser engine: cross-tenant read as a non-member → 403 at the membership gate. Dev guide tenancy section updated. **Caveat vs plan:** the `/ext/*` cross-tenant case in H-09's HTTP suite is deferred (needs the CI live-engine harness); the dedicated integration test is the targeted proof. |
| H-13 | Unified error envelope (RFC 9457 problem+json) defined in the SDK | 4 | 2d | **DONE** (PR #26) — SDK `errors.ts` is the contract (`ProblemDetails` + `ZveltioApiError` with a tolerant `fromResponse`/`fromParts` for legacy `{error}` during beta); exported from the SDK root; `client.ts` throws typed errors. Engine `lib/problem.ts` mirrors the type + a `problem(code,status,detail)` helper (`ProblemException`), an `onError` renderer, and a **scoped `problemNormalizer()`** mounted on `/api/*`+`/ext/*` that rewraps ANY returned non-2xx (legacy `c.json({error})`, plain 404, zValidator body) into the envelope with an inferred `code` — so every non-2xx conforms WITHOUT touching hundreds of call sites. Rich stable code adopted at the tenant-membership 403 (`tenant.membership_required`). Unhandled throws → generic 500 (no leak; logged server-side with traceId). OpenAPI `Error` schema upgraded to the envelope + common-codes list, error responses → `application/problem+json`. Studio `api.ts` reads `detail`/`code`/`traceId`. Proof: in-process Hono test (`problem-envelope.test.ts`, 7/7 — legacy/plain/zod/thrown/generic all envelope, no leak) + live spec-walk (`error-envelope.integration.test.ts`, 14 non-2xx GETs all problem+json). No existing test asserted the old body shape (dev-reload uses a bare sub-router; the one `.error` in sync is a per-item batch status). CHANGELOG + `MIGRATION-ALPHA-TO-BETA.md` note the breaking-ish change. **Deferred:** mechanical per-route adoption of `problem()` for richer codes (normalizer covers correctness; rich codes added incrementally). |
| H-14 | Failure-injection integration tests (Postgres/registry/S3 down) | 5 | 1.5d | **DONE** (PR #27) — `failure-injection.integration.test.ts` + `fixtures/fault-injection.ts`, all three with EXACT mid-flight injection + state assertions (not just the error): **S1** a multi-statement write is held open via `pg_sleep` and its backend is `pg_terminate_backend`'d from a 2nd connection mid-write → the txn rejects, **no partial row** survives (full rollback), a fresh connection serves traffic (DB recovers, no restart). Uses a raw `Bun.SQL({max:1})` victim so no Kysely pool wrapper masks the fault. **S2** spawns a fault engine (`REGISTRY_URL`→a mock that serves the catalog but 500s the tarball download — the real "down mid-install") → install returns a typed non-2xx error, **no orphan `zv_extension_registry` row**, `pg_advisory_xact_lock` released so a **retry proceeds** (downloadHits>1). **S3** spawns a fault engine (`S3_ENDPOINT` at a dead port) → upload → 5xx, **no orphan `zv_media_files` row** (the metadata insert only runs after a successful PUT). Verified locally on non-superuser WSL PG: 3/3 pass. Runs under the CI integration job (superuser PG → terminate + zv_* reads work). No bug found — the no-orphan invariants are structural (insert-after-success ordering); tests pin them. |
| H-15 | Nightly soak job with memory-monitor assertions | 5 | 1d | **DONE** (PR #28) — `.github/workflows/soak.yml` (nightly + `workflow_dispatch` with a `minutes` input) boots PG+engine, seeds a god admin, drives `SOAK_MINUTES` (default 60) of mixed CRUD/get/list/patch with bounded delete churn (`bench/soak.ts`, reusing the `bench/` HTTP drivers + `percentile`), samples RSS every 30s from the **existing** `/metrics` `zveltio_memory_rss_bytes` gauge, and uploads the RSS/latency timeseries as an artifact. Asserts: RSS slope over the final 30 min (scaled for short runs) < 1 MB/min, **zero unhandled rejections**, and p95 late-window <= 1.5x the early window. Verified locally with a 2-min run on WSL PG: 9 samples, RSS 203->213MB (slope -9.5 MB/min = no leak), p95 12->11ms, 0 unhandled, exit 0. No engine change needed — `/metrics` already exposes RSS. **No leak found** on the first run; the nightly 60-min run is the real detector. |
| H-16 | `scripts/release-gate.ts` — codified criteria for cutting 3.0.0 stable | 5 | 0.5d | **DONE** (PR #29) — `scripts/release-gate.ts`: prerelease tags (`-alpha/-beta/-rc.`) BYPASS with a warning; a STABLE tag must pass all checks or exit non-zero. Checks: any-ratchet at baseline (H-01); gated coverage buckets meet stable target — `lib` >= 60% (H-02); HEAD migrations a strict superset of the last release tag (no renumber, reuses H-11); `package.json` == tag; required CI green on the RC commit via `gh api .../check-runs` (Type Check/Lint/Unit/Integration[incl. H-09 adversarial + H-14]/Perf); latest soak green via `gh run list` (H-15); no open `P0` issues. Wired into `release.yml` as job `release-gate` with `publish-release` `needs: [generate-assets, release-gate]` (self-bypasses beta, so current publishes are unaffected). `docs/VERSIONING.md` documents the two rules: versions are never renumbered; stable means the gate passed. Verified locally: beta bypass exit 0; forced `3.0.0` correctly BLOCKS (coverage 24<60 + version mismatch) with the deterministic checks passing and the `gh` paths executing cleanly. |

Total: ~19 days of focused work. Wave order matters: H-01/H-02 install the
ratchets **before** the big refactors so regressions are impossible, and the
splits (H-04/H-05) happen **together with** their de-`any` work so files are
touched once, not twice.

---

## Wave 1 — Gates first

### H-01 Biome `noExplicitAny: error` + suppression ratchet 🔴

**Problem.** 801 explicit `any` escapes in engine non-test code, concentrated
in the most security-critical modules. `strict: true` is already on, so every
one of these is a deliberate opt-out. Nothing stops the count from growing.

**Change.**
1. In `biome.json`, set `suspicious/noExplicitAny` to `error` (it is currently
   not enforced at error level for the engine).
2. Write a one-shot codemod script (`scripts/suppress-existing-any.ts`) that
   inserts `// biome-ignore lint/suspicious/noExplicitAny: legacy — see docs/HARDENING-9-PLAN.md H-01`
   above every existing violation. Run it once; commit the result.
3. Add `scripts/any-ratchet.ts`: counts `biome-ignore.*noExplicitAny` across
   `packages/*/src`, compares against a checked-in baseline file
   (`refactoring/any-baseline.json`, per-package counts). Fails if any count
   **increased**; auto-suggests lowering the baseline when counts decrease.
4. Wire the ratchet into `.github/workflows/ci.yml` (lint job) and into the
   root `prepush` script.

**Files.** `biome.json`, `scripts/suppress-existing-any.ts` (new),
`scripts/any-ratchet.ts` (new), `refactoring/any-baseline.json` (new),
`.github/workflows/ci.yml`, root `package.json`.

**Acceptance criteria.**
- [x] `bun run lint` fails on a newly introduced bare `any` in any package.
      (Verified: bare `any` → exit 1, `Found 1 error`, `lint/suspicious/noExplicitAny`.)
- [x] CI fails if the suppression count for any package rises above baseline.
      (Verified: a new suppression → `any-ratchet` exit 1, `cli: 47 → 48 (+1)`.)
- [x] Baseline file committed with the real current counts. Measured **1931**
      total (engine 896, studio 780, sdk 164, cli 47, client 12, sdk-vue 10,
      sdk-react 6, scripts 13, other/bench 3) — biome's `noExplicitAny` catches
      more `any` positions than the earlier `as any`+`: any` grep (~801).
- [x] `tsc --noEmit` green (engine exit 0) and unit suite unchanged
      (348 pass; the 7 fails are the pre-existing Windows `.bun` EACCES env
      issue tracked in H-03, not H-01). Zero behaviour change — the only
      non-comment edit was one `any`→`Record<string, unknown>` in
      `cli/src/commands/extension-validate.ts` where a multiline-ternary
      violation could not be cleanly suppressed.

**Implementation notes for future waves.**
- `scripts/lib/any-targets.ts` is the single source of truth for "files where
  `noExplicitAny` is enforced" (non-test, non-generated). Both the codemod and
  the ratchet import it. If you change the exclusions in `biome.json`, mirror
  them there.
- As H-04..H-06 delete `any`, the corresponding suppression comments vanish;
  run `bun run any:ratchet --update` and commit the lowered baseline. The
  ratchet prints the drop and tells you to do this.
- `bun run any:ratchet --verify` guards against anyone flipping the rule back
  to `off`.

---

### H-02 Coverage measurement + CI ratchet 🔴

**Problem.** ~10k test LOC against 120k product LOC and **no coverage number
anywhere** — test depth is a guess, and nothing protects it from eroding.

**Change.**
1. Enable `bun test --coverage` for the engine unit + integration suites
   (bun supports lcov via `--coverage-reporter=lcov` — verify against the
   pinned bun version and use text reporter as fallback).
2. Add `scripts/coverage-gate.ts`: parses the summary, compares line coverage
   for `packages/engine/src/lib` and `packages/engine/src/routes` against a
   committed baseline (`refactoring/coverage-baseline.json`). Fail on drop
   > 0.5pt; print the new number so raising the baseline is a one-line PR.
3. Wire into CI after the integration-tests job (integration coverage counts —
   most route code is only exercised there).
4. Record the initial measured number in this document under H-02 status.

**Files.** `packages/engine/package.json` (test scripts),
`scripts/coverage-gate.ts` (new), `refactoring/coverage-baseline.json` (new),
`.github/workflows/ci.yml`.

**Acceptance criteria.**
- [x] CI publishes a coverage number on every PR — the unit-tests job runs
      `test:unit:coverage` and writes the bucket table to `$GITHUB_STEP_SUMMARY`.
- [x] CI fails when engine `lib/` line coverage drops > 0.5pt below baseline.
      (Verified: bumping baseline lib to 60 → `coverage-gate` exit 1,
      `lib: 60% → 49% (dropped 11.0pt)`.) **`routes/` is measured but NOT
      line-gated** — see the scope deviation below; gating it would enforce ~0%
      because route handlers run in a separately-spawned engine process.
- [x] Baseline committed with the real measured value — `lib` **49.0%**
      (1643/3355 lines over the 18 lib files the unit suite loads). Not guessed.
- [x] Medium-term target recorded: **60% on engine `lib/`** (`target.lib` in the
      baseline; printed each run, not yet enforced). The ratchet forbids
      regression; waves H-04..H-06 + new unit tests raise it toward 60%, then
      `coverage-gate --update` lifts the baseline.

**Scope deviation (deliberate, review before extending).** The plan assumed
"integration coverage counts". It does not with the current harness: the
`integration-tests` job starts the engine as a child process
(`bun packages/engine/src/index.ts &`) and exercises it via curl, so
`bun test --coverage` (which profiles the *test* process) never sees route
handlers. Options considered:
  1. Gate `routes/` anyway → enforces ~0%, pure noise. Rejected.
  2. Rewrite the integration suite to mount the Hono app in-process
     (supertest-style) so routes are instrumented → real, but a substantial
     harness change, out of a 0.5d item. Deferred; revisit alongside H-14.
Chosen: gate `lib/` (genuinely unit-tested, in-process), measure+print the
rest. `scripts/coverage-gate.ts`'s header documents this so the next reader
does not "fix" it by gating routes.

**Denominator caveat.** lcov only lists files loaded during the run, so 49% is
"of the lib lines the unit suite exercises" — the ~52 lib files no unit test
imports are invisible, not counted as 0%. Adding unit tests that import more lib
modules will make the number more honest (and may dip it before it climbs);
that is expected and the 0.5pt tolerance + `--update` flow handles it.

---

### H-03 Windows CI job — or declare WSL/Linux-only 🟠

**Problem.** The product claims "self-hosted, own your hardware", but unit
tests fail on a real Windows host (EACCES reading `node_modules/.bun/*`
junctions) and no CI job covers Windows. Untested promises are the expensive
kind.

**Change.** Decide, then enforce — either branch is acceptable:
- **(a) Support it**: add a `unit-tests-windows` job on `windows-latest`
  (checkout → setup-bun → `bun install --frozen-lockfile` → SDK build →
  `bun test src/tests/unit` in the engine). Fix whatever the junction/EACCES
  issue turns out to be (likely stale `.bun` store — a fresh install in CI
  will tell). Mark the job `continue-on-error: false` once green.
- **(b) Don't**: add a "Supported platforms" section to `README.md` and
  `docs/SECURITY.md` stating Linux/macOS/WSL only, and make `install/install.sh`
  + the engine entrypoint print a clear warning on `process.platform === 'win32'`.

**Files.** `.github/workflows/ci.yml` (a) or `README.md`, `install/`,
`packages/engine/src/index.ts` (b).

**Acceptance criteria.**
- [x] Platform policy stated unambiguously — no "third state". Resolved via the
      **soft-docs** branch (owner chose this over both a Windows CI job and a
      runtime nag): `README.md` "Supported platforms" matrix + `docs/SECURITY.md`
      "Supported & tested surface" note. Deploy surface = Linux/macOS (the only
      built + CI-tested targets); dev = Linux/macOS/WSL2; native-Windows tests →
      run under WSL. No `install.sh`/engine `win32` warning, by explicit owner
      decision (they develop on native Windows), which supersedes the original
      branch-(b) "warn at runtime" wording above.

---

## Wave 2 — Decomposition + type safety (touch each file once)

### H-04 Split + de-`any` `extension-loader.ts` 🔴

**Problem.** 1,773 lines and 27 `as any` casts in the module that downloads,
verifies, and executes third-party code. Auditing it requires holding the whole
file in your head; the casts sit exactly where a type error becomes a sandbox
escape.

**Change.**
1. Create `packages/engine/src/lib/extensions/` and split by lifecycle:
   - `manifest.ts` — manifest resolution + validation. Generate the
     `ExtensionManifest` type **from** `docs/manifest-v2.schema.json` using
     `json-schema-to-ts` (dev-dep only, type-level — zero runtime cost) so the
     schema stays the single source of truth.
   - `shims.ts` — the `installExtensionShims()` Bun.plugin machinery.
   - `sandbox-wiring.ts` — capability policy + sandbox setup (the existing
     `extension-sandbox.ts` stays; this is the loader-side glue).
   - `lifecycle.ts` — install / enable / disable / uninstall orchestration
     (advisory locks, signature verify calls, migration runner invocation).
   - `index.ts` — public API, re-exporting exactly what the rest of the engine
     imports today (grep call-sites first; keep signatures identical).
2. While each block moves, remove its `as any` casts: type the manifest, type
   the loaded-module shape (`ZveltioExtension` from the SDK is already the
   contract), type the migration entries.
3. Delete the corresponding H-01 suppression comments as casts disappear; the
   ratchet baseline goes down.

**Files.** `packages/engine/src/lib/extension-loader.ts` →
`packages/engine/src/lib/extensions/*` (new), all import sites (grep
`from './extension-loader'` / `from '../lib/extension-loader'`),
`docs/manifest-v2.schema.json` (read-only source of truth).

**Acceptance criteria.**
- [x] No file in `lib/extensions/` exceeds ~500 lines — split modules
      `manifest-schema.ts` (175), `load-phases.ts` (455), `internals.ts` (148),
      `migration-runner.ts`, `npm-install.ts`, plus the SIZE-tail extractions
      `register.ts` (299), `load.ts` (282), `lifecycle.ts` (156),
      `discovery.ts` (92) are all under. **The loader itself is now 465 L
      (< 500 target MET).**
- [x] `as any` count in the loader code drops from 27 to ≤ 5 — **`extension-loader.ts`
      now has 0 `any` markers**. The lone documented survivor (`ctx.auth: any`,
      better-auth deep generic) moved with the context types to
      `lib/extensions/internals.ts`, where it carries its one-line justification.
- [x] `ExtensionManifest` is derived from the runtime Zod validator
      (`z.infer<ManifestSchema>`) rather than the JSON schema — a stronger
      single-source guarantee, since the Zod schema is what actually runs at
      load time. Documented deviation; changing `ManifestSchema` changes the type.
- [x] All existing unit tests pass unmodified (extension-loader-archive,
      extension-lock, extension-sandbox, signature-verify, peer-deps-allowlist,
      third-party-isolation-enforcement) — 404 pass / 0 fail in WSL, no test
      edits. Real engine boot green. Zero HTTP or SDK contract change.

---

### H-05 Split + de-`any` `routes/data.ts` ✅

**Problem.** 1,795 lines and 60 `any` suppressions in the CRUD core — the
single hottest path in the product. Filter parsing, write hooks, response
shaping and routing were interleaved, and rows flowed through as untyped blobs.

**Change (DONE).** Created `packages/engine/src/lib/data/`:
   - `types.ts` (67 L) — boundary types `JsonValue` / `DynamicRow` +
     `RequestUser`, `CollectionDef`, `CollectionField`, `ExpandTarget`
     (extracted first to break the helper↔routes import cycle).
   - `shape.ts` (178 L) — `serializeRecord` / `resolveExpand` / `applyExpand` /
     `computeEtag` + `normalizeFields`, typed with `DynamicRow`.
   - `query-parse.ts` (157 L) — `QuerySchema` / `ParsedQuery`, `buildAllowedCols`,
     `parseFilters` (bracket + JSON), `decodeCursor`. Pure, unit-testable.
   - `write-pipeline.ts` (388 L) — `processInput`, `mapPgError`/`handlePgErrors`,
     `afterWrite`, `broadcastWebhook`, `getVirtualConfig`, plus the centralizing
     helpers `getDb` / `getTenantId` / `dynamicDb` (one documented `DynamicDB`
     escape hatch for runtime-resolved dynamic tables) / `runAtomic` / `isUuid`.
   - `auth.ts` (127 L) — `authenticate` + `checkAccess`.
   - `handlers/list.ts` (306 L), `handlers/bulk.ts` (286 L),
     `handlers/single.ts` (483 L) — the route handler bodies, each a
     `(c, db[, query])` function.
   Rows are typed `DynamicRow` past the parse boundary; the field-type registry
   validates/serializes at that boundary (no cast past it). `routes/data.ts`
   shrank to **63 lines** — auth middleware + thin route wiring that delegates
   to the handler modules.

**Files.** `packages/engine/src/routes/data.ts`,
`packages/engine/src/lib/data/*` (new).

**Acceptance criteria.**
- [x] `routes/data.ts` ≤ 350 lines — **63 lines** (from 1,795). No new module
      exceeds ~500 (largest: `handlers/single.ts` at 483).
- [x] `any` in the data path drops to ≤ 3 — **2 documented survivors**, both the
      better-auth instance (`authenticate(auth)` + `dataRoutes(auth)`), no
      exported type; mirrors the extension-loader's documented survivor.
- [x] `crud.integration.test.ts`, `cursor-pagination.integration.test.ts`,
      `etag.integration.test.ts`, `relations.integration.test.ts`,
      `revisions.integration.test.ts`, `tenant-rls.integration.test.ts` all
      pass **unmodified** — 42/42 green after every step.
- [x] No accidental N+1 introduced — expansion still one query per relation;
      unit 404/0, lint clean, coverage gate OK (lib 24%, unchanged).

---

### H-06 De-`any` marketplace routes, insights, approvals 🟠

**Problem.** The next three hotspots: `extension-marketplace-routes.ts` (25),
`routes/insights.ts` (22), `routes/approvals.ts` (21). No structural split
needed — sizes are tolerable — just typing.

**Change.** For each file: identify the untyped seams (usually Kysely results
on dynamic tables, registry API responses, and Hono context stuffing), define
interface types next to the module (or reuse SDK types where the shape is a
public contract), replace casts, delete H-01 suppressions.

**Files.** `packages/engine/src/lib/extension-marketplace-routes.ts`,
`packages/engine/src/routes/insights.ts`,
`packages/engine/src/routes/approvals.ts`.

**Acceptance criteria.**
- [ ] Combined `as any` across the three files drops from 68 to ≤ 10.
- [ ] Registry response shapes are typed once (shared with
      `extension-download.ts` / `extension-registry.ts` if they duplicate them).
- [ ] Unit + integration suites green; ratchet baseline lowered.

---

### H-07 Split `routes/admin.ts` and the collections detail page ✅

**Problem.** `routes/admin.ts` is 1,320 lines of unrelated admin concerns;
`studio/src/routes/(admin)/collections/[name]/+page.svelte` is 1,636 lines
mixing field editing, data grid, and relation management in one component.

**Change.**
1. Engine: split `routes/admin.ts` by concern into `routes/admin/` (e.g.
   `stats.ts`, `maintenance.ts`, `config.ts` — read the file and cut along its
   natural comment-section seams; keep the mounted paths byte-identical).
2. Studio: extract from the collections page three components under
   `packages/studio/src/lib/components/collections/`:
   `FieldEditor.svelte`, `CollectionDataTable.svelte`, `RelationPanel.svelte`.
   Svelte 5 runes (`$state`/`$derived`/`$props`) — follow existing component
   conventions in `packages/studio/src/lib/components/`.

**Files.** `packages/engine/src/routes/admin.ts` → `routes/admin/*`,
`packages/studio/src/routes/(admin)/collections/[name]/+page.svelte`,
`packages/studio/src/lib/components/collections/*` (new).

**Acceptance criteria.**
- [x] No resulting file exceeds ~600 lines. Engine: admin.ts 244 + 3 route
      files (565/310/299). Studio: page 390 + RecordDrawer 367 + DataTable 438 +
      SchemaPanel 588 + field-helpers 55.
- [x] Admin HTTP surface unchanged (register-fn pattern preserves call order →
      byte-identical mounted paths; engine boot mounts every group, WSL 404/0).
- [x] Collections page works: create/edit rows (RecordDrawer → dataTable.reload),
      add/drop field + manage relation (SchemaPanel → onSchemaChanged →
      reloadSchema). Verified LIVE in the dev-server preview against a seeded
      `contacts` collection (both tabs, both cross-component round-trips).

---

### H-08 Subsystem boundaries in `lib/` + import check ✅

**Problem.** 70 flat files in `engine/src/lib` where anything imports
anything. This is how the next god file forms and how "extension code" quietly
grows tendrils into "tenant code".

**Change.**
1. Group into subsystems (move files, fix imports — mechanical):
   `lib/extensions/` (from H-04 plus extension-catalog, -context, -deps,
   -download, -errors, -license, -paths, -registry, -sandbox, -utils,
   marketplace-routes), `lib/tenancy/` (tenant-context, tenant-manager, rls,
   entity-access, column-permissions, permissions), `lib/data/` (from H-05 plus
   query-cache, query-utils, query-alter, ddl-manager, ddl-queue, ghost-ddl,
   field-crypto, field-type-*), `lib/flows/` (flow-*), `lib/security/` (merge
   existing `security/` dir, api-key-hash, signature-verify, registry-keys,
   sso-session), `lib/runtime/` (the rest: cache, event-bus, realtime-bus,
   telemetry, memory-monitor, cron-runner, garbage-collector, …).
2. Each subsystem gets an `index.ts` public API. Outside code imports only
   from `lib/<subsystem>` — never deep paths.
3. Enforce with a ~60-line script `scripts/import-boundaries.ts` (regex over
   `git ls-files`, no new dependency): flag any import matching
   `lib/<subsystem>/<deep-file>` from outside that subsystem. Wire into CI
   lint job.

**Files.** `packages/engine/src/lib/**` (moves), every import site,
`scripts/import-boundaries.ts` (new), `.github/workflows/ci.yml`.

**Acceptance criteria.**
- [x] The 6 planned clusters are grouped + barrel-sealed (`flows`, `security`,
      `runtime`, `data`, `extensions`, `tenancy`). lib/ root 67 → 26 flat files.
      The 26 remaining are genuine leaf modules (audit, notifications, webhooks,
      service-registry, wasm/worker hosts, …) with no natural subsystem — left
      flat per the "utils if truly shared" spirit rather than forced into an
      ill-fitting bucket.
- [x] CI fails on a deep cross-subsystem import (`scripts/import-boundaries.ts`
      in the Lint job; negative-tested).
- [x] `tsc --noEmit` 0, WSL unit 427/0 across all six moves. Pure moves — git
      shows renames (96–100% similarity). Barrel `export *` eager-loading dropped
      gated coverage 24→22.9%; recovered to 24.6% with real tests on the exposed
      infra (field-type-conversions + validation-engine), not a re-baseline.

---

## Wave 3 — Tests that prove the promises

### H-09 Adversarial multi-tenant suite over the OpenAPI spec ✅

**Problem.** Tenant isolation is the product's flagship claim, but it is
tested point-wise (tenant-rls, tenant-rbac, tenant-membership tests). Every
new route ships without an isolation proof. The IP-hostname RLS incident
(fixed in beta.29) is exactly the class this catches.

**Change.** New integration test
`packages/engine/src/tests/integration/tenant-adversarial.integration.test.ts`:
1. Boot the engine, create tenants A and B, one user in each, seed one
   collection + one record + one file + one saved query per tenant.
2. Fetch the live OpenAPI spec from the running engine. For every path+method:
   substitute B-owned resource IDs into path params, authenticate as A's user,
   fire the request.
3. Assert: response ∈ {401, 403, 404} **and** response body never contains any
   B-seeded sentinel value (use unguessable sentinels like
   `zvB-secret-<uuid>`). For write methods, additionally assert B's data is
   unchanged.
4. Maintain an explicit allowlist for genuinely tenant-agnostic routes
   (`/api/health`, `/api/openapi.json`, auth endpoints) — every allowlist entry
   needs a one-line justification comment. An unlisted route that returns 200
   is a failure, which forces every **future** route to declare itself.

**Files.** new test file, possibly a fixtures helper in
`src/tests/fixtures/`.

**Acceptance criteria.**
- [~] Walks the spec + logs every skip with a reason. ~59% of routes are
      actually fired at B (32/54); the rest have `{id}`/`{channel}`/`{keyPrefix}`
      params that can't be type-safely filled from B — all logged, not silently
      passed. Short of the ≥90% aspiration; raising it needs per-route type-aware
      id seeding (follow-up).
- [x] Fails loudly on any cross-tenant read (sentinel leak / 2xx on B's record)
      or write (B record mutated after the sweep).
- [x] Runs in the existing CI integration job (`test:integration` globs the dir),
      ~2s.
- [x] The ALLOWLIST (each entry justified) is the only knob a new route touches.

**Caveat.** CI runs the engine as a DB superuser, so Postgres RLS is bypassed;
isolation held anyway (app-level tenant scoping + RBAC denial), so the guarantee
doesn't rest on RLS alone. The RLS-bound proof stays in `tenant-rls.test` under a
non-superuser role.

---

### H-10 Property/fuzz tests: filter parser + field-type conversions ✅

**Problem.** The filter/query parser (H-05's `query-parse.ts`) and
`field-type-conversions.ts` handle hostile, user-shaped input. Historic bug
classes here: operator injection, type coercion surprises, crash-on-weird-input.

**Change.** Add `fast-check` (dev-dep) and two suites:
1. `query-parse.property.test.ts` — arbitrary strings + structured-but-wrong
   filter objects: parser must never throw non-typed errors, never emit SQL
   fragments outside the Kysely builder (assert output AST shape), and
   round-trip valid inputs.
2. `field-type-conversions.property.test.ts` — for every registered field type
   pair with a declared conversion: arbitrary values in → conversion either
   succeeds with an output the target type's Zod schema accepts, or fails with
   a typed error. No exceptions, no silent data mangling (idempotence where
   the matrix declares it).

**Files.** two new files in `src/tests/unit/`, `packages/engine/package.json`
(dev-dep).

**Acceptance criteria.**
- [x] Both suites run ≥ 500 cases each (600 runs/property; ~7,900 assertions
      total) in < 1s, in the CI unit job (`test:unit` globs `*.test.ts`).
- [x] No counterexample surfaced — the code held under fuzzing — so there is
      nothing to pin as a regression. (If one ever does, fix + pin it as a named
      case above the property blocks.)

---

### H-11 Upgrade-path test in CI ✅

**Problem.** `migrate-safety.yml` checks migrations in isolation. Nothing
tests what an operator actually does: run version N-1, upgrade the binary,
keep working. For a self-hosted Business OS, a broken upgrade is the most
expensive possible bug.

**Change.** New workflow `upgrade-path.yml` (on PR touching migrations/engine,
plus nightly):
1. Download the latest published release binary (GitHub Releases — the same
   artifact `install.sh` pins).
2. Start it against a fresh Postgres service; seed via the public API: a
   collection with several field types, records, a user, a webhook, a flow.
3. Stop it. Build HEAD (`bun run build`). Start HEAD against the same database.
4. Assert: migrations apply cleanly, seeded data readable byte-for-byte via
   the API, auth session/user still valid, health endpoint green.
5. Also run the reverse guard: HEAD's migration list must be a strict superset
   of the release's (no renumbering/removal — this is the check that would have
   flagged the migration renumber).

**Files.** `.github/workflows/upgrade-path.yml` (new),
`scripts/upgrade-smoke.ts` (new — the seed/verify logic, reusable locally).

**Acceptance criteria.**
- [ ] Workflow green against the current latest release → HEAD.
- [ ] Fails if a migration is renamed, renumbered, or deleted.
- [ ] Runbook note added to `docs/DISASTER-RECOVERY.md` cross-referencing it.

---

## Wave 4 — Close the known architectural gaps

### H-12 Tenant-scope extension `ctx.db` ✅

**Problem.** The last hole from the multi-tenant review: extension code gets a
DB handle that is not tenant-scoped. A buggy (not even malicious) extension can
read or write across tenants. Casbin domains + membership (migrations 008/009)
closed the route layer; this closes the data layer.

**Change.**
1. In `extension-context.ts`, make `ctx.db` a per-request handle that sets the
   RLS tenant GUC (same mechanism `route-db.ts` / `tenant-context.ts` use for
   first-party routes) before yielding the Kysely instance. Extensions running
   in background jobs (cron, flows) receive the tenant from the job payload —
   make it a **required** parameter of the job-context factory so it cannot be
   forgotten.
2. Provide an explicit, capability-gated escape hatch (`ctx.adminDb`) for
   extensions that legitimately need cross-tenant access; require the
   `db:admin` capability in the manifest so it is visible at review/install
   time and surfaced in the marketplace UI.
3. Extend `third-party-isolation-enforcement.test.ts`: a test extension that
   tries to read tenant B's rows through `ctx.db` while handling a tenant-A
   request must get zero rows. Add the extension-route case to H-09's
   adversarial suite (fire `/ext/*` routes cross-tenant).

**Files.** `packages/engine/src/lib/extension-context.ts`,
`packages/engine/src/lib/route-db.ts` / `tenant-context.ts` (reuse, don't
duplicate), `packages/sdk/src/extension/index.ts` (capability + `adminDb`
typing — SDK is the contract source of truth),
`src/tests/unit/third-party-isolation-enforcement.test.ts`.

**Acceptance criteria.**
- [ ] `ctx.db` queries are RLS-constrained to the request/job tenant; proven
      by the extended isolation test.
- [ ] `ctx.adminDb` exists only behind an explicit manifest capability.
- [ ] Existing bundled extensions (backup, saved-queries, schema-branches,
      insights) still pass their tests — audit each for accidental reliance on
      cross-tenant reads; if one needs `adminDb`, that is a finding worth its
      own changelog line.
- [ ] `docs/EXTENSION-DEVELOPER-GUIDE.md` updated (tenancy section).

---

### H-13 Unified error envelope (problem+json) defined in the SDK ✅

**Problem.** Each route family formats errors ad hoc; the SDK and Studio guess
at shapes. Debuggability and client ergonomics both suffer, and error shapes
are silently unversioned API surface.

**Change.**
1. Define once in `packages/sdk/src/errors.ts` (SDK = contract source of
   truth, same pattern as `ZveltioExtension`): RFC 9457 fields (`type`,
   `title`, `status`, `detail`, `instance`) + `code` (stable machine string,
   e.g. `tenant.membership_required`) + `traceId` (from the existing W3C
   traceparent plumbing).
2. Engine: a single Hono `onError` + `HTTPException` mapping in
   `packages/engine/src/index.ts` producing the envelope with
   `content-type: application/problem+json`; a `problem(code, status, detail)`
   helper for routes. Migrate route families mechanically (grep
   `c.json({ error` and equivalents).
3. Client/SDK: parse the envelope into a typed `ZveltioApiError` (keep
   tolerant fallback for old shapes during beta).
4. Studio: the toast-error path reads `detail`/`code` instead of guessing.

**Files.** `packages/sdk/src/errors.ts` (new), `packages/engine/src/index.ts`,
all `routes/*.ts` (mechanical), `packages/client/src/*`,
`packages/studio/src/lib/api.js`.

**Acceptance criteria.**
- [ ] Every non-2xx response from the engine carries the envelope (assert in an
      integration test that walks the spec firing unauthenticated requests —
      can share H-09's walker).
- [ ] Error codes are stable strings documented in the generated OpenAPI.
- [ ] SDK exposes typed errors; Studio displays `detail` + `traceId`.
- [ ] This is a **breaking-ish** change: gate behind beta, note in CHANGELOG
      and `docs/MIGRATION-ALPHA-TO-BETA.md` successor doc.

---

## Wave 5 — Reliability you can point at

### H-14 Failure-injection integration tests ✅

**Problem.** DLQ, retries, and pg-boss exist, but only happy paths are tested.
Nobody knows what actually happens when Postgres drops mid-write, the registry
is down mid-install, or S3 is down mid-upload.

**Change.** New `src/tests/integration/failure-injection.integration.test.ts`
(or one file per scenario), using containers/mocks already available in CI:
1. **Postgres drop mid-write**: kill the connection (terminate backend via a
   second connection) during a multi-statement write → assert typed 5xx
   problem+json (H-13), no partial row visible after reconnect, engine serves
   traffic again without restart.
2. **Registry down mid-install**: point registry URL at a dead port → install
   fails with a typed error, advisory lock released, no orphan rows in
   extension tables, retry after "recovery" succeeds.
3. **S3 down mid-upload**: storage endpoint unreachable → typed error, no
   orphan metadata row, no half-written object reference.

**Files.** new integration tests, small fault helpers in
`src/tests/fixtures/`.

**Acceptance criteria.**
- [ ] All three scenarios pass in CI; each asserts *state* (no orphans/partials),
      not just the error response.
- [ ] Any bug found gets fixed in the same PR with a pinned regression test.

---

### H-15 Nightly soak job with memory assertions ✅

**Problem.** `memory-monitor.ts`, stress tests, and Valkey caching exist, but
nothing runs long enough to catch leaks before operators do.

**Change.** `.github/workflows/soak.yml` (nightly, `workflow_dispatch` for
on-demand): boot engine + Postgres, drive 60 minutes of mixed traffic (reuse
`bench/` drivers: CRUD, list-pagination, realtime connect/disconnect churn,
extension route hits). Sample RSS every 30s via the existing metrics endpoint.
Assert: RSS slope over the final 30 min < 1 MB/min; zero unhandled rejections;
p95 at minute 55 within 1.5× of p95 at minute 5.

**Files.** `.github/workflows/soak.yml` (new), `bench/soak.ts` (new, reusing
`bench/benchmarks/*`).

**Acceptance criteria.**
- [ ] First soak run analyzed; any leak found is fixed before the item closes
      (finding a leak = the item working, not failing).
- [ ] Job uploads the RSS/latency timeseries as an artifact.

---

### H-16 `scripts/release-gate.ts` — codified 3.0.0-stable criteria ✅

**Problem.** The 1.0 → 2.0-orphan → 3.0 version history reads as instability
from the outside. The fix is procedural: stable is cut when a script says so,
not when it feels ready.

**Change.** `scripts/release-gate.ts` asserts, with real checks not vibes:
1. `any` ratchet baseline (H-01) at or below the target recorded here.
2. Coverage (H-02) ≥ committed baseline; engine `lib/` ≥ 60% for stable.
3. Adversarial suite (H-09), upgrade-path (H-11), failure-injection (H-14)
   all green on the release candidate SHA (query GitHub checks API via `gh`).
4. perf-smoke within budget; latest soak (H-15) green.
5. No open issues labeled `P0`.
6. `versions.json` / changesets consistent; no migration renumbered since the
   last release (reuse H-11's superset check).
Wire as a required job in `release.yml` for any non-prerelease tag.

**Files.** `scripts/release-gate.ts` (new), `.github/workflows/release.yml`,
`docs/VERSIONING.md` (document the gate).

**Acceptance criteria.**
- [ ] Gate runs in CI on release tags and blocks a stable tag when any check
      fails; prerelease tags (`-beta.*`) bypass with a warning.
- [ ] `docs/VERSIONING.md` states: version numbers are never renumbered again;
      stable means the gate passed. Full stop.

---

## Non-goals (explicitly out of scope for this plan)

- New features, new extensions, new SDUI migrations — parked until Wave 3 done.
- Rewrites of working subsystems (flows, realtime, storage) — they are fine.
- Chasing 100% coverage or zero `any` — the ratchets converge us; perfection
  is not the bar, *defensibility* is.
- Go-to-market items (demo hosting, community, case studies) — tracked in
  `docs/TECHNICAL-GAPS.md`, not here. They gate the *other* score.
