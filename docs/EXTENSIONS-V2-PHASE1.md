# Extensions v2 — Phase 1 plan (engine artifact + manifest v2 + CLI)

**Status**: ratified scoping document. Implementation gated on this contract.

**Scope**: per-extension `engine/index.js` artifact, manifest v2, CLI `pack`,
migration of the 54 official extensions, test pyramid.

**Out of scope (separate tracks)**:
- Studio v2 page-merging (see `EXTENSIONS-V2-DESIGN.md`).
- WASM-isolated third-party extensions.
- Marketplace UI.

**Companion docs**:
- `EXTENSION-AUTHORING.md` will be updated to point at this file for v2.
- `manifest-v2.schema.json` (this PR) is the machine-checkable contract.

---

## 1. The one paragraph that drives every other decision

Phase 1 ships extensions as **fully-bundled `engine/index.js` ESM
artifacts**. `bun build engine/index.ts --target=bun --format=esm`
without `--external` for core deps (hono, zod, kysely,
@hono/zod-validator). Allow-listed peer deps (e.g. imapflow,
nodemailer, sharp) STAY external at build time and the engine
installs them at enable. Engine loads bundled artifacts via
`import(pathToFileURL(entry).href)` — no cache-buster, no
node_modules symlink dependency, no runtime module map. The
symlink path remains only for the dev-reload `.ts` workflow.

There is **no legacy channel**. The 54 official extensions are all
ours, all in one repo; converting them is a single scripted batch
(`bun build` × 54 + commit, hours of work), not a 90-day migration.
Keeping a legacy `.ts` path in the loader buys us nothing except more
bug surface — the alpha.106–110 incident chain was almost entirely
loader-quirk regressions, and every legacy alternative path we keep
is another candidate for the next one.

Phase 1.5 (optional, only if pain emerges) revisits a shared runtime
barrel for kysely/hono/zod. We're not building it yet.

---

## 2. Why bundle, not runtime barrel

The previous draft recommended "runtime barrel + import map". After
review, three implementation realities make it the wrong call for now:

1. **Bun's compiled binary has no runtime import map**. The only
   resolution path for bare specifiers like `kysely` is Node-style
   `node_modules` walk-up. Anything else requires custom resolver
   infrastructure that Bun deliberately doesn't expose in compiled
   binaries.
2. **`Bun.plugin` runs at bundle time, not at runtime in a binary.**
   Documented behavior.
3. **Path-rewriting at pack time** (replacing `import 'kysely'` with
   `import '/opt/zveltio/runtime/deps/kysely.mjs'`) hard-codes an
   absolute install prefix. Breaks Docker, custom installers, multi-
   tenant deployments that mount extensions at different paths.

Bundle-into-artifact has no such problems:
- `bun build` already does it; zero new tooling.
- Each extension is 100 % self-contained — no cross-extension
  versioning, no engine-imposes-kysely-version coupling.
- Disk cost is rounding error (200–500 KB per extension; 54
  extensions ≈ 25 MB total — modern disks have TB).
- RAM: only enabled extensions load. A typical install enables 5–10,
  so ≤ 10 copies of kysely in memory. Still negligible.
- CVE response: re-pack via CI is a one-liner. Signing + CI already
  exist; the mass-republish path is solved.

The one exception:

**Native peer-deps stay on an allow-list.** Some extensions depend on
packages with native bindings (`imapflow`, `sharp`, future
`@aws-sdk/client-textract`) that don't bundle cleanly. For these,
the manifest declares them in `peerDependencies`, the engine
installs them at enable time (the existing `installNpmDependencies`
flow), and the build tooling doesn't try to bundle them.
Communications/mail is the canonical pilot for this path.

---

## 3. Manifest v2 contract

Every published manifest REQUIRES the fields in
`docs/manifest-v2.schema.json`. The shape below mirrors the schema
exactly and matches the existing `studio.pages[]` convention already
used by the 54 official manifests (so migration is field-additive,
not field-renaming):

