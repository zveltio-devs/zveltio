# Changelog

All notable changes to Zveltio will be documented in this file.

## [3.0.0-beta.4] - 2026-06-17

### Studio is now an installable PWA

The admin Studio ships a web app manifest + service worker, so it
installs to the home screen with an offline app shell. For a
self-hosted Business OS this is the low-friction mobile path: each
customer installs their own instance's `/admin` — no app store, instant
updates. (Capacitor remains the planned "enterprise shell" for
MDM / iOS push / store presence, on the same Studio.)

- Service worker precaches the hashed app shell; never caches `/api/*`
  (dynamic + auth-sensitive), non-GET, or cross-origin requests.
- Manifest: `id` + `scope` `/admin/`, standalone display, dedicated
  maskable icon. New square brand icon + iOS apple-touch / standalone
  meta.

### Removed

- `@zveltio/react-native` — redundant with `@zveltio/react` (same hooks,
  only an AsyncStorage adapter differed) and never published. Mobile
  goes to PWA + Capacitor, both reusing the SvelteKit Studio.

## [3.0.0-beta.3] - 2026-06-16

### CI

- npm publishing is now **pure OIDC Trusted Publishing** — no token.
  The per-package trusted-publisher config on npmjs.com had the wrong
  workflow filename (`publish.yml` vs the actual `publish-npm.yml`);
  corrected on all four packages. `NODE_AUTH_TOKEN` removed from the
  workflow. Nothing to expire, nothing to rotate.

(No engine/runtime changes from beta.2.)

## [3.0.0-beta.2] - 2026-06-14

### Fixes

- `zveltio --version` read a hardcoded `2.0.0`; now derives from
  package.json (inlined at build) so it always matches the release.
- biome format on the tier-policy CLI/engine edits.

### CI

- npm publishing moved to **OIDC Trusted Publishing** — no npm token,
  nothing to expire. First release published via the GitHub Actions
  OIDC identity. (Per-package trusted-publisher config on npmjs.com.)

## [3.0.0-beta.1] - 2026-06-14

### Version line realigned to 3.x

The version jumps from `1.0.0-beta.3` to `3.0.0-beta.1`. This is a
**numbering correction, not a feature release** — the code is identical
to `1.0.0-beta.3`.

Why: early in the project a handful of npm packages (`@zveltio/sdk`,
`@zveltio/cli`, `@zveltio/react`, `@zveltio/vue`) were mistakenly
published at `2.0.x`, which can never be unpublished or reused. Staying
on the `1.0.0` line meant `npm i` resolved to those orphaned `2.0.x`
builds, and a future legitimate `2.0.0` would have collided with them
permanently. Moving to `3.0.0` puts every package cleanly above the
orphans: `npm i` now resolves to real code, npm sets `latest`
automatically at the `3.0.0` stable, and there is no future collision.

**Still beta.** "beta" is the platform maturity (expressed via the
release `channel` + the `-beta.N` suffix), independent of the now-3.x
version number. The extensions + marketplace API remain API-stable;
engine internals + Studio keep iterating toward stable `3.0.0`.

Everything in `1.0.0-beta.3` below ships unchanged under this version.

## [1.0.0-beta.3] - 2026-06-14

### Three-tier marketplace publisher policy (first-party / verified / community)

Extensions now carry a **publisher tier** that governs which isolation
they may run, enforced end-to-end instead of a binary official/community
split. Verified partners may ship `inline`; community publishers must use
`worker`.

- **Registry**: `publisher_tier` column (migration 010), single
  `policy.ts` module, submit + approve gates returning
  `422 ISOLATION_POLICY_VIOLATION`, catalog exposes
  `publisher_tier` + `allows_inline`, new `GET /api/dev/publisher/self`.
- **Engine**: enable reads `publisher_tier` (falls back to `is_official`
  for older registries); an extension absent from a loaded catalog is
  treated as community (refused inline) rather than skipping the gate.
- **CLI**: `extension pack` auto-injects `isolation: "worker"` for
  community publishers; `extension validate` hard-fails community
  `inline`; `extension publish` threads tier resolution and pretty-prints
  the registry 422. New `--first-party` / `--token` / `--registry-url`
  flags + `GET /api/dev/publisher/self` lookup.
- **Review UI** (apps): §2 policy banner (green OK / amber will-fail),
  Approve disabled on violation, publisher-tier badge in the queue.

### Fixes

- D1 returns booleans as integers; `is_official` is coerced so the engine
  no longer mis-classifies all 54 first-party extensions as community
  (the bug that blocked every marketplace enable).
- DR-smoke weekly workflow: set `PGDATABASE` + install the pg18 client so
  the dump/restore round-trip runs against the migrated DB.

### Docs

- Alpha track EOL policy + migration callouts; site refresh for beta
  (extensions / installation / intro); EXTENSION-DEVELOPER-GUIDE §13.5
  "how the tier is decided" + MARKETPLACE-POLICY §0/§2 four-point
  enforcement.

## [1.0.0-beta.2] - 2026-05-31

### Marketplace admin team (owner-managed review roster)

> **Reminder:** The alpha track (`1.0.0-alpha.*`) is EOL as of beta.1. See
> [docs/ALPHA-TRACK-EOL.md](docs/ALPHA-TRACK-EOL.md).

Until beta.1, the registry recognized exactly one admin — the user
whose email matched `ADMIN_EMAIL` env var. That bottlenecked all
review-queue actions through a single identity. beta.2 adds a real
team model.

**Registry** (`zveltio-registry@e2b32c8`):
  - Migration 009: `admin_users` table joining better-auth's `user`
    table. Two roles: `owner` (review + team management) and
    `admin` (review only).
  - `verifyAdmin` refactored to consult `admin_users` first, with
    a bootstrap path: when `ADMIN_EMAIL` matches the signed-in user
    AND no `admin_users` row exists, auto-promote them to `owner`.
    First-deploy operators don't need to manually insert a row.
  - New endpoints: `GET /api/admin/me` (UI role check), `GET/POST/
    PATCH/DELETE /api/admin/team[/:userId]`. Last-owner protection
    on demote + remove.

**Apps UI** (`zveltio-apps@e212176`):
  - `/admin/team` page lists members + their roles. Owner sees
    Promote / Demote / Remove buttons + Invite-by-email form
    (invited user must already have an account on apps.zveltio.com).
  - Layout now drives admin gating via `/api/admin/me` (server-side
    authoritative) instead of frontend email comparison. Header
    shows the current user's role badge. Team nav link hidden for
    non-owners.

**CLI** (`zveltio@<this commit>`):
  - `zveltio admin team list | add | set-role | remove` for operators
    who prefer terminal. Same last-owner protections as the UI.

**Bootstrap workflow for first deploy:**
  1. Set `ADMIN_EMAIL=you@example.com` in Cloudflare Worker secrets.
  2. Sign in to `apps.zveltio.com` with that email.
  3. Navigate to `/admin/marketplace/pending` — you're auto-promoted
     to owner.
  4. Use `/admin/team` (visible in nav now) to invite the rest of
     the review team.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-beta.1] - 2026-05-31

### Extensions v2 stable on the compiled binary; marketplace controlled-launch

### Alpha track end-of-life

**`1.0.0-alpha.*` is closed.** Last alpha: `v1.0.0-alpha.129`. Alpha GitHub
releases are kept for history; no new alpha tags will be published. Upgrade to
beta: `zveltio update --version 1.0.0-beta.2` (or latest from get.zveltio.com).
See [docs/ALPHA-TRACK-EOL.md](docs/ALPHA-TRACK-EOL.md) and
[docs/MIGRATION-ALPHA-TO-BETA.md](docs/MIGRATION-ALPHA-TO-BETA.md).

13 alpha releases (.117 → .129) closed every Phase 1 bundle-first,
worker isolation, trust chain, and marketplace review-queue gap.
Beta 1 is the stabilization tag: the platform extension model is
now considered API-stable; engine binary + 54 first-party
extensions + marketplace submissions are all validated end-to-end.

**Headline guarantees this tag promises:**

- Every extension ships as a self-contained bundled `engine/index.js`
  with `manifest.integrity.engineSha256` verified at install AND at
  enable. Bun's compiled-binary dynamic-import bug class is closed.
- Worker isolation (`engine.isolation: 'worker'`) is opt-in for
  trusted code, MANDATORY for community submissions (engine refuses
  the enable otherwise). Crash isolation + zero DB credentials in
  the worker thread. Honest about Tier 3 limits — no per-extension
  RSS or OOM kill (that's a future subprocess track).
- Marketplace trust chain: archive SHA-256 computed by publisher,
  verified by registry on upload, verified by engine on download
  before extraction.
- Review queue mechanics live: community submissions land `pending`,
  admin approves/rejects/takes down via CLI or the new
  `apps.zveltio.com/admin/marketplace/*` UI. Email notifications
  + audit trail + bundle preview in-browser.
- CI gates: hash-drift refusal on PR, smoke binary exercises three
  fixtures (inline subapp, worker, global mount) + `/api/admin/
  extensions/health` endpoint shape.

**This release adds:**

- `extension validate` is now a hard-fail on v1 manifests (warning
  in .125-.129). All 54 official are v2; community submissions
  must run `zveltio extension pack` before publish. Override the
  community-isolation warning for vendor builds with
  `--first-party`.

**What this release is NOT:**

- Public marketplace ships as **controlled launch** — submissions
  are technically accepted but every community extension stays
  `pending` until an admin approves manually via the apps UI or
  CLI. Until the review team is staffed + SLA published, expect
  delays.
- `MARKETPLACE-POLICY.md` v1.0 is effective but the operational
  pieces (review team, escalation, appeals process) are documented
  as "operator decisions, not code".
- v1.0 GA-blockers from `TECHNICAL-GAPS.md` (benchmarks, DR drill
  in CI, demo.zveltio.com, case studies) remain — separate track.

**Migrating from alpha:**

- See `docs/MIGRATION-ALPHA-TO-BETA.md`.
- If you run a custom extension, ensure `manifest.engine.bundled:
  true` and run `zveltio extension pack` once. Community-tier
  extensions must additionally set `engine.isolation: 'worker'`.
- Default Bun.SQL idle timeout is now 5 min (was 30s). Override
  via `BUN_SQL_IDLE_TIMEOUT_MS` for memory-constrained deployments.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.129] - 2026-05-31

### Marketplace review queue (code complete; ops process pending)

The mechanics for accepting community extension submissions are
now wired end-to-end. The 54 first-party extensions are unaffected
(they bypass the queue via SYNC_TOKEN); third-party submissions
land `status='pending'` and require explicit admin approval before
becoming downloadable.

**Registry side** (`zveltio-registry`):
  - Migration 008: extension status enum widened with `taken_down`;
    audit columns `reviewed_by`, `reviewed_at`, `reviewed_note`,
    `taken_down_at`, `taken_down_reason`. New `allowed_publishers`
    table (Ed25519 key allowlist with trust tiers).
  - `GET /api/admin/pending` — list submissions awaiting review.
  - `POST /api/admin/approve/:id` — sets status='published', writes
    reviewer + timestamp. Optional `note`.
  - `POST /api/admin/reject/:id` — sets status='rejected' with reason
    (visible to publisher).
  - `POST /api/admin/takedown/:id` — pulls a published extension
    with required reason. Refuses if extension is first-party.
  - `GET /api/admin/publishers` + `POST /api/admin/publishers` +
    `PATCH /api/admin/publishers/:id` — enroll / list / suspend
    allowed publishers.
  - `GET /api/dev/extensions/by-name/:name` — public status check
    (no auth), used by `zveltio extension status`.

**Engine side** (`zveltio`):
  - Download endpoint already 403s for non-published extensions;
    error message now surfaces "pending review" instead of generic
    "not available", with link to registry.zveltio.com.

**CLI side**:
  - `zveltio admin marketplace pending | approve | reject | takedown
    | publishers | enroll-publisher` — registry admin commands.
    Requires admin session cookie via `--cookie` or
    `ZVELTIO_ADMIN_COOKIE`.
  - `zveltio extension status <name>` — publisher-facing status
    check (no auth). Shows pending/published/rejected/taken_down +
    reason text.
  - `zveltio extension publish` output now ends with "submission
    received, status: pending" + link to status check command.

**Docs**:
  - `MARKETPLACE-POLICY.md` is no longer DRAFT. Section 0 maps every
    policy claim to the file where it's enforced. New §8 operator
    runbook with copy-paste commands for daily review + onboarding
    + takedown. New §9 lists the human-process decisions the
    operator must still make (SLA, escalation, appeals) — those
    don't ship with code.

What's still pending (human/process, not code):
  - Staff the review team
  - Pick a published SLA
  - Onboard first community publishers

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.128] - 2026-05-31

### Fix: `initDatabase` idle timeout was overriding alpha.126's fix

External review caught that alpha.126's B1 fix in
`bun-sql-dialect.ts` (raise idle timeout from 30s to 5min) had
zero runtime effect — `initDatabase()` in `db/index.ts` explicitly
passes `Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30_000)` which
overrides the dialect's default. So the only Bun SQL race
mitigation actually running in production was the
`uncaughtException` handler.

Fix: `initDatabase` now reads `BUN_SQL_IDLE_TIMEOUT_MS` (the env
var documented in the dialect's comment) or falls back to legacy
`DB_IDLE_TIMEOUT_MS` for backward compat, with default 300s
matching the dialect's intent.

Plus: `EXTENSIONS-V2-PHASE1.md` "Validated live" table extended
with .126 / .127 / .128 rows.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.127] - 2026-05-31

