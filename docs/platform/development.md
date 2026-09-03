# Development

How to work on Zveltio: environment, commands, tests, quality gates, and the
conventions that reviewers enforce.

> The short operational map is [`../../AGENTS.md`](../../AGENTS.md). Contribution
> process and PR conventions are in
> [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md). This document is the long
> form of the engineering workflow.

---

## 1. Environment

Prerequisites: **Bun ≥ 1.3.13** (pinned `bun@1.3.14`), **PostgreSQL 18 with
pgvector**, **Valkey 8**. Linux, macOS or WSL2.

```sh
bun install
cp .env.example .env            # fill required secrets
docker compose up -d db cache   # or the full stack
bun run dev                     # turbo: engine with --watch, plus other dev targets
```

Studio must be built and embedded for `/admin` to work:

```sh
bun run studio:build && bun run studio:embed
```

**Do not run `bun test` on native Windows.** Bun's symlinked package store
causes spurious `EACCES` failures there — a documented Bun limitation, not a
project bug.

### Required environment variables

`DATABASE_URL`, `BETTER_AUTH_SECRET`, `FIELD_ENCRYPTION_KEY`,
`MAIL_ENCRYPTION_KEY`, `AI_KEY_ENCRYPTION_KEY`. Production additionally requires
`VALKEY_URL`. Full reference: [configuration.md](configuration.md).

`BETTER_AUTH_SECRET` signs session cookies **and** keys field encryption —
rotating it invalidates sessions and breaks encrypted secrets.
`FIELD_ENCRYPTION_KEY` is separate.

### Extensions during development

`packages/engine/extensions/` is a **gitignored runtime install cache**, not
source. Point the engine at the real source with
`EXTENSIONS_DIR=/absolute/path/to/zveltio-extensions`, or clone that repository
as a sibling. Resolution order: `EXTENSIONS_DIR` → `./extensions/` relative to
CWD → sibling repository. To reset: stop the engine and delete
`packages/engine/extensions/*`.

---

## 2. Tests

Four lanes, in increasing cost:

| Lane | Command | Needs |
|---|---|---|
| Engine unit | `cd packages/engine && bun run test:unit` | nothing |
| Engine harness | `cd packages/engine && bun run test:harness` | real Postgres via `TEST_DATABASE_URL` |
| Engine integration | `cd packages/engine && bun run test:integration` | a database, plus a user granted the `god` role |
| Studio / client | `cd packages/studio && bun run test` (Vitest) | nothing |
| E2E | `bun run test:e2e` (Playwright, from root) | a browser; specs in `e2e/tests/` |

One-shot local database setup: `scripts/setup-test-db.sh` (Debian/Ubuntu, needs
sudo). CI uses
`postgresql://postgres:postgres@localhost:5432/zveltio_test` with the `pg_trgm`
and `vector` extensions.

The **harness lane is where authorization behaviour is pinned** — it boots a
real engine against a real database. A failing harness test is the most
convincing artifact for a suspected security defect.

Turbo's `passThroughEnv` in `turbo.json` forwards `TEST_DATABASE_URL`,
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `VALKEY_URL`, `S3_*` and others. If tests
cannot see an environment variable, check that list before suspecting the test.

Mutation testing (security-focused): `cd packages/engine && bun run test:mutation`.
Benchmarks: [`../../bench/README.md`](../../bench/README.md).

