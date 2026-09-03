# Contributing to Zveltio

Thanks for considering it. Zveltio is run by a small team, so a little
context up front saves a lot of round-trips.

## Before you open a PR

1. **Open an issue first** for anything bigger than a typo fix. Five minutes
   of discussion beats five days of rework. The maintainers will tell you
   the right shape of the change and whether someone is already on it.
2. **Discussions, not issues, for questions**. If you're not sure something
   is a bug, post in [Discussions](https://github.com/zveltio-devs/zveltio/discussions)
   first. We close vague "doesn't work" issues without a repro.
3. **Read the architecture docs**:
   - [`docs/private/REFACTORING-V1-PLAN.md`](docs/private/REFACTORING-V1-PLAN.md) — what we
     are *intentionally* leaving for v1.
   - [`docs/private/TECHNICAL-GAPS.md`](docs/private/TECHNICAL-GAPS.md) — known gaps,
     P0–P3 priorities. Pick from here if you want maximum impact.
   - [`docs/extensions/developer-guide.md`](docs/extensions/developer-guide.md)
     — start here if you're building an extension instead of patching core.

## Development setup

```sh
# Prereqs: Bun >= 1.3.13, Postgres 16+ with pgvector
bun install

# Clone official extensions next to the monorepo (recommended)
# git clone … zveltio-extensions   → ../zveltio-extensions

cp .env.example .env
# Set DATABASE_URL, EXTENSIONS_DIR (see footguns below)

cd packages/engine
bun run db:init                 # create dev DB
bun run dev                     # engine — PORT from .env (default 3000 at repo root)

# Option A — embedded Studio (simplest):
#   bun run studio:build && bun run studio:embed   # from repo root
#   open http://localhost:<PORT>/admin

# Option B — Studio hot reload (separate terminal):
cd packages/studio
VITE_ENGINE_URL=http://localhost:<PORT> bun run dev   # → :5173
```

Run the test suite before pushing:

```sh
bun run typecheck                # all packages
cd packages/engine && bun test   # unit + integration
```

### Common dev footguns

These bite contributors regularly. See also
[`docs/extensions/developer-guide.md` §12](docs/extensions/developer-guide.md#12-local-development-loop).

#### `EXTENSIONS_DIR` — where extension files come from

The engine resolves extension files in this order:

1. **`EXTENSIONS_DIR`** env var (explicit — always wins)
2. **`./extensions/`** relative to the process **CWD**
3. **Sibling `../zveltio-extensions`** (monorepo dev default when the repo exists)
4. **`./extensions/`** as the install target even if empty

`packages/engine/extensions/` is **gitignored**. It is a **runtime install cache**
(populated when you install extensions from the marketplace), **not** the source
repo. An old copy of `crm` sitting there can miss routes such as
`GET /ext/crm/briefing` even though `zveltio-extensions` is up to date.

**Recommended:** clone [`zveltio-extensions`](https://github.com/zveltio-devs/zveltio-extensions)
as a sibling directory **or** set in `.env`:

```env
EXTENSIONS_DIR=/absolute/path/to/zveltio-extensions
```

To reset a confused local cache: stop the engine, delete
`packages/engine/extensions/*`, and point `EXTENSIONS_DIR` at the real repo.

`ZVELTIO_EXTENSIONS_PATH` is a **second** directory the loader scans in addition
to the base above (used in CI). Prefer `EXTENSIONS_DIR` for day-to-day dev.

#### CORS when Studio runs on `:5173`

Split dev (`packages/studio` Vite on `:5173`, engine on another port) is
cross-origin. The engine must allow the Studio origin:

```env
CORS_ORIGINS=http://localhost:5173,http://localhost:5174,http://localhost:3400
```

(`3400` or `3000` — match your `PORT` and include every origin you open in the
browser.) Symptom when missing: login or API calls fail from Studio dev with CORS
errors in the browser console.

Set `VITE_ENGINE_URL=http://localhost:<PORT>` when running Studio dev so API
calls hit the engine, not `:5173` itself (see `packages/studio/src/lib/config.ts`).

#### `studio-dist/` and “Setup Required”

The engine serves the embedded admin UI from **`studio-dist/` relative to CWD**.
When you run from `packages/engine`, that is `packages/engine/studio-dist/`.

After building Studio, from the **repo root**:

```sh
bun run studio:build    # packages/studio → dist/
bun run studio:embed    # copies dist → engine/studio-dist + engine/src/studio-dist
```

If `studio-dist/index.html` is missing, the engine boots but `/admin` shows
**Setup Required**. The binary embed path uses `src/studio-dist/`; runtime Docker
/binaries typically mount `studio-dist/` beside the executable.

#### Remote dev (Cursor, WSL, SSH)

When the browser runs on your host but the engine runs on a remote VM, forward
the engine **`PORT`** (e.g. `3400`) in Cursor/VS Code port forwarding. Studio
dev still needs `VITE_ENGINE_URL` pointing at the forwarded URL if you use split
dev; embedded Studio at `http://localhost:<forwarded-port>/admin` avoids CORS.

## Code rules

These are enforced in review. Skim before writing code:

- **Runtime is Bun**, not Node. Use `Bun.file`, `Bun.spawn`, `Bun.write` —
  not `fs`/`child_process`.
- **Database access via Kysely** — no raw SQL string concatenation. Use
  `kysely`'s `sql` template tag for parameterised queries.
- **Studio uses Svelte 5 runes** (`$state`, `$derived`, `$effect`). No
  legacy stores in new code.
- **Auth guard on every admin route** — copy the pattern from any existing
  route under `packages/engine/src/routes/admin.ts`.
- **One-line comments** explaining *why*, not *what*. Code names explain
  what. If a comment isn't surprising, delete it.

## Commit + PR style

- Conventional commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Subject line ≤ 72 characters. Body explains *why*, not what.
- One feature per PR. Three small PRs beat one big one — they review faster
  and are safer to revert.
- We use [Changesets](https://github.com/changesets/changesets). Run
  `bun run changeset` to add a release note for any user-visible change.

## What we love

- **A failing test that demonstrates the bug.** Faster fix than a paragraph.
- **Bench numbers** for any perf-sensitive change (see `bench/README.md`).
- **A migration guide** if you're changing public API shape.

## What we'll push back on

- New dependencies. The whole engine is ~10 deps. Default to "no" — bring
  the function in directly if it's small, or open a discussion if not.
- Backwards-compatibility shims for unreleased APIs. We're in alpha — break
  things cleanly, document the change, move on.
- New patterns when an existing one works. Three similar uses justifies a
  helper; one doesn't.

## Security

Found a vulnerability? **Don't open a public issue.** Email
`security@zveltio.com`. We respond within 48 h on business days. See
[`docs/platform/security-model.md`](docs/platform/security-model.md) for the disclosure policy.

## Licence

Contributions are licensed under MIT, the same as the project. By opening
a PR you confirm you have the right to submit the code under that licence.