### Fix: marketplace-lifecycle integration tests gate-by-default

The alpha.126 suite triggered 6 CI failures because the standard
`test:integration` runner has `TEST_DATABASE_URL` set (engine running)
but does NOT stage the hello-ext / hello-ext-worker fixtures or
provision a god user. The tests assumed both.

Fix: gated behind `ENABLE_MARKETPLACE_INTEGRATION_TESTS=1` explicit
opt-in. CI doesn't set it; the suite stays skipped there. The
release-binary smoke job in `.github/workflows/release.yml` already
exercises the same flow against the compiled binary, so CI coverage
of the path is unchanged.

To run the suite locally, follow the comment block at the top of
`marketplace-lifecycle.integration.test.ts`.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.126] - 2026-05-31

### Operational hardening — the "B1-B5" backlog from in-session observations

Five fixes attacked together: each addressed a real pain point
observed during the alpha.118 → .125 sessions, not speculation.

**B1 — Bun SQL race during studio rebuild (the only real bug)**

We saw the engine crash 4–5 times in WSL when a transaction held a
connection during the `bun run build` studio rebuild window
(5–15s). The C++ binding throws `connection must be a
PostgresSQLConnection` synchronously, which escapes `await` context
and lands as an `uncaughtException`, NOT a Promise rejection — so
the alpha.117 `unhandledRejection` handler missed it.

Two changes:
- New `uncaughtException` handler mirrors the rejection one with
  the same recoverable-error gate (`ERR_POSTGRES_CONNECTION_CLOSED`
  / `Connection closed` / `must be a PostgresSQLConnection` /
  `ECONNRESET` / `EPIPE`).
- Bun.SQL idle timeout raised from 30s to 5min (override via
  `BUN_SQL_IDLE_TIMEOUT_MS`). Wider window closes the race in
  practice; the studio rebuild now fits comfortably under the
  eviction threshold.

**B2 — Studio rebuild coalescing**

Each marketplace `enable` triggered an immediate full Vite build.
Five enables in a row = 5 × 15s of CPU + I/O. Now:
- Rebuild requests within 750ms coalesce into a single in-flight
  build. The latest call's arguments win.
- Before invoking Vite, the host hashes (sorted extension names +
  pages/ mtimes + sizes). If hash matches the last successful
  build, the rebuild short-circuits. Common when WS-driven
  refreshes fire after no actual change.

**B3 — Manifest doc refresh**

`EXTENSION-DEVELOPER-GUIDE.md` §4 was last touched before manifest
v2 landed (alpha.111). The "All fields" table now lists the
`engine.*` and `integrity.*` blocks that `extension pack`
produces, plus the v2 minimal-valid-manifest example. Author-
facing notes call out that `engine.isolation: 'worker'` is
mandatory for community submissions.

**B4 — Marketplace lifecycle integration tests**

`marketplace-lifecycle.integration.test.ts` (5 specs): install,
enable, GET `/ext/hello-ext/health`, same for hello-ext-worker
(asserts `runtime: 'bun-worker'`), `/api/admin/extensions/health`
records inline + worker correctly, unknown extension → 404. Same
shape as the release-binary smoke job but runs in `bun test` —
catches regressions earlier in the dev loop.

**B5 — `check:schema` + `prepush` scripts**

Two new package.json scripts:
- `check:schema` — codegen + format + drift check, in one command
- `prepush` — runs check:schema + format:check + typecheck for
  authors who want a pre-push validation

Doesn't install a hook (intrusive); makes it one command for
authors who want a faster feedback loop than CI.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.125] - 2026-05-31

### Marketplace polish — pre-validate + fail-closed + enforcement tests

Four small items the external review flagged on alpha.124. Not
critical, but each closes a specific surprise vector:

- **`zveltio extension validate` warns at pre-publish time** when
  `engine.isolation !== 'worker'`. The runtime enforcement landed
  in alpha.124 but only fires at enable time — authors found out
  late. Now the publisher sees it before pushing to the registry.
  Suppress for vendor builds with `--first-party`.

- **`ZVELTIO_REQUIRE_CATALOG=1` fail-closed mode**. By default the
  engine falls through to local-only assumptions when the catalog
  fetch fails (offline-friendly self-hosted). Operators who want
  strict enforcement set this env var; the loader refuses to
  enable non-worker extensions whenever the registry is unreachable.
  Worker isolation still passes either way — no point refusing if
  the extension is already sandboxed.

- **10 unit tests for the enforcement decision logic**. Covers:
  first-party inline allowed, community + worker allowed,
  community inline refused, missing isolation refused, env-var
  escape hatch, unknown extension treated as community, fail-closed
  refusal, worker overrides fail-closed.

- **`EXTENSIONS-V2-PHASE1.md` "Validated live" table** extended with
  rows for .123 (trust chain), .124 (marketplace enforcement),
  .125 (this release).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.124] - 2026-05-31

### Marketplace public readiness — enforcement + trust chain closure

Three small pieces that close the gap between
`docs/MARKETPLACE-POLICY.md` (the contract) and the runtime (which
previously just trusted the publisher).

- **Engine enforces `isolation: 'worker'` for third-party
  extensions.** Catalog entries now carry `is_official` (defaults
  to `true` for the 54 hardcoded first-party + smoke fixtures;
  registry returns `false` for community submissions). At enable
  time the loader hard-fails non-official extensions that don't
  declare `engine.isolation: 'worker'`. Operators with their own
  audited extensions can override via
  `ZVELTIO_ALLOW_INLINE_THIRD_PARTY=1`.

- **Registry verifies publisher-declared archive SHA-256 at
  upload.** Sync workflow now sends `X-Manifest-Archive-Sha256`
  with the upload; registry computes the hash server-side, compares
  with the header, and rejects with HTTP 400 on mismatch. Catches
  MITM / proxy mutation between publisher pack and registry
  upload. Pairs with the alpha.123 engine-side verify-on-download
  to close the publisher → R2 → engine chain end-to-end.

- **Unit tests for archive SHA-256 verification.** Five tests
  covering accept/reject paths: matching hash, uppercase header,
  wrong hash, missing header (backward compat), single-bit
  tamper detection. Complements the alpha.123 worker host
  bookkeeping tests.

Doc: `EXTENSIONS-V2-PHASE1.md` §8 "Remaining" table updated —
items closed by alpha.123 and .124 moved from ⏳ TODO to ✅ DONE.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.123] - 2026-05-31

### Trust chain + DX + tests (the P2/P3/P4 backlog from the agent review)

**P2 — archive SHA-256 trust chain end-to-end**

- Registry returns `X-Archive-Sha256` header on every download
  (pulled from R2 customMetadata stored at upload, alpha.117).
- Engine verifies the downloaded ZIP bytes against that header
  before extraction; mismatch refuses the install with an explicit
  message naming both hashes.
- Cost: one SHA-256 pass over the ZIP at install time
  (~10ms for a 1-2 MB archive). Zero per-request overhead.

**P3 — DX for public marketplace authors**

- `@zveltio/sdk/build` exports `createExtensionBuildConfig` and
  `createExtensionBundleResolvePlugin`. The CLI's `extension pack`
  command now imports the plugin from the SDK — single source of
  truth. Authors with custom build pipelines (monorepo orchestrators,
  IDE integrations, alternative entrypoints) can `Bun.build(...
  createExtensionBuildConfig(...))` and produce byte-identical
  artifacts.
- `zveltio extension create` template now scaffolds two files
  every published extension needs:
  - `.gitattributes` — pins `engine/index.js` + `.map` as binary so
    autocrlf can't drift the hash across OSes (same protection
    `zveltio-extensions` carries for all 54 official packs).
  - `.github/workflows/ci.yml` — runs `extension pack` + verifies
    committed bundle hash matches manifest engineSha256 + runs
    `extension validate`. PR red = no merge.
- `docs/MARKETPLACE-POLICY.md` (new) — submission rules, isolation
  tier requirements per publisher tier (community / verified
  partner / first-party), permission scopes, review checklist,
  lifecycle, takedown criteria. Honest about Tier 3 limitations.

**P4 — unit test coverage for WorkerExtensionHost**

- New `worker-extension-host.test.ts` (7 tests): lifecycle helpers
  (`isRunning`, `stopAll`, `stop`), health record shape (workers
  generation, last crash/hang, in-flight counts, integrity, **no**
  rssBytes), duplicate start guard. Smoke release continues to
  exercise the full IPC chain; these tests pin the host-side
  bookkeeping the smoke can't easily inspect.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.122] - 2026-05-31

### Worker isolation: reliability + observability + service bridge

Five additions on top of the alpha.121 worker isolation foundation:

- **Crash auto-recovery**: a worker that crashes (`worker.onerror`)
  is automatically respawned with exponential backoff (500ms → 30s
  ceiling). `workerGeneration` is bumped per respawn so operators
  can detect flapping. The Hono proxy sub-app stays mounted; the
  new worker takes over the same routes.
- **Hang detection**: every 30s the host sends `ping` to each
  worker. If no `pong` arrives within 60s the worker is terminated
  and respawned. Prevents a stuck handler from holding proxy
  routes open forever.
- **Cross-worker service registry bridge**: `ctx.services.register()`
  inside a worker is no longer a no-op. The host wraps each
  worker-registered service so that inline extensions / other
  workers can call it transparently — calls route to the publishing
  worker via `service:invoke`, the worker runs the impl in its
  own thread, and the reply travels back through the host.
- **`GET /api/admin/extensions/health`** (admin-only). Returns
  per-extension records with isolation tier, status, worker
  generation, last crash / hang timestamps, in-flight + total
  request counts, integrity status, route count, plus
  `engine_rss_mb` at the response root. **NO per-extension RSS
  field** — Bun.Worker is a thread, so per-extension RSS isn't
  measurable from the OS layer. Don't promise what the runtime
  can't give.
- **`hello-ext-global` fixture**: covers `mountStrategy: 'global'`
  in release.yml smoke alongside the existing `hello-ext` (inline
  subapp) and `hello-ext-worker` (worker subapp) fixtures. Three
  fixtures × three code paths.

Docs: `EXTENSION-DEVELOPER-GUIDE.md` §13.5 adds the 3-tier
isolation policy (inline / worker / future subprocess+WASM) with
explicit limits — calling out that worker mode is "crash isolation
+ credential separation", not OS sandboxing.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.121] - 2026-05-31

### Worker isolation: embed runtime source, write to /tmp at first spawn

alpha.118 → .120 chased the same symptom (`BuildMessage: ModuleNotFound
resolving /$bunfs/root/worker-extension-runtime.ts (entry point)`) with
progressively-more-correct theory:
  - alpha.118: inline `new URL(...)` instead of hoisted const
  - alpha.119: same, plus the schema-format fix
  - alpha.120: static-import the host so Bun's static analysis sees the
    worker URL expression

None of them worked. Bun's `--compile` mode genuinely does not bundle
workers, even with a textbook-correct `new Worker(new URL(...,
import.meta.url))` call site at a statically-reachable location.

Bulletproof fix: pre-compile the worker runtime at engine build time
into a string constant, embed it in the binary, write it to a temp
file on first worker spawn, and pass the temp path to the Worker
constructor. Bun's worker constructor accepts an absolute disk path
without needing any bundler involvement.

Three pieces:
  - `packages/engine/scripts/gen-worker-source.ts` — pre-build step
    that runs Bun.build on worker-extension-runtime.ts and emits
    `worker-extension-runtime-source.generated.ts` exporting the
    compiled JS as a `WORKER_RUNTIME_SOURCE` string constant.
  - `worker-extension-host.ts` — imports the constant, lazily
    writes it to `mkdtemp(/tmp/zveltio-worker-)/worker-extension-
    runtime.mjs` on first spawn, points `new Worker(...)` at the
    file URL.
  - release.yml — runs gen-worker-source.ts before
    `bun build --compile` so the embedded string is always fresh.

The generated file is committed (treated like `db/migrations/embedded.ts`)
so cold checkouts work without a manual codegen step.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.120] - 2026-05-31

### Worker isolation: static-import the host so Bun bundles the worker entry

alpha.119's smoke still failed with the same
`BuildMessage: ModuleNotFound resolving
/$bunfs/root/worker-extension-runtime.ts (entry point)` despite the
inline `new URL(...)` fix. Reason: extension-loader.ts loaded
worker-extension-host.ts via dynamic `await import(...)` from inside
the enable handler, which means Bun's compile-time static analysis
never walked into the host file and never saw the worker URL
expression. The compiled binary shipped without the worker source
embedded.

Fix: switch to a static `import { getWorkerHost } from
'./worker-extension-host.js'` at the top of extension-loader.ts.
Bun now walks the host module at build time, finds the
`new Worker(new URL('./worker-extension-runtime.ts',
import.meta.url))` call site, and bundles the worker entry into
the binary.

If alpha.120 smoke also fails with the same ModuleNotFound, the
fallback is to extract the worker source to /tmp at runtime — see
the worker-extension-host TODO comment for the next iteration.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.119] - 2026-05-31

### Worker isolation: fix worker entry not embedded in compiled binary

alpha.118's release smoke caught a real bug in the C-minimal worker
host: `BuildMessage: ModuleNotFound resolving
/$bunfs/root/worker-extension-runtime.ts (entry point)`. Bun's
compile-time bundler detects worker entry points only when the
constructor receives a literal `new URL('./relative.ts',
import.meta.url)` expression at the call site — hoisting the URL to
a const and passing `.href` (a string) sidesteps that detection, so
the bundled binary shipped without the worker source embedded.

