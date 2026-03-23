# Zveltio — Versioning Guide

Zveltio uses **[Changesets](https://github.com/changesets/changesets)** for automated semantic versioning across its monorepo packages.
The goal: you write code, run one command, and everything else — version bumps, changelogs, Docker images, GitHub Releases — happens automatically.

---

## How the system works

```
Developer writes code
        │
        ▼
bun run changeset          ← declares what changed + severity
        │
    (PR merged)
        │
        ▼
GitHub Action: version.yml
        │
        ├─► [changeset files found]
        │       Creates "chore: version packages" PR
        │       Bumps package.json versions
        │       Generates / updates CHANGELOG.md files
        │       Syncs ENGINE_VERSION in version.ts
        │
        └─► [PR merged — no changeset files left]
                Pushes Git tags  (e.g. v1.2.0)
                        │
                        ▼
                GitHub Action: release.yml
                        ├─ Builds Studio
                        ├─ Compiles binaries (linux x64/arm64, macos x64/arm64)
                        ├─ Builds + pushes Docker image to GHCR
                        ├─ Creates GitHub Release with assets
                        └─ Updates zveltio-get repo (versions.json / latest.json)
```

All packages (`engine`, `studio`, `sdk`, `sdk-react`, `sdk-vue`, `cli`) are **linked** — a single Changeset bumps all of them to the same version number.

---

## Workflow for developers

### 1. Work on a feature / bugfix as normal

```bash
git checkout -b feat/my-feature
# ... write code ...
```

### 2. Declare your change with a Changeset

Before you commit (or before opening a PR), run:

```bash
bun run changeset
```

The interactive prompt asks:

| Question | What to answer |
|---|---|
| Which packages changed? | Select all affected packages (space to toggle) |
| Bump type? | `major` — breaking change · `minor` — new feature · `patch` — bug fix |
| Summary? | One-line description that appears in CHANGELOG, e.g. *"Add SAF-T XML export for Romanian compliance"* |

This creates a small Markdown file in `.changeset/`. **Commit it with your code** — it's part of the PR.

```bash
git add .changeset/
git commit -m "feat: add saft export"
git push
```

### 3. Open a Pull Request

Normal code review. The changeset file is included.

### 4. Merge to main — automation takes over

After merge:

1. **`version.yml`** detects the changeset files and opens a PR titled **"chore: version packages"**.
   This PR contains: bumped `package.json`, updated `CHANGELOG.md`, updated `ENGINE_VERSION` in `version.ts`.

2. **Review and merge that PR** — one click.

3. **`version.yml`** pushes a Git tag (e.g. `v1.2.0`).

4. **`release.yml`** triggers automatically on the new tag, builds everything, and publishes the release.

> **You never touch a version number manually.**

---

## Bump type reference

| Type | When to use | Example |
|---|---|---|
| `patch` | Bug fix, security fix, internal refactor | `1.0.0` → `1.0.1` |
| `minor` | New feature, new endpoint, new extension API | `1.0.0` → `1.1.0` |
| `major` | Breaking change in API / schema / CLI | `1.0.0` → `2.0.0` |

When in doubt, use `minor`. A patch that fixes a security vulnerability is still `patch` (use the summary to highlight it).

---

## Internal sync — ENGINE_VERSION

`packages/engine/src/version.ts` contains a hardcoded `ENGINE_VERSION` constant.
This is kept in sync automatically: the `version-packages` script calls `scripts/sync-engine-version.ts` right after Changesets bumps `packages/engine/package.json`.

**You never need to update `ENGINE_VERSION` manually.**

The `generate-versions-json.sh` script is now called by the CI/CD pipeline (`release.yml` → update-website job) after each release — it pulls data from GitHub Releases API and updates `zveltio-get/versions.json`. You do not need to run it locally.

---

## Accessing and maintaining older versions

### View previous versions

Every release is tagged and available as a GitHub Release:

- **Tags**: `https://github.com/zveltio-devs/zveltio/tags`
- **Releases**: `https://github.com/zveltio-devs/zveltio/releases`
- **Changelog**: `packages/engine/CHANGELOG.md`, `packages/cli/CHANGELOG.md`, etc.

---

### Time-travel locally (read-only)

To check out the codebase exactly as it was at version `1.2.0`:

```bash
git checkout v1.2.0
bun install
bun run dev

# Return to current work
git checkout main
```

---

### Fix a bug on an old release (Support Branch)

Use this when a critical bug (e.g. security vulnerability) affects customers still running v1.x while `main` is already at v2.x.

```bash
# Create a support branch from the old tag
git checkout -b support/v1.x v1.5.0

# Fix the bug
# ... edit code ...

# Commit and push
git add .
git commit -m "fix: CVE-2026-XXXX — input sanitization in webhook handler"
git push origin support/v1.x

# Tag manually (Changesets doesn't manage support branches)
git tag v1.5.1
git push origin v1.5.1
# → release.yml triggers and publishes v1.5.1 binaries/Docker image
```

Clients running v1.x can pin their `docker-compose.yml` to `ghcr.io/zveltio/zveltio-engine:1.5.1` and update safely.

---

### Work on two versions simultaneously (Git Worktrees)

When you need to repair a bug on `support/v1.x` **while** keeping your current dev server running on `main`:

```bash
# Create a separate folder on disk with v1.x code
# Uses the same local Git history — fast, no re-clone
git worktree add ../zveltio-v1 support/v1.x

# You now have:
#   ~/zveltio-ecosystem/zveltio         ← main (v2.x dev server running)
#   ~/zveltio-ecosystem/zveltio-v1      ← support/v1.x (separate server)

# Open second VS Code window
code ../zveltio-v1

# Run v1.x on a different port
cd ../zveltio-v1
bun install
PORT=3001 bun run dev

# When done
git worktree remove ../zveltio-v1
```

---

### Docker images — all versions are permanent

Every release publishes immutable Docker images:

```
ghcr.io/zveltio/zveltio-engine:1.2.0   ← specific version (never deleted)
ghcr.io/zveltio/zveltio-engine:1.2     ← latest 1.2.x patch
ghcr.io/zveltio/zveltio-engine:latest  ← always the newest stable
```

To roll back a self-hosted instance, edit `docker-compose.yml`:

```yaml
# Before (latest):
image: ghcr.io/zveltio/zveltio-engine:latest

# After (pinned rollback):
image: ghcr.io/zveltio/zveltio-engine:1.2.0
```

Then `docker compose up -d`. No recompile needed.

---

## GitHub token setup

The `version.yml` workflow uses `CHANGESETS_TOKEN` (if set) or falls back to `GITHUB_TOKEN`.

For PR-triggered CI to work on the Version Packages PR, set a **Personal Access Token** with `contents: write` and `pull-requests: write` scopes as a repository secret named `CHANGESETS_TOKEN`.
Without it everything still works — the Version Packages PR just won't run CI checks.

---

## Quick reference

| Command | What it does |
|---|---|
| `bun run changeset` | Declare a change before committing |
| `bun run version-packages` | Bump versions + update CHANGELOG (run by CI) |
| `bun run tag` | Create git tags after version bump (run by CI) |
| `git checkout v1.2.0` | Inspect old version locally |
| `git checkout -b support/v1.x v1.2.0` | Start a maintenance branch |
| `git worktree add ../zveltio-v1 support/v1.x` | Run two versions in parallel |
