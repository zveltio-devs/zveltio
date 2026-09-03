# AGENTS.md

Guidance for AI coding agents working in this repository. Read this before
touching code. `CONTRIBUTING.md` and the docs under `docs/` carry more detail;
this file is the map.

## Project overview

**Zveltio** is a headless BaaS/CMS (Bun + Hono + PostgreSQL) that becomes a
self-hosted SaaS through signed, sandboxed extensions. Current version:
`3.0.0-beta.64` (source of truth: `packages/engine/package.json`). MIT license.

- The **engine** is headless: dynamic collections, auth (Better-Auth), RBAC
  (Casbin), row-level multi-tenancy enforced by Postgres RLS, REST/RPC API,
  realtime (WebSocket + LISTEN/NOTIFY), storage, audit trail, automation flows,
  webhooks, edge functions, AI providers, and a plugin runtime.
- The **Studio** is a SvelteKit 5 admin UI served by the engine at `/admin`
  (embedded build; the engine is framework-agnostic — everything is REST/WS).
- **Extensions** are plugins, not forks: TypeScript engine extensions mounting
  routes at `/ext/<name>/`, plus Svelte 5 Studio extensions. Signed with
  Ed25519, verified at install. First-party extensions live in a **separate
  repo** (`zveltio-extensions`, conventionally cloned as a sibling directory
  `../zveltio-extensions`) — not in this tree.

## Repository layout

Bun workspaces + Turborepo monorepo. Packages under `packages/*`:

| Package | Path | Purpose |
|---|---|---|
| `@zveltio/engine` | `packages/engine` | The server. All core logic, routes, tests. |
| `@zveltio/studio` | `packages/studio` | SvelteKit 5 admin UI (embedded into engine). |
| `@zveltio/client` | `packages/client` | End-user facing SvelteKit app (portals etc.). |
| `@zveltio/sdk` | `packages/sdk` | Public SDK. Subpath exports: `./extension`, `./codegen`, `./validate`, `./testing`, `./publish`, `./build`, `./studio`, `./ddl`, `./rpc`, `./offline`. **API-stable surface** — do not break it. |
| `@zveltio/react` / `@zveltio/vue` | `packages/sdk-react`, `packages/sdk-vue` | Thin framework bindings over the SDK. |
| `@zveltio/cli` | `packages/cli` | `zveltio` binary (commander): install, extension init/publish/validate. |

Other top-level directories:

- `scripts/` — repo-level gate/check/maintenance scripts run via `bun run` (see
  Quality gates below). `scripts/sql/` holds SQL helpers.
- `e2e/` — Playwright end-to-end specs (`e2e/tests/*.spec.ts`).
- `bench/` — reproducible performance suite (see `bench/README.md`).
- `docs/` — the unified documentation, in five chapters: `platform/`,
  `engine/`, `studio/`, `ui/`, `extensions/`. Start at `docs/README.md`.
  `docs/adr/` holds architecture decision records; `docs/private/` holds
  internal engineering plans that are cited from source code and must keep
  stable paths.
- `quality-gates/` — JSON baselines for ratchet-style checks (lint warnings,
  `any` counts, coverage, ambient authority, etc.). Do not edit these by hand
  to make a failing gate pass.
- `docker-compose.yml` (+ `.dev`, `.ai`, `.electric` variants) — full runtime
  stack: Postgres, PgDog pooler, Valkey, SeaweedFS storage, Prometheus,
  Grafana, engine.
- `charts/zveltio/` — Helm chart. `install/` — bare-metal/Proxmox installer
  scripts. `release/` — built binaries + checksums.

### Engine internals (`packages/engine/src/`)

- `index.ts` — Hono app assembly, middleware order, boot sequence.
- `routes/` — HTTP routes (`/api/*`); `routes/admin/` for admin endpoints.
  Core routes are registered via `registerCoreRoutes` in `routes/index.ts`.
- `lib/` — domain modules: `data/` (collections, DDL), `tenancy/` (RLS,
  tenant manager, request-scoped DB), `extensions/` (loader, runtime),
  `flows/` (automation), `runtime/`, `storage/`, `security/`, plus worker/WASM
  extension hosts (`worker-extension-*.ts`, `wasm-extension-host.ts`).
- `db/` — Kysely setup, migrations (`db/migrations/`), `migrate.ts`
  (`bun run db:init`), auto-migrate, generated schema.
