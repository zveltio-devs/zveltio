# Changelog

All notable changes to Zveltio will be documented in this file.

## [1.0.0-alpha.99] - 2026-05-22

### Fixed — race-guard workflow bug introduced in alpha.97

The race-guard I added in alpha.97 had its own bug: read the
new latest.json with `node -p "require('$NEW_FILE')..."`, where
$NEW_FILE was a relative path like `release-assets/latest.json`.
Node treats bare relative paths as MODULE specifiers, not file
paths, so the call failed with ERR_MODULE_NOT_FOUND.

Effect: every `update-website` job since alpha.97 has been failing
silently (the job is `continue-on-error: true`). zveltio-get's
latest.json was stuck at alpha.96 from May 21 19:21 onward, even
though alpha.97 and alpha.98 shipped after that.

Switched to `JSON.parse(fs.readFileSync(...))` and passed version
strings to the comparison node script via `env` (instead of bash
string interpolation, which was also fragile against pre-release
suffixes containing dots).

Also fixed: latest.json on zveltio-get was manually corrected to
alpha.98 in commit `05cf966` before this release shipped, so
users running install.sh now get the binary that actually boots.

## [1.0.0-alpha.98] - 2026-05-21

### Fixed — compiled binary crashed on boot

The `zveltio-linux-x64` (and all matrix targets) binary failed with
"tsyringe requires a reflect polyfill" when run on a fresh install
via `install.sh`. The error fired during database migration boot,
before the engine could even handle a request.

Root cause: `@better-auth/passkey` → `@simplewebauthn/server` →
`@peculiar/x509` pulls in `tsyringe`, which initialises decorators
at module load and requires `reflect-metadata` to be loaded first.
The dev path (HMR / `bun --watch`) happened to load reflect first,
hiding the bug. The `bun build --compile` binary has a tighter
load order and exposed it.

Fix: `import 'reflect-metadata'` as the very first line of
`packages/engine/src/index.ts`, plus a direct dependency entry in
`packages/engine/package.json` (was a phantom transitive dep).

This bug has been latent since `cacd554` (S5-08 enabled passkeys
by default) — every binary release from then on would have failed
on a clean install, but the issue wasn't surfaced until WSL
end-to-end install validation on alpha.97.

## [1.0.0-alpha.97] - 2026-05-21

### CI — release workflow race-guard

When the alpha.94/.95/.96 batch was pushed at once, the three
Release workflows ran in parallel. Each `update-website` job tried
to push its own `latest.json` to `zveltio-get`. The .95 workflow
happened to finish last and clobbered .96 — leaving the public
installer endpoint pointing at the wrong version.

Two changes to `.github/workflows/release.yml`:

1. `concurrency: { group: zveltio-get-push }` on `update-website`
   so parallel workflows serialize their pushes instead of racing.
2. `latest.json` copy step now compares versions before
   overwriting. A workflow for an older tag can no longer
   downgrade the current `latest.json` even if it finishes after
   a newer one. Stable releases still win over prereleases.

Also added a `git pull --rebase --autostash` before the push so
the same workflow re-runs cleanly after a previous one in the
same batch has just committed.

## [1.0.0-alpha.96] - 2026-05-21

### Changed — disable flow parity

`POST /api/marketplace/:name/disable` now AWAITS the Studio rebuild
inline, mirroring what `enable` does. Without this, a disabled
extension's pages remained reachable in the live dist until the
next enable triggered a rebuild — confusing for the operator
("I just disabled it, why is the route still there?").

Response shape matches enable: `studio_rebuild: 'success' |
'failed' | 'skipped'`, `studio_rebuild_ms`, optional
`studio_rebuild_error`. On success, the engine broadcasts
`studio:reloaded` (`reason: 'disable'`) so connected clients see
the refresh prompt toast.

Marketplace UI updated to read the new shape.

### Fixed — content/media route conflict

Studio core had a hand-coded 618-line `/admin/media` page. The
`content/media` extension shipped a thin v1 stub (89 lines). When
sync-extensions ran, it overwrote the rich Studio version with the
stub — a real regression discovered during the alpha.95 sanity
build. The extension now owns the rich page (618 lines copied
into `content/media/studio/pages/+page.svelte`); sync regenerates
the Studio route from the extension, no clobber.

### Docs

`docs/EXTENSION-AUTHORING.md` updated with two new sections:
- "Studio v2 — no per-extension build" — what's gone, what to
  ship instead, why.
- "Studio rebuild — what happens on enable/disable" — the actual
  response shape, the trade-offs (5s build, 50ms 503 swap window),
  what happens on build failure.

Plus the existing "What to avoid" list now flags shipping
`studio/dist/` or importing `@zveltio/sdk/studio` as hard errors.

## [1.0.0-alpha.95] - 2026-05-21

### Changed — extension model v2: every extension now aligned

Companion to alpha.94. The foundation lets the Studio rebuild
absorb extensions at build/install time; this release brings the
54 first-party extensions in line with that model.

In the `zveltio-extensions` sibling repo (separate commit), every
extension was stripped of its v1 build pipeline:

- `studio/dist/` — pre-built v1 bundles (the things that failed
  in the alpha.93 visual audit with
  "Failed to resolve module specifier 'svelte/internal/disclose-version'")
- `studio/vite.config.ts`, `studio/package.json`,
  `studio/node_modules/`, `studio/.turbo/` — per-ext build infra
- `studio/src/index.ts` — old `registerRoute(...)` bundle entry,
  called the dead `@zveltio/sdk/studio` API
- `studio/src/pages/*.svelte` — v1 page wrappers (redundant —
  `studio/pages/+page.svelte` is the real route)

