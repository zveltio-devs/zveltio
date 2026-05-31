# Zveltio Marketplace Policy

> Status: **DRAFT — pre-public-marketplace**.
> The 54 first-party extensions ship under different rules (audited,
> built into the release pipeline, no review queue). This document
> covers third-party / community submissions once the marketplace
> opens for external publishers.

## 1. Submission ground rules

Every submitted extension MUST:

1. **Ship a bundled engine artifact.** No `.ts`-only extensions.
   `manifest.engine.bundled` MUST be `true` and the bundle's
   SHA-256 MUST match `manifest.integrity.engineSha256`. Built via
   `zveltio extension pack` (canonical) or via the
   `@zveltio/sdk/build` plugin (custom pipelines).

2. **Be signed.** `.zvext` archives are accompanied by a `.zvext.sig`
   envelope produced by `zveltio extension publish`. The publisher's
   key must be enrolled in the registry's allowed-publishers table.
   Unsigned submissions are rejected at upload.

3. **Declare migrations explicitly.** `engine.getMigrations()` must
   return an array of file paths that exist on disk. CI's
   `validate-migration-paths` script catches drift.

4. **Pass `zveltio extension validate`** with zero errors. The
   command checks manifest schema, peer-dep allow-list, bundle
   presence + hash, migration paths, and bundle size budgets.

5. **Ship a CI workflow** (the `extension create` scaffold writes one
   for you) that runs validate + pack + hash verify on every PR.
   Submissions whose CI is red are rejected.

## 2. Isolation requirements

| Publisher tier | Required `engine.isolation` |
| --- | --- |
| First-party (Zveltio team) | `inline` (default) — full functionality, max speed |
| Verified partner (vendor-vetted) | `inline` allowed, `worker` recommended |
| **Community / third-party** | **`worker` REQUIRED** |

Worker isolation (`isolation: 'worker'`) gives:

- Crash isolation: a panic in the extension doesn't take the engine
  down. Auto-respawn with exponential backoff.
- Credential separation: the worker never sees `DATABASE_URL`. SQL
  is proxied through the host pool so RLS, audit, and tenant scoping
  all stay enforceable.
- Hang detection: 30s ping / 60s pong timeout terminates a stuck
  handler and respawns the worker.

What worker isolation does NOT give:

- Per-extension RSS metrics or OOM kill (Bun.Worker is a thread,
  not a subprocess — RSS is per-process).
- OS-level sandboxing of filesystem / network. Use platform
  permissions to constrain capabilities, not the worker boundary.
- Cross-process transactions. Each `ctx.db.query()` from a worker is
  independent — `BEGIN`/`COMMIT` across multiple worker queries is
  not supported.
- Streaming responses. Bodies are buffered as text across the IPC
  hop.

See `EXTENSION-DEVELOPER-GUIDE.md` §13.5 for the full 3-tier policy
including the "future Tier 3" (subprocess / WASM) that isn't
implemented today.

## 3. Permissions

Every extension declares `manifest.permissions[]`. The currently
recognized values:

| Permission | What it grants |
| --- | --- |
| `database` | Read/write to declared tables only (CREATE TABLE in migrations, queries via `ctx.db`) |
| `settings` | Read/write to `zv_settings` keys prefixed with the extension's slug |
| `network` | Outbound HTTP from extension code |
| `filesystem` | Read from the extension's own folder; write to `EXTENSIONS_DIR/<name>/data/` |

Submissions requesting `network` or `filesystem` get extra review.
Extensions in `isolation: 'worker'` cannot bypass these — the host
gates DB queries and the worker has no env access.

## 4. Review checklist (reviewer side)

A reviewer assesses a submission against:

- [ ] CI green: validate + pack + hash verify all pass on PR
- [ ] Signature valid; publisher key enrolled
- [ ] Manifest declares `engine.bundled: true` + `engine.isolation`
      matches publisher tier
- [ ] Migrations are idempotent (re-running them does nothing)
- [ ] No `CREATE TABLE IF NOT EXISTS` with a name that collides with
      core engine tables (cf. `content/media` regression in alpha.117)
- [ ] Bundle size within budget (default 50 MB, smaller is better)
- [ ] No obvious credential leaks in `engine/index.ts` (regex scan
      for `BEGIN PRIVATE KEY`, `sk_live_`, …)
- [ ] Permissions requested match what the routes actually use
- [ ] Studio routes (if any) use `mountStrategy: 'subapp'` unless
      there's a documented reason for `'global'`
- [ ] Worker-mode extensions don't depend on transactions or
      streaming (call out in submission if they do)
- [ ] README / EXTENSION.md present with: what it does, supported
      Zveltio versions, install steps, configuration env vars

## 5. Lifecycle

- **Publish:** `zveltio extension publish` signs + uploads the
  `.zvext` to the registry. The registry stores it in R2 with an
  `archiveSha256` customMetadata field (alpha.117).
- **Install:** Engine fetches the `.zvext` from the registry, verifies
  the archive SHA-256 against the `X-Archive-Sha256` response header
  (alpha.123), unpacks into `EXTENSIONS_DIR/<name>/`, and verifies
  the engine bundle SHA-256 against `manifest.integrity.engineSha256`
  before any code runs.
- **Enable:** Engine runs migrations, then either imports the bundle
  inline (default) or spawns a `Bun.Worker` (worker isolation).
  Routes mount under `/ext/<name>/*` (subapp) or at the engine root
  (global, rare).
- **Disable:** Engine unloads the extension; its routes start
  returning 503. Migrations are NOT rolled back automatically.
- **Uninstall:** Manual — operator removes the `EXTENSIONS_DIR/<name>/`
  folder. Marketplace removes the catalog entry.
- **Republish:** New version uploaded with same name + higher
  `manifest.version`. Engine notifies on next catalog refresh.

## 6. Takedown criteria

A submission may be removed from the marketplace if:

- Bundle hash drifts between published versions (silent tampering)
- Extension causes engine crashes that aren't caught by worker
  isolation (escape via Bun runtime bugs)
- Reported security vulnerability with no publisher response within
  72 hours
- Publisher requests removal
- Legal compliance issue (DMCA, GDPR data-processor agreements, etc.)

## 7. Versioning

Extensions follow semver. `manifest.zveltioMinVersion` declares the
oldest engine version the bundle works against; the engine refuses
to load extensions whose minimum is newer than its own version.

Engine major version bumps (`1.x` → `2.x`) are the only times the
extension contract may break in incompatible ways. Patch and minor
engine releases stay backward-compatible — your extension keeps
working without a re-pack as long as you're within the declared
`zveltioMinVersion` / `zveltioMaxVersion` window.

---

This document will evolve once the public marketplace opens for
submissions. Feedback to `extensions@zveltio.com` or via GitHub
issues on the `zveltio` repo.