- `middleware/` — auth gates, tenant resolution, rate limiting.
- `field-types/` — core field type registry.
- `tests/` — `unit/`, `integration/`, `harness/`, `stress/`, `fixtures/`.
- `extensions/` — **gitignored runtime install cache**, NOT extension source.
  See footguns below.

## Tech stack

- **Runtime: Bun 1.3+** (package manager pinned to `bun@1.3.14`). Not Node.
- **Language:** TypeScript 5.4+, ESM throughout (`"type": "module"`).
- **Web:** Hono 4.13+ (typed RPC, `@hono/zod-validator`). The pin is exact and
  shared with `zveltio-extensions`: hono is BUNDLED into every extension
  artifact and into the worker runtime source, so bumping the version in
  `node_modules` does not reach them. `check:embedded-deps-fresh` reads the
  version out of the built artifacts; `check-dep-lockstep` keeps the two repos
  together. A security release needs a repack, not a bump.
- **Database:** PostgreSQL 18 with pgvector (both CI and `docker-compose.yml`
  pin `pgvector/pgvector:pg18`); Kysely query builder; PgDog connection pooler
  in deployments; pg-boss job queue; squawk for DDL linting.
- **Auth/Z:** Better-Auth 1.7+ (sessions, OAuth, passkeys, 2FA) + Casbin
  policies + Postgres FORCE RLS keyed on a per-transaction GUC.
- **Cache/realtime:** Valkey 8 (Redis-compatible). **Required, not optional**
  — a production boot without `VALKEY_URL` is refused by
  `productionGuardViolations`. Without it the permission and identity caches
  degrade in silence: `isGodUser` and `resolveUserRole` hit the database on
  every request, and a revoked grant reaches only the replica that revoked it.
  An operator who genuinely has no cache must say so with
  `ZVELTIO_ALLOW_NO_CACHE=1`.
- **Frontend:** SvelteKit 2 + Svelte 5 runes, Tailwind 4 + daisyUI,
  Paraglide JS (inlang) for i18n, Layerchart/D3, TipTap.
- **Tooling:** Biome 2 (lint+format), Turborepo, Vitest (studio/client),
  `bun test` (engine), Playwright (e2e), Stryker (mutation),
  Changesets (versioning), OpenTelemetry.

## Build and dev commands

Prereqs: Bun ≥ 1.3.13, PostgreSQL 18 with pgvector, Valkey 8. All commands from
repo root unless noted.

```sh
bun install
cp .env.example .env          # fill required secrets; see .env.example comments
docker compose up -d db cache # or the full stack / infra-only compose

bun run dev                   # turbo: engine with --watch (and other dev targets)
bun run build                 # turbo build all packages
bun run typecheck             # turbo typecheck all packages
bun run check                 # biome check (lint + format, read-only)
bun run check:fix             # biome check --write

# Studio embedded into the engine (required for /admin to work):
bun run studio:build && bun run studio:embed
```

Per-package (run inside the package dir):

- `packages/engine`: `bun run dev` (hot reload), `bun run build`,
  `bun run build:binary` (compiled binary), `bun run db:init` (create/migrate
  dev DB), `bun test`.
- `packages/studio`: `bun run dev` (Vite on :5173; set `VITE_ENGINE_URL`
  for split dev), `bun run build`.
- `packages/sdk`, `sdk-react`, `sdk-vue`: `bun run build` (tsc/bun build),
  `bun run typecheck`.

Native binaries are built with `bun run build:binary` (Bun `--compile`);
`Dockerfile` is a multi-stage build (frontend → engine binary).

## Testing

Three test systems, plus e2e:

- **Engine unit tests** — `bun test` via Bun's test runner:
  `cd packages/engine && bun run test:unit` (`src/tests/unit/`).
  Coverage: `bun run test:unit:coverage`; gate: root `bun run coverage:gate`.
- **Engine harness tests** — `cd packages/engine && bun run test:harness`
  (boot engines against a real Postgres). **Require
  `TEST_DATABASE_URL`** — CI uses
  `postgresql://postgres:postgres@localhost:5432/zveltio_test` with `pg_trgm`
  and `vector` extensions. One-shot local setup: `scripts/setup-test-db.sh`
  (Debian/Ubuntu, needs sudo).
