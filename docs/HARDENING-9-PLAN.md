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
| H-04 | Split + de-`any` `extension-loader.ts` (manifest type from JSON schema) | 2 | 2d | IN PROGRESS — **manifest cluster DONE** (6245aef) + **migration-runner DONE**: `ExtensionManifest` from `z.infer<ManifestSchema>` (deviation from json-schema-to-ts: the Zod validator is the real enforced contract), `manifest` typed, latent null-safety fixed. Migration runner: added real `down_sql` col to `ZvMigrationsTable` in `schema.ts`, removed all `zv_migrations` `as any`, replaced `(trx as any).executeQuery({sql})` with idiomatic `_sql.raw(sql).execute(trx)` (verified multi-statement raw works vs a real Postgres). + **ExtensionInternals DONE** (2877044): fields typed as `typeof <helper>`, casts dropped; `sendNotification` kept loose via `unknown` params (SDK contract, H-13). Engine any 896→**861** (−35); loader 45→**16** markers. All verified green in WSL (404 pass / 0 fail) + real engine boot (health ok, extension-load + cron paths exercised). **Remaining:** structural split of the 630-line `loadExtension` into `lib/extensions/*` (the bulk; the residual ~16 loader markers are mostly Hono `c: any` context params + better-auth `auth: any`, which the split addresses). Do it as a dedicated session with the engine booting between steps (WSL + Postgres are set up). |
| H-05 | Split + de-`any` `routes/data.ts` (typed `DynamicRow` + Zod boundary) | 2 | 2d | TODO |
| H-06 | De-`any` `extension-marketplace-routes.ts`, `insights.ts`, `approvals.ts` | 2 | 1d | TODO |
| H-07 | Split `routes/admin.ts` and the collections detail Svelte page | 2 | 1.5d | TODO |
| H-08 | Subsystem boundaries in `lib/` + import-boundary check | 2 | 1d | TODO |
| H-09 | Adversarial multi-tenant suite parametrized over the OpenAPI spec | 3 | 1.5d | TODO |
| H-10 | Property/fuzz tests: filter parser + field-type conversions | 3 | 1d | TODO |
| H-11 | Upgrade-path test in CI (release N-1 binary → HEAD migration → smoke) | 3 | 1d | TODO |
| H-12 | Tenant-scope extension `ctx.db` (close the last multi-tenant hole) | 4 | 1.5d | TODO |
| H-13 | Unified error envelope (RFC 9457 problem+json) defined in the SDK | 4 | 2d | TODO |
| H-14 | Failure-injection integration tests (Postgres/registry/S3 down) | 5 | 1.5d | TODO |
| H-15 | Nightly soak job with memory-monitor assertions | 5 | 1d | TODO |
| H-16 | `scripts/release-gate.ts` — codified criteria for cutting 3.0.0 stable | 5 | 0.5d | TODO |

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
- [ ] No file in `lib/extensions/` exceeds ~500 lines.
- [ ] `as any` count in the loader code drops from 27 to ≤ 5 (document each
      survivor with a one-line justification in place).
- [ ] `ExtensionManifest` is derived from the JSON schema — changing the schema
      changes the type.
- [ ] All existing unit tests pass unmodified (extension-loader-archive,
      extension-lock, extension-sandbox, signature-verify, peer-deps-allowlist,
      third-party-isolation-enforcement) plus the marketplace-lifecycle
      integration test. Zero HTTP or SDK contract change.

---

### H-05 Split + de-`any` `routes/data.ts` 🔴

**Problem.** 1,734 lines and 23 `as any` in the CRUD core — the single
hottest path in the product. Filter parsing, write hooks, response shaping and
routing are interleaved, and rows flow through as untyped blobs.

**Change.**
1. Create `packages/engine/src/lib/data/`:
   - `query-parse.ts` — filter / sort / pagination / expand parsing from
     request params into a typed `ParsedQuery`.
   - `write-pipeline.ts` — validation + pre/post write hooks + RLS context.
   - `shape.ts` — select/expand response shaping.
2. Define the boundary type instead of casting:
   `type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }`
   and `type DynamicRow = Record<string, JsonValue>` in
   `packages/engine/src/lib/data/types.ts`. Rows are validated with the
   collection's Zod schema (already built per-collection by the field-type
   registry) at the parse boundary; past the boundary, no casts.
3. `routes/data.ts` shrinks to route definitions calling the three modules
   (~200–300 lines).

**Files.** `packages/engine/src/routes/data.ts`,
`packages/engine/src/lib/data/*` (new), `packages/engine/src/field-types/index.ts`
(read — reuse its Zod builders, don't duplicate).

**Acceptance criteria.**
- [ ] `routes/data.ts` ≤ 350 lines; no new module exceeds ~500.
- [ ] `as any` in the data path drops from 23 to ≤ 3.
- [ ] `crud.integration.test.ts`, `cursor-pagination.integration.test.ts`,
      `etag.integration.test.ts`, `relations.integration.test.ts`,
      `revisions.integration.test.ts`, `tenant-rls.integration.test.ts` all
      pass **unmodified** — they are the contract.
- [ ] perf-smoke stays within budget (no accidental N+1 introduced by the split).

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

### H-07 Split `routes/admin.ts` and the collections detail page 🟠

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
- [ ] No resulting file exceeds ~600 lines.
- [ ] Admin HTTP surface unchanged (diff the OpenAPI output before/after —
      `routes/openapi.ts` generation must be byte-identical for admin paths).
- [ ] Studio builds (`bun run studio:build`) and the collections page works:
      create field, edit rows, manage a relation — verified manually or via
      existing Studio checks.

---

### H-08 Subsystem boundaries in `lib/` + import check 🟠

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
- [ ] `lib/` root contains only subsystem directories (+ `utils.ts` if truly
      shared).
- [ ] CI fails on a deep cross-subsystem import.
- [ ] `tsc --noEmit`, unit, and integration suites green. Pure move — zero
      logic change (reviewable as such: `git diff --stat` shows renames).

---

## Wave 3 — Tests that prove the promises

### H-09 Adversarial multi-tenant suite over the OpenAPI spec 🔴

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
- [ ] Suite walks ≥ 90% of spec'd routes (log skipped ones with reasons).
- [ ] Fails loudly on any cross-tenant read or write.
- [ ] Runs in the existing CI integration job (budget: < 3 min).
- [ ] The allowlist, not the test body, is the only thing a new route may edit.

---

### H-10 Property/fuzz tests: filter parser + field-type conversions 🟠

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
- [ ] Both suites run ≥ 500 cases each in < 30s and are in the CI unit job.
- [ ] Any counterexample found during development is fixed **and** pinned as a
      named regression test, not just left to the fuzzer.

---

### H-11 Upgrade-path test in CI 🔴

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

### H-12 Tenant-scope extension `ctx.db` 🔴

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

### H-13 Unified error envelope (problem+json) defined in the SDK 🟠

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

### H-14 Failure-injection integration tests 🟠

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

### H-15 Nightly soak job with memory assertions 🟠

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

### H-16 `scripts/release-gate.ts` — codified 3.0.0-stable criteria 🔴

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
