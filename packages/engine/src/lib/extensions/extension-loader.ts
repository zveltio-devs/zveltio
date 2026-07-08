import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import type { FieldTypeRegistry } from '../data/index.js';
// Extension install/load is naturally a synchronous filesystem operation
// (unpack archive, copy node_modules, build vite bundles, symlink shared
// deps). The project rule prefers Bun.file/Bun.spawn for runtime IO, but
// Bun deliberately exposes node:fs as the native install-time API — there
// is no synchronous Bun.file equivalent for mkdir/symlink/writeFile. The
// explicit `node:` prefix makes that intent visible.
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import type { EventBus } from '../runtime/index.js';
import { auth } from '../auth.js';
import { fieldTypeRegistry as _fieldTypeRegistry } from '../data/index.js';
// checkPermission/getUserRoles/DDLManager/createRestrictedDb/getWorkerHost +
// ExtensionSchedule now live only inside the extracted register core
// (lib/extensions/register.ts, H-04 split); dropped from the loader's imports.
// Note: the ~16 engine-helper imports that only fed buildExtensionInternals
// moved with it to ./extensions/internals.ts (H-04 split). The registry values
// (serviceRegistry/queryAlterRegistry/entityAccessRegistry/cronRunner) are now
// used only inside the extracted register/lifecycle helpers, not here.
import type { ZveltioExtension } from '@zveltio/sdk/extension';
// Utilities moved to extension-utils.ts (PR #5). Imported here for
// the loader's own internal use; also re-exported below so external
// import sites that still reach into extension-loader keep working.
import {
  inMemoryMutex,
  withExtensionLock,
  fetchWithRetry,
  isPathInsideBase,
  parseMigrationSql,
} from './extension-utils.js';
import {
  getLicenseKey,
  writeLicenseAudit,
  fingerprintToken,
  clientIp,
} from './extension-license.js';
import {
  resolveExtensionsBase,
  extensionFilesPresent,
  extensionFilesPresentCached,
  invalidateFilesPresent,
} from './extension-paths.js';
import { ensureExtensionCoreDeps } from './extension-deps.js';
import { REGISTRY_URL, downloadExtension } from './extension-download.js';
import { registerMarketplaceRoutes } from './extension-marketplace-routes.js';
import { DEFAULT_QUOTAS, QuotaExceededError, DownMissingError } from './extension-errors.js';
import { purgeExtensionData } from './migration-runner.js';
import type { ManifestMeta } from './manifest-schema.js';
// resolveManifest/enforcePublisherTier/resolveEntryPath + finalizeExtensionLoad
// + buildAllowedTables/EXTENSION_TABLE_GRANTS + embedPageSchemas (internal use)
// now live inside the extracted load pipeline (lib/extensions/load.ts, H-04
// split); dropped from the loader's imports.
import {
  buildExtensionInternals,
  type ExtensionContext,
  type ExtensionInternals,
} from './internals.js';
import { reRegisterExtension } from './register.js';
import { loadDynamic, reloadExtensionFromDisk, unloadExtension } from './lifecycle.js';
import { loadExtensionFromDir } from './load.js';
import { discoverExternal, getActiveExtensionNames, topoSortExtensions } from './discovery.js';

export { serviceRegistry } from '../service-registry.js';

// EXTENSION_TABLE_GRANTS + buildAllowedTables + the HonoRouteFn type + the
// route-register core moved to lib/extensions/register.ts (H-04 split). Imported
// above for the loader's own use.

// ── Extension lifecycle lock ─────────────────────────────────────────────────
// Serialize concurrent install/enable/disable/uninstall requests for the same
// extension name. Two protections layered:
//
//   1. In-memory Map<name, Promise> serializes same-process concurrent
//      requests. The second request waits for the first to settle.
//   2. Postgres pg_advisory_xact_lock inside the wrapped operation guards
//      against concurrent requests from other engine replicas. The lock is
//      transaction-scoped, so it auto-releases on commit/rollback.
//
// Lifecycle mutex + advisory-lock implementation moved to
// extension-utils.ts (PR #5). Re-exported below so existing import
// sites (which do `import { withExtensionLock } from './extension-loader.js'`)
// keep working — touching every call site would have made the split
// a much bigger PR.
export { inMemoryMutex, withExtensionLock } from './extension-utils.js';