Six extensions that only had v1 sources were promoted to v2:
`content/media`, `data/export`, `data/import`, `developer/byod`,
`i18n/translations`, `operations/traceability` (multi-page).

Net diff on the extensions repo: 314 files changed, 33 insertions,
47,638 deletions.

### Changed — Studio

- `scripts/sync-extensions.ts` (prebuild) now also copies each
  extension's `studio/src/` into `$lib/ext/<name>/`, mirroring
  what the runtime `studio-builder.ts` already does on install.
  Keeps dev parity with the production hot-install flow.

## [1.0.0-alpha.94] - 2026-05-21

### Changed — extension model v2 foundation

Strapi-style compile-time integration replaces runtime bundle loading.
First wave of the refactor agreed on in [docs/EXTENSIONS-V2-DESIGN.md].

**Engine**:
- `POST /api/marketplace/:name/enable` now AWAITS the Studio rebuild
  inline instead of fire-and-forget. The response carries the real
  outcome: `studio_rebuild: 'success' | 'failed' | 'skipped'`,
  `studio_rebuild_ms`, plus `studio_rebuild_error` on failure. No more
  guessing whether the rebuild finished.
- After a successful rebuild, the engine broadcasts a `studio:reloaded`
  WebSocket message to ALL connected clients (via `broadcastToAll` —
  not subscription-filtered).

**Studio**:
- Dropped `loadExtensionBundles()` from `(admin)/+layout.svelte`. That
  was the path that fetched extension Studio bundles as text, wrapped
  them in blob URLs, and dynamic-imported them — which failed for
  every extension that imported from `svelte/internal/*` (no import
  map). All 42 active extensions had this broken in alpha.93.
  Replaced with `installGlobalApi()` only — extensions now live in
  Studio's compiled route tree, no runtime bundle loading needed.
- `realtime.onSystem('studio:reloaded', ...)` listener in the admin
  layout shows a toast with a "Refresh now" action button so users see
  the new pages without manual reload.
- Marketplace page reads the new sync response shape; success / failed
  / skipped each get a specific message with timing.

**Trade-off accepted**: a Studio rebuild takes ~5s and briefly serves
~50 ms of 503s during the atomic swap. For an admin tool where
extension installs happen rarely, this is the correct cost — and it
eliminates every runtime resolution issue we hit in v1
(import-map missing, peer deps unresolved, Hono matcher locked, etc.).

### Not in this release (next wave)

- Disable flow parity (currently `disable` doesn't rebuild — old pages
  remain reachable in the bundle until next enable triggers a rebuild)
- `EXTENSION-AUTHORING-V2.md` developer guide
- Migration of pilot extensions to the v2 layout (crm, invoicing,
  approvals, mail, api-docs)
- Atomic blue/green swap to drop the 50ms 503 window
- Progress SSE endpoint for live rebuild feedback

## [1.0.0-alpha.93] - 2026-05-21

Visual audit run — Playwright headless captured 40 admin pages, then
read each PNG via the multimodal Read tool to actually look at the
rendered UI. Two quick UX fixes + documentation of one P0 architectural
issue that needs a design decision.

### Fixed

- **Collection cards no longer truncate long names with `…`.** Removed
  `truncate` on the title + slug in `collections/+page.svelte`, replaced
  with `break-words` plus a `title` attribute for tooltip-on-hover. Now
  "Stock movements", "Organizations", "inv_locations" render fully instead
  of "Stock…", "Organizati…", "inv_locati…".
- **AI Studio empty-state notice promoted from raw text to themed alert.**
  "No AI provider configured" was a `text-warning` `<p>` that blended
  into the background. Wrapped in `alert alert-warning alert-soft` with
  `role="status"` so screen readers announce it and the visual prominence
  matches its importance.

### Found, not yet fixed (logged in `docs/AUDIT-2026-05-21.md`)

- **P0 — All 42 active extension Studio bundles fail to load** with
  `Failed to resolve module specifier "svelte/internal/disclose-version"`.
  Extensions are built with Svelte as external; Studio has no import map
  in `app.html` so bare specifiers can't resolve at runtime. Three fix
  paths documented (bundle Svelte per-ext / Vite plugin import-map /
  Studio re-export at stable URL); each needs a few days of work and a
  design decision before implementation.
- **P1 — Browser session lost mid-audit** after ~24 sequential page
  loads. Possibly cookie-related; not reproducible from raw curl. Worth
  an investigation pass.

## [1.0.0-alpha.92] - 2026-05-21

### Fixed

- **Hot-enable of bundle-only extensions no longer fails with
  "Can not add a route since the matcher is already built".** A live
  sweep of all 54 marketplace extensions surfaced two consistent
  failures (`content/pdf-viewer`, `developer/views`) that both have
  a no-op `register()` plus a Studio bundle. The existing try/catch
  wrapped `extension.register()` but not the subsequent
  `app.get(bundleUrl, ...)`, so the matcher-built error from the
  bundle-route registration escaped and the enable response read
  `success: false`. Wrapped the bundle registration in the same
  defer-then-rebuild path. `triggerReload` then re-runs `loadExtension`
  on a fresh Hono app where both `register()` and the bundle route
  land cleanly.

### Added

- **`docs/AUDIT-2026-05-21.md`** — full audit of alpha.91:
  - Live sweep of all 54 extensions: 54/54 install, 42/54 enable
    (78%), 12 categorised failures with proposed fixes.
  - Code-size hotspots flagged (`extension-loader.ts` 2393 LOC,
    `collections/[name]` 1561 LOC) with split recommendations.
  - Missing features vs Supabase/Pocketbase/Directus.
  - Better implementations identified — notably a four-phase
    extension install (verify → stage → promote → verify-post) that
    would resolve three of the four failure categories.
  - Honest disclaimer on what was/wasn't verified — visual UI/UX,
    a11y dynamic, and per-extension Studio pages still need a human
    with a browser.