```json
{
  "name": "crm",
  "displayName": "CRM",
  "description": "Contacts, Organizations, and Transactions — core Business OS data layer",
  "category": "business",
  "version": "1.2.0",
  "package": "@zveltio/ext-crm",
  "zveltioMinVersion": "1.0.0-alpha.110",
  "zveltioMaxVersion": "2.0.0",
  "engine": {
    "entry": "engine/index.js",
    "format": "esm",
    "target": "bun",
    "bundled": true,
    "bundlePeers": false
  },
  "studio": {
    "pages": [
      { "path": "/admin/crm", "label": "CRM", "icon": "Users" }
    ],
    "navGroup": "business"
  },
  "dependencies": [],
  "peerDependencies": {},
  "permissions": ["database"],
  "contributes": {
    "engine": true,
    "studio": true,
    "fieldTypes": []
  },
  "integrity": {
    "engineSha256": "abc123…",
    "archiveSha256": "def456…"
  }
}
```

The only fields v2 ADDS to today's manifests are the `engine` block
and the `integrity` block. Everything else (`displayName`, `package`,
`dependencies`, `peerDependencies`, `requires`, `quotas`, `runtime`,
`contributes.{fieldTypes, stepTypes, collections}`) is preserved
because the engine's `ManifestSchema` already parses them and the 54
production manifests rely on them.

### Validation rules (enforced by `extension validate` + engine at enable)

| Rule | Failure mode |
| --- | --- |
| `engine.entry` must end in `.js` | `VALIDATION_FAILED` |
| `engine/index.js` exists in archive | `VALIDATION_FAILED` |
| `engine.bundled: true` ⇒ no bare imports of {hono,zod,kysely,@hono/zod-validator} in the bundled output | `VALIDATION_FAILED` |
| `engine.bundlePeers: false` (default) ⇒ all `peerDependencies` keys are in the curated allow-list | `VALIDATION_FAILED` |
| `engine.bundlePeers: true` ⇒ `peerDependencies` keys are bundled into entry (no allow-list constraint) | `VALIDATION_FAILED` if any peer-dep is still a bare import in entry |
| each `studio.pages[].path` starts with `/admin/` or `/portal/` and the corresponding Svelte page file exists | `VALIDATION_FAILED` |
| `name` ≠ folder slug | `VALIDATION_FAILED` |
| `integrity.engineSha256` missing OR doesn't match SHA-256 of `engine/index.js` | `VALIDATION_FAILED` (mandatory from Phase 1) |
| `integrity.archiveSha256` missing OR doesn't match SHA-256 of the `.zvext` | `VALIDATION_FAILED` |

### `engine.target`