- **Engine integration tests** — `cd packages/engine && bun run test:integration`
  (start an out-of-process engine; need a database and, per CI, a
  user granted the `god` role for admin routes).
- **Studio/client component tests** — Vitest:
  `cd packages/studio && bun run test`.
- **E2E** — Playwright from repo root: `bun run test:e2e`
  (config `playwright.config.ts`; specs in `e2e/tests/`). `bun run test:e2e:ui`
  for the UI runner.
- Root `bun run test` runs `turbo run test` across packages. Turbo's
  `passThroughEnv` in `turbo.json` already forwards `TEST_DATABASE_URL`,
  `DATABASE_URL`, `BETTER_AUTH_SECRET`, `VALKEY_URL`, `S3_*`, etc. — if tests
  can't see env vars, check that list, not the test code.

Run tests on Linux, macOS, or WSL2. **Do not run `bun test` on native
Windows** — Bun's symlinked package store causes spurious `EACCES` failures
there (documented Bun limitation, not a project bug).

Mutation testing (security-focused): `cd packages/engine && bun run
test:mutation` (Stryker). Benchmarks: see `bench/README.md`
(`bench/runner.ts`, `bench/soak.ts`).

## Code style guidelines

Enforced by Biome (`biome.json`) and code review (`CONTRIBUTING.md`):

- **Format:** 2-space indent, 100-char line width, LF, single quotes,
  trailing commas, semicolons, arrow parens always. Run `bun run check:fix`
  before pushing.
- **`noExplicitAny` is an error** outside tests; a ratchet script
  (`bun run any:ratchet`) tracks the baseline in
  `quality-gates/any-baseline.json`. New `any` fails the gate.
- **Runtime is Bun, not Node.** Use `Bun.file`, `Bun.spawn`, `Bun.write` —
  not `fs`/`child_process`.
- **Database access via Kysely only** — no raw SQL string concatenation; use
  the `sql` template tag for parameterised queries. Custom gates enforce this
  (`check:raw-sql`, `sql:backticks`, `sql:numeric-arith`).
- **Studio uses Svelte 5 runes** (`$state`, `$derived`, `$effect`). No legacy
  stores in new code.
- **Auth guard on every admin route** — copy the pattern from an existing
  route under `packages/engine/src/routes/admin.ts`. Privileged routes must
  call `auditLog()` (enforced by `scripts/audit-regression-check.ts`).
- **Comments explain *why*, not *what*; one line.** If a comment isn't
  surprising, delete it. This codebase's existing comments are a good model
  (they often record which past bug a line prevents).
- **New dependencies: default answer is no.** The engine intentionally has
  ~10 direct deps. Inline small helpers; open a discussion for anything big.
- No new patterns when an existing one works; three similar uses justify a
  helper, one doesn't.

## Quality gates (repo-specific, run before pushing)

The root `package.json` defines a `prepush` chain — this is the local contract
for a pushable tree:

```sh
bun run prepush
# = check:schema + check:table-owners + check:schema-snapshot
#   + check:atomic-writes + check:pooldb-txn + check:tenant-on-pool
#   + check:shared-keys + scripts/import-boundaries.ts + check:raw-sql
#   + sql:backticks + any:ratchet + lint:ratchet + format:check + typecheck
```

Notable custom gates (all in `scripts/`, all run via `bun run <name>` from
root):

- `check:schema` — regenerates SDK schema types and fails on drift.
- `check:schema-snapshot` / `check:ext-snapshot` / `check:studio-embed` —
  freshness checks for generated artifacts (installed-schema snapshot,
  extension snapshot, embedded Studio build). If you change the schema, Studio
  build, or extension contracts, regenerate rather than editing snapshots.
- `check:atomic-writes`, `check:pooldb-txn`, `check:tenant-on-pool` —
  transaction/tenant-safety invariants.
- `check:shared-keys`, `ext:i18n-ownership` — i18n message-key consistency
  between engine, Studio, and extensions.
- `catch:fabricated`, `ext:ambient`, `ext:seam` — extension-sandbox and
  error-handling honesty checks.
- `release:gate:dry` — dry-run of the full release gate.

Many generated files exist (embedded migrations, worker runtime source, Studio
dist). Regenerate them with the corresponding `gen:`/`check:` scripts; never
hand-edit (Biome's ignore list in `biome.json` is a good indicator of what's
generated).

## Database, migrations, multi-tenancy

