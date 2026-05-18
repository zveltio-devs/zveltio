# zveltio/docs/site — Source of Truth for zveltio.com docs

The `.md` files in this directory are the canonical, editable source for
every page rendered at https://zveltio.com (the SvelteKit website at
`zveltio-website/`).

## How the pipeline works

```
zveltio/docs/site/*.md            ← edit here, commit here
        ↓
zveltio-website/scripts/sync-docs.mjs  ← runs on predev/prebuild
        ↓
zveltio-website/src/lib/content/*.md   ← generated (commited for CI portability)
        ↓
SvelteKit + mdsvex render as pages at /intro, /installation, /architecture, ...
```

Page routing is defined in `zveltio-website/src/lib/config.ts`. Adding a
new page requires:
1. Drop `<slug>.md` here.
2. Add an entry to the `pages` array in `config.ts`.
3. Run `bun run sync-docs` (or just `bun run dev` — it auto-syncs).

## Why a single source of truth

Previously docs lived inside the website repo. That meant:
- Engineering changes (new feature, renamed env var, new route) shipped
  in this repo, but the docs lived in a different repo — drift was
  guaranteed.
- Reviewers had to remember to update two repos when changing a public
  surface.

With docs co-located with the engine code, a PR that adds a feature
also touches the doc that describes it. Reviewers see both diffs in one
place. The website picks the latest copy at build time.

## Editing rules

- **No relative links across docs.** The mdsvex setup uses flat slug
  routing (`/installation`, `/architecture`), not nested paths. Link
  with `[Installation](/installation)`, not `[Installation](./installation.md)`.
- **No fenced code blocks longer than ~30 lines.** Long examples
  silently overflow the prose container. Break with prose between.
- **Headings are auto-slugged via `rehype-slug`.** Use H2/H3 sparingly
  so the table-of-contents stays scannable.
- **No images that aren't in `zveltio-website/static/`.** The sync
  script doesn't copy images; image-heavy docs need both halves edited.

## Technical docs that DON'T live here

Some docs stay in `zveltio/docs/` proper (one level up) because they're
engineering-internal and don't ship to the public website:

- `REFACTORING-V1-PLAN.md`         — backlog tracking
- `EXTENSION-DEVELOPER-GUIDE.md`  — extension SDK reference (could move
  here later once we add an /extensions/developer-guide page)
- `MIGRATION-ALPHA-TO-BETA.md`    — internal migration log
- `DEPLOYMENT-K8S.md`             — ops runbook
- `MEMORY_OPTIMIZATIONS.md`       — Bun tuning notes
- `OFFLINE-SYNC.md`               — Electric SQL + CRDT setup (could move
  here later once we add an /offline-sync page)

Move them into `site/` only when they're ready to be public.