/**
 * Fetch with exponential-backoff retry on transient failures.
 *
 * Retries on:
 *   - Network errors (TypeError from fetch, AbortError from timeout)
 *   - HTTP 5xx and 429 responses
 *
 * Does NOT retry on:
 *   - 4xx other than 429 (auth, not-found — retrying won't help)
 *   - Successful 2xx/3xx
 *
 * Delays: 500ms, 2s, 5s between the 3 attempts.
 */
// Moved to extension-utils.ts (PR #5); re-exported for compat.
export { fetchWithRetry } from './extension-utils.js';

// ── Hot-reload callback ───────────────────────────────────────────────────────
// Set by index.ts after Bun.serve() starts. Called after enable/disable so the
// server swaps to a freshly built Hono app without restarting the process.
type ReloadCallback = () => Promise<void>;
let _reloadCallback: ReloadCallback | null = null;

export function setReloadCallback(fn: ReloadCallback): void {
  _reloadCallback = fn;
}

async function doReload(reason: string): Promise<void> {
  try {
    console.log(`🔄 Hot-reloading server routes (${reason}) …`);
    await _reloadCallback!();
    console.log('✅ Server routes reloaded (zero downtime)');
  } catch (err) {
    console.error('❌ Hot-reload failed:', (err as Error).message);
  }
}

// Coalesce overlapping reloads. buildHonoApp() is expensive (re-registers every
// active extension + the full middleware stack); a UI that enables/disables
// several extensions back-to-back would otherwise fire N concurrent rebuilds
// that also race each other. A caller is correctly served by ANY rebuild that
// STARTS after its change landed in this.loaded (callers mutate state, THEN
// await triggerReload). So: if none is running, start one; if one is running,
// all arrivals share a single trailing rebuild that begins once it finishes —
// collapsing a burst of N into ≤2 rebuilds, and never returning before the
// caller's change is live.
let _reloadInFlight: Promise<void> | null = null;
let _reloadQueued: Promise<void> | null = null;

async function triggerReload(reason: string): Promise<void> {
  if (!_reloadCallback) return;
  if (!_reloadInFlight) {
    _reloadInFlight = doReload(reason).finally(() => {
      _reloadInFlight = null;
    });
    return _reloadInFlight;
  }
  if (!_reloadQueued) {
    _reloadQueued = _reloadInFlight.then(() => {
      _reloadQueued = null;
      _reloadInFlight = doReload(reason).finally(() => {
        _reloadInFlight = null;
      });
      return _reloadInFlight;
    });
  }
  return _reloadQueued;
}

// ── Engine-internal access for extensions ────────────────────────────────────
// Extensions receive engine internals (`auth`, `checkPermission`, `DDLManager`,
// `aiProviderManager`, etc.) via the `ctx.*` object passed into `register()`.
// They never import these directly — the SDK type `ExtensionContext` is the
// authoritative public surface. See `EXTENSION-AUTHORING.md`.
//
// Core npm packages (`hono`, `zod`, `kysely`, `@hono/zod-validator`) are
// installed into `<EXTENSIONS_DIR>/node_modules/` by `ensureExtensionCoreDeps()`
// at first startup.  A CWD-level symlink (maybeSymlinkNodeModules) makes them
// visible to the compiled binary's module resolver, which walks from CWD upward.

export type { EventBus };

// Manifest schema, types, and studio-page embedding moved to
// lib/extensions/manifest-schema.ts (H-04 split) to break the circular
// import between the per-phase load helpers and the loader. Re-exported here
// so existing import sites keep working.
export { ManifestSchema, embedPageSchemas } from './manifest-schema.js';
export type { ExtensionManifest } from './manifest-schema.js';