## [1.0.0-alpha.91] - 2026-05-21

### Changed

- **Code cleanup — historic markers removed.** Stripped 10 `Bug #N`
  prefixes and 18 sprint-code prefixes (`M4 FIX`, `P0 FIX`, `C2 FIX`,
  `H1 FIX`, `I4 FIX`, `S5-02` through `S5-08`, etc.) from non-test
  source. The labels were internal sprint trackers from the alpha
  pre-release cycle; once shipped they became confusing — a recent
  peer code review interpreted the markers as open bugs when they
  were actually annotations next to the fix code.

  Where the prefix carried no information beyond "this code exists",
  the whole comment was deleted. Where the prefix preceded a real
  explanation, only the prefix was removed and the explanation
  rephrased to stand on its own.

  No behaviour change. Functional verification against the WSL test
  instance: create / patch / drop collection, field rename, ERD
  layout PUT/GET, audit log capture, templates list, backup list,
  health endpoints — all unchanged.

## [1.0.0-alpha.90] - 2026-05-20

Four legitimate findings from a peer code review, all implemented.

### Added

- **WebSocket live sync in Studio.** New `realtime` store at
  `packages/studio/src/lib/stores/realtime.svelte.ts` opens one shared
  WS to `/api/ws`, subscribes per-collection on demand, and reconnects
  with exponential backoff. The collection detail page now subscribes
  automatically — inserts/updates/deletes from any other client refresh
  the grid within ~250 ms (debounced so a bulk update doesn't hammer
  the API). Disconnects cleanly on sign-out.
- **`withOptimistic` helper.** Tiny wrapper at
  `lib/stores/optimistic.svelte.ts` that captures a state snapshot,
  patches local state immediately, awaits the network call, and rolls
  back on failure. Applied to record delete on the collection detail
  page — the row disappears instantly instead of waiting for the
  round-trip.
- **SvelteKit error boundaries.** Four new `+error.svelte` pages
  (root, admin, client, intranet). Previously an unhandled error
  rendered SvelteKit's default white-screen fallback; now users get a
  themed page with a Retry button (invalidateAll) and a "back to
  dashboard" link, plus the raw error message in a collapsible block
  so they can paste it into a bug report.

### Fixed

- **Atomic collection create — no more ghost rows on enqueue failure.**
  `POST /api/collections` previously inserted metadata into
  `zvd_collections` and then enqueued the DDL job in two separate steps.
  pg-boss has its own connection pool so a Kysely transaction can't
  span both. Solution: if the enqueue throws, delete the metadata row
  we just inserted. The route now stays consistent with the physical
  schema on every error path.

## [1.0.0-alpha.89] - 2026-05-20

### Fixed