- Schema changes ship as SQL migrations under
  `packages/engine/src/db/migrations/sql/` (numbered `NNN_name.sql`), embedded
  into the binary via `bun run gen:migrations` **from `packages/engine`** (it is
  a package script, not a root one; regenerates `db/migrations/embedded.ts`).
  `zveltio start` auto-migrates. squawk lints
  DDL safety in CI (`migrate-safety.yml`).
- Collections are dynamic — routine user schema changes need no code-side
  migration; the DDL manager lives in `packages/engine/src/lib/data/`.
- **Tenant isolation is Postgres-enforced**: FORCE RLS keyed on a
  per-transaction GUC; tenant-scoped transactions switch to a plain
  `zveltio_rls` role. The engine's own DB role must not be `SUPERUSER` or
  `BYPASSRLS` in multi-tenant deployments — read
  `docs/private/MULTI-TENANT-ENABLEMENT.md` before touching tenancy. Do not
  "fix" it with blanket `ALTER ROLE … NOSUPERUSER` (breaks `CREATE EXTENSION`);
  the doc explains the right shape.
- CI sets `DB_POOL_MAX=10` at workflow level because CI boots many engines
  against one Postgres. Left unset, the engine does NOT use a fixed default: it
  reads the server's `max_connections` and sizes the pool from it, falling back
  to `DEFAULT_DB_POOL_MAX = 40` only when it cannot read them (see
  `packages/engine/src/db/index.ts`). Keep `pool_max × engines ≤
  max_connections` in mind when adding test jobs.

## Extension system

- Engine extensions mount Hono routes at `/ext/<name>/`, declare migrations,
  hooks (pre/post-write), cron; Studio extensions are Svelte 5 components
  copied into the Studio route tree on enable.
- Community extensions run **worker-isolated** (separate process, restricted
  SQL allowlist of user tables + own `zv_<ext>_*` namespace, reserved
  connection with statement timeout, `zveltio_worker` DB role with no grants
  on Better-Auth tables). Optional WASM runtime for strict isolation.
- Extension dev loop, manifest v2 schema, and publishing:
  `docs/extensions/developer-guide.md` (§12 covers the local loop).
  Scaffold with `zveltio extension init <name>`.
- The SDK extension surface (`ZveltioExtension`, `@zveltio/sdk/extension`,
  manifest v2, marketplace flow, worker isolation contract) is **API-stable in
  beta — do not break it**. Engine internals and Studio layout may move.

## Common footguns (bite contributors regularly)

- **`packages/engine/extensions/` is a runtime install cache, not source.** It
  is gitignored. Set `EXTENSIONS_DIR=/absolute/path/to/zveltio-extensions` in
  `.env` (or clone that repo as `../zveltio-extensions`). Resolution order:
  `EXTENSIONS_DIR` → `./extensions/` (CWD) → sibling repo. To reset: stop
  engine, delete `packages/engine/extensions/*`.
- **`studio-dist/` is resolved relative to CWD.** If `/admin` shows "Setup
  Required", run `bun run studio:build && bun run studio:embed` from repo root.
- **Split dev CORS:** Studio on :5173 + engine elsewhere needs
  `CORS_ORIGINS=http://localhost:5173,...` and
  `VITE_ENGINE_URL=http://localhost:<PORT>` (see
  `packages/studio/src/lib/config.ts`).
- **Hono matches paths exactly and resolves in registration order.** Static
  routes registered after same-method `:param` routes get shadowed —
  `scripts/route-collision-check.ts` gates this.
- `/api/thing/` (trailing slash) 308-redirects to `/api/thing` — intentional.
- `.env` is required and gitignored; `.env.example` is the template. Compose
  refuses to start with empty required secrets — intentional, not a bug.

## Security considerations

- **Vulnerabilities: do NOT open public issues.** Email `security@zveltio.com`;
  policy in `docs/platform/security-model.md`. (There is no root `SECURITY.md` — if
  you add one, GitHub will surface it in the repo's Security tab, which is
  where a researcher looks first.)
- Secrets come from `.env` / env vars only. `BETTER_AUTH_SECRET` signs session
  cookies **and** keys field encryption — rotating it invalidates sessions and
  breaks encrypted secrets. `FIELD_ENCRYPTION_KEY` is separate.