Fix: construct the URL inline inside `WorkerExtensionHost.start()`.
hello-ext (inline path) was already green; hello-ext-worker (worker
path) now wires through end-to-end.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.118] - 2026-05-31

### C-minimal: opt-in Bun.Worker isolation for extensions

The engine now supports per-extension thread isolation via
`manifest.engine.isolation: 'worker'`. When set, the extension runs
inside a dedicated `Bun.Worker`, the host postMessage-forwards each
HTTP route invocation, and SQL queries are proxied back to the
host's shared pool. The worker never receives `DATABASE_URL` or any
other env credential — host is the gatekeeper.

Default stays `inline` for backward compatibility and max speed —
the existing 54 first-party extensions are unchanged. Worker mode
is designed for the third-party marketplace future where untrusted
publisher code needs a real isolation boundary.

Trade-offs (so you can choose informed):
  - +0.5-2ms per route hit (one IPC round-trip)
  - +5-20ms per chatty DB workload (one IPC round-trip per query)
  - +30-50MB RSS per active worker
  - Crash in worker doesn't take the engine down
  - Worker has zero DB credentials; SQL is audited through host
  - Memory leak in extension stays in worker, not engine
  - Per-extension RSS becomes measurable (Phase 2 prep)

Limitations in C-minimal (documented for follow-up):
  - No cross-process transactions (each `db.query()` is independent)
  - No streaming responses (body is buffered as text)
  - `ctx.services.register()` from a worker is a no-op (workers
    can call other extensions' services but cannot publish their
    own — the host registry stays single-source-of-truth)

New: `hello-ext-worker` fixture under
`packages/engine/src/tests/fixtures/`. Release smoke now exercises
BOTH the inline path (hello-ext) and the worker path
(hello-ext-worker) — any regression in the IPC chain fails the
release before publishing artifacts.

CLI: `extension pack` preserves `engine.isolation` when re-writing
the manifest engine block.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.117] - 2026-05-29

### Beta-readiness backlog (Phase 2 prep)

Six fixes that turn the engine from "marketplace works" into
"marketplace works AND is hard to break by accident":

- **Bun SQL race**: the engine crashed during studio rebuild when
  a transaction's `release()` raced Bun's pool idle-timeout. The
  release call threw `ERR_POSTGRES_CONNECTION_CLOSED` as an
  unhandled rejection and the binary exited. Fix: dialect's
  `release()` now swallows that specific code (the connection is
  already gone; there is nothing to roll back), and a global
  `unhandledRejection` handler keeps the process alive for the
  same code + ECONNRESET / EPIPE on broken websocket peers.
  Every other rejection still aborts.

- **Loader refuses legacy .ts in production**. `NODE_ENV=production`
  + non-bundled extension is now a hard fail with a clear message
  pointing at `zveltio extension pack`. Dev installs still work via
  `ZVELTIO_EXTENSION_DEV_RELOAD=1`. Closes the "extension slipped
  through unpacked, mystery dynamic-import error" class of bugs.

- **`zveltio extension validate` enforces manifest v2**. v1 (no
  `engine` block) prints a warning that recommends running pack.
  Partial v2 (engine block present but missing `entry`, `bundled`,
  or `integrity.engineSha256`) is a hard error — the engine would
  refuse to load it at enable time, so failing in validate
  surfaces it during publish prep.

Registry side:

- `/api/admin/upload-package/:name` now computes the archive
  SHA-256 server-side and returns it in the response + persists it
  as R2 customMetadata. The engine doesn't enforce this against a
  manifest-declared value yet (engineSha256 stays load-bearing),
  but operators can now verify byte-identical archives across
  publisher → R2 → install.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.116] - 2026-05-29

### hello-ext fixture: mountStrategy = subapp

alpha.115's smoke job failed because the fixture used the default
mountStrategy ('global'), which would have mounted /health at the
engine root rather than under /ext/hello-ext/. The smoke test was
correctly hitting /ext/hello-ext/health and getting 404.

