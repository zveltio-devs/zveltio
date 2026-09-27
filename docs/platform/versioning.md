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

## What triggers what

| Event | Runs |
| --- | --- |
| push to `master` | CI, Build Check, Studio, Client, E2E |
| tag `v*` | Release — the only workflow that produces public artifacts |
| manual dispatch | `publish-npm.yml` |
