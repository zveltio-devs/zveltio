# Changelog

All notable changes to Zveltio will be documented in this file.

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