New field, values `"bun" | "node" | "*"`. Future-proofs for a Node-only
extension (e.g., one using a native addon Bun doesn't support).
Today every official extension is `"bun"`.

### Backward compatibility — none

There is no backward-compat path. As of the Phase 1 ship engine release,
the loader refuses any extension whose manifest lacks the `engine`
block or whose `engine.entry` ends in `.ts`. The migration of the 54
official extensions is mechanical and lands in the same window as the
loader change (see §5).

### Local dev workflow — env var, not manifest channel

Authors actively editing an extension run from source via
`zveltio extension dev`, which sets `ZVELTIO_EXTENSION_DEV_RELOAD=1`.
The engine loader treats this env var as a scoped opt-in to load
`engine/index.ts` directly with hot-reload. There is NO `channel`
field in the manifest for this — local dev is a runtime concern, not
a metadata concern. The registry, the validator, and the loader on
production binaries all behave the same way (require `engine/index.js`).

---

## 4. CLI — one binary, one verb tree

Decision: extend `@zveltio/cli` rather than ship a separate
`@zveltio/ext-cli`. Operators and authors use the same `zveltio`
entry point.

| Command | Behavior |
| --- | --- |
| `zveltio extension new <name>` | scaffolds from `templates/minimal/`, sets manifest v2 defaults |
| `zveltio extension dev` | sets `ZVELTIO_EXTENSION_DEV_RELOAD=1`, watches `engine/*.ts` + `studio/pages/**`, hot-reload via existing `reloadExtensionFromDisk` |
| `zveltio extension validate` | manifest schema check, slug match, migration paths, `engine/index.js` existence in archive, `peerDependencies` against allow-list |
| `zveltio extension pack` | (NEW) runs `bun build engine/index.ts --outfile engine/index.js --target=bun --format=esm`, computes `engineSha256`, then archives + manifest with hash filled in |
| `zveltio extension sign` | (extracted from existing publish) ED25519 over archive |
| `zveltio extension publish` | `validate → pack → sign → upload`. Replaces today's "publish .ts as-is" behavior — every published `.zvext` is bundled |

Files:
- `packages/cli/src/commands/extension-pack.ts` (NEW)
- `packages/cli/src/commands/extension-publish.ts` (refactor — uses pack)
- `packages/sdk/src/build/index.ts` (NEW) — exports `createExtensionBuildConfig({ entry, externals })` so authors who want to call `bun build` directly can share the config

---

## 5. Migration plan — waves, not big-bang

| Wave | Window | Scope |
| --- | --- | --- |
| 0 | Done (alpha.110, master) | Loader hardening **only**: no `?v=`, `pathToFileURL`, symlink-on-every-load, audit-FK fix, kysely-presence check. The v2 contract itself is NOT yet enforced. |
| 1 | Phase 1 ship | 5 pilots packed to v2: **crm, communications/mail, finance/invoicing, ai, forms**. Validates the pack tooling against the real risk classes. |
| 2 | Same release as Wave 1 | Remaining 49 official extensions packed in one scripted batch via `scripts/migrate-ext-to-production.sh` (runs `extension pack` for each, commits the manifest + `engine/index.js`). |
| 3 | Same release as Waves 1+2 | Engine refuses any extension with `engine.entry` ending in `.ts` outside the `ZVELTIO_EXTENSION_DEV_RELOAD=1` dev workflow. |

Waves 1–3 land **in the same release**. There is no grace window
because the 54 official extensions all live in one repo we control —
converting them is a script, not a coordination problem. Wave 0 is
explicitly DIFFERENT — it's the loader-hardening fixes already shipped
on alpha.110, not the v2 cut.

### Why these 5 pilots

Each one exercises a distinct risk class:

| Pilot | Risk class |
| --- | --- |
| crm | SDK surface, route registration, `zvd_*` dynamic tables |
| communications/mail | External peer-deps (`imapflow`, `nodemailer`) — exercises the allow-list path |
| finance/invoicing | Multi-migration history + inter-extension dependency on crm |
| ai | Highest existing bug density (4 dead subsystems fixed this session) |
| forms | Baseline — small, clean, control case |

If all 5 publish to v2 cleanly, wave 2 is mechanical.

---

## 6. Test pyramid

| Level | Where | Coverage |
| --- | --- | --- |
| L1 — Unit | `zveltio-extensions` CI, per extension | `@zveltio/sdk/testing` `createTestApp(extension)` — routes, permission gates, response shape. Required for every extension that exports `register()`. |
| L2 — Contract | `zveltio-extensions` CI, once per PR | `extension validate` + `extension pack` + `engine/index.js exists` + import smoke (Bun resolves the bundled module without error) |
| L3 — Engine integration | `zveltio` CI | One Postgres fixture, `loadExtension('fixtures/hello-ext')` in-process. Runs against the source tree, NOT the binary |
| L4 — Binary E2E | `zveltio` release.yml `smoke-binary` job | Boot the compiled binary, install + enable `fixtures/hello-ext`, assert `GET /ext/hello/health` → 200. Gates the release |

The current `smoke-binary` job (shipped in `756a733`) uses CRM. We'll
swap it for a `hello-ext` fixture so the gate is isolated from
marketplace-side regressions; CRM can stay as a nightly broader smoke.

The fixture extension lives at
`packages/engine/src/tests/fixtures/hello-ext/` with the smallest
possible legal v2 layout:

```
hello-ext/
├── manifest.json
├── engine/
│   ├── index.js       (pre-built, checked in)
│   └── migrations/001_hello.sql
└── studio/
    └── pages/index/+page.svelte   (trivial)
```

---

## 7. Open decisions — ratified

| # | Question | Decision |
| --- | --- | --- |
| A | Include `.ts` sources in production `.zvext` | **No** — sources stay in git, artifact is build output only |
| B | `integrity.engineSha256` mandatory from start | **Yes** — anything optional in v1 is never enforced. Mandatory now |
| C | Studio bundle mode deprecation | **Yes**, hard-removed in the same release as the engine v2 cut — Studio bundles are only used by our own extensions, all of which migrate in the same batch as the engine artifact (§5) |
| D | Who generates `runtime/deps/` | **Moot** — bundle-first means no runtime deps barrel for now |

---

## 8. PR order — and the gap between this contract and the code today

At ratification time, the v2 contract above is NOT implemented in
engine or CLI. The following items are still TODO and each maps to a
PR in §8 below:

| Item | Status today | Required by Phase 1 ship |
| --- | --- | --- |
| `extension pack` command | Doesn't exist. `extension publish` ships `.ts` as-is. | PR #3 — `packages/cli/src/commands/extension-pack.ts` |
| Manifest v2 schema in engine `ManifestSchema` | v1 with `.passthrough()`. No `engine` block, no `integrity` block. | PR #4 — extend `ManifestSchema` in `extension-loader.ts:665` |
| Refuse `.ts` entry outside dev reload | Loader prefers `.js` but falls back to `.ts` if `.js` missing. | PR #4 — same edit |
| Verify `integrity.engineSha256` at load | Not checked. | PR #4 — same edit |
| `hello-ext` fixture | Doesn't exist in repo. | PR #5 — `packages/engine/src/tests/fixtures/hello-ext/` |
| `smoke-binary` job uses fixture, not CRM | Uses CRM (added in `756a733`). | PR #5 — swap fixture |
| Skip CORE_NPM_PACKAGES presence check when `engine.bundled: true` | Loader always checks `extensions/node_modules/{kysely,hono,zod,@hono/zod-validator}`, contradicting the bundle-first promise | PR #4 — add `engine.bundled` short-circuit |
| `integrity.archiveSha256` mismatch refusal | Not checked at install. | PR #8 — registry endpoint |

The doc represents the **target contract**. Code lands in the PRs below.

1. **This document + `manifest-v2.schema.json`** (zero code) — gives reviewers a single contract surface for everything that follows.
2. **Engine: extension-loader runtime hardening already shipped** (alpha.110 + `c64b11b`). Confirm via post-merge smoke.
3. **CLI: `extension pack` command** + `extension publish` refactor to use it.
4. **Engine: manifest v2 parser** — extend `ManifestSchema` in `extension-loader.ts:665` with `engine` and `integrity` blocks; refuse `.ts` entry (except under `ZVELTIO_EXTENSION_DEV_RELOAD=1`); short-circuit the CORE_NPM_PACKAGES check when `engine.bundled: true`; verify `integrity.engineSha256` at load.
5. **CI engine: hello-ext fixture + swap smoke-binary** — add `packages/engine/src/tests/fixtures/hello-ext/` and point `release.yml`'s `smoke-binary` job at it.
6. **CI extensions: per-extension `extension pack` step on changed paths**, mandatory L1 for new code.
7. **5 pilots packed** (crm, mail, invoicing, ai, forms).
8. **Registry: accept + verify `integrity.archiveSha256` at upload**, refuse mismatches.

Each step is independently reviewable. Steps 4–7 can ship across
separate release tags as needed.

---

## 9. What stays the same

- Same-process loading for official extensions (RO-SME perf is fine).
- Per-extension RLS migrations (multi-tenancy story).
- No extensions installed by default (`zveltio install --bundle <name>` opt-in).
- WASM track stays experimental; not on the critical Phase 1 path.

---

## 10. Phase 1.5 — only if pain

The shared-deps runtime barrel comes back on the table if:

- Total marketplace artifact size > 1 GB (we'd need to start counting deduplication wins), or
- A core-dep CVE (kysely, hono, zod) forces a mass republish AND the script-based fix proves too slow operationally, or
- Memory pressure measured: a multi-tenant install with 30+ enabled extensions consuming significant RSS from duplicated module instances.

None of these is the case today. Don't pre-build for them.

---

## Stale WSL diagnostics — note for future sessions

WSL sudo-non-interactive commands (`wsl -- sudo -n …`) block on
password prompt in background tasks. For future diagnostics, either:
- Run from the WSL shell directly (interactive sudo), or
- Read files reachable as `liviu` (no sudo needed for `/opt/zveltio/.env`
  if it's group-readable, or `cat ~/.zveltio/...`).

Don't queue `wsl -- sudo` patterns as background tasks.
