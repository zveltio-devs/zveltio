# Extensions v2 — Phase 1 plan (engine artifact + manifest v2 + CLI)

**Status**: ✅ COMPLETE at 1.0.0-beta.1 (2026-05-31). All items in §8
landed across alpha.111 → beta.2. The original scoping document
below is preserved for historical context; live status is in
§8 "PR order — status".

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

## 8. PR order — status (post alpha.122, 2026-05-31)

Phase 1 is complete on the binary install. All 54 official extensions
are packed; marketplace install + enable validated end-to-end in WSL
on 11 representative extensions including all 6 bundlePeers cases.
Worker isolation (C-minimal) shipped alpha.121 + observability
hardening alpha.122 — full crash recovery, hang detection, cross-
worker service bridge, admin health endpoint.

### Bundle pipeline

| Item | Status | Notes |
| --- | --- | --- |
| `extension pack` command | ✅ DONE (alpha.111) | `packages/cli/src/commands/extension-pack.ts` + Bun.build plugin for hono types resolution |
| Manifest v2 schema in `ManifestSchema` | ✅ DONE (alpha.111) | `engine` and `integrity` blocks accepted; alpha.112 widened `archiveSha256` to also accept empty placeholder |
| Refuse `.ts` entry in production | ✅ DONE (alpha.117) | `NODE_ENV=production` + non-bundled → hard fail with pointer at `zveltio extension pack`. Dev still works via `ZVELTIO_EXTENSION_DEV_RELOAD=1`. |
| Verify `integrity.engineSha256` at load | ✅ DONE (alpha.111) | Mismatch errors out with explicit message |
| `hello-ext` fixture | ✅ DONE (alpha.114) | `packages/engine/src/tests/fixtures/hello-ext/`. Catalog entry in `extension-catalog.ts` |
| `smoke-binary` job uses fixture, not CRM | ✅ DONE (alpha.114) | `release.yml` copies the fixture into `EXTENSIONS_DIR` and exercises install + enable + GET `/ext/hello-ext/health` |
| Skip CORE_NPM_PACKAGES presence check when `engine.bundled: true` | ✅ DONE (alpha.111) | `extension-loader.ts` short-circuit |
| `engine.bundlePeers: true` required for any peerDependencies | ✅ DONE (alpha.113) | Loader + pack hard-fail otherwise; the "install peers at enable time" model never worked on the compiled binary and was retired. `PEER_DEP_ALLOWLIST` is now empty. |
| `sync-to-registry.mjs` uses committed bundle (no re-build) | ✅ DONE (alpha.113) | Sync was re-running `bun build --bundle` without the hono plugin, producing broken bundles that didn't match the manifest hash. Now verifies committed bundle hash vs declared hash before uploading. |
| Hash drift via autocrlf | ✅ DONE | `.gitattributes` in `zveltio-extensions` pins `**/engine/index.js` as binary |
| Batch pack 49 remaining extensions | ✅ DONE (zveltio-extensions @7b03f06) | 54/54 packed; sync upload 54/54 success |
| CI extensions: pack-on-PR hash gate | ✅ DONE (alpha.117) | `zveltio-extensions/.github/workflows/ci.yml` rejects PRs with bundle ↔ manifest hash drift |
| `extension validate` enforces v2 manifest | ✅ DONE (alpha.117) | v1 prints warning; partial v2 (engine block present but missing entry / bundled / engineSha256) is hard fail |

### Worker isolation (C-minimal)

| Item | Status | Notes |
| --- | --- | --- |
| `engine.isolation: 'worker'` opt-in manifest field | ✅ DONE (alpha.121) | Default stays `inline`; per-extension opt-in |
| `WorkerExtensionHost` + protocol + runtime | ✅ DONE (alpha.121) | `worker-extension-{host,protocol,runtime}.ts`. RPC: init, route invoke, db query, service call, log forward, ping/pong, service register/invoke |
| Pre-compiled worker source embedded in binary | ✅ DONE (alpha.121) | `scripts/gen-worker-source.ts` emits string constant; host writes to `/tmp` at first spawn. Bun --compile doesn't auto-bundle workers; this is the bulletproof workaround. |
| Worker DB proxy via host pool (zero credentials in worker) | ✅ DONE (alpha.121) | Every `ctx.db.query()` traverses IPC; host runs SQL on shared `Bun.SQL` pool |
| Crash auto-recovery with exponential backoff | ✅ DONE (alpha.122) | `worker.onerror` → terminate + respawn (500ms → 30s ceiling); `workerGeneration` bumped per respawn |
| Hang detection (30s ping / 60s pong timeout) | ✅ DONE (alpha.122) | Stuck worker is terminated + respawned; proxy routes 503 during respawn window |
| Cross-worker service registry bridge | ✅ DONE (alpha.122) | `ctx.services.register()` in worker now publishes a host-side stub that proxies invocations back via `service:invoke` RPC |
| `GET /api/admin/extensions/health` | ✅ DONE (alpha.122) | Per-extension records (isolation, workerGeneration, lastCrash/HangAt, inFlight/totalRequests, integrityOk, routes) + `engine_rss_mb` at root. **No per-extension RSS** by design — Bun.Worker is a thread |
| `hello-ext-worker` fixture | ✅ DONE (alpha.121) | Exercises `isolation: 'worker'` in release smoke |
| `hello-ext-global` fixture | ✅ DONE (alpha.122) | Exercises `mountStrategy: 'global'` (route at engine root, not `/ext/<name>/`) |
| 3-tier isolation docs (inline / worker / future subprocess+WASM) | ✅ DONE (alpha.122) | `EXTENSION-DEVELOPER-GUIDE.md` §13.5 — honest about thread limits, no oversell |