- Tenant/RLS rules: never bypass the request-scoped DB
  (`createRequestScopedDb`) for tenant data; the tenancy gates above exist
  because regressions here are cross-tenant data leaks.
- Extension installs verify Ed25519 signatures by default
  (`REQUIRE_EXTENSION_SIGNATURES=false` only for unsigned private mirrors;
  extra signers go in `REGISTRY_PUBLIC_KEYS_JSON`).
- Edge functions run in a separate process per invocation with a minimal env
  by default; `EDGE_SANDBOX_MODE=worker` is the faster but weaker in-process
  mode.
- Worker isolation is a guard-rail, not an adversarially-tested sandbox —
  treat untrusted community extensions accordingly.
- Outbound webhooks are HMAC-signed. Audit log covers every write; GDPR
  right-to-erasure is built in.

## CI, release, deployment

- GitHub Actions in `.github/workflows/`: `ci.yml` (typecheck, lint, unit +
  harness + integration tests, audit-regression and route-collision checks,
  benchmarks), `e2e.yml`, `studio.yml`, `client.yml`, `migrate-safety.yml`
  (squawk), `mutation.yml`, `soak.yml`, `release.yml`, `publish-npm.yml`,
  `build.yml`, `upgrade-path.yml`, `dr-smoke.yml`. Actions are pinned by SHA.
- CI clones `zveltio-extensions` as a sibling (`../zveltio-extensions`),
  using a paired branch when one exists with the PR's branch name.
- Versioning: Changesets. Add a changeset (`bun run changeset`) for any
  user-visible change. Linked packages: sdk, react, vue, cli. Engine, Studio,
  and client are ignored (private, versioned with the repo).
  `bun run version-packages` bumps versions and syncs the engine version.
- Commit style: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`,
  `refactor:`, `test:`), subject ≤ 72 chars, body explains *why*. One feature
  per PR. Open an issue first for anything bigger than a typo.
- Deployment artifacts: multi-stage `Dockerfile`, `docker-compose.yml` (full
  stack with PgDog/Valkey/SeaweedFS/Prometheus/Grafana), Helm chart in
  `charts/zveltio/`, bare-metal installers in `install/`, plus `fly.toml`,
  `railway.json`, `render.yaml`. Compiled binaries for linux-x64,
  linux-x64-baseline, linux-arm64, macos-x64, macos-arm64 — no Windows binary.
- Observability: OpenTelemetry tracing, Prometheus metrics endpoint, Grafana
  dashboards in `grafana/` and `observability/`.

## Documentation map

Everything lives under `docs/`, in five chapters. **Start at
[`docs/README.md`](docs/README.md)** — it is the index and the reading order by
role.

| Chapter | Read it when |
|---|---|
| `docs/platform/` | Product overview, architecture, install, configuration, multi-tenancy, security, operations, development workflow, known gaps |
| `docs/engine/` | The server: API reference, collections, ghost DDL, auth, webhooks, SDK, CLI |
| `docs/studio/` | The admin SPA: routing, data access, extension pages, i18n |
| `docs/ui/` | Design system, component library, interaction patterns, SDUI |
| `docs/extensions/` | The extension system, the developer guide, and the 56 official extensions |

Read before you touch the thing they describe:

- `docs/platform/multi-tenancy.md` — how tenant isolation actually works,
  written for auditors. Read it before answering any question about tenancy,
  and before assuming what a reviewer will assume.
- `docs/platform/security.md` — the threat model, and the list of patterns that
  look like findings and are not.
- `docs/platform/known-gaps.md` — what is knowingly unfinished.

Also:

- `README.md` — positioning and feature overview (canonical; mirror edits in the
  website frontpage, per its header comment).
- `CONTRIBUTING.md` — dev setup, code rules, PR conventions.
- `docs/private/` — internal plans. `HARDENING-9-PLAN.md` is cited by ~1100
  `biome-ignore` comments and must not move. `TECHNICAL-GAPS.md` is the roadmap.
- `bench/README.md` — benchmark methodology.
- `CHANGELOG.md` — release history (large; grep it, don't read it whole).

**The docs are also the source for zveltio.com.** The website repository syncs a
selected subset at build time, driven by the `PAGES` manifest in its
`scripts/sync-docs.mjs`. Before moving or renaming anything under `docs/`, grep
the tree for the path — several documents are cited from source comments and
from runtime error messages, and one is parsed by a unit test.