// Default quotas exposed for callers that don't have a full manifest yet.
// Quota constants + lifecycle errors moved to extension-errors.ts (loader split);
// imported for internal use and re-exported so existing import sites keep working.
export { DEFAULT_QUOTAS, QuotaExceededError, DownMissingError };

/**
 * Returns true if `target` resolves to a path strictly inside `base`.
 * Used before destructive filesystem operations to prevent path-traversal
 * attacks (e.g. an extension named "../../../etc" trying to escape
 * EXTENSIONS_DIR).
 *
 * Both paths are resolved to absolute form before comparison; we also reject
 * the case where they resolve to the exact same path (you should not delete
 * the base directory itself).
 */
// Moved to extension-utils.ts (PR #5); re-exported for compat.
export {
  isPathInsideBase,
  parseMigrationSql,
  directorySizeBytes,
  type ParsedMigration,
} from './extension-utils.js';

// ZveltioExtension is imported from @zveltio/sdk/extension — single source of truth.
// Re-export so other engine modules can import from here without depending on the SDK directly.
export type { ZveltioExtension };

// ExtensionContext, ExtensionInternals, and buildExtensionInternals moved to
// lib/extensions/internals.ts (H-04 split). Imported above for internal use;
// re-exported here so existing import sites (index.ts, routes, other lib
// modules) keep resolving them from './extension-loader.js'.
export { buildExtensionInternals };
export type { ExtensionContext, ExtensionInternals };

interface LoadedExtension {
  name: string;
  /** Cleanup callback captured from the extension module, if exported. */
  cleanup?: () => Promise<void>;
  /** True if the extension registered HTTP routes — unload requires restart. */
  registeredRoutes: boolean;
  /** Tables allowed by migration scan + explicit grants. */
  allowedTables?: Set<string>;
  /** Declared manifest permissions/capabilities (e.g. `db:admin`) — kept so a
   * hot-reload rebuilds the same capability-gated context (H-12). */
  permissions?: string[];
}

// ManifestMeta, ExtensionManifest, and embedPageSchemas moved to
// lib/extensions/manifest-schema.ts (H-04 split). ManifestMeta is imported at
// the top for internal use; ExtensionManifest + embedPageSchemas are
// re-exported above for external import sites.

export class ExtensionLoader {
  /** internal — also read by registerMarketplaceRoutes (loader split). */
  loaded: Map<string, LoadedExtension> = new Map();
  /** internal — also written by the extracted load pipeline (loader split). */
  manifestMeta: Map<string, ManifestMeta> = new Map();
  /** internal — also read by the extracted register/lifecycle helpers (loader split). */
  ctx?: ExtensionContext;
  /** Module cache: name → imported ZveltioExtension, kept for re-registration on hot-reload.
   *  internal — also read by the extracted register/lifecycle helpers (loader split). */
  modules: Map<string, ZveltioExtension> = new Map();
  /** Last load error per extension name — used by loadDynamic() to surface the real error.
   *  internal — also read by registerMarketplaceRoutes (loader split). */
  lastLoadError: Map<string, string> = new Map();

  async loadAll(app: Hono, ctx: ExtensionContext): Promise<void> {
    // ctx must be set FIRST — ensureExtensionCoreDeps may throw and loadAll() is
    // called inside Promise.all() with a .catch(); if ctx is set late it stays null.
    this.ctx = ctx;

    const extBase = resolveExtensionsBase();
    await ensureExtensionCoreDeps(extBase).catch((err: Error) => {
      console.warn('[extensions] Core dep install failed (non-fatal):', err.message);
    });

    const envExtensions = getActiveExtensionNames();
    const sortedEnv = await topoSortExtensions(envExtensions, extBase);
    for (const extName of sortedEnv) {
      await this.loadExtension(extName, app, ctx);
    }

    // Also load from external path if configured
    const externalPath = process.env.ZVELTIO_EXTENSIONS_PATH;
    if (externalPath && existsSync(externalPath)) {
      const externalExts = await discoverExternal(externalPath);
      const sortedExt = await topoSortExtensions(externalExts, externalPath);
      for (const extName of sortedExt) {
        await this.loadExtension(extName, app, ctx, externalPath);
      }
    }
  }