### Remaining (not Phase 1 blockers)

| Item | Status | Priority |
| --- | --- | --- |
| Registry computes archive SHA-256 on upload | ✅ DONE (alpha.117) | Returned in response + stored as R2 customMetadata |
| Registry returns `X-Archive-Sha256` on download | ✅ DONE (alpha.123) | `store.ts` reads R2 customMetadata, sets header |
| Engine verifies archive bytes against header at install | ✅ DONE (alpha.123) | `extension-loader.ts` SHA-256s the ZIP, refuses extract on mismatch |
| Registry enforces `integrity.archiveSha256` declared in manifest at upload | ✅ DONE (alpha.124) | Sync flow now compares manifest hash against ZIP bytes; mismatch rejected with 400 |
| `createExtensionBuildConfig` export in `@zveltio/sdk` | ✅ DONE (alpha.123) | `@zveltio/sdk/build` — CLI imports from there (single source of truth) |
| Marketplace public policy doc | ✅ DONE (alpha.129) | `docs/MARKETPLACE-POLICY.md` — v1.0 effective beta.1. §0 maps each policy claim to enforcing code; §8 operator runbook; §9 lists what's still human (review team / SLA / appeals) |
| Enforce `isolation: 'worker'` for third-party at engine load | ✅ DONE (alpha.124) | Catalog entry carries `is_official`; loader refuses to enable non-official extensions without `engine.isolation: 'worker'` |
| Unit tests for worker host bookkeeping | ✅ DONE (alpha.123) | 7 tests covering lifecycle, health record shape, duplicate guard |
| Unit test: archive SHA mismatch refused | ✅ DONE (alpha.124) | `extension-loader-archive.test.ts` |
| `extension validate` hard-fail on v1 manifests | ✅ DONE (beta.1) | v1 manifests now exit 1 with a pointer at `zveltio extension pack`. All 54 official are v2; the warning-only mode is retired. |
| Subprocess workers / WASM (Tier 3) | ⏸ Future | Don't promise per-extension RSS or OS sandbox until this lands |

### Validated live

| Alpha | Path | Validation |
| --- | --- | --- |
| .113 | Inline / bundled extensions | WSL: crm, ai, mail, forms, invoicing, auth/ldap, billing, search, sms, data/import — install + enable + route-200, zero patches |
| .121 | Worker isolation (`mountStrategy: 'subapp'`) | WSL: hello-ext-worker enabled, `runtime: 'bun-worker'` returned by `/ext/hello-ext-worker/health` — handler executed inside `Bun.Worker`, not main thread |
| .122 | Inline + worker + global mount + health endpoint | release smoke: 3 fixtures × install + enable + route + `/api/admin/extensions/health` lists all three with correct isolation tier |
| .123 | Trust chain — archive SHA-256 verify at install | release smoke continues green; 5 unit tests cover accept/reject paths including single-bit tamper. SDK build export, marketplace policy doc, worker host bookkeeping tests all land |
| .124 | Marketplace enforcement: worker mandatory for community | unit tests cover allow/refuse decisions for catalog × isolation combinations; registry rejects upload on X-Manifest-Archive-Sha256 mismatch; sync sends header from publisher hash |
| .125 | Validate-time isolation warning + fail-closed catalog flag | `extension validate` flags non-worker for community submissions before publish (avoids late surprise at enable); `ZVELTIO_REQUIRE_CATALOG=1` adds fail-closed mode when catalog fetch fails |
| .126 | Operational hardening (B1-B5) | Bun SQL `uncaughtException` handler + studio rebuild coalescing (debounce + content-hash skip); marketplace lifecycle integration tests added; manifest docs refreshed to v2; `check:schema` + `prepush` package.json scripts |
| .127 | Marketplace integration tests gated by env var | `ENABLE_MARKETPLACE_INTEGRATION_TESTS=1` opt-in; CI stays green without staged fixtures, release-binary smoke covers the path anyway |
| .128 | `initDatabase` idle timeout aligned with dialect (real B1 fix) | `BUN_SQL_IDLE_TIMEOUT_MS` (or legacy `DB_IDLE_TIMEOUT_MS`) honored; default 300s instead of the previous 30s that bypassed alpha.126's dialect change |
| .129 | Marketplace review queue (code complete) | Registry: migration 008 (status enum + audit cols + allowed_publishers); admin endpoints approve/reject/takedown/pending/publishers with reviewer audit trail. Engine: friendlier "pending review" 403 message. CLI: `admin marketplace ...` + `extension status <name>`. Apps: `/admin/marketplace/{pending,publishers,[name]}` UI with bundle preview + audit history. Policy doc DRAFT → v1.0. |
| beta.1 | Extensions v2 stable; controlled-launch marketplace | Hard-fail v1 manifests in `extension validate`. All 54 official extensions verified. CHANGELOG documents the platform contract guarantees that hold from beta.1 → v1.0. |
| beta.2 | Admin team (multi-user review roster) | Registry migration 009 + `admin_users` table + `/api/admin/team` endpoints + bootstrap path (ADMIN_EMAIL → first owner). Apps `/admin/team` UI with invite/promote/demote/remove. CLI `zveltio admin team list/add/set-role/remove`. Last-owner protections everywhere. |

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
