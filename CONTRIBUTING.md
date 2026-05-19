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
   - [`docs/REFACTORING-V1-PLAN.md`](docs/REFACTORING-V1-PLAN.md) — what we
     are *intentionally* leaving for v1.
   - [`docs/TECHNICAL-GAPS.md`](docs/TECHNICAL-GAPS.md) — known gaps,
     P0–P3 priorities. Pick from here if you want maximum impact.
   - [`docs/EXTENSION-DEVELOPER-GUIDE.md`](docs/EXTENSION-DEVELOPER-GUIDE.md)
     — start here if you're building an extension instead of patching core.

## Development setup

```sh
# Prereqs: Bun >= 1.3.13, Postgres 16+ with pgvector
bun install
cd packages/engine
bun run db:init                 # create dev DB
bun run dev                     # engine on :3000
# Separately:
cd packages/studio && bun run dev   # studio on :5173
```

Run the test suite before pushing:

```sh
bun run typecheck                # all packages
cd packages/engine && bun test   # unit + integration
```

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
[`SECURITY.md`](SECURITY.md) for the disclosure policy.

## Licence

Contributions are licensed under MIT, the same as the project. By opening
a PR you confirm you have the right to submit the code under that licence.