  /**
   * Read manifest.dependencies for each extension and topologically sort.
   * Body extracted to lib/extensions/discovery.ts (H-04 split); kept as a thin
   * delegator because registerMarketplaceRoutes calls it via the loader instance.
   */
  async topoSortExtensions(names: string[], baseDir: string): Promise<string[]> {
    return topoSortExtensions(names, baseDir);
  }

  /** internal — also called by the extracted lifecycle helpers (loader split). */
  async loadExtension(
    extName: string,
    app: Hono,
    ctx: ExtensionContext,
    basePath?: string,
  ): Promise<void> {
    // Body extracted to lib/extensions/load.ts (H-04 split) — the full
    // per-extension load pipeline (dir resolution, Studio-only short-circuit,
    // manifest/tier/entry phases, WASM-or-import, migrations, field types,
    // then finalizeExtensionLoad). Thin delegator so callers stay unchanged.
    return loadExtensionFromDir(this, extName, app, ctx, basePath);
  }

  /**
   * Reverse-apply every migration this extension has on record, in reverse
   * order, then delete the zv_migrations rows (see migration-runner.ts).
   * Kept as a public method because registerMarketplaceRoutes calls it via
   * the loader instance.
   */
  async purgeExtensionData(extensionName: string, db: Database): Promise<void> {
    return purgeExtensionData(extensionName, db);
  }

  async loadFromDB(db: Database, app: Hono): Promise<void> {
    try {
      const rows = await db
        .selectFrom('zv_extension_registry')
        .select(['name'])
        .where('is_enabled', '=', true)
        .execute();

      const pending = rows.map((r) => r.name).filter((name) => !this.loaded.has(name));
      if (pending.length === 0 || !this.ctx) return;

      const extBase = resolveExtensionsBase();
      const sorted = await this.topoSortExtensions(pending, extBase);
      for (const name of sorted) {
        await this.loadExtension(name, app, this.ctx);
        // Persist the per-extension outcome so a boot-time failure is visible in
        // /api/extensions (red badge + reason) instead of a silent skip, and a
        // recovered one loses its badge. is_enabled is left untouched — a
        // failing extension stays enabled and retries on the next boot.
        const err = this.isActive(name) ? null : (this.lastLoadError.get(name) ?? 'load failed');
        await db
          .updateTable('zv_extension_registry')
          .set({ last_load_error: err, last_load_at: new Date() })
          .where('name', '=', name)
          .execute()
          .catch(() => {});
      }
    } catch {
      // Table may not exist on first run — silently skip
    }
  }

  async loadDynamic(name: string, app: Hono): Promise<void> {
    // Body extracted to lib/extensions/lifecycle.ts (H-04 split). Thin
    // delegator so external callers stay unchanged.
    return loadDynamic(this, name, app);
  }

  /**
   * Register the marketplace routes (/api/marketplace).
   * Called from bootstrap after core routes — always available, not optional.
   * Moved here from routes/marketplace.ts to eliminate the inverted dependency
   * where the engine route was importing from the extension-loader lib.
   */
  registerMarketplace(app: Hono, db: Database): void {
    registerMarketplaceRoutes(this, app, db, triggerReload);
  }

  /**
   * Unloads an extension from memory.
   *
   * Limitations:
   * - HTTP routes registered via `extension.register(app)` cannot be removed
   *   at runtime because Hono does not support route de-registration.
   *   If the extension registered routes, a process restart is required for
   *   those routes to disappear. `needs_restart` is set to true in that case.
   * - If the extension exported a `cleanup()` function it will be called
   *   before removal (good for closing DB connections, timers, etc.).
   */
  async unload(
    name: string,
  ): Promise<{ unloaded: boolean; needs_restart: boolean; message: string }> {
    // Body extracted to lib/extensions/lifecycle.ts (H-04 split). Thin
    // delegator so external callers stay unchanged.
    return unloadExtension(this, name);
  }