First-party extensions (CRM, ai, mail, …) all set
`mountStrategy: 'subapp'` so their routes land under
/ext/<name>/*. The fixture has to match.

Re-packed; engineSha256 = 83d2b7dd60b6…

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.115] - 2026-05-29

### hello-ext fixture bundle re-packed under .gitattributes

The fixture committed in alpha.114 was packed BEFORE
`.gitattributes` pinned `**/engine/index.js` as binary in this repo,
so the bundle bytes drifted vs the manifest's `engineSha256`
(50,142 stored vs 48,955 packed — same CRLF de-sync class that hit
zveltio-extensions @ a382d8c). The smoke job would have failed on
that mismatch.

Re-packed now that the gitattributes are in place. Verified
`git ls-files -s | git cat-file -p | sha256sum` matches the
committed `integrity.engineSha256`.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.114] - 2026-05-29

### Phase 1 of EXTENSIONS-V2 closes

Marketplace install + enable validated end-to-end on the compiled
binary across 8 representative extensions in WSL, including the
6 cases with peerDependencies that needed `bundlePeers: true`:
crm, ai, communications/mail, auth/ldap, billing, search, sms,
data/import. All 54 official extensions are packed with manifest v2 +
integrity.engineSha256; sync workflow uploads 54/54 with hash drift
detection in place.

Two follow-ups land in this release:

- **hello-ext fixture** — a self-contained Hono router under
  `packages/engine/src/tests/fixtures/hello-ext/`, listed in the
  local `EXTENSION_CATALOG` with category `'fixture'`. The release
  smoke job no longer clones `zveltio-extensions` and no longer
  depends on the registry being reachable — it copies the fixture
  into `EXTENSIONS_DIR` and exercises install + enable + a real
  GET against `/ext/hello-ext/health`. Removes the entire class
  of "release fails because the marketplace pipeline regressed."

- **Docs §8 refresh** — `docs/EXTENSIONS-V2-PHASE1.md` Section 8
  was last updated before pack/publish existed. Status table now
  reflects what's actually shipped through alpha.113.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.113] - 2026-05-29

### Drop the "peer deps installed at enable time" model

The compiled Bun binary cannot resolve bare specifiers from a
dynamically-imported disk file. Verified live: imapflow imports inside
`communications/mail`'s bundle threw `Cannot find package 'imapflow'`
on alpha.112 even though the peer dep was correctly installed in
`/opt/zveltio/extensions/node_modules`, the CWD symlink pointed at
it, AND a sibling `engine/node_modules` symlink existed. Bun's
compiled-binary resolver only sees modules embedded at build time;
disk node_modules walks don't apply.

Consequence: the only working configuration on the binary install is
`engine.bundlePeers: true` — peers must be inlined into
`engine/index.js` at pack time. There is no "external peer dep"
path that works in production anymore.

- Loader rejects bundled extensions with non-empty `peerDependencies`
  unless `engine.bundlePeers` is true. Clear error pointing at the
  fix instead of the cryptic "Cannot find package".
- `zveltio extension pack` enforces the same at pack time — refuses
  to build a known-broken artifact.
- `PEER_DEP_ALLOWLIST` retired (now empty). Truly-native bindings
  (sharp, etc.) need a separate mechanism — ship via engine plugin,
  not peerDependencies.

Migration: extensions that previously listed peers as external must
either set `bundlePeers: true` (and install the peers locally so
Bun.build can resolve them) or remove the entries. `communications/mail`
is the reference: 958KB → 3.2MB bundle with imapflow/mailparser/nodemailer
inlined.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.112] - 2026-05-29

### Marketplace enable validated end-to-end on the compiled binary

Closes the marketplace install/enable loop that's been broken on
binary installs since alpha.99 (when marketplace first shipped).
WSL validation today: CRM installed from marketplace, enabled, two
migrations ran, routes registered at `/ext/crm/*`, marketplace state
reports `is_enabled=true is_running=true`.

Three follow-up fixes after the alpha.111 release surfaced live:

- **Loader**: `integrity.archiveSha256` schema now accepts an empty
  string (or a valid 64-hex hash). alpha.111's pack wrote an empty
  placeholder; alpha.111's loader rejected it → manifest parse
  threw → silent return → opaque "engine/index.ts not found"
  fallback error. The loader path was correct, just gated by an
  over-strict schema.

- **Loader**: manifest-parse failures now set `lastLoadError` instead
  of returning silently. Operators see the actual Zod issue list
  instead of a generic "not found" fallback.

- **Pack**: `zveltio extension pack` no longer writes
  `archiveSha256: ""` into manifest.integrity. The field is now
  omitted entirely when no prior valid value exists. The registry
  computes archiveSha256 on upload.

### CLI: `extension publish` is single-shot

`zveltio extension publish` now runs `extension pack` as Step 2/6
(after validate, before studio build). Previously publishers had to
remember to run pack manually before publish; the engine bundle was
shipped as raw `.ts`. New flags: `--no-pack` skips engine pack;
`--no-build` skips both pack + Studio build.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

## [1.0.0-alpha.111] - 2026-05-28

### Extensions v2 — Phase 1 ships (bundled extension artifacts)

Concludes the EXTENSIONS-V2-PHASE1 scoping work. Marketplace
install/enable now works on the compiled binary, which has been
broken since the first alpha that shipped marketplace support.

**Root cause of the original bug**: Bun compiled binaries cannot
resolve bare specifiers like `kysely` from on-disk `node_modules`
for dynamically-imported external files. The runtime has no
node_modules walk-up for those imports — the only thing it sees
is what's bundled into the binary itself.

**Fix**: each extension now ships a fully-bundled `engine/index.js`
artifact with hono/zod/kysely/@hono/zod-validator inlined. The
engine loader detects `manifest.engine.bundled === true` and
imports the .js directly, skipping the symlink dance and the
CORE_NPM_PACKAGES presence check entirely.

What landed:

  - **CLI** (`packages/cli/src/lib/extension-bundle.ts`): a custom
    Bun plugin that resolves `import 'hono'` to its ESM .js entry
    instead of the .d.ts that Bun's default exports-condition
    matching picks. Plus `extension pack` command +
    smoke-test script.
  - **Engine** (`packages/engine/src/lib/extension-loader.ts`):
    `ManifestSchema` extended with `engine` + `integrity` blocks.
    When `engine.bundled` is true, the loader skips the legacy
    code paths and verifies the on-disk bundle's SHA-256 against
    `integrity.engineSha256` before import.
  - **5 pilot extensions packed** (`zveltio-extensions@9c6d142`):
    crm (918 KB), communications/mail (776 KB, with imapflow/
    mailparser/nodemailer external), finance/invoicing (741 KB),
    ai (1303 KB), forms (603 KB). Each manifest now declares the
    v2 `engine` + `integrity` blocks.

The remaining 49 official extensions can be packed via the same
CLI in the next migration wave; the loader handles both v1 (legacy
.ts on disk + symlink) and v2 (bundled) extensions correctly so
the rollout doesn't need to be atomic.

See `docs/EXTENSIONS-V2-PHASE1.md` for the full scoping doc and
`docs/manifest-v2.schema.json` for the machine-checkable manifest
contract.

## [1.0.0-alpha.110] - 2026-05-28

### Extension loader hardening — 4 polish fixes on top of alpha.109

alpha.109 fixed the cache-buster crash by detecting compiled binary mode
via `Bun.embeddedFiles.length > 0`. A follow-up audit by a second
reviewer surfaced 4 improvements worth shipping together:

1. **Cache-buster gated by explicit dev flag, not heuristic detection.**
   `Bun.embeddedFiles` shape can vary across Bun versions; relying on
   it is fragile. The cache-buster now activates only when
   `ZVELTIO_EXTENSION_DEV_RELOAD=1`. Binary installs and ordinary dev
   runs both get clean imports. The CLI's `zveltio extension dev`
   workflow can set the env var when hot-reload is actually desired.

2. **Imports anchored to file location via `pathToFileURL().href`.**
   The previous string-path import resolved bare specifiers from the
   binary's CWD (which is correct only after the symlink in #3 below
   exists). Resolving from the file URL anchors the walk to the
   extension's actual filesystem location and is more robust against
   CWD changes.

3. **`maybeSymlinkNodeModules` re-runs on every load.** Previously it
   only ran during `ensureExtensionCoreDeps` at boot. A
   marketplace-installed extension that arrived after boot got its
   `node_modules` populated but no symlink refresh → import failed.
   Now the symlink is reasserted before every dynamic load.

4. **`maybeSymlinkNodeModules` logs loud on failure.** The old `catch
   {}` swallowed permission errors silently. Operators now see a
   warning that names the source/target paths and explains the
   consequence ("extensions importing bare specifiers may fail to
   load"), so a misconfigured deployment is obvious.

### Audit log — `userId: 'system'` FK violations

`zv_audit_log.user_id` is `TEXT REFERENCES "user"(id) ON DELETE SET NULL`.
The extension loader was writing `userId: 'system'` on
`extension.loaded` / `extension.load_failed` / `extension.unloaded`
events, triggering FK violations (`zv_audit_log_user_id_fkey`). The
audit log entries were dropped silently; non-fatal but noisy.

Fix: omit `userId` for these system-triggered events (NULL is
allowed). Actor is recorded in `metadata.actor: 'system'` instead.

## [1.0.0-alpha.109] - 2026-05-28

### Extension loader — cache-buster broke Bun resolution in compiled binary

WSL smoke test: tried to enable any marketplace extension → "Cannot find
package 'kysely' from '/opt/zveltio/extensions/<ext>/engine/index.ts?v=…'".

Root cause: the dynamic-import cache-buster (`?v=<timestamp>`) was being
appended whenever `NODE_ENV !== 'production'`. In a compiled Bun binary
the `?v=…` suffix becomes part of the importer's path for module
resolution, which breaks the `node_modules` walk-up that resolves bare
specifiers like `kysely`. The core packages were installed correctly
under `/opt/zveltio/extensions/node_modules/` (verified) but
unreachable from any extension file that had the cache-buster suffix.

This affected EVERY extension enable on every binary install since the
loader was written — the marketplace install path was fully dead from
the user's perspective.

Fix: skip the cache-buster entirely when running in a compiled binary
(`Bun.embeddedFiles.length > 0`). Live reload doesn't apply there
anyway — extensions are loaded once at boot/enable. Source-mode dev
keeps the cache-buster for hot-edit workflow.

Found by attempting `POST /api/marketplace/crm/enable` after a fresh
alpha.108 binary install.

## [1.0.0-alpha.108] - 2026-05-28

### `/api/backup/pitr/status` — fix invalid Postgres function

`pg_last_checkpoint()` doesn't exist in standard Postgres. The route
was 500ing on every call against any vanilla PG install. The correct
function is `pg_control_checkpoint()`, which returns a row with
`checkpoint_lsn` + `checkpoint_time` (the latter is what the route
intends to surface as "last checkpoint").

Found while validating alpha.107 — 5 of 6 route fixes confirmed green,
this one stayed 500 because the underlying SQL itself was broken, not
the route ordering. Fixed inline; no migration needed.

## [1.0.0-alpha.107] - 2026-05-28

### Route-ordering collisions — static routes shadowed by /:id (multiple 500s)

WSL smoke-testing alpha.106 exposed a systemic bug class. The engine's
Hono router resolves routes in **registration order**: a static route
registered AFTER a same-method parameterized route that could match it
is unreachable. The param route captures the static segment as `:id`,
and because most id columns are UUID, the cast throws → 500.

Confirmed empirically: `GET /api/notifications/push-tokens` → 500
(matched `/:id`, id="push-tokens"); `DELETE /clear-all` (registered
*before* `/:id`) → 200. Definitive proof the router honors order.

Fixed every collision by moving the static route before the param one:

  - **engine** `flows.ts`        — `GET /dlq`, `GET /runs/:runId` before `/:id`
                                    (+ UUID-format guard on `/:id`)
  - **engine** `backup.ts`       — `GET /pitr/status` before `/:id/status`
  - **engine** `notifications.ts`— `GET /push-tokens` before `/:id`
  - **engine** `translations.ts` — `GET /glossary` before `/:keyId`
  - **ext** `compliance/ro/efactura` — `GET /stats` before `/:id`
  - **ext** `operations/assets`      — `GET /stats` before `/:id`
  - **ext** `i18n/translations`      — `GET /glossary` before `/:keyId`

Every one of these endpoints returned 500 on every call before the fix.

New `scripts/route-collision-check.ts` walks all route files (engine +
extensions), splits each into router scopes at `new Hono()` boundaries
(so multi-router files don't false-positive), and fails CI if any
static route is shadowed by an earlier same-method param route.

### Smoke-test validation

Full WSL smoke test on a fresh binary install passed: health/ready/deep,
login + session, collections CRUD, flows CRUD + run execution, the
complete invite flow (invite → metadata → accept → login with correct
role), audit log capture, and Studio UI.

## [1.0.0-alpha.106] - 2026-05-27

### Embedded migrations fix (critical — affected all binary installs)

Smoke-testing on WSL revealed migrations 002–005 (panels title,
glossary, invitations, flow_dlq) were never applied on fresh binary
installs. Root cause: `release.yml`'s binary build ran `bun build
--compile` directly, which embeds `embedded.ts` — an auto-generated
file that lists each migration for the compiled binary. But the
release workflow never ran `gen-embedded-migrations.ts` first, so the
committed `embedded.ts` (only `001_initial.sql` from the original
squash) was what shipped. Every alpha.100–105 binary booted with just
the initial schema; tables created by 002–005 (`zv_invitations`,
`zv_flow_dlq`, panels.title reconcile, translation_glossary) were
silently missing → 500s on `/users/invite`, `/flows/dlq`, etc.

Dev/source-mode installs (reading the `sql/` dir directly) were NOT
affected — only compiled binaries.

Fixes: regenerated `embedded.ts` with all 5 migrations + added a
"Generate embedded migrations" step to `release.yml` before the
compile so the binary always embeds the current set.

## [1.0.0-alpha.105] - 2026-05-27

### Schema drift checker + codegen + 3 more real bugs fixed

Two new repo-wide diagnostics land in this release, plus the bug fixes
the first run of the checker surfaced.

**B — `scripts/schema-drift-check.ts`:**
Walks every migration SQL file (engine + sibling extensions), the
hand-written `schema.ts`, and every route/lib TS file. Reports three
classes of drift:

  - TABLE_MISSING — code references a table no migration creates.
  - COLUMN_MISSING — code references a column not declared on that
                     table by any migration.
  - SCHEMA_TS_DRIFT — `schema.ts` is missing a table or column the
                     migration declares (warning-only — typing gap,
                     no crashloop).

First-run surfaced these real bugs:

  - `zv_flow_dlq` — table referenced by `routes/flows.ts` (DLQ list,
    retry, executor failure-path INSERTs) but no migration created
    it. New `005_flow_dlq.sql` (engine).
  - `zv_ai_memory.{importance, source, embedding}` — three columns
    referenced by `lib/zveltio-ai/engine.ts` for ranked memory +
    pgvector semantic recall, never created. New
    `003_ai_memory_columns.sql` in the AI extension (commit
    `zveltio-extensions@8723ce4`).

Also caught several parser-side bugs in the checker itself
during validation:

  - `checksum` was being mistaken for a `CHECK` table constraint
    (name starts with `check`). Fixed.
  - ALTER TABLE bodies with multi-clause `ADD COLUMN priority TEXT
    NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal'))`
    were eating the inner comma in `('low','normal')` as a column
    boundary. Fixed.
  - Better-Auth `"camelCase"` columns were being lowercased on one
    side of the diff and not the other. Fixed (case preserved for
    quoted identifiers).

**A — `scripts/schema-codegen.ts`:**
Emits `packages/engine/src/db/schema.generated.ts` from the same
migration walk. 353 table interfaces with proper `Generated<>` /
nullable / enum-literal typing. CI gate ("Schema codegen freshness")
re-runs codegen on every PR and fails if the output differs from
what's committed — net effect: a migration change without a matching
regenerated schema fails the build.

Hand-written `schema.ts` is NOT replaced yet. Generated lives
alongside as a parallel source; consumers can opt in. Migrating all
consumers to import from `.generated` is deferred (would cascade
typecheck errors because generated includes ~240 tables — mostly
extension-managed — that hand-written omits).

## [1.0.0-alpha.104] - 2026-05-26

### AI extension — four broken subsystems repaired (extensions `528b900`)

The AI extension routes use a local `reqDb(c): any` helper that
short-circuits Kysely's type-checking, and most reads/writes wrap
in `.catch(() => …)`. Net effect on every previous alpha: schema
mismatches surfaced as empty UI tabs or silently-dropped INSERTs
rather than crashes — so the bugs were invisible until the
post-alpha.103 audit went looking. Four subsystems were dead:

  1. **Prompt templates** (`/api/ext/ai/prompts*`) — routes
     referenced `zv_ai_prompts`, no such table exists. Real table
     is `zv_prompt_templates`. Admin prompt-template manager has
     been a no-op since the extension shipped. Fixed by renaming.

  2. **Usage tracking** (`/api/ext/ai/chat` + `/embed` + billing
     analytics) — every successful AI call INSERTed into a
     `zv_ai_usage` table that didn't exist. `.catch(() => {})`
     made it invisible. No billing data ever collected. New
     migration `002_ai_complete.sql` creates the table matching
     the INSERTs' shape + indexes.

  3. **Feature gating** (`/api/ext/ai/admin/features*`) — admin
     toggle UI for chat/search/generate/decide/embed read from
     `zv_ai_features`, table didn't exist. UI silently empty.
     Migration creates it + seeds the five standard feature rows.

  4. **Chat history + multi-turn memory** — both `lib/zveltio-ai/
     engine.ts` (Studio AI assistant) and `routes/zveltio-ai.ts`
     (public `/conversations`) queried `zv_ai_conversations` +
     `zv_ai_messages` (and the alias `zv_ai_chat_history`), none
     existed. `getConversationHistory()` always returned `[]` —
     every chat turn was one-shot with no memory of prior
     messages within a single session. `persistConversation()`
     silently dropped the INSERT. Migration creates both tables
     with the schema the code already expects; the route's alias
     is changed to point at `zv_ai_messages` directly so both
     consumers share storage.

Plus a handful of secondary AI bugs:

  - `zv_users` → `user` (Better-Auth's actual table name). Admin
    stats counter was reporting `users=0` regardless of reality.
  - `zv_collections` → `zvd_collections` at six call sites.
    Affected the AI's collection listing, schema introspection
    before text-to-SQL, and admin stats.
  - `c.schema` / `colDef.schema` on `zvd_collections` — the real
    column is named `fields`. The schema-context builder used by
    text-to-SQL was always silently returning empty fields, so
    the generated SQL referenced tables with no column context.
    Also fixed a sibling bug where the same builder rendered
    table names as `zv_<name>` — concrete data tables are
    `zvd_<name>` (DDLManager convention).

### Migrations

New extension migration `002_ai_complete.sql` is idempotent and
safe to apply to alpha.103-installed instances.

## [1.0.0-alpha.103] - 2026-05-26

### Schema / runtime bug pass (continued)

Continuing the (db as any) cleanup that produced alpha.102, this
release surfaces and fixes several more crash-or-silently-broken
sites that the casts were hiding.

**Engine-side (this repo):**

  - `routes/media.ts` (and the parallel content/media extension)
    was completely broken: every `/api/media/upload` and stats
    endpoint wrote/read columns named `mime_type`, `size_bytes`,
    `original_filename`, `uploaded_by` on `zv_media_files`. The
    real columns are `mimetype`, `size`, `original_name`,
    `created_by`. Net effect: zero uploads went through, every
    media stats handler returned an empty rollup. Fixed at all
    sites. Also `zv_media_folders` UPDATE was setting an
    `updated_at` column that doesn't exist — removed.

  - `lib/storage/cloud/file-versions.ts`: `createFileVersion()`
    read `currentFile.size_bytes`, `currentFile.mime_type`,
    `currentFile.uploaded_by` from a `zv_media_files` row, but
    those properties are undefined on the real schema. The
    `zv_media_versions` table legitimately has those columns
    (legacy naming), so the INSERT lined up wrong. Now translates
    explicitly.

  - `routes/users.ts` + new `routes/auth.ts` invitationRoutes:
    POST `/api/users/invite` INSERTed into a `zv_invitations`
    table that no migration created, with a graceful try/catch
    that made every invite silently fall through to an
    in-response fallback. The invite link pointed at
    `/accept-invite?token=...`, a URL no route handled. New
    migration `004_invitations.sql` creates the table; the
    catch is removed; new public routes at `/api/invitations`
    serve the metadata + accept flow.

  - Schema interfaces fattened (mostly `Generated<>` on DEFAULT
    columns + missing columns added): zv_media_files
    (`deleted_at`/`deleted_by`/`restore_folder_id`), zv_media_folders
    (`deleted_at`), zv_invitations (new), zv_approval_*
    (Generated<> on booleans + status), zvd_collections
    (`has_trgm`), zv_collection_publish_settings,
    zv_publish_schedule, zv_quality_scans, zv_quality_issues,
    zv_backup_schedules (new interface), zvd_push_tokens (new).

  - Audit log coverage bumped from 25% to 31%: added auditLog
    on PITR restore-point create/delete, backup schedule manual
    trigger, collections sync-schema, flows create/update/delete/run,
    edge functions create/update/delete.

  - `validation-engine.ts`: `error_message` is nullable in the
    migration but the `ValidationRule` interface declared it
    string. Fixed both sides.

  - `data-quality.ts`: `runQualityScan()` never null-checked the
    INSERT result before reading `.id`.

**Extensions-side (`zveltio-extensions`, commit `c8c7a71`):**

  - `content/media`: same column-name bug as the engine.

  - `ai/engine/lib/zveltio-ai`: two queries hit `zv_audit_logs`
    (plural). Real table is `zv_audit_log`. Both queries silently
    returned zero rows. Fixed.

### CI

  - New `format:check` step on the Lint job; repo-wide `bun run
    format` pass applied as a preceding commit so the gate starts
    green.

  - New `dr-smoke` workflow runs weekly: fresh Postgres → all
    migrations → seed → `pg_dump -Fc` → restore → verify row
    counts and table queryability. Catches dump/restore drift.

### Migrations

  - `004_invitations.sql` (new).

### Tests

  - 377/377 unit tests pass.
  - Engine + studio + sdk + extensions all typecheck clean.

## [1.0.0-alpha.102] - 2026-05-26

### TypeScript types — eliminated 199 of 204 `(db as any)` casts (97.5%)

The engine had 204 `(db as any)` casts in routes/lib/middleware that
silently bypassed type-checking on tables already declared in
`DbSchema`. Cleaning them up surfaced multiple latent bugs that
would crash at runtime against Postgres. The 5 remaining casts are
all legitimately dynamic (user-supplied table names, raw transaction
wrappers).

**P1 bugs fixed (would crash on a real DB):**

  - `routes/flows.ts`: the entire `/api/flows` surface was dead. Routes
    INSERTed/SELECTed columns `trigger` and `steps` on `zv_flows`,
    neither of which exists in the schema. Steps actually live in
    a separate `zv_flow_steps` table (which `flow-executor.ts`
    already reads from). `GET /:id/runs` selected `completed_at`
    but `zv_flow_runs` has `finished_at`. Rewrote all handlers to
    use the real schema, persisting steps as rows with `step_order`
    and re-compacting on delete. `triggerDataFlows()` now reads
    `trigger_config.collection` instead of parsing the non-existent
    `trigger` column.

  - `routes/insights.ts`: every `INSERT/UPDATE` on `zv_panels` would
    500 with "column title does not exist". Root cause: 001_initial.sql
    is a squash of 70 migrations, and 026_insights + 067_insights
    both `CREATE TABLE IF NOT EXISTS zv_panels` with different
    columns — 067's body was silently skipped (table existed),
    and the 069 reconcile migration only patched dashboards, not
    panels. Fixed both for fresh installs (in 001_initial.sql) and
    for existing instances via a new `002_insights_panels_title.sql`
    that adds `title`, backfills from `name`, and drops the NOT NULL
    on `name`. Added 4 missing dashboard-related table interfaces.

  - `routes/translations.ts`: the `/api/translations/glossary`
    GET/POST routes referenced `zvd_translation_glossary` but no
    migration ever created it. New `003_translation_glossary.sql`
    adds the table.

  - `validation-engine.ts`: `zv_validation_rules.error_message` was
    nullable in the migration but the in-code `ValidationRule`
    interface declared it as `string`. Fixed both sides.

  - `data-quality.ts`: `runQualityScan()` never null-checked the
    INSERT result before reading `.id` — would NPE on partial
    failure.

  - `users.ts` + `admin.ts`: `parseInt(count(...))` on a
    `bigint | number | string` count result. On tables larger than
    2^31 rows, the bigint path would have produced `Infinity`.
    Switched to `Number(...)`.

**Schema fixes (latent INSERT failures that the casts masked):**

  - Added missing tables to `DbSchema`: `zv_rate_limit_configs`,
    `zv_backup_schedules`, `zvd_column_permissions`, `zvd_push_tokens`,
    `zvd_dashboard_shares`, `zvd_panel_cache`,
    `zvd_insight_saved_queries`, `zvd_dashboard_subscriptions`,
    `zvd_translation_glossary`.
  - `Generated<>` on every column with a DEFAULT in the migration
    (across ~15 interfaces) — callers can now INSERT without
    specifying the column.
  - Added `has_trgm` column to `ZvdCollectionsTable` (added by
    migration 059_pg_trgm).
  - `zv_api_keys.allowed_ips` typed as `unknown`; callers narrow
    via `Array.isArray()` at the read site.

**Installer fixes (alpha.101 follow-ups still applied here):**

  - All `install/*.sh` scripts continue to point at
    `zveltio-devs/zveltio` (the actual GitHub namespace).
  - WSL / no-systemd hosts auto-detect to Docker mode.

### Schema migrations

Two new migrations land in this release:
  - `002_insights_panels_title.sql` — backfill `title` from `name`
    on `zv_panels`, drop NOT NULL on `name`.
  - `003_translation_glossary.sql` — create the missing
    `zvd_translation_glossary` table with `(term, locale)` unique.

Both are idempotent. Fresh installs get the same fixes baked into
`001_initial.sql`.

### Tests

  - 377/377 unit tests pass.
  - Engine typecheck clean. Studio typecheck clean. SDK typecheck clean.

## [1.0.0-alpha.101] - 2026-05-25

### Installer fixes (audit follow-up)

  - **GitHub URLs corrected** in `install/install.sh`,
    `install/update.sh`, and `install/proxmox-lxc.sh`: all references
    to `github.com/zveltio/zveltio`,
    `raw.githubusercontent.com/zveltio/zveltio`, and
    `api.github.com/repos/zveltio/zveltio` rewritten to point at the
    real `zveltio-devs/zveltio` repo. Prior alpha installers were
    silently downloading from a nonexistent repo for the Docker mode
    (compose file), helper scripts (update.sh, uninstall.sh,
    wrapper), the `update` command, and the Proxmox LXC variant.
  - **Auto-detect: WSL / no-systemd hosts now pick Docker.** The old
    logic preferred native whenever Bun was present, which on WSL
    without `systemd=true` made the install die at
    `systemctl daemon-reload`. New behaviour: probe `/run/systemd/system`
    and fall back to Docker if absent; emit a clear error if neither
    Docker nor systemd is available.
  - **Header comment** updated to match the actual decision tree
    (native preferred where systemd + Bun are both present; Docker
    elsewhere).

### Studio CI fix

  - Added `@types/node` to `packages/studio/devDependencies`. A
    fresh `svelte-kit sync` now writes `types: ["node"]` into the
    generated tsconfig (older `@sveltejs/kit` versions didn't), so
    typecheck fails with "Cannot find type definition file for 'node'"
    on hosts without `@types/node` transitively hoisted. Locks the
    dep down so CI is reproducible regardless of npm resolution.

## [1.0.0-alpha.100] - 2026-05-25

### Tenant RLS rollout — closed §6.1 backlog

The historical `AUDIT-2026-05-24 §6.1` backlog ("systemic multi-tenant
gap in extensions other than ai") is now closed. Both halves of the
gap are fixed:

  - **Migration template applied** to 51 DB-bearing official
    extensions (`002_tenant_rls.sql` adds `tenant_id` with the
    GUC-default, indexes it, enables FORCE RLS with a per-table
    isolation policy, warns on legacy NULL rows). `ai` had its
    isolation folded into `001_initial.sql`. The three stateless
    extensions (`content/pdf-viewer`, `developer/edge-functions`,
    `developer/views`) need no DB migration.

  - **`getMigrations() ↔ disk` reconciled.** The engine's extension
    loader silently skips paths that don't exist on disk — a pre-fix
    audit found 50 `002_tenant_rls.sql` files on disk that were never
    referenced by any extension's `getMigrations()`, plus several
    extensions still listing pre-squash filenames (e.g. CRM's
    `001_init.sql + 002_enterprise.sql + 003_missing_columns.sql`
    when only `001_initial.sql + 002_tenant_rls.sql` actually exist).
    Net effect before this release: every fresh `install + enable
    extension` was leaving RLS un-applied without raising any error.

  - **Defensive tooling** added to prevent recurrence:
    `scripts/validate-migration-paths.ts` in `zveltio-extensions`
    diffs declared paths against on-disk SQL files; the new
    `.github/workflows/ci.yml` runs it on every PR.

### Audit log — privileged-action coverage

Added `auditLog` calls on routes that mutate sensitive state but
previously emitted no event: `users.invited`, `users.deleted`,
`approval.submitted`, `approval.cancelled`, `api_key.rate_limit_set`,
`api_key.rate_limit_removed`. `AuditEventType` union extended
accordingly.

### CI

  - **Studio CI** added (`.github/workflows/studio.yml`) — Svelte 5
    + Paraglide regressions now caught on every PR + push, scoped via
    `paths:` so engine-only PRs don't pay the cost. Runs
    `svelte-kit sync` before `tsc` so the generated tsconfig
    (`include` list, `$app/*` paths, `moduleResolution: bundler`)
    is available.
  - **Dependabot lockfile auto-sync** (`dependabot-lockfile.yml`) —
    `pull_request_target` workflow rewrites `bun.lock` after each
    Dependabot npm bump so `bun install --frozen-lockfile` in main
    CI stays green.
  - **`--frozen-lockfile`** now enforced in every CI `bun install`
    step; Atlas migrate-safety lint fixed (`format = goose` bare
    identifier, not the invalid quoted `"up.sql"`).
  - **Studio embed path** corrected to `packages/studio/dist`
    (was `packages/studio/build` — the binary embed silently
    captured nothing).

### Ops docs

  - **`docs/DEPLOYMENT-K8S.md`** — Probes section expanded with a
    3-endpoint table (`/api/health`, `/api/health/ready`,
    `/api/health/deep`) and concrete `livenessProbe` /
    `readinessProbe` / `startupProbe` YAML matching the engine's
    measured boot profile.
  - **`docs/BENCHMARKS.md`** (new) — single source of truth for
    published throughput / latency numbers, the hardware baseline
    they're measured on, the reproduction recipe (`bench/scenarios/`
    + `bench/ci-check.ts`), and the multi-tenant overhead delta.
  - **`docs/SECURITY.md`** + **`docs/SESSION-PRs-2026-05-24.md`** —
    updated to reflect the closed §6.1 backlog (was previously
    listing it as "pending").

### Dependencies

  - **OpenTelemetry** — overrides pin `@opentelemetry/sdk-trace-base`
    to `2.7.1`. Transitive resolution still drags in v1 copies, so
    `telemetry.ts` keeps a narrow `as any` on `traceExporter` (the
    v1 ↔ v2 `ReadableSpan` interface drift is type-only; runtime
    contract is unchanged) — documented inline.
  - **zod** bumped to `^4.4.3`; the regression on `z.input<>` for
    `z.preprocess`-using schemas worked around with a hand-written
    `CoreCollectionInput` interface.

## [1.0.0-alpha.99] - 2026-05-22

### Fixed — race-guard workflow bug introduced in alpha.97

The race-guard I added in alpha.97 had its own bug: read the
new latest.json with `node -p "require('$NEW_FILE')..."`, where
$NEW_FILE was a relative path like `release-assets/latest.json`.
Node treats bare relative paths as MODULE specifiers, not file
paths, so the call failed with ERR_MODULE_NOT_FOUND.

Effect: every `update-website` job since alpha.97 has been failing
silently (the job is `continue-on-error: true`). zveltio-get's
latest.json was stuck at alpha.96 from May 21 19:21 onward, even
though alpha.97 and alpha.98 shipped after that.

Switched to `JSON.parse(fs.readFileSync(...))` and passed version
strings to the comparison node script via `env` (instead of bash
string interpolation, which was also fragile against pre-release
suffixes containing dots).

Also fixed: latest.json on zveltio-get was manually corrected to
alpha.98 in commit `05cf966` before this release shipped, so
users running install.sh now get the binary that actually boots.

## [1.0.0-alpha.98] - 2026-05-21

### Fixed — compiled binary crashed on boot

The `zveltio-linux-x64` (and all matrix targets) binary failed with
"tsyringe requires a reflect polyfill" when run on a fresh install
via `install.sh`. The error fired during database migration boot,
before the engine could even handle a request.

Root cause: `@better-auth/passkey` → `@simplewebauthn/server` →
`@peculiar/x509` pulls in `tsyringe`, which initialises decorators
at module load and requires `reflect-metadata` to be loaded first.
The dev path (HMR / `bun --watch`) happened to load reflect first,
hiding the bug. The `bun build --compile` binary has a tighter
load order and exposed it.

Fix: `import 'reflect-metadata'` as the very first line of
`packages/engine/src/index.ts`, plus a direct dependency entry in
`packages/engine/package.json` (was a phantom transitive dep).

This bug has been latent since `cacd554` (S5-08 enabled passkeys
by default) — every binary release from then on would have failed
on a clean install, but the issue wasn't surfaced until WSL
end-to-end install validation on alpha.97.

## [1.0.0-alpha.97] - 2026-05-21

### CI — release workflow race-guard

When the alpha.94/.95/.96 batch was pushed at once, the three
Release workflows ran in parallel. Each `update-website` job tried
to push its own `latest.json` to `zveltio-get`. The .95 workflow
happened to finish last and clobbered .96 — leaving the public
installer endpoint pointing at the wrong version.

Two changes to `.github/workflows/release.yml`:

1. `concurrency: { group: zveltio-get-push }` on `update-website`
   so parallel workflows serialize their pushes instead of racing.
2. `latest.json` copy step now compares versions before
   overwriting. A workflow for an older tag can no longer
   downgrade the current `latest.json` even if it finishes after
   a newer one. Stable releases still win over prereleases.

Also added a `git pull --rebase --autostash` before the push so
the same workflow re-runs cleanly after a previous one in the
same batch has just committed.

## [1.0.0-alpha.96] - 2026-05-21

### Changed — disable flow parity

`POST /api/marketplace/:name/disable` now AWAITS the Studio rebuild
inline, mirroring what `enable` does. Without this, a disabled
extension's pages remained reachable in the live dist until the
next enable triggered a rebuild — confusing for the operator
("I just disabled it, why is the route still there?").

Response shape matches enable: `studio_rebuild: 'success' |
'failed' | 'skipped'`, `studio_rebuild_ms`, optional
`studio_rebuild_error`. On success, the engine broadcasts
`studio:reloaded` (`reason: 'disable'`) so connected clients see
the refresh prompt toast.

Marketplace UI updated to read the new shape.

### Fixed — content/media route conflict

Studio core had a hand-coded 618-line `/admin/media` page. The
`content/media` extension shipped a thin v1 stub (89 lines). When
sync-extensions ran, it overwrote the rich Studio version with the
stub — a real regression discovered during the alpha.95 sanity
build. The extension now owns the rich page (618 lines copied
into `content/media/studio/pages/+page.svelte`); sync regenerates
the Studio route from the extension, no clobber.

### Docs

`docs/EXTENSION-AUTHORING.md` updated with two new sections:
- "Studio v2 — no per-extension build" — what's gone, what to
  ship instead, why.
- "Studio rebuild — what happens on enable/disable" — the actual
  response shape, the trade-offs (5s build, 50ms 503 swap window),
  what happens on build failure.

Plus the existing "What to avoid" list now flags shipping
`studio/dist/` or importing `@zveltio/sdk/studio` as hard errors.

## [1.0.0-alpha.95] - 2026-05-21

### Changed — extension model v2: every extension now aligned

Companion to alpha.94. The foundation lets the Studio rebuild
absorb extensions at build/install time; this release brings the
54 first-party extensions in line with that model.

In the `zveltio-extensions` sibling repo (separate commit), every
extension was stripped of its v1 build pipeline:

- `studio/dist/` — pre-built v1 bundles (the things that failed
  in the alpha.93 visual audit with
  "Failed to resolve module specifier 'svelte/internal/disclose-version'")
- `studio/vite.config.ts`, `studio/package.json`,
  `studio/node_modules/`, `studio/.turbo/` — per-ext build infra
- `studio/src/index.ts` — old `registerRoute(...)` bundle entry,
  called the dead `@zveltio/sdk/studio` API
- `studio/src/pages/*.svelte` — v1 page wrappers (redundant —
  `studio/pages/+page.svelte` is the real route)

Six extensions that only had v1 sources were promoted to v2:
`content/media`, `data/export`, `data/import`, `developer/byod`,
`i18n/translations`, `operations/traceability` (multi-page).

Net diff on the extensions repo: 314 files changed, 33 insertions,
47,638 deletions.

### Changed — Studio

- `scripts/sync-extensions.ts` (prebuild) now also copies each
  extension's `studio/src/` into `$lib/ext/<name>/`, mirroring
  what the runtime `studio-builder.ts` already does on install.
  Keeps dev parity with the production hot-install flow.

## [1.0.0-alpha.94] - 2026-05-21

### Changed — extension model v2 foundation

Strapi-style compile-time integration replaces runtime bundle loading.
First wave of the refactor agreed on in [docs/EXTENSIONS-V2-DESIGN.md].

**Engine**:
- `POST /api/marketplace/:name/enable` now AWAITS the Studio rebuild
  inline instead of fire-and-forget. The response carries the real
  outcome: `studio_rebuild: 'success' | 'failed' | 'skipped'`,
  `studio_rebuild_ms`, plus `studio_rebuild_error` on failure. No more
  guessing whether the rebuild finished.
- After a successful rebuild, the engine broadcasts a `studio:reloaded`
  WebSocket message to ALL connected clients (via `broadcastToAll` —
  not subscription-filtered).

**Studio**:
- Dropped `loadExtensionBundles()` from `(admin)/+layout.svelte`. That
  was the path that fetched extension Studio bundles as text, wrapped
  them in blob URLs, and dynamic-imported them — which failed for
  every extension that imported from `svelte/internal/*` (no import
  map). All 42 active extensions had this broken in alpha.93.
  Replaced with `installGlobalApi()` only — extensions now live in
  Studio's compiled route tree, no runtime bundle loading needed.
- `realtime.onSystem('studio:reloaded', ...)` listener in the admin
  layout shows a toast with a "Refresh now" action button so users see
  the new pages without manual reload.
- Marketplace page reads the new sync response shape; success / failed
  / skipped each get a specific message with timing.

**Trade-off accepted**: a Studio rebuild takes ~5s and briefly serves
~50 ms of 503s during the atomic swap. For an admin tool where
extension installs happen rarely, this is the correct cost — and it
eliminates every runtime resolution issue we hit in v1
(import-map missing, peer deps unresolved, Hono matcher locked, etc.).

### Not in this release (next wave)

- Disable flow parity (currently `disable` doesn't rebuild — old pages
  remain reachable in the bundle until next enable triggers a rebuild)
- `EXTENSION-AUTHORING-V2.md` developer guide
- Migration of pilot extensions to the v2 layout (crm, invoicing,
  approvals, mail, api-docs)
- Atomic blue/green swap to drop the 50ms 503 window
- Progress SSE endpoint for live rebuild feedback

## [1.0.0-alpha.93] - 2026-05-21

Visual audit run — Playwright headless captured 40 admin pages, then
read each PNG via the multimodal Read tool to actually look at the
rendered UI. Two quick UX fixes + documentation of one P0 architectural
issue that needs a design decision.

### Fixed

- **Collection cards no longer truncate long names with `…`.** Removed
  `truncate` on the title + slug in `collections/+page.svelte`, replaced
  with `break-words` plus a `title` attribute for tooltip-on-hover. Now
  "Stock movements", "Organizations", "inv_locations" render fully instead
  of "Stock…", "Organizati…", "inv_locati…".
- **AI Studio empty-state notice promoted from raw text to themed alert.**
  "No AI provider configured" was a `text-warning` `<p>` that blended
  into the background. Wrapped in `alert alert-warning alert-soft` with
  `role="status"` so screen readers announce it and the visual prominence
  matches its importance.

### Found, not yet fixed (logged in `docs/AUDIT-2026-05-21.md`)

- **P0 — All 42 active extension Studio bundles fail to load** with
  `Failed to resolve module specifier "svelte/internal/disclose-version"`.
  Extensions are built with Svelte as external; Studio has no import map
  in `app.html` so bare specifiers can't resolve at runtime. Three fix
  paths documented (bundle Svelte per-ext / Vite plugin import-map /
  Studio re-export at stable URL); each needs a few days of work and a
  design decision before implementation.
- **P1 — Browser session lost mid-audit** after ~24 sequential page
  loads. Possibly cookie-related; not reproducible from raw curl. Worth
  an investigation pass.

## [1.0.0-alpha.92] - 2026-05-21

### Fixed

- **Hot-enable of bundle-only extensions no longer fails with
  "Can not add a route since the matcher is already built".** A live
  sweep of all 54 marketplace extensions surfaced two consistent
  failures (`content/pdf-viewer`, `developer/views`) that both have
  a no-op `register()` plus a Studio bundle. The existing try/catch
  wrapped `extension.register()` but not the subsequent
  `app.get(bundleUrl, ...)`, so the matcher-built error from the
  bundle-route registration escaped and the enable response read
  `success: false`. Wrapped the bundle registration in the same
  defer-then-rebuild path. `triggerReload` then re-runs `loadExtension`
  on a fresh Hono app where both `register()` and the bundle route
  land cleanly.

### Added

- **`docs/AUDIT-2026-05-21.md`** — full audit of alpha.91:
  - Live sweep of all 54 extensions: 54/54 install, 42/54 enable
    (78%), 12 categorised failures with proposed fixes.
  - Code-size hotspots flagged (`extension-loader.ts` 2393 LOC,
    `collections/[name]` 1561 LOC) with split recommendations.
  - Missing features vs Supabase/Pocketbase/Directus.
  - Better implementations identified — notably a four-phase
    extension install (verify → stage → promote → verify-post) that
    would resolve three of the four failure categories.
  - Honest disclaimer on what was/wasn't verified — visual UI/UX,
    a11y dynamic, and per-extension Studio pages still need a human
    with a browser.

## [1.0.0-alpha.91] - 2026-05-21

### Changed

- **Code cleanup — historic markers removed.** Stripped 10 `Bug #N`
  prefixes and 18 sprint-code prefixes (`M4 FIX`, `P0 FIX`, `C2 FIX`,
  `H1 FIX`, `I4 FIX`, `S5-02` through `S5-08`, etc.) from non-test
  source. The labels were internal sprint trackers from the alpha
  pre-release cycle; once shipped they became confusing — a recent
  peer code review interpreted the markers as open bugs when they
  were actually annotations next to the fix code.

  Where the prefix carried no information beyond "this code exists",
  the whole comment was deleted. Where the prefix preceded a real
  explanation, only the prefix was removed and the explanation
  rephrased to stand on its own.

  No behaviour change. Functional verification against the WSL test
  instance: create / patch / drop collection, field rename, ERD
  layout PUT/GET, audit log capture, templates list, backup list,
  health endpoints — all unchanged.

## [1.0.0-alpha.90] - 2026-05-20

Four legitimate findings from a peer code review, all implemented.

### Added

- **WebSocket live sync in Studio.** New `realtime` store at
  `packages/studio/src/lib/stores/realtime.svelte.ts` opens one shared
  WS to `/api/ws`, subscribes per-collection on demand, and reconnects
  with exponential backoff. The collection detail page now subscribes
  automatically — inserts/updates/deletes from any other client refresh
  the grid within ~250 ms (debounced so a bulk update doesn't hammer
  the API). Disconnects cleanly on sign-out.
- **`withOptimistic` helper.** Tiny wrapper at
  `lib/stores/optimistic.svelte.ts` that captures a state snapshot,
  patches local state immediately, awaits the network call, and rolls
  back on failure. Applied to record delete on the collection detail
  page — the row disappears instantly instead of waiting for the
  round-trip.
- **SvelteKit error boundaries.** Four new `+error.svelte` pages
  (root, admin, client, intranet). Previously an unhandled error
  rendered SvelteKit's default white-screen fallback; now users get a
  themed page with a Retry button (invalidateAll) and a "back to
  dashboard" link, plus the raw error message in a collapsible block
  so they can paste it into a bug report.

### Fixed

- **Atomic collection create — no more ghost rows on enqueue failure.**
  `POST /api/collections` previously inserted metadata into
  `zvd_collections` and then enqueued the DDL job in two separate steps.
  pg-boss has its own connection pool so a Kysely transaction can't
  span both. Solution: if the enqueue throws, delete the metadata row
  we just inserted. The route now stays consistent with the physical
  schema on every error path.

## [1.0.0-alpha.89] - 2026-05-20

### Fixed

- **Info banners unreadable in light mode** on `/admin/rls`,
  `/admin/column-permissions`, and `/admin/rpc`. All three used
  hardcoded dark-mode colors:
  ```
  bg-blue-950/30 text-blue-300 border-blue-800/40
  ```
  In light mode this produced light-blue text on a light-blue
  background — invisible. Replaced with DaisyUI's `alert alert-info
  alert-soft` semantic classes, which auto-adapt to the active theme.
  Inline `<code>` blocks switched from `bg-blue-900/40` to `bg-base-300`
  for the same reason.

## [1.0.0-alpha.88] - 2026-05-20

### Fixed

- **REAL root cause of `Plus is not defined` on `/collections`.** Three
  pages have `<Plus ... />` in their template but never imported the
  icon — pre-existing bug from the alpha.82 UX overhaul that I missed
  because the previous diagnoses focused only on `CrudListPage`:
  - `routes/(admin)/collections/+page.svelte` — line 471
    (`<Plus size={13} /> Add field` inside the New Collection modal)
  - `routes/(admin)/api-keys/+page.svelte` — line 240
    (`<Plus size={12} /> Add scope`)
  - `routes/(admin)/tenants/+page.svelte`
- Verified the patched chunks now reference the Plus icon chunk
  (`B8cigCLj2.js`) at build time. Multi-line `import { ... } from
  '@lucide/svelte'` ran a precise sweep across every .svelte file —
  no other missing icon imports remain.

### Note

The `CrudListPage` template-inline `<Plus>` fix from alpha.87 stays
in place — it's correct defensive code that protects future callers
who rely on the default action icon. The actual user-visible bug was
upstream: the collections page itself referenced `Plus` without
importing it, so the icon binding was simply undefined at runtime
regardless of how `CrudListPage` handled defaults.

## [1.0.0-alpha.87] - 2026-05-19

### Fixed

- **`Plus is not defined` STILL not fixed on alpha.85/.86** despite two
  separate attempts. Rolldown was tree-shaking the icon binding even
  when it appeared in a `$derived(...)` expression. The pattern only
  worked locally — under code-splitting, the bundler placed the icon
  import in a sibling chunk that the action-button branch didn't pull
  in. Final fix: stop routing the icon through any binding at all and
  inline both branches in the template:

  ```svelte
  {#if actionIcon}
    {@const Icon = actionIcon}
    <Icon size={16} />
  {:else}
    <Plus size={16} />
  {/if}
  ```

  `<Plus>` appears as a real template tag now, which the bundler
  treats as a hard usage. Verified by inspecting `dist/_app/immutable`:
  the Plus icon chunk (`B8cigCLj2.js`) is referenced by the CrudListPage
  chunk's imports list.

## [1.0.0-alpha.86] - 2026-05-19

Audit pass on alpha.85 — found via Liviu's real WSL install + browser
testing. Tier-1 (UI-blocking) fixed; tier-2 polish fixes batched in.

### Fixed (UI-blocking)

- **Templates with reserved `status` field name failed silently** on
  install. The DDL job died with `column "status" specified more than
  once` (DDLManager auto-adds `status` as a system column) and left
  phantom metadata in `zvd_collections`. Renamed the conflicting field
  in `helpdesk` (`status → ticket_status`), `invoicing`
  (`status → invoice_status`), and `project` (two: `status →
  project_status` on projects, `status → task_status` on tasks).
- **Templates route now validates SYSTEM_FIELDS upfront.** Before, a
  template that referenced a reserved field name would enqueue the DDL
  job + leave ghost metadata. Now returns 400 before any side effects
  with a clear message naming the offending field.
- **ERD drag state was non-reactive.** `dragMode`, `cardDragName`, and
  `didMove` were plain `let` instead of `$state(...)`. Drag-to-move
  worked because position updates propagated through other reactive
  paths, but the cursor classes and the "didMove" border highlight
  stayed stale. All three are now `$state`. Pure-numeric drag offsets
  (dragStartX/Y, etc.) stay as plain locals since nothing renders them.

### Fixed (polish)

- **`<svelte:component>` modernised.** `NavLink.svelte` and `Slot.svelte`
  were the last two places using the deprecated dynamic-component tag.
  Replaced with the Svelte 5 runes idiom (`const Icon = $derived(...)`
  then `<Icon ...>`).
- **`InlineEdit` $state-referenced-locally warning.** Was
  `let draft = $state(value)` — Svelte 5 flagged the prop capture. Now
  initialises to `''` and is overwritten from `value` in `enterEdit()`,
  which was already the behaviour intended by the original code.

### Known issues (logged for alpha.87)

- A subset of marketplace extensions (`communications/mail`,
  `auth/saml`, `compliance/ro/efactura`) fail to activate on first
  install with `Cannot find package '<dep>'` even though the dep IS
  installed in `/opt/zveltio/extensions/node_modules/`. The compiled
  binary's dynamic-import resolver doesn't walk into the symlinked
  `node_modules` for some specifiers. 12 out of the 16 most common
  extensions install + enable cleanly.
- `geospatial/postgis` requires `CREATE EXTENSION postgis` in psql —
  that's a correct precondition, not a bug, but the install.sh + docs
  should call it out.

## [1.0.0-alpha.85] - 2026-05-19

### Fixed
- **Studio: "New Collection" button silently no-ops on alpha.83/.84**.
  `CrudListPage` destructured `actionIcon: ActionIcon = Plus` — Plus
  appeared only as a default value, rolldown tree-shook the binding, and
  the chunk at runtime threw `ReferenceError: Plus is not defined` the
  moment the action button rendered. Click handlers below the error were
  never reached, so the user saw a button that did nothing. Replaced the
  destructure default with `const ActionIcon = $derived(actionIcon ?? Plus)`,
  which keeps Plus reachable from the template path so the bundler
  preserves it. Affects every page that uses CrudListPage (the
  collections list is the most user-visible).

## [1.0.0-alpha.84] - 2026-05-19

### Fixed
- **Install failure on alpha.83**: the Studio-source tarball shipped only
  `packages/studio/`, but the Studio's `package.json` references
  `@zveltio/sdk: workspace:*`. On the install host there is no workspace
  root and no SDK alongside, so `bun install` failed with
  `error: @zveltio/sdk@workspace:* failed to resolve`.
- Release workflow now builds a self-contained Studio bundle: `studio/`
  + `sdk/` (pre-built) at the tarball root, with Studio's package.json
  rewritten to `"@zveltio/sdk": "file:../sdk"`. `install.sh` extracts to
  `${ZVELTIO_DIR}/studio-bundle/` and runs `bun install` inside
  `studio-bundle/studio/`. A `studio-src` symlink stays for back-compat
  with any extension scripts that hard-code the old path.

## [1.0.0-alpha.83] - 2026-05-18

v1.0 ship-readiness pack. Eleven P0 items closed plus a full visual schema
designer + first-class business templates + a public demo mode.

### Added

#### Performance
- Benchmark suite at `bench/` — REST CRUD, list + pagination, realtime WS,
  cold-start. Pocketbase comparison via `bench/compare/pocketbase/`.
- CI `perf-smoke` job that enforces p95 budgets and uploads the result JSON
  as an artifact (`PERF_BUDGET_*_P95_MS` overridable).

#### Reliability
- `docs/DISASTER-RECOVERY.md` — operator runbook (scenarios A–F, RPO/RTO
  targets) + `scripts/dr-drill.sh` quarterly drill (requires `ZVELTIO_ENV=drill`).
- `GET /api/health/ready` — kubernetes-style readiness probe (db + cache +
  migrations).
- `GET /api/health/deep` — comprehensive operator diagnostic with per-check
  timings + disk write canary.

#### Observability
- `observability/` — Prometheus + Grafana docker-compose with the
  pre-provisioned "Zveltio Engine Overview" dashboard.

#### Security & audit
- `scripts/audit-inventory.ts` — generates `docs/AUDIT-COVERAGE.md` listing
  every mutating route handler and whether it calls `auditLog()`. Coverage
  went from 7 % to 22 % (12 → 41 audited handlers).
- `scripts/audit-regression-check.ts` — locks 28 critical-path handlers
  into CI; PRs that drop an `auditLog()` call on a mandatory route fail
  the build.
- New `AuditEventType` values: `backup.*`, `pitr.*`, `approval.*`,
  `export.executed`.

#### Features
- **Five pre-built business templates** — CRM, Invoicing, Project Mgmt,
  Help Desk, Asset Inventory. One-click install via `/admin/templates`,
  engine endpoint `POST /api/templates/:id/install` creates collections in
  dependency order.
- **Visual schema designer** at `/admin/collections/erd`. Drag-to-arrange
  with **per-user server-side persistence** (table `zv_erd_layouts`, route
  `/api/erd/layout`, localStorage fallback). Force-directed auto-arrange
  (Fruchterman–Reingold). Export to PNG (@2×) + SVG. Inline editing on
  every card — double-click renames any field, pencil opens a popover for
  type + required. `PATCH /api/collections/:name/fields/:field` handles
  rename (incl. m2o/reference relations + zvd_relations sync), type change
  (lib/field-type-conversions.ts), and required toggle in one atomic call.
- **Public demo mode** — `DEMO_MODE=true` env flag. Engine middleware
  blocks destructive admin ops with HTTP 451 (`packages/engine/src/middleware/demo-mode.ts`).
  Studio shows a persistent banner; login surfaces throwaway credentials.
  Reproducible deploy via `demo/docker-compose.yml` + `demo/seed.sh` +
  hourly `demo/reset.sh` cron.

#### Community + go-to-market
- `CONTRIBUTING.md`, GitHub issue + discussion templates under `.github/`.
- Website: `/support` (Community / Indie / Business / Enterprise tiers)
  and `/demo` pages.

### Migrations
- `076_erd_layout.sql` — per-user ERD positions (`zv_erd_layouts`).

### Breaking changes
None. Every new endpoint, env flag, and middleware is additive.

### Tooling
- `scripts/sync-engine-version.ts` reworked to read the bumped SDK version
  and propagate to root + engine + studio (root + ignored packages are
  invisible to Changesets but must track the SDK version).

## [1.0.0-alpha.72] - 2026-05-10

### Changes

- **ESM + Import Maps for extension Studio bundles.** Extension bundles are now ES modules (`formats: ['es']`) instead of IIFE. Svelte runtime is shared via a browser-native import map in `app.html` — no more `window.__SvelteRuntime` globals, no version coupling in `vite.config.ts`. Extension developers write standard Svelte; the import map handles runtime resolution transparently.
- `hooks.client.ts` simplified — Svelte runtime exposure now handled entirely by import map.
- `generate-runtime.ts` prebuild script bundles Svelte sub-modules into `static/runtime/` at Studio build time.

---

## [1.0.0-alpha.71] - 2026-05-09

### Fixes

- **Extension Studio UIs no longer freeze.** All 54 extension bundles were built with Svelte 4 externals (`svelte/internal`) that don't exist in Svelte 5. Svelte 5 uses `svelte/internal/client` — since that module was never externalized, the full Svelte 5 runtime was bundled inside every extension IIFE, creating 54 competing Svelte instances on the same page and deadlocking reactive signals. All vite.config.ts files now use a function-based `external` that catches every `svelte/*` sub-path, with a globals map that includes `svelte/internal/client → window.__SvelteRuntime.internal_client` and `svelte/reactivity`.
- **Studio correctly exposes `svelte/internal/client` and `svelte/reactivity` to extension bundles.** `hooks.client.ts` now imports and exports both via `window.__SvelteRuntime` so extension globals can resolve them.
- **19 extension bundles now self-register on load.** `auth/ldap`, `auth/saml`, `billing`, `communications/mail`, `compliance/ro/*` (5), `content/page-builder`, `crm`, `developer/edge-functions`, `forms`, `geospatial/postgis`, `operations/traceability`, `search`, `sms`, `workflow/approvals`, `workflow/checklists` exported `register()` but never called it at IIFE load time. Added `register();` to each `src/index.ts`.

---

## [1.0.0-alpha.70] - 2026-05-09

### Fixes

- **Extension Studio UI now works on fresh installs.** `studio/dist/bundle.js` files were excluded by `.gitignore` (`dist/`) and never shipped. Added `!**/studio/dist/bundle.js` exception — all 54 extension bundles are now committed and served by the engine at `/ext/<name>/bundle.js`.
- **`zv_revisions` integration test race condition fixed.** Revision INSERT was fire-and-forget; test read the table before the row landed. Now awaited (errors still swallowed).

---

## [1.0.0-alpha.69] - 2026-05-09

### Fixes

- **Extension Studio UI now appears after marketplace install.** `reRegisterExtension()` (called during hot-reload when an extension is enabled/disabled) was registering the Hono bundle route but not updating the in-memory `bundleUrl` in `this.loaded`. This meant `GET /api/extensions` returned `"bundles": []` even after a hot-reload, so the Studio never injected the bundle `<script>` tag and showed the generic "Extension active" placeholder for every extension. `reRegisterExtension()` now keeps `bundleUrl` in sync with the current filesystem state.
- **Clearer warning when extension ZIP lacks a pre-built Studio bundle.** `downloadExtension()` now emits a `⚠️` warning if an extension has `studio/vite.config.ts` but no `studio/dist/bundle.js` in the downloaded package — pointing developers to re-upload with the bundle included.
- **Audit log now logs the actual error**, not just the event type, when an audit event fails to write to `zv_audit_log`.
- **Extension package resolution fixed for compiled binaries.** When running as a compiled Bun binary (`/opt/zveltio/zveltio`), dynamic imports resolve modules starting from the process CWD, not from the imported file's directory. `ensureExtensionCoreDeps()` now calls `maybeSymlinkNodeModules()` which creates `<CWD>/node_modules → <EXTENSIONS_DIR>/node_modules` on first startup if they differ. This makes `hono`, `zod`, `kysely`, `@hono/zod-validator` and all peer-dependency packages visible to the binary's resolver. Fixes load failures for: `geospatial/postgis`, `storage/cloud`, `auth/ldap`, `auth/saml`, `communications/mail`, `content/media`, `developer/graphql`, `operations/traceability`, `compliance/ro/efactura`.
- **CRM extension migrations hardened for pre-extension installs.** The old core schema had a `zvd_transactions` table without a `name` column. `001_init.sql` now adds `name` in its upgrade block; `003_missing_columns.sql` wraps `ALTER COLUMN name DROP NOT NULL` in a conditional `DO $$` block so it skips safely when the column was never present.
- **Extension manifest peer dependencies declared.** `storage/cloud` (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`), `developer/graphql` (`graphql`), and `content/media` (`@aws-sdk/client-s3`) now declare their peer dependencies so the engine auto-installs them on first activation.
- **`content/media` removed `nanoid` dependency.** Replaced with `crypto.randomUUID()` (Bun built-in) to eliminate an unshimmed npm import.
- **`geospatial/postgis` removed direct engine imports.** Replaced `import { checkPermission } from '@zveltio/engine/lib/permissions.js'` and `import { DDLManager } from '@zveltio/engine/lib/ddl-manager.js'` with `ctx.checkPermission` and inline SQL — engine-internal modules cannot be resolved from extension files at runtime.
- **Extension schema upgrade blocks for pre-extension installs.** `forms`, `content/page-builder`, `content/drafts`, and `content/document-templates` migrations now add missing columns via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` when the table already exists from a pre-extension core schema.

---

## [1.0.0-alpha.68] - 2026-05-09

### Fix

- **CI integration tests (12 failures) resolved.** `POST /api/collections` was returning 400 on fresh installs because `DDLManager.registerMetadata()` tried to INSERT `ai_search_enabled` and `ai_search_field` columns that no longer exist in the core schema after the AI extraction in alpha.67. These are AI-extension-owned columns managed by the extension's own migrations. Removed from core `DDLManager` INSERT, `updateCollectionMetadata()`, and `ZvdCollectionsTable` TS type. All cascading test failures (relations, API keys, webhooks, cursor pagination) are resolved.

---

## [1.0.0-alpha.66] - 2026-05-07

### Internal
- Version bump only (no functional changes shipped under this number; placeholder retained for changelog continuity).

---

## [1.0.0-alpha.67] - 2026-05-08

### Breaking / Architecture

- **AI is now an extension, not core.** All `/api/ai*`, `/api/zveltio-ai`, and `/api/ai-analytics` routes; the AI provider manager; embeddings; semantic search; text-to-SQL; schema generation; agentic ZveltioAI engine — all moved out of `packages/engine` and into `zveltio-extensions/ai/`. The extension is auto-activated on first boot when files are on disk, so out-of-the-box behaviour is unchanged for new installs.
- **`ctx.services` inter-extension service registry.** Extensions can now publish services (`ctx.services.register('ai.providers', …)`) and consume services published by other extensions (`ctx.services.get('ai.providers')`). This is the supported way for extensions to communicate; direct imports between extensions remain forbidden. See [docs/EXTENSION-AUTHORING.md](docs/EXTENSION-AUTHORING.md#inter-extension-services--ctxservices).
- **Topological extension loading.** Extensions declaring `dependencies` in `manifest.json` are now loaded after their providers. Cycles fail loudly. Missing dependencies emit a warning and the dependent extension still loads (services it expected may return null).
- **`ctx.internals.aiProviderManager` removed.** Consumers must use `ctx.services.get('ai.providers')` and add `{ "name": "ai" }` to manifest dependencies.
- **`ctx.internals` gained**: `enqueueDDLJob`, `validatePublicUrl`, `extractTextFromFile`, `sendNotification`. These are engine-internal helpers previously imported directly by AI code; they remain available for first-party extensions that need them.
- **RestrictedDb extended**: extensions may now access `zv_<extname>_*` tables (their own reserved namespace). Other `zv_*` system tables remain blocked.

### Migrations

- 8 AI migrations (`011_ai.sql`, `032_ai_embeddings.sql`, `033_ai_search_config.sql`, `034_ai_decision_step.sql`, `036_ai_task_trigger.sql`, `039_ai_query.sql`, `043_ai_embed_excluded_fields.sql`, `045_ai_memory.sql`) moved to `zveltio-extensions/ai/engine/migrations/` and renumbered as `001_ai_init.sql` … `008_memory.sql`. They now run on AI extension activation rather than at engine bootstrap.

### Messaging

- README, package.json, OpenAPI spec, install scripts, and systemd unit description updated from "BaaS" to "Self-hosted Business OS".
- `versions.json` corrected — no fictional 1.0.0 stable; `latest_alpha: 1.0.0-alpha.67`.
- New [FUNDING.md](FUNDING.md) — explicit "self-hosted only, no cloud" stance + funding plan (donations + paid extensions + future support contracts).

### Affected extensions (consumers updated to ctx.services)

- `communications/mail` — AI compose/summarize endpoints now use `ctx.services.get('ai.providers')`. Manifest: declares dependency on `ai`.
- `developer/validation` — AI rule-generation endpoint same. Manifest: declares dependency on `ai`.
- `storage/cloud` — internal `document-indexer` now takes the providers as a parameter rather than importing.

### Engine consumers updated

- `lib/flow-executor.ts` — `ai_decision` flow step now resolves AI via service registry; if AI extension isn't active, step is skipped with `usedFallback: true` instead of failing the flow.
- `lib/flow-scheduler.ts` — `ai_task` flow trigger calls `ai.runBackgroundTask` service, skips with warning if AI extension is inactive.
- `lib/data-quality.ts`, `lib/cloud/document-indexer.ts` — same pattern, fail-soft when AI is unavailable.
- `routes/data.ts` — auto-embedding hook removed; replaced by AI extension subscribing to `record.created` / `record.updated` events.

---

## [1.0.0-alpha.65] - 2026-05-07

### Fixes
- Extension migrations: all `CREATE INDEX` changed to `CREATE INDEX IF NOT EXISTS` — prevents "relation already exists" 422 errors when activating extensions on databases where tables were previously created (e.g. carried over from core engine or reinstall scenarios).
- `auth/saml` peerDependency: `node-saml` version changed from `^4.0.0` (non-existent on npm) to `^3.1.0` (latest stable).
- Studio Checklists page: was calling `/api/ext/checklists` — corrected to `/api/checklists` to match the extension's actual mount path.

---

## [1.0.0-alpha.64] - 2026-05-07

### Features
- Extension manifest metadata (`displayName`, `studio.pages`) is now returned by `/api/extensions` — Studio sidebar automatically shows active extensions as nav items under an "Extensions" group without requiring a compiled IIFE bundle.
- Extension catch-all page (`/extensions/[...path]`) now shows a friendly info page (name, description, "active" badge) for API-only extensions that have no Studio UI bundle, with correct multi-segment path matching for extensions like `compliance/ro/efactura`.

### Fixes
- Removed `@zveltio/engine` from `peerDependencies` in `zveltio-extensions/package.json` — Bun was trying to resolve it from npm during CI `bun install` and failing with a 404.

---

## [1.0.0-alpha.63] - 2026-05-07

### Fixes
- Extension hot-load: swallow Hono "matcher is already built" error when enabling an extension on a running server — extension is now marked loaded immediately and `triggerReload()` rebuilds routes on a fresh Hono app, so enabling from the Studio works without restarting the service.

---

## [1.0.0-alpha.62] - 2026-05-06

### Fixes
- `install.sh`: `chown` extensions directory to `${ZVELTIO_USER}` **before** running `bun install` — the directory was created as root so `sudo -u zveltio bun install` failed with EACCES when trying to create `node_modules/`.

---

## [1.0.0-alpha.61] - 2026-05-06

### Fixes
- `install.sh`: fixed `BUN_INSTALL` variable not being passed to the bun installer — `BUN_INSTALL=... curl | bash` sets it on `curl`, not on `bash`; changed to `curl | BUN_INSTALL=... bash` so the installer writes to `/usr/local/share/bun` as intended.

---

## [1.0.0-alpha.60] - 2026-05-05

### Breaking / Architecture

- **Extensions no longer use runtime engine imports** — all `@zveltio/engine-*` virtual packages and direct `../../../../packages/engine/src/...` imports removed from every extension. Engine internals are now injected via `ctx.internals.*` (see `docs/EXTENSION-AUTHORING.md`).
- **`Bun.plugin` shims removed** — `installExtensionShims()` deleted from `extension-loader.ts`. Shims never worked in compiled binaries; all extensions now rely on real `node_modules/` provisioned by `ensureExtensionCoreDeps()`.
- **SDK `ExtensionContext` extended** — `ctx.internals` namespace added: `aiProviderManager`, `dynamicInsert`, `introspectSchema`, `runQualityScan`, `invalidateRulesCache`, `runEdgeFunction`, `extensionRegistry`, `generatePDFAsync`, `renderTemplate`, `generatePDF`, `moveToTrash`, `scheduleFileIndexing`, `DataLoaderRegistry`, `checkQueryDepth`.
- **`buildExtensionInternals()`** exported from `extension-loader.ts`; engine passes the full internals object when calling `loadAll()` and `reRegisterExtension()`.

### Fixes

- **`install.sh`**: Bun now installed system-wide at `BUN_INSTALL=/usr/local/share/bun` (symlinked to `/usr/local/bin/bun`) instead of `/root/.bun/`. Fixes the WSL/Linux systemd case where the `zveltio` service user cannot access `/root/` (mode 700).
- **`install.sh`**: Added validation step — `sudo -u nobody /usr/local/bin/bun --version` — fails the install script if Bun is not readable by unprivileged users.
- **`install.sh`**: `bun install` for extension peer deps now exits non-zero on failure (removed silent error swallow).
- **Dockerfile**: Added `RUN mkdir -p /data/extensions && chown -R zveltio:zveltio /data` before `USER zveltio` — fixes "permission denied" when engine writes `node_modules/` into `/data/extensions/` as an unprivileged container user.
- All 57 extension `routes.ts` files refactored to accept `ctx: ExtensionContext` as single argument; route factories never import engine internals directly.
- All extension `engine/index.ts` files updated to call `myRoutes(ctx)` (was `myRoutes(ctx.db, ctx.auth)`).

### Docs

- Added `docs/EXTENSION-AUTHORING.md` — full contract for extension authors: folder layout, `manifest.json` fields, `engine/index.ts` shape, the `ctx` API, route patterns, migration guide, and what to avoid.

---

## [1.0.0-alpha.59] - 2026-05-04

### Fixes
- `ensureExtensionCoreDeps()` now falls back to direct npm tarball fetch + `tar` extraction when `bun` is not on PATH — fixes "Cannot find package 'hono'" on production compiled-binary installs (e.g. systemd service) where Zveltio is installed as a single binary and `bun` is not separately available. Affected every extension that imports `hono`/`zod`/`kysely`/`@hono/zod-validator` from `routes.ts` (i.e. all extensions with engine routes); only `content/pdf-viewer` worked previously because it has no runtime imports.

---

## [1.0.0-alpha.58] - 2026-05-03

### Fixes
- Extension loader: `this.ctx` is now set as the very first operation in `loadAll()` — prevents "ExtensionLoader not initialized" when `ensureExtensionCoreDeps()` throws and the error is swallowed by the outer `Promise.all().catch()`
- `ensureExtensionCoreDeps()` errors are now caught non-fatally inside `loadAll()` so a failing `bun install` never blocks loader initialization

---

## [1.0.0-alpha.57] - 2026-05-03

### Fixes
- Extensions: `ensureExtensionCoreDeps()` auto-installs hono/zod/kysely/@hono/zod-validator in extensions base dir on first startup — fixes "Cannot find package 'hono'" in production compiled binary where `Bun.plugin` shims don't intercept dynamic imports

---

## [1.0.0-alpha.56] - 2026-05-03

### Fixes
- CI: build SDK before engine typecheck so `@zveltio/sdk` dist types exist in fresh checkout

---

## [1.0.0-alpha.55] - 2026-05-03

### Fixes
- Engine `tsconfig.json`: removed deprecated `baseUrl` + `paths` — `@zveltio/sdk` is now a proper `workspace:*` devDependency, resolved via Bun workspace symlink and SDK `package.json` exports

---

## [1.0.0-alpha.54] - 2026-05-03

### Architecture
- `ZveltioExtension` is now the single source of truth in `@zveltio/sdk/extension` — engine imports the type from SDK, eliminating the duplicate definition
- `ExtensionContext` updated in SDK with full public API: `events`, `checkPermission`, `getUserRoles`, `DDLManager`, `cleanup`
- `AssetPreviewHandler` and `StudioExtensionAPI.registerAssetPreview` added to SDK extension types
- Engine `tsconfig.json` maps `@zveltio/sdk/*` to SDK dist for typecheck
- Website: repositioned as "Business OS, not BaaS" — hero H1, comparison section, all BaaS references updated
- Website: fixed install command (`sudo bash`), alpha badge, `~10x` qualifier, `S3-compatible` storage label

### Extensions (zveltio-extensions)
- All 37 `engine/index.ts` files updated to `@zveltio/sdk/extension` import pattern
- Fixed `name` field mismatch in 17 extensions (now matches `manifest.json` exactly)
- Added `getMigrations()` to all extensions with SQL migration files (was missing — migrations never ran)
- Fixed string concatenation in `getMigrations()` → `join(import.meta.dir, ...)`

### Fixes
- Removed spurious `@zveltio/cli@2.0.0`, `@zveltio/react@2.0.0`, `@zveltio/sdk@2.0.0`, `@zveltio/vue@2.0.0` tags from git
- CHANGELOG rewritten to reflect real version history (removed erroneous `[2.0.0]` entry)

---

## [1.0.0-alpha.53] - 2026-05-03

### Extensions
- `content/pdf-viewer` extension: Studio asset preview via iframe + client EmbedPDF components (`PdfViewer`, `PdfBlock`)
- `registerAssetPreview` added to `window.__zveltio` Studio extension API
- Storage page: clickable PDF preview modal using registered asset previewers

### Marketplace
- Removed OAuth login requirement — free extensions are public, no authentication needed
- License key system for paid extensions (`ext_license:<name>` in `zv_settings`)
- Added `POST /api/marketplace/license/:name` and `DELETE /api/marketplace/license/:name` endpoints
- Catalog response includes `has_license` field per paid extension

### Bug Fixes
- Fixed `worker-configuration.d.ts` TypeScript error in zveltio-apps (leftover Cloudflare Workers reference)
- Fixed marketplace page SSR crash (`window.location.search` at module level)
- Fixed build error (extra closing `</div>` in marketplace page)

---

## [1.0.0-alpha.52] - 2026-05-02

### Bug Fixes
- Removed extra closing `</div>` in marketplace page causing build failure

---

## [1.0.0-alpha.51] - 2026-05-01

### Marketplace
- Removed OAuth popup auth flow — replaced with per-installation license key model
- Studio marketplace shows catalog directly, no login wall for free extensions

---

## [1.0.0-alpha.50] - 2026-04-28

### Extensions
- `registerAssetPreview` API added to extension registry (Svelte 5 `$state`-based)
- Extension IIFE bundles can now register custom asset preview components

---

## [1.0.0-alpha.49] - 2026-04-24

### Platform
- Edge Functions: Bun Worker sandbox, TS transpile, CRUD + `/invoke` + `/logs` + public `/api/fn/:name`
- Distributed Tracing: HTTP SERVER spans, W3C traceparent propagation, `tracedFetch()`
- DB-driven Rate Limits: per-route and per-API-key limits stored in DB, cached in Valkey
- Performance Indexes: 7 CONCURRENTLY indexes on high-traffic tables
- Onboarding Wizard: 6-step wizard, auto-redirect on first login

### Alpha→Beta Features
- Webhook HMAC signing: auto-generated secrets, `X-Zveltio-Signature: sha256=...`, `/rotate-secret`
- Full-text search via `pg_trgm`: `search_text` column + GIN index, `websearch_to_tsquery OR ILIKE`
- Column-level permissions: read/write field access control per role
- Realtime Presence + Broadcast: SSE channels, Valkey sorted-set, in-memory fallback
- Mobile Push Notifications: FCM + APNS (JWT/HTTP/2)
- Query result caching: Valkey-backed, TTL via `QUERY_CACHE_TTL_SECONDS`

---

## [1.0.0-alpha.48] - 2026-04-03

### Engine Improvements
- `crypto.randomUUID()` replaces nanoid — native Bun UUID generation
- PDF generation rewritten with `pdf-lib` (~300KB vs ~1.2MB pdfkit)
- AI engine: enhanced text-to-SQL with READ ONLY transactions
- Valkey pipeline optimizations: atomic zadd/zremrangebyscore operations
- Memory-aware request throttling with `BUN_MEMORY_LIMIT` env var

### Dependencies
- Removed: `pdfkit`, `nanoid`, `graphql-dataloader`
- Added: `pdf-lib ^1.17.1`

---

## [1.0.0-alpha.1] to [1.0.0-alpha.47]

See git history for earlier changes.