> The rules in this section are not style preferences — each one exists because
> a specific measurement lied. The incidents are in
> [history.md](history.md#6-the-lesson-that-produced-the-working-method).

### Two traps that produce false results

**Two sessions sharing one test database destroy each other.** The failures look
like a regression rather than a collision — since the single-god change, the
symptom is mass `403`, which reads exactly like an authorization regression. Use
a database per session, and run `pgrep -af "bun test packages"` before starting
anything long.

**A coverage baseline goes stale against master.** The gate compares against a
stored number, not against master. Check that before writing tests to close a
gap that may not exist. A symlinked `node_modules` in a worktree also falsifies
the measurement.

---

## 3. Quality gates

The root `package.json` defines `prepush` — the local contract for a pushable
tree:

```sh
bun run prepush
# check:schema + check:table-owners + check:schema-snapshot + check:atomic-writes
# + check:pooldb-txn + check:tenant-on-pool + check:shared-keys
# + scripts/import-boundaries.ts + check:raw-sql + sql:backticks
# + any:ratchet + lint:ratchet + format:check + typecheck
```

`prepush` is **not wired to a git hook** — run it yourself.

Notable gates, all in `scripts/` and run via `bun run <name>`:

| Gate | Enforces |
|---|---|
| `check:schema`, `check:schema-snapshot` | Generated SDK types and the installed-schema snapshot are fresh |
| `check:ext-snapshot`, `check:studio-embed` | Extension snapshot and embedded Studio build are fresh |
| `check:atomic-writes` | Multi-statement writes are in a transaction |
| `check:pooldb-txn`, `check:tenant-on-pool` | Tenant data never reaches the unscoped pool |
| `check:raw-sql`, `sql:backticks`, `sql:numeric-arith` | No SQL string concatenation; no string arithmetic on numerics |
| `check:shared-keys`, `ext:i18n-ownership`, `check-i18n-core` | i18n message-key consistency across engine, Studio and extensions |
| `catch:fabricated` | No `catch` block that reports success on failure. Baseline is **0** in both repositories; annotate a genuine exception with `// fabricated-ok: <reason>` |
| `ext:ambient`, `ext:seam` | Extension sandbox and insert/schema agreement |
| `check:rule-interpreters` | A row rule is interpreted in exactly one place |
| `any:ratchet`, `lint:ratchet` | `noExplicitAny` and lint-warning counts never grow |
| `audit:gates` | The meta-gate: that the gates themselves run |
| `release:gate:dry` | Dry run of the full release gate |

Baselines live in `quality-gates/*.json`. **Do not edit a baseline by hand to
make a failing gate pass** — that is the failure mode the ratchet exists to
prevent.

Generated artifacts (embedded migrations, worker runtime source, Studio dist,
schema snapshots) are regenerated by their `gen:`/`check:` scripts, never
hand-edited. Biome's ignore list in `biome.json` is a good indicator of what is
generated. Note that **editing a generated artifact at its destination is
silently reverted by the next build** — edit the source.

### Gates that scan the sibling repository

Several gates read `../zveltio-extensions`, and the path is **hardcoded** —
`argv` is ignored. This creates a circular dependency between the two
repositories during a coordinated change: land the engine side first.
`check-i18n-core` does *not* read the sibling, so its failures are always real.

---

## 4. Code conventions

Enforced by Biome (`biome.json`) and by review:

- **Format:** 2-space indent, 100-char lines, LF, single quotes, trailing
  commas, semicolons, arrow parens always. `bun run check:fix` before pushing.
- **`noExplicitAny` is an error** outside tests.
- **Runtime is Bun, not Node.** `Bun.file`, `Bun.spawn`, `Bun.write` — not
  `fs`/`child_process`.
- **Database access via Kysely only.** Use the `sql` template tag for
  parameterised queries; never concatenate.
- **Svelte 5 runes** (`$state`, `$derived`, `$effect`) in Studio. No legacy
  stores in new code.
- **Auth guard on every admin route.** Privileged routes must call `auditLog()`;
  `scripts/audit-regression-check.ts` enforces it.
- **Comments explain *why*, not *what*, in one line.** If a comment is not
  surprising, delete it. The strongest convention in this codebase is that a
  comment at a fix site records the bug that line prevents — that is why the
  audit reports could be retired: their findings live at the code they fixed.
- **New dependencies: the default answer is no.** The engine has roughly ten
  direct dependencies deliberately.
- **No new pattern when an existing one works.** Three similar uses justify a
  helper; one does not.

### Commits and PRs

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`,
`test:`), subject ≤ 72 characters, body explains *why*. One feature per PR.
Add a changeset (`bun run changeset`) for any user-visible change.

**Never commit or push without explicit approval.** Cutting a release is a
manual, owner-only decision.

---

## 5. CI

GitHub Actions in `.github/workflows/`, all pinned by SHA:

`ci.yml` (typecheck, lint, unit + harness + integration, audit-regression and
route-collision checks, benchmarks), `e2e.yml`, `studio.yml`, `client.yml`,
`migrate-safety.yml` (squawk DDL linting), `mutation.yml`, `soak.yml`,
`release.yml`, `publish-npm.yml`, `build.yml`, `upgrade-path.yml`,
`dr-smoke.yml`, `version.yml`, `dependabot-lockfile.yml`, `deprecate-npm.yml`.

CI sets `DB_POOL_MAX=10` at workflow level because it boots many engines against
one Postgres. Left unset, the engine sizes its pool from the server's
`max_connections`, falling back to `DEFAULT_DB_POOL_MAX` only when it cannot
read them. Keep `pool_max × engines ≤ max_connections` in mind when adding jobs.

**Local green plus CI red on unchanged code** usually means a dependency drifted
— check npm publish dates before suspecting your change.

---

## 6. Dependency changes

A dependency bump has **three consequences in the extensions repository**, each
caught by a different gate and each costing a CI round: pin exactly, repack the
bundles, bump the extension versions.

Seven dependencies — `hono` among them — must be pinned exactly and match the
engine's `bun.lock`, because they are **bundled into every extension artifact**.
Bumping the version in `node_modules` does not reach them:
`check:embedded-deps` reads the version out of the built artifact, and
`check-dep-lockstep` keeps the two repositories together. A security release
needs a repack, not a bump.

Branch per dependency, no auto-merge.