  /**
   * Re-register a loaded extension's routes onto a fresh Hono app.
   * Used by buildHonoApp() during hot-reload — does NOT re-run migrations or npm installs.
   * Safe to call multiple times: only registers routes, no side effects.
   */
  async reRegisterExtension(name: string, app: Hono): Promise<void> {
    // Body extracted to lib/extensions/register.ts (H-04 split) — shares
    // buildRestrictedContext + registerExtensionRoutes with the loadExtension
    // register-core. Thin delegator so external callers stay unchanged.
    return reRegisterExtension(this, name, app);
  }

  /** Register the hot-reload callback. Called from index.ts after Bun.serve() starts. */
  setReloadCallback(fn: ReloadCallback): void {
    _reloadCallback = fn;
  }

  /**
   * Dev-only: drop the cached module + scoped state for `name`, then trigger
   * a full app rebuild. The rebuild's `loadExtension` re-imports with the
   * cache-buster query string, picking up edits on disk. Returns the load
   * status so the `zveltio extension dev` watcher can surface failures back
   * to the developer's terminal instead of leaving the engine running on
   * stale code.
   *
   * Scope-cleanup matches what `disable` does:
   *   - module cache, loaded map, lastLoadError
   *   - serviceRegistry, queryAlterRegistry, entityAccessRegistry
   *   - cronRunner schedules
   *
   * NOT cleaned (intentionally): migrations already applied. SQL changes
   * still require an explicit migration file — this method only re-imports
   * `engine/index.ts`.
   */
  async reloadExtensionFromDisk(name: string): Promise<{ ok: boolean; error?: string }> {
    // Body extracted to lib/extensions/lifecycle.ts (H-04 split); triggerReload
    // (module-private here) is passed in. Thin delegator — callers unchanged.
    return reloadExtensionFromDisk(this, name, triggerReload);
  }

  /**
   * Dev-only HTTP endpoint mounted in non-production. The CLI's
   * `zveltio extension dev` watcher POSTs `{ name }` here to ask the engine
   * to re-import an extension's source. No auth — same trust boundary as
   * the dev server itself (only listens when `NODE_ENV !== 'production'`).
   */
  registerDevEndpoints(app: Hono): void {
    if (process.env.NODE_ENV === 'production') return;
    app.post('/__zveltio_dev_reload', async (c) => {
      let body: { name?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'body must be JSON' }, 400);
      }
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name) return c.json({ error: 'name is required' }, 400);
      const result = await this.reloadExtensionFromDisk(name);
      return c.json(result, result.ok ? 200 : 500);
    });
    console.log(
      '🛠️  Dev reload endpoint mounted at POST /__zveltio_dev_reload (NODE_ENV != production)',
    );
  }

  getActive(): string[] {
    return [...this.loaded.keys()];
  }

  getExtensionMeta(): Array<{ name: string } & ManifestMeta> {
    return [...this.loaded.keys()].map((name) => ({
      name,
      ...(this.manifestMeta.get(name) ?? {}),
    }));
  }

  isActive(name: string): boolean {
    return this.loaded.has(name);
  }

  /** Exposes the last load error for the given extension (or undefined
   *  if the load succeeded / was never attempted). Used by
   *  /api/admin/extensions/health to surface failed-to-load extensions
   *  with their reason. */
  getLastLoadError(name: string): string | undefined {
    return this.lastLoadError.get(name);
  }

  /** Mark an extension as active (used after manual enable without a full dynamic load). */
  markActive(name: string): void {
    if (!this.loaded.has(name)) {
      this.loaded.set(name, { name, registeredRoutes: true });
    }
  }
}

export const extensionLoader = new ExtensionLoader();
