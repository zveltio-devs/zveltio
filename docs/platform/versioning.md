# Versioning and releases

Every Zveltio package ships with **one version number** — the root package, the
engine, Studio, the client, the SDK and its React and Vue bindings, the CLI, and
the Helm chart's `appVersion`. The engine binary reports it on
`/api/health/version`, Studio shows it in its footer, and the GitHub Release tag
matches it.

Releases are **cut by hand, by a maintainer**. There is no bot that bumps
versions or opens a release PR, and pull requests carry no release files: what
changed goes into `CHANGELOG.md` when the release is cut.

## Version numbers

The current line is `3.0.0-beta.N`. Each beta raises `N` by one. Leaving beta
(`3.0.0`) is a deliberate decision, not a side effect of any change.

| Package | Where | Published |
| --- | --- | --- |
| `@zveltio/sdk` | `packages/sdk` | npm |
| `@zveltio/react` | `packages/sdk-react` | npm |
| `@zveltio/vue` | `packages/sdk-vue` | npm |
| `@zveltio/cli` | `packages/cli` | npm |
| engine | `packages/engine` | GitHub Release (binaries), GHCR |
| Studio | `packages/studio` | embedded in the engine binary |
| client | `packages/client` | no |
| Helm chart | `charts/zveltio/Chart.yaml` (`appVersion`) | no |

## Cutting a release

1. **Bump the version** to `3.0.0-beta.N+1` in `packages/sdk`, `packages/sdk-react`,
   `packages/sdk-vue`, `packages/cli` and `packages/client`, then run

   ```bash
   bun run sync-versions
   ```

   It copies the SDK's version to the root package, the engine, Studio and the
   chart's `appVersion`, and stops with an error if the chart has no `appVersion`
   line.
2. **Write the release notes** in `CHANGELOG.md`, under `## [Unreleased]`.
3. **Open a PR** named `chore/release-3.0.0-beta.N+1` with the commit
   `chore(release): 3.0.0-beta.N+1`. A correct release commit touches exactly
   **10 files**: eight `package.json`, `Chart.yaml` and `CHANGELOG.md`. Nine
   means the chart was not bumped.
4. **Before merging**, if the change touched migrations, extension loading or
   anything the compiled binary embeds, build it locally:
   `bun build packages/engine/src/index.ts --compile`, and start it. Bugs that
   exist only in the binary are not caught by a push to master.
5. **After the merge, tag the merge commit and push that tag on its own:**

   ```bash
   git tag -a v3.0.0-beta.N+1 <merge-sha> -m "3.0.0-beta.N+1"
   git push origin refs/tags/v3.0.0-beta.N+1
   ```

   The `v*` tag starts `release.yml`: binaries, the Docker image on GHCR, the
   signed checksums and the GitHub Release. Push it alone — GitHub emits no event
   for tags beyond the third in a single push, and `release.yml` cannot be
   started by hand.
6. **Publish to npm** by running the `publish-npm.yml` workflow manually with the
   version and the dist-tag (`beta` for prereleases). It authenticates through
   GitHub OIDC; pushing a tag does not publish anything to npm.
7. **Check the published assets** on the GitHub Release, including
   `env.example` (GitHub renames dotfiles).

## Stable release gate

Two rules, enforced by machine, not judgement:

1. **Version numbers are never renumbered again.** The 1.0 → orphaned-2.0 → 3.0
   history is behind us. A published version is immutable; a mistake is fixed by
   moving *forward* to the next number, never by reusing or renumbering one.
2. **Stable means the gate passed. Full stop.** A non-prerelease tag is only
   published when `scripts/release-gate.ts` says so — it is a required job in
   `release.yml` (`publish-release` needs it). Prerelease tags
   (`-alpha`/`-beta`/`-rc.`) bypass the gate with a warning.

The gate (`scripts/release-gate.ts`) asserts, with real checks:

- the `any` suppression ratchet is at/below baseline (H-01);
- gated coverage buckets meet their stable target — engine `lib/` ≥ 60% (H-02);
- HEAD's migrations are a strict superset of the last release's — nothing
  renamed/renumbered/deleted (reuses the H-11 invariant);
- `package.json` version matches the tag;
- the required CI checks are green on the release-candidate commit (H-09
  adversarial + H-11 upgrade-path run inside integration; Type Check, Lint,
  Unit, Integration, Perf Smoke);
- the latest soak run is green (H-15);
- there are no open `P0` issues.

Any failure blocks the stable publish. Run it yourself before proposing a stable
cut: `bun run scripts/release-gate.ts 3.0.0` (add `RELEASE_GATE_SKIP_NETWORK=1`
to skip the GitHub-API checks offline).

## What triggers what

| Event | Runs |
| --- | --- |
| push to `master` | CI, Build Check, Studio, Client, E2E |
| tag `v*` | Release — the only workflow that produces public artifacts |
| manual dispatch | `publish-npm.yml` |

## Accessing and maintaining older versions

### View previous versions

Every release is tagged and available as a GitHub Release:

- **Tags**: `https://github.com/zveltio-devs/zveltio/tags`
- **Releases**: `https://github.com/zveltio-devs/zveltio/releases`
- **Changelog**: `CHANGELOG.md` at the repository root

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

# Tag the fix — the same v* tag that starts release.yml on master
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

## Quick reference

| Command | What it does |
|---|---|
| `bun run sync-versions` | Copy the SDK's version to root, engine, Studio and the chart |
| `bun run scripts/release-gate.ts 3.0.0` | Check a stable cut before proposing it |
| `git checkout v1.2.0` | Inspect an old version locally |
| `git checkout -b support/v1.x v1.2.0` | Start a maintenance branch |
| `git worktree add ../zveltio-v1 support/v1.x` | Run two versions in parallel |