- **Info banners unreadable in light mode** on `/admin/rls`,
  `/admin/column-permissions`, and `/admin/rpc`. All three used
  hardcoded dark-mode colors:
  ```
  bg-blue-950/30 text-blue-300 border-blue-800/40
  ```
  In light mode this produced light-blue text on a light-blue
  background — invisible. Replaced with DaisyUI's `alert alert-info
  alert-soft` semantic classes, which auto-adapt to the active theme.
  Inline `<code>` blocks switched from `bg-blue-900/40` to `bg-base-300`
  for the same reason.

## [1.0.0-alpha.88] - 2026-05-20

### Fixed

- **REAL root cause of `Plus is not defined` on `/collections`.** Three
  pages have `<Plus ... />` in their template but never imported the
  icon — pre-existing bug from the alpha.82 UX overhaul that I missed
  because the previous diagnoses focused only on `CrudListPage`:
  - `routes/(admin)/collections/+page.svelte` — line 471
    (`<Plus size={13} /> Add field` inside the New Collection modal)
  - `routes/(admin)/api-keys/+page.svelte` — line 240
    (`<Plus size={12} /> Add scope`)
  - `routes/(admin)/tenants/+page.svelte`
- Verified the patched chunks now reference the Plus icon chunk
  (`B8cigCLj2.js`) at build time. Multi-line `import { ... } from
  '@lucide/svelte'` ran a precise sweep across every .svelte file —
  no other missing icon imports remain.

### Note

The `CrudListPage` template-inline `<Plus>` fix from alpha.87 stays
in place — it's correct defensive code that protects future callers
who rely on the default action icon. The actual user-visible bug was
upstream: the collections page itself referenced `Plus` without
importing it, so the icon binding was simply undefined at runtime
regardless of how `CrudListPage` handled defaults.

## [1.0.0-alpha.87] - 2026-05-19

### Fixed

- **`Plus is not defined` STILL not fixed on alpha.85/.86** despite two
  separate attempts. Rolldown was tree-shaking the icon binding even
  when it appeared in a `$derived(...)` expression. The pattern only
  worked locally — under code-splitting, the bundler placed the icon
  import in a sibling chunk that the action-button branch didn't pull
  in. Final fix: stop routing the icon through any binding at all and
  inline both branches in the template:

  ```svelte
  {#if actionIcon}
    {@const Icon = actionIcon}
    <Icon size={16} />
  {:else}
    <Plus size={16} />
  {/if}
  ```

  `<Plus>` appears as a real template tag now, which the bundler
  treats as a hard usage. Verified by inspecting `dist/_app/immutable`:
  the Plus icon chunk (`B8cigCLj2.js`) is referenced by the CrudListPage
  chunk's imports list.

## [1.0.0-alpha.86] - 2026-05-19

Audit pass on alpha.85 — found via Liviu's real WSL install + browser
testing. Tier-1 (UI-blocking) fixed; tier-2 polish fixes batched in.

### Fixed (UI-blocking)

- **Templates with reserved `status` field name failed silently** on
  install. The DDL job died with `column "status" specified more than
  once` (DDLManager auto-adds `status` as a system column) and left
  phantom metadata in `zvd_collections`. Renamed the conflicting field
  in `helpdesk` (`status → ticket_status`), `invoicing`
  (`status → invoice_status`), and `project` (two: `status →
  project_status` on projects, `status → task_status` on tasks).
- **Templates route now validates SYSTEM_FIELDS upfront.** Before, a
  template that referenced a reserved field name would enqueue the DDL
  job + leave ghost metadata. Now returns 400 before any side effects
  with a clear message naming the offending field.
- **ERD drag state was non-reactive.** `dragMode`, `cardDragName`, and
  `didMove` were plain `let` instead of `$state(...)`. Drag-to-move
  worked because position updates propagated through other reactive
  paths, but the cursor classes and the "didMove" border highlight
  stayed stale. All three are now `$state`. Pure-numeric drag offsets
  (dragStartX/Y, etc.) stay as plain locals since nothing renders them.

### Fixed (polish)

- **`<svelte:component>` modernised.** `NavLink.svelte` and `Slot.svelte`
  were the last two places using the deprecated dynamic-component tag.
  Replaced with the Svelte 5 runes idiom (`const Icon = $derived(...)`
  then `<Icon ...>`).
- **`InlineEdit` $state-referenced-locally warning.** Was
  `let draft = $state(value)` — Svelte 5 flagged the prop capture. Now
  initialises to `''` and is overwritten from `value` in `enterEdit()`,
  which was already the behaviour intended by the original code.

### Known issues (logged for alpha.87)

- A subset of marketplace extensions (`communications/mail`,
  `auth/saml`, `compliance/ro/efactura`) fail to activate on first
  install with `Cannot find package '<dep>'` even though the dep IS
  installed in `/opt/zveltio/extensions/node_modules/`. The compiled
  binary's dynamic-import resolver doesn't walk into the symlinked
  `node_modules` for some specifiers. 12 out of the 16 most common
  extensions install + enable cleanly.
- `geospatial/postgis` requires `CREATE EXTENSION postgis` in psql —
  that's a correct precondition, not a bug, but the install.sh + docs
  should call it out.

## [1.0.0-alpha.85] - 2026-05-19

### Fixed
- **Studio: "New Collection" button silently no-ops on alpha.83/.84**.
  `CrudListPage` destructured `actionIcon: ActionIcon = Plus` — Plus
  appeared only as a default value, rolldown tree-shook the binding, and
  the chunk at runtime threw `ReferenceError: Plus is not defined` the
  moment the action button rendered. Click handlers below the error were
  never reached, so the user saw a button that did nothing. Replaced the
  destructure default with `const ActionIcon = $derived(actionIcon ?? Plus)`,
  which keeps Plus reachable from the template path so the bundler
  preserves it. Affects every page that uses CrudListPage (the
  collections list is the most user-visible).

## [1.0.0-alpha.84] - 2026-05-19

### Fixed
- **Install failure on alpha.83**: the Studio-source tarball shipped only
  `packages/studio/`, but the Studio's `package.json` references
  `@zveltio/sdk: workspace:*`. On the install host there is no workspace
  root and no SDK alongside, so `bun install` failed with
  `error: @zveltio/sdk@workspace:* failed to resolve`.
- Release workflow now builds a self-contained Studio bundle: `studio/`
  + `sdk/` (pre-built) at the tarball root, with Studio's package.json
  rewritten to `"@zveltio/sdk": "file:../sdk"`. `install.sh` extracts to
  `${ZVELTIO_DIR}/studio-bundle/` and runs `bun install` inside
  `studio-bundle/studio/`. A `studio-src` symlink stays for back-compat
  with any extension scripts that hard-code the old path.

## [1.0.0-alpha.83] - 2026-05-18

v1.0 ship-readiness pack. Eleven P0 items closed plus a full visual schema
designer + first-class business templates + a public demo mode.

### Added

#### Performance
- Benchmark suite at `bench/` — REST CRUD, list + pagination, realtime WS,
  cold-start. Pocketbase comparison via `bench/compare/pocketbase/`.
- CI `perf-smoke` job that enforces p95 budgets and uploads the result JSON
  as an artifact (`PERF_BUDGET_*_P95_MS` overridable).

#### Reliability
- `docs/DISASTER-RECOVERY.md` — operator runbook (scenarios A–F, RPO/RTO
  targets) + `scripts/dr-drill.sh` quarterly drill (requires `ZVELTIO_ENV=drill`).
- `GET /api/health/ready` — kubernetes-style readiness probe (db + cache +
  migrations).
- `GET /api/health/deep` — comprehensive operator diagnostic with per-check
  timings + disk write canary.

#### Observability
- `observability/` — Prometheus + Grafana docker-compose with the
  pre-provisioned "Zveltio Engine Overview" dashboard.

#### Security & audit
- `scripts/audit-inventory.ts` — generates `docs/AUDIT-COVERAGE.md` listing
  every mutating route handler and whether it calls `auditLog()`. Coverage
  went from 7 % to 22 % (12 → 41 audited handlers).
- `scripts/audit-regression-check.ts` — locks 28 critical-path handlers
  into CI; PRs that drop an `auditLog()` call on a mandatory route fail
  the build.
- New `AuditEventType` values: `backup.*`, `pitr.*`, `approval.*`,
  `export.executed`.

#### Features
- **Five pre-built business templates** — CRM, Invoicing, Project Mgmt,
  Help Desk, Asset Inventory. One-click install via `/admin/templates`,
  engine endpoint `POST /api/templates/:id/install` creates collections in
  dependency order.
- **Visual schema designer** at `/admin/collections/erd`. Drag-to-arrange
  with **per-user server-side persistence** (table `zv_erd_layouts`, route
  `/api/erd/layout`, localStorage fallback). Force-directed auto-arrange
  (Fruchterman–Reingold). Export to PNG (@2×) + SVG. Inline editing on
  every card — double-click renames any field, pencil opens a popover for
  type + required. `PATCH /api/collections/:name/fields/:field` handles
  rename (incl. m2o/reference relations + zvd_relations sync), type change
  (lib/field-type-conversions.ts), and required toggle in one atomic call.
- **Public demo mode** — `DEMO_MODE=true` env flag. Engine middleware
  blocks destructive admin ops with HTTP 451 (`packages/engine/src/middleware/demo-mode.ts`).
  Studio shows a persistent banner; login surfaces throwaway credentials.
  Reproducible deploy via `demo/docker-compose.yml` + `demo/seed.sh` +
  hourly `demo/reset.sh` cron.

#### Community + go-to-market
- `CONTRIBUTING.md`, GitHub issue + discussion templates under `.github/`.
- Website: `/support` (Community / Indie / Business / Enterprise tiers)
  and `/demo` pages.

### Migrations
- `076_erd_layout.sql` — per-user ERD positions (`zv_erd_layouts`).

### Breaking changes
None. Every new endpoint, env flag, and middleware is additive.

### Tooling
- `scripts/sync-engine-version.ts` reworked to read the bumped SDK version
  and propagate to root + engine + studio (root + ignored packages are
  invisible to Changesets but must track the SDK version).

## [1.0.0-alpha.72] - 2026-05-10

### Changes

- **ESM + Import Maps for extension Studio bundles.** Extension bundles are now ES modules (`formats: ['es']`) instead of IIFE. Svelte runtime is shared via a browser-native import map in `app.html` — no more `window.__SvelteRuntime` globals, no version coupling in `vite.config.ts`. Extension developers write standard Svelte; the import map handles runtime resolution transparently.
- `hooks.client.ts` simplified — Svelte runtime exposure now handled entirely by import map.
- `generate-runtime.ts` prebuild script bundles Svelte sub-modules into `static/runtime/` at Studio build time.

---

## [1.0.0-alpha.71] - 2026-05-09

### Fixes

- **Extension Studio UIs no longer freeze.** All 54 extension bundles were built with Svelte 4 externals (`svelte/internal`) that don't exist in Svelte 5. Svelte 5 uses `svelte/internal/client` — since that module was never externalized, the full Svelte 5 runtime was bundled inside every extension IIFE, creating 54 competing Svelte instances on the same page and deadlocking reactive signals. All vite.config.ts files now use a function-based `external` that catches every `svelte/*` sub-path, with a globals map that includes `svelte/internal/client → window.__SvelteRuntime.internal_client` and `svelte/reactivity`.
- **Studio correctly exposes `svelte/internal/client` and `svelte/reactivity` to extension bundles.** `hooks.client.ts` now imports and exports both via `window.__SvelteRuntime` so extension globals can resolve them.
- **19 extension bundles now self-register on load.** `auth/ldap`, `auth/saml`, `billing`, `communications/mail`, `compliance/ro/*` (5), `content/page-builder`, `crm`, `developer/edge-functions`, `forms`, `geospatial/postgis`, `operations/traceability`, `search`, `sms`, `workflow/approvals`, `workflow/checklists` exported `register()` but never called it at IIFE load time. Added `register();` to each `src/index.ts`.

---

## [1.0.0-alpha.70] - 2026-05-09

### Fixes

- **Extension Studio UI now works on fresh installs.** `studio/dist/bundle.js` files were excluded by `.gitignore` (`dist/`) and never shipped. Added `!**/studio/dist/bundle.js` exception — all 54 extension bundles are now committed and served by the engine at `/ext/<name>/bundle.js`.
- **`zv_revisions` integration test race condition fixed.** Revision INSERT was fire-and-forget; test read the table before the row landed. Now awaited (errors still swallowed).

---

## [1.0.0-alpha.69] - 2026-05-09

### Fixes

- **Extension Studio UI now appears after marketplace install.** `reRegisterExtension()` (called during hot-reload when an extension is enabled/disabled) was registering the Hono bundle route but not updating the in-memory `bundleUrl` in `this.loaded`. This meant `GET /api/extensions` returned `"bundles": []` even after a hot-reload, so the Studio never injected the bundle `<script>` tag and showed the generic "Extension active" placeholder for every extension. `reRegisterExtension()` now keeps `bundleUrl` in sync with the current filesystem state.
- **Clearer warning when extension ZIP lacks a pre-built Studio bundle.** `downloadExtension()` now emits a `⚠️` warning if an extension has `studio/vite.config.ts` but no `studio/dist/bundle.js` in the downloaded package — pointing developers to re-upload with the bundle included.
- **Audit log now logs the actual error**, not just the event type, when an audit event fails to write to `zv_audit_log`.
- **Extension package resolution fixed for compiled binaries.** When running as a compiled Bun binary (`/opt/zveltio/zveltio`), dynamic imports resolve modules starting from the process CWD, not from the imported file's directory. `ensureExtensionCoreDeps()` now calls `maybeSymlinkNodeModules()` which creates `<CWD>/node_modules → <EXTENSIONS_DIR>/node_modules` on first startup if they differ. This makes `hono`, `zod`, `kysely`, `@hono/zod-validator` and all peer-dependency packages visible to the binary's resolver. Fixes load failures for: `geospatial/postgis`, `storage/cloud`, `auth/ldap`, `auth/saml`, `communications/mail`, `content/media`, `developer/graphql`, `operations/traceability`, `compliance/ro/efactura`.
- **CRM extension migrations hardened for pre-extension installs.** The old core schema had a `zvd_transactions` table without a `name` column. `001_init.sql` now adds `name` in its upgrade block; `003_missing_columns.sql` wraps `ALTER COLUMN name DROP NOT NULL` in a conditional `DO $$` block so it skips safely when the column was never present.
- **Extension manifest peer dependencies declared.** `storage/cloud` (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`), `developer/graphql` (`graphql`), and `content/media` (`@aws-sdk/client-s3`) now declare their peer dependencies so the engine auto-installs them on first activation.
- **`content/media` removed `nanoid` dependency.** Replaced with `crypto.randomUUID()` (Bun built-in) to eliminate an unshimmed npm import.
- **`geospatial/postgis` removed direct engine imports.** Replaced `import { checkPermission } from '@zveltio/engine/lib/permissions.js'` and `import { DDLManager } from '@zveltio/engine/lib/ddl-manager.js'` with `ctx.checkPermission` and inline SQL — engine-internal modules cannot be resolved from extension files at runtime.
- **Extension schema upgrade blocks for pre-extension installs.** `forms`, `content/page-builder`, `content/drafts`, and `content/document-templates` migrations now add missing columns via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` when the table already exists from a pre-extension core schema.

---

## [1.0.0-alpha.68] - 2026-05-09

### Fix

- **CI integration tests (12 failures) resolved.** `POST /api/collections` was returning 400 on fresh installs because `DDLManager.registerMetadata()` tried to INSERT `ai_search_enabled` and `ai_search_field` columns that no longer exist in the core schema after the AI extraction in alpha.67. These are AI-extension-owned columns managed by the extension's own migrations. Removed from core `DDLManager` INSERT, `updateCollectionMetadata()`, and `ZvdCollectionsTable` TS type. All cascading test failures (relations, API keys, webhooks, cursor pagination) are resolved.

---

## [1.0.0-alpha.66] - 2026-05-07

### Internal
- Version bump only (no functional changes shipped under this number; placeholder retained for changelog continuity).

---

## [1.0.0-alpha.67] - 2026-05-08

### Breaking / Architecture

- **AI is now an extension, not core.** All `/api/ai*`, `/api/zveltio-ai`, and `/api/ai-analytics` routes; the AI provider manager; embeddings; semantic search; text-to-SQL; schema generation; agentic ZveltioAI engine — all moved out of `packages/engine` and into `zveltio-extensions/ai/`. The extension is auto-activated on first boot when files are on disk, so out-of-the-box behaviour is unchanged for new installs.
- **`ctx.services` inter-extension service registry.** Extensions can now publish services (`ctx.services.register('ai.providers', …)`) and consume services published by other extensions (`ctx.services.get('ai.providers')`). This is the supported way for extensions to communicate; direct imports between extensions remain forbidden. See [docs/EXTENSION-AUTHORING.md](docs/EXTENSION-AUTHORING.md#inter-extension-services--ctxservices).
- **Topological extension loading.** Extensions declaring `dependencies` in `manifest.json` are now loaded after their providers. Cycles fail loudly. Missing dependencies emit a warning and the dependent extension still loads (services it expected may return null).
- **`ctx.internals.aiProviderManager` removed.** Consumers must use `ctx.services.get('ai.providers')` and add `{ "name": "ai" }` to manifest dependencies.
- **`ctx.internals` gained**: `enqueueDDLJob`, `validatePublicUrl`, `extractTextFromFile`, `sendNotification`. These are engine-internal helpers previously imported directly by AI code; they remain available for first-party extensions that need them.
- **RestrictedDb extended**: extensions may now access `zv_<extname>_*` tables (their own reserved namespace). Other `zv_*` system tables remain blocked.

### Migrations

- 8 AI migrations (`011_ai.sql`, `032_ai_embeddings.sql`, `033_ai_search_config.sql`, `034_ai_decision_step.sql`, `036_ai_task_trigger.sql`, `039_ai_query.sql`, `043_ai_embed_excluded_fields.sql`, `045_ai_memory.sql`) moved to `zveltio-extensions/ai/engine/migrations/` and renumbered as `001_ai_init.sql` … `008_memory.sql`. They now run on AI extension activation rather than at engine bootstrap.

### Messaging

- README, package.json, OpenAPI spec, install scripts, and systemd unit description updated from "BaaS" to "Self-hosted Business OS".
- `versions.json` corrected — no fictional 1.0.0 stable; `latest_alpha: 1.0.0-alpha.67`.
- New [FUNDING.md](FUNDING.md) — explicit "self-hosted only, no cloud" stance + funding plan (donations + paid extensions + future support contracts).

### Affected extensions (consumers updated to ctx.services)

- `communications/mail` — AI compose/summarize endpoints now use `ctx.services.get('ai.providers')`. Manifest: declares dependency on `ai`.
- `developer/validation` — AI rule-generation endpoint same. Manifest: declares dependency on `ai`.
- `storage/cloud` — internal `document-indexer` now takes the providers as a parameter rather than importing.

### Engine consumers updated

- `lib/flow-executor.ts` — `ai_decision` flow step now resolves AI via service registry; if AI extension isn't active, step is skipped with `usedFallback: true` instead of failing the flow.
- `lib/flow-scheduler.ts` — `ai_task` flow trigger calls `ai.runBackgroundTask` service, skips with warning if AI extension is inactive.
- `lib/data-quality.ts`, `lib/cloud/document-indexer.ts` — same pattern, fail-soft when AI is unavailable.
- `routes/data.ts` — auto-embedding hook removed; replaced by AI extension subscribing to `record.created` / `record.updated` events.

---

## [1.0.0-alpha.65] - 2026-05-07

### Fixes
- Extension migrations: all `CREATE INDEX` changed to `CREATE INDEX IF NOT EXISTS` — prevents "relation already exists" 422 errors when activating extensions on databases where tables were previously created (e.g. carried over from core engine or reinstall scenarios).
- `auth/saml` peerDependency: `node-saml` version changed from `^4.0.0` (non-existent on npm) to `^3.1.0` (latest stable).
- Studio Checklists page: was calling `/api/ext/checklists` — corrected to `/api/checklists` to match the extension's actual mount path.

---

## [1.0.0-alpha.64] - 2026-05-07

### Features
- Extension manifest metadata (`displayName`, `studio.pages`) is now returned by `/api/extensions` — Studio sidebar automatically shows active extensions as nav items under an "Extensions" group without requiring a compiled IIFE bundle.
- Extension catch-all page (`/extensions/[...path]`) now shows a friendly info page (name, description, "active" badge) for API-only extensions that have no Studio UI bundle, with correct multi-segment path matching for extensions like `compliance/ro/efactura`.

### Fixes
- Removed `@zveltio/engine` from `peerDependencies` in `zveltio-extensions/package.json` — Bun was trying to resolve it from npm during CI `bun install` and failing with a 404.

---

## [1.0.0-alpha.63] - 2026-05-07

### Fixes
- Extension hot-load: swallow Hono "matcher is already built" error when enabling an extension on a running server — extension is now marked loaded immediately and `triggerReload()` rebuilds routes on a fresh Hono app, so enabling from the Studio works without restarting the service.

---

## [1.0.0-alpha.62] - 2026-05-06

### Fixes
- `install.sh`: `chown` extensions directory to `${ZVELTIO_USER}` **before** running `bun install` — the directory was created as root so `sudo -u zveltio bun install` failed with EACCES when trying to create `node_modules/`.

---

## [1.0.0-alpha.61] - 2026-05-06

### Fixes
- `install.sh`: fixed `BUN_INSTALL` variable not being passed to the bun installer — `BUN_INSTALL=... curl | bash` sets it on `curl`, not on `bash`; changed to `curl | BUN_INSTALL=... bash` so the installer writes to `/usr/local/share/bun` as intended.

---

## [1.0.0-alpha.60] - 2026-05-05

### Breaking / Architecture

- **Extensions no longer use runtime engine imports** — all `@zveltio/engine-*` virtual packages and direct `../../../../packages/engine/src/...` imports removed from every extension. Engine internals are now injected via `ctx.internals.*` (see `docs/EXTENSION-AUTHORING.md`).
- **`Bun.plugin` shims removed** — `installExtensionShims()` deleted from `extension-loader.ts`. Shims never worked in compiled binaries; all extensions now rely on real `node_modules/` provisioned by `ensureExtensionCoreDeps()`.
- **SDK `ExtensionContext` extended** — `ctx.internals` namespace added: `aiProviderManager`, `dynamicInsert`, `introspectSchema`, `runQualityScan`, `invalidateRulesCache`, `runEdgeFunction`, `extensionRegistry`, `generatePDFAsync`, `renderTemplate`, `generatePDF`, `moveToTrash`, `scheduleFileIndexing`, `DataLoaderRegistry`, `checkQueryDepth`.
- **`buildExtensionInternals()`** exported from `extension-loader.ts`; engine passes the full internals object when calling `loadAll()` and `reRegisterExtension()`.

### Fixes

- **`install.sh`**: Bun now installed system-wide at `BUN_INSTALL=/usr/local/share/bun` (symlinked to `/usr/local/bin/bun`) instead of `/root/.bun/`. Fixes the WSL/Linux systemd case where the `zveltio` service user cannot access `/root/` (mode 700).
- **`install.sh`**: Added validation step — `sudo -u nobody /usr/local/bin/bun --version` — fails the install script if Bun is not readable by unprivileged users.
- **`install.sh`**: `bun install` for extension peer deps now exits non-zero on failure (removed silent error swallow).
- **Dockerfile**: Added `RUN mkdir -p /data/extensions && chown -R zveltio:zveltio /data` before `USER zveltio` — fixes "permission denied" when engine writes `node_modules/` into `/data/extensions/` as an unprivileged container user.
- All 57 extension `routes.ts` files refactored to accept `ctx: ExtensionContext` as single argument; route factories never import engine internals directly.
- All extension `engine/index.ts` files updated to call `myRoutes(ctx)` (was `myRoutes(ctx.db, ctx.auth)`).

### Docs

- Added `docs/EXTENSION-AUTHORING.md` — full contract for extension authors: folder layout, `manifest.json` fields, `engine/index.ts` shape, the `ctx` API, route patterns, migration guide, and what to avoid.

---

## [1.0.0-alpha.59] - 2026-05-04

### Fixes
- `ensureExtensionCoreDeps()` now falls back to direct npm tarball fetch + `tar` extraction when `bun` is not on PATH — fixes "Cannot find package 'hono'" on production compiled-binary installs (e.g. systemd service) where Zveltio is installed as a single binary and `bun` is not separately available. Affected every extension that imports `hono`/`zod`/`kysely`/`@hono/zod-validator` from `routes.ts` (i.e. all extensions with engine routes); only `content/pdf-viewer` worked previously because it has no runtime imports.

---

## [1.0.0-alpha.58] - 2026-05-03

### Fixes
- Extension loader: `this.ctx` is now set as the very first operation in `loadAll()` — prevents "ExtensionLoader not initialized" when `ensureExtensionCoreDeps()` throws and the error is swallowed by the outer `Promise.all().catch()`
- `ensureExtensionCoreDeps()` errors are now caught non-fatally inside `loadAll()` so a failing `bun install` never blocks loader initialization

---

## [1.0.0-alpha.57] - 2026-05-03

### Fixes
- Extensions: `ensureExtensionCoreDeps()` auto-installs hono/zod/kysely/@hono/zod-validator in extensions base dir on first startup — fixes "Cannot find package 'hono'" in production compiled binary where `Bun.plugin` shims don't intercept dynamic imports

---

## [1.0.0-alpha.56] - 2026-05-03

### Fixes
- CI: build SDK before engine typecheck so `@zveltio/sdk` dist types exist in fresh checkout

---

## [1.0.0-alpha.55] - 2026-05-03

### Fixes
- Engine `tsconfig.json`: removed deprecated `baseUrl` + `paths` — `@zveltio/sdk` is now a proper `workspace:*` devDependency, resolved via Bun workspace symlink and SDK `package.json` exports

---

## [1.0.0-alpha.54] - 2026-05-03

### Architecture
- `ZveltioExtension` is now the single source of truth in `@zveltio/sdk/extension` — engine imports the type from SDK, eliminating the duplicate definition
- `ExtensionContext` updated in SDK with full public API: `events`, `checkPermission`, `getUserRoles`, `DDLManager`, `cleanup`
- `AssetPreviewHandler` and `StudioExtensionAPI.registerAssetPreview` added to SDK extension types
- Engine `tsconfig.json` maps `@zveltio/sdk/*` to SDK dist for typecheck
- Website: repositioned as "Business OS, not BaaS" — hero H1, comparison section, all BaaS references updated
- Website: fixed install command (`sudo bash`), alpha badge, `~10x` qualifier, `S3-compatible` storage label

### Extensions (zveltio-extensions)
- All 37 `engine/index.ts` files updated to `@zveltio/sdk/extension` import pattern
- Fixed `name` field mismatch in 17 extensions (now matches `manifest.json` exactly)
- Added `getMigrations()` to all extensions with SQL migration files (was missing — migrations never ran)
- Fixed string concatenation in `getMigrations()` → `join(import.meta.dir, ...)`

### Fixes
- Removed spurious `@zveltio/cli@2.0.0`, `@zveltio/react@2.0.0`, `@zveltio/sdk@2.0.0`, `@zveltio/vue@2.0.0` tags from git
- CHANGELOG rewritten to reflect real version history (removed erroneous `[2.0.0]` entry)

---

## [1.0.0-alpha.53] - 2026-05-03

### Extensions
- `content/pdf-viewer` extension: Studio asset preview via iframe + client EmbedPDF components (`PdfViewer`, `PdfBlock`)
- `registerAssetPreview` added to `window.__zveltio` Studio extension API
- Storage page: clickable PDF preview modal using registered asset previewers

### Marketplace
- Removed OAuth login requirement — free extensions are public, no authentication needed
- License key system for paid extensions (`ext_license:<name>` in `zv_settings`)
- Added `POST /api/marketplace/license/:name` and `DELETE /api/marketplace/license/:name` endpoints
- Catalog response includes `has_license` field per paid extension

### Bug Fixes
- Fixed `worker-configuration.d.ts` TypeScript error in zveltio-apps (leftover Cloudflare Workers reference)
- Fixed marketplace page SSR crash (`window.location.search` at module level)
- Fixed build error (extra closing `</div>` in marketplace page)

---

## [1.0.0-alpha.52] - 2026-05-02

### Bug Fixes
- Removed extra closing `</div>` in marketplace page causing build failure

---

## [1.0.0-alpha.51] - 2026-05-01

### Marketplace
- Removed OAuth popup auth flow — replaced with per-installation license key model
- Studio marketplace shows catalog directly, no login wall for free extensions

---

## [1.0.0-alpha.50] - 2026-04-28

### Extensions
- `registerAssetPreview` API added to extension registry (Svelte 5 `$state`-based)
- Extension IIFE bundles can now register custom asset preview components

---

## [1.0.0-alpha.49] - 2026-04-24

### Platform
- Edge Functions: Bun Worker sandbox, TS transpile, CRUD + `/invoke` + `/logs` + public `/api/fn/:name`
- Distributed Tracing: HTTP SERVER spans, W3C traceparent propagation, `tracedFetch()`
- DB-driven Rate Limits: per-route and per-API-key limits stored in DB, cached in Valkey
- Performance Indexes: 7 CONCURRENTLY indexes on high-traffic tables
- Onboarding Wizard: 6-step wizard, auto-redirect on first login

### Alpha→Beta Features
- Webhook HMAC signing: auto-generated secrets, `X-Zveltio-Signature: sha256=...`, `/rotate-secret`
- Full-text search via `pg_trgm`: `search_text` column + GIN index, `websearch_to_tsquery OR ILIKE`
- Column-level permissions: read/write field access control per role
- Realtime Presence + Broadcast: SSE channels, Valkey sorted-set, in-memory fallback
- Mobile Push Notifications: FCM + APNS (JWT/HTTP/2)
- Query result caching: Valkey-backed, TTL via `QUERY_CACHE_TTL_SECONDS`

---

## [1.0.0-alpha.48] - 2026-04-03

### Engine Improvements
- `crypto.randomUUID()` replaces nanoid — native Bun UUID generation
- PDF generation rewritten with `pdf-lib` (~300KB vs ~1.2MB pdfkit)
- AI engine: enhanced text-to-SQL with READ ONLY transactions
- Valkey pipeline optimizations: atomic zadd/zremrangebyscore operations
- Memory-aware request throttling with `BUN_MEMORY_LIMIT` env var

### Dependencies
- Removed: `pdfkit`, `nanoid`, `graphql-dataloader`
- Added: `pdf-lib ^1.17.1`

---

## [1.0.0-alpha.1] to [1.0.0-alpha.47]

See git history for earlier changes.
