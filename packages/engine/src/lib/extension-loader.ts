import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Database } from '../db/index.js';
import type { FieldTypeRegistry } from './field-type-registry.js';
// Extension install/load is naturally a synchronous filesystem operation
// (unpack archive, copy node_modules, build vite bundles, symlink shared
// deps). The project rule prefers Bun.file/Bun.spawn for runtime IO, but
// Bun deliberately exposes node:fs as the native install-time API — there
// is no synchronous Bun.file equivalent for mkdir/symlink/writeFile. The
// explicit `node:` prefix makes that intent visible.
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'node:url';
import type { EventBus } from './event-bus.js';
import { auth } from './auth.js';
import { checkPermission, getUserRoles } from './permissions.js';
import { DDLManager } from './ddl-manager.js';
import { fieldTypeRegistry as _fieldTypeRegistry } from './field-type-registry.js';
import { createRestrictedDb } from './extension-context.js';
import { auditLog } from './audit.js';
import { dynamicInsert } from '../db/dynamic.js';
import { introspectSchema } from './introspection.js';
import { runQualityScan } from './data-quality.js';
import { invalidateRulesCache } from './validation-engine.js';
import { runFunction as runEdgeFunction } from './edge-functions/sandbox.js';
import { extensionRegistry } from './extension-registry.js';
import { generatePDFAsync } from './pdf-queue.js';
import { renderTemplate, generatePDF } from './doc-generator.js';
import { moveToTrash } from './cloud/trash.js';
import { scheduleFileIndexing, extractTextFromFile } from './cloud/document-indexer.js';
import { DataLoaderRegistry, checkQueryDepth } from './graphql-dataloader.js';
import { enqueueDDLJob } from './ddl-queue.js';
import { validatePublicUrl } from './edge-functions/safe-fetch.js';
import { createBetterAuthSession } from './sso-session.js';
import { encryptField, decryptField, isEncryptedValue } from './field-crypto.js';
import { sendNotification } from './notifications.js';
import { serviceRegistry } from './service-registry.js';
import { queryAlterRegistry, type QueryAlterScope } from './query-alter.js';
import { entityAccessRegistry, type EntityAccessScope } from './entity-access.js';
import { cronRunner } from './cron-runner.js';
import type { ExtensionSchedule, ServiceRegistry, ZveltioExtension } from '@zveltio/sdk/extension';
// Static-import so Bun's compile-time bundler walks into the worker
// host and sees the `new Worker(new URL('./worker-extension-runtime.ts',
// import.meta.url))` call site. Dynamic-import hid the worker entry
// from static analysis and the compiled binary shipped without the
// worker source embedded (verified alpha.118 + alpha.119 smoke).
import { getWorkerHost as _getWorkerHost } from './worker-extension-host.js';
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
import { purgeExtensionData, runExtensionMigrations } from './extensions/migration-runner.js';
import {
  embedPageSchemas,
  type ExtensionManifest,
  type ManifestMeta,
} from './extensions/manifest-schema.js';
import {
  enforcePublisherTier,
  resolveEntryPath,
  resolveManifest,
} from './extensions/load-phases.js';

export { serviceRegistry } from './service-registry.js';

// ── Extension table access helpers ───────────────────────────────────────────
// Some extensions access specific core engine tables that fall outside their
// auto-detected `zv_{extname}_*` namespace. Declare those grants here so the
// RestrictedDb proxy allows them through.
const EXTENSION_TABLE_GRANTS: Record<string, string[]> = {
  'content/drafts': ['zv_revisions'],
  'developer/validation': ['zv_validation_rules'],
};

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

async function buildAllowedTables(migrationPaths: string[]): Promise<Set<string>> {
  const tables = new Set<string>();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
  for (const p of migrationPaths) {
    try {
      const content = await Bun.file(p).text();
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(content)) !== null) tables.add(m[1]);
    } catch {
      /* skip unreadable files */
    }
  }
  return tables;
}

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
export { ManifestSchema, embedPageSchemas } from './extensions/manifest-schema.js';
export type { ExtensionManifest } from './extensions/manifest-schema.js';

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

/**
 * Build the `ctx.internals` object passed to every extension.
 * All helpers are statically imported above and already linked into the
 * engine binary — building the object is just struct construction.
 *
 * Exported so the engine bootstrap (index.ts) can build the context once
 * and pass it to `loadAll`.
 */
export function buildExtensionInternals(): ExtensionInternals {
  return {
    dynamicInsert,
    introspectSchema,
    runQualityScan,
    invalidateRulesCache,
    runEdgeFunction,
    extensionRegistry,
    generatePDFAsync: generatePDFAsync as ExtensionInternals['generatePDFAsync'],
    renderTemplate,
    generatePDF,
    moveToTrash,
    scheduleFileIndexing,
    DataLoaderRegistry,
    checkQueryDepth,
    enqueueDDLJob,
    validatePublicUrl: validatePublicUrl as ExtensionInternals['validatePublicUrl'],
    extractTextFromFile: extractTextFromFile as ExtensionInternals['extractTextFromFile'],
    sendNotification: sendNotification as ExtensionInternals['sendNotification'],
    createBetterAuthSession,
    encryptSecret: async (plaintext: string) => {
      if (isEncryptedValue(plaintext)) return plaintext;
      return encryptField(plaintext);
    },
    decryptSecret: async (value: string) => {
      if (!isEncryptedValue(value)) return value;
      return decryptField(value);
    },
  };
}

/**
 * Internal extension context — extends the public ExtensionContext from the SDK
 * with concrete engine types (Database, FieldTypeRegistry, EventBus, DDLManager).
 * Extensions receive this at runtime but only see the public interface.
 */
/**
 * A Hono route-registration method (`app.get`/`post`/…). Used for the dynamic
 * `app[method]` dispatch in `registerPublicRoute`, where the method name is only
 * known at runtime from the extension's spec.
 */
type HonoRouteFn = (path: string, handler: (c: Context) => Response | Promise<Response>) => unknown;

export interface ExtensionContext {
  db: Database;
  /** Per-request tenant-scoped DB (request's tenant transaction + table guard).
   * Data handlers should use `ctx.reqDb(c)`; `ctx.db` is the global pool. */

  reqDb?: (c: Context) => Database;
  // Better-Auth instance. Its type is a deep generic over the configured
  // plugins/adapters; naming it here would couple the loader to the exact
  // better-auth build. Kept `any` as a documented survivor (H-04).
  // biome-ignore lint/suspicious/noExplicitAny: better-auth instance is a deep generic; documented survivor (H-04)
  auth: any;
  fieldTypeRegistry: FieldTypeRegistry;
  events: EventBus;
  checkPermission: (userId: string, resource: string, action: string) => Promise<boolean>;
  getUserRoles: (userId: string) => Promise<string[]>;
  DDLManager: typeof DDLManager;
  /** Inter-extension service registry — see service-registry.ts */
  services: ServiceRegistry;
  /** Query-alter registry — see query-alter.ts. Extensions add global WHERE
   * filters here (tenant isolation, soft-delete masks, redaction). */
  queryAlter: QueryAlterScope;
  /** Entity-access registry — see entity-access.ts. Per-record allow/deny
   * callbacks; first deny wins across all extensions. */
  entityAccess: EntityAccessScope;
  /** Escape hatch for routes on the engine's global app (outside /ext/<name>).
   * See SDK `registerPublicRoute` JSDoc for usage and trade-offs. */
  registerPublicRoute: (spec: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'ALL';
    path: string;
    handler: (c: Context) => Response | Promise<Response>;
  }) => void;
  internals: ExtensionInternals;
}

/**
 * Engine-internal helpers exposed to official extensions via ctx.internals.*.
 * Lazy-loaded at first access to avoid forcing every extension into pulling
 * heavy modules (PDF rendering, edge sandbox, etc.) when they don't need them.
 */
export interface ExtensionInternals {
  // Fields typed as `typeof <helper>` mirror the engine helper's real signature
  // (single source of truth) — no `any`, no cast in buildExtensionInternals().
  dynamicInsert: typeof dynamicInsert;
  introspectSchema: typeof introspectSchema;
  runQualityScan: typeof runQualityScan;
  invalidateRulesCache: (collection: string) => void;
  runEdgeFunction: typeof runEdgeFunction;
  extensionRegistry: typeof extensionRegistry;
  generatePDFAsync: (html: string, options?: Record<string, unknown>) => Promise<unknown>;
  renderTemplate: (template: string, variables: Record<string, unknown>) => string;
  generatePDF: typeof generatePDF;
  moveToTrash: typeof moveToTrash;
  scheduleFileIndexing: typeof scheduleFileIndexing;
  DataLoaderRegistry: typeof DataLoaderRegistry;
  checkQueryDepth: (query: string, maxDepth?: number) => string | null;
  enqueueDDLJob: typeof enqueueDDLJob;
  validatePublicUrl: (url: string) => Promise<URL>;
  extractTextFromFile: (
    buffer: ArrayBuffer | Buffer | Uint8Array,
    mimeType: string,
  ) => Promise<string>;
  // NOT `typeof sendNotification`: the SDK's public ExtensionContext declares a
  // looser `input` (message optional) than the engine helper (message required),
  // so this slot must stay at least as loose as the SDK's. `unknown` params keep
  // it loose without `any`; the real (stricter) fn is cast in buildExtensionInternals.
  sendNotification: (db: unknown, input: unknown) => Promise<void>;
  createBetterAuthSession: typeof createBetterAuthSession;
  encryptSecret: (plaintext: string) => Promise<string>;
  decryptSecret: (value: string) => Promise<string>;
}

interface LoadedExtension {
  name: string;
  /** Cleanup callback captured from the extension module, if exported. */
  cleanup?: () => Promise<void>;
  /** True if the extension registered HTTP routes — unload requires restart. */
  registeredRoutes: boolean;
  /** Tables allowed by migration scan + explicit grants. */
  allowedTables?: Set<string>;
}

// ManifestMeta, ExtensionManifest, and embedPageSchemas moved to
// lib/extensions/manifest-schema.ts (H-04 split). ManifestMeta is imported at
// the top for internal use; ExtensionManifest + embedPageSchemas are
// re-exported above for external import sites.

export class ExtensionLoader {
  /** internal — also read by registerMarketplaceRoutes (loader split). */
  loaded: Map<string, LoadedExtension> = new Map();
  private manifestMeta: Map<string, ManifestMeta> = new Map();
  private ctx?: ExtensionContext;
  /** Module cache: name → imported ZveltioExtension, kept for re-registration on hot-reload. */
  private modules: Map<string, ZveltioExtension> = new Map();
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

    const envExtensions = this.getActiveExtensionNames();
    const sortedEnv = await this.topoSortExtensions(envExtensions, extBase);
    for (const extName of sortedEnv) {
      await this.loadExtension(extName, app, ctx);
    }

    // Also load from external path if configured
    const externalPath = process.env.ZVELTIO_EXTENSIONS_PATH;
    if (externalPath && existsSync(externalPath)) {
      const externalExts = await this.discoverExternal(externalPath);
      const sortedExt = await this.topoSortExtensions(externalExts, externalPath);
      for (const extName of sortedExt) {
        await this.loadExtension(extName, app, ctx, externalPath);
      }
    }
  }

  /**
   * Read manifest.dependencies for each extension and topologically sort.
   *
   * Behavior:
   *   - Extensions with no manifest or no dependencies retain their relative order.
   *   - If a declared dependency is not in the planned-for-load set, the dependent
   *     extension is skipped with a warning (it can be loaded later via loadFromDB).
   *   - Cycles throw with a clear path for debugging.
   *
   * @param names    Extension names planned for load.
   * @param baseDir  Base directory where extensions live (manifests are read from here).
   */
  /** internal — also called by registerMarketplaceRoutes (loader split). */
  async topoSortExtensions(names: string[], baseDir: string): Promise<string[]> {
    if (names.length <= 1) return names;

    const depsMap = new Map<string, string[]>();
    for (const name of names) {
      const manifestPath = join(baseDir, name, 'manifest.json');
      let deps: string[] = [];
      if (existsSync(manifestPath)) {
        try {
          const m = JSON.parse(await Bun.file(manifestPath).text()) as {
            dependencies?: Array<{ name: string }>;
          };
          deps = (m.dependencies ?? []).map((d) => d.name);
        } catch {
          /* ignore — extension will fail later in loadExtension with proper error */
        }
      }
      depsMap.set(name, deps);
    }

    const sorted: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string, path: string[]): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular extension dependency: ${[...path, name].join(' -> ')}`);
      }
      visiting.add(name);
      for (const dep of depsMap.get(name) ?? []) {
        if (!depsMap.has(dep)) {
          console.warn(
            `[extensions] "${name}" depends on "${dep}" which is not in the load set — "${name}" will load anyway, but ctx.services.get('${dep}.*') may return null until "${dep}" is also activated.`,
          );
          continue;
        }
        visit(dep, [...path, name]);
      }
      visiting.delete(name);
      visited.add(name);
      sorted.push(name);
    };

    for (const name of names) visit(name, []);
    return sorted;
  }

  private getActiveExtensionNames(): string[] {
    const envExtensions = process.env.ZVELTIO_EXTENSIONS || '';
    return envExtensions
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
  }

  private async discoverExternal(basePath: string): Promise<string[]> {
    try {
      const entries = await readdir(basePath, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  private async loadExtension(
    extName: string,
    app: Hono,
    ctx: ExtensionContext,
    basePath?: string,
  ): Promise<void> {
    try {
      // Resolve extension directory.
      // Priority: explicit basePath > resolveExtensionsBase() (EXTENSIONS_DIR, CWD, dev sibling).
      const defaultBase = resolveExtensionsBase();
      const extDir = basePath ? join(basePath, extName) : join(defaultBase, extName);

      const enginePath = join(extDir, 'engine/index.js');

      // Studio/client-only extensions (`contributes.engine: false`) ship no
      // engine routes — there's nothing to load into the engine. Register
      // them as active (their Studio components are wired by the Studio
      // rebuild, separately) and skip the whole engine-load path below,
      // which would otherwise hard-fail on the missing engine bundle.
      const earlyManifestPath = join(extDir, 'manifest.json');
      if (existsSync(earlyManifestPath)) {
        try {
          const early = JSON.parse(await Bun.file(earlyManifestPath).text());
          if (early?.contributes?.engine === false) {
            this.loaded.set(extName, {
              name: extName,
              registeredRoutes: false,
              allowedTables: new Set<string>(),
            });
            this.manifestMeta.set(extName, {
              displayName: early.displayName,
              description: early.description,
              category: early.category,
              contributes: early.contributes,
              studio: await embedPageSchemas(extDir, early.studio),
            });
            console.log(`🔌 Extension loaded: ${extName} (Studio/client-only — no engine)`);
            return;
          }
        } catch {
          // Malformed manifest — fall through; the engine path re-reads it
          // and surfaces the parse error properly.
        }
      }

      if (!existsSync(enginePath)) {
        // Try TypeScript source (dev mode)
        const engineTsPath = join(extDir, 'engine/index.ts');
        if (!existsSync(engineTsPath)) {
          console.warn(`⚠️  Extension "${extName}": engine/index.js not found at ${enginePath}`);
          return;
        }
      }

      // Phase 1 — resolve + validate manifest.json (compat / quota / deps /
      // pg-exts / peerDeps) and compute the manifestMeta payload. The helper is
      // pure; it reports the exact console.* call + lastLoadError write the
      // pre-split inline path used, which we replay here verbatim.
      const manifestPhase = await resolveManifest(extName, extDir, ctx.db);
      if (!manifestPhase.ok) {
        if (manifestPhase.logLevel !== 'none') {
          console[manifestPhase.logLevel](...manifestPhase.logArgs);
        }
        if (manifestPhase.lastLoadError !== null) {
          this.lastLoadError.set(extName, manifestPhase.lastLoadError);
        }
        return;
      }
      const { manifest, migrationsLimit, extCategory, extRuntime, manifestMeta } =
        manifestPhase.value;
      // Cache UI-relevant manifest fields for the /api/extensions Studio endpoint.
      // Computed inside the phase (including embedPageSchemas); the state write
      // stays here so the phase is loader-state-free.
      if (manifestMeta !== null) {
        this.manifestMeta.set(extName, manifestMeta);
      }

      // WASM runtime path — if the manifest opts in, load the `.wasm`
      // extension through `WasmExtensionHost`. Returns a synthetic
      // `ZveltioExtension` whose register() invokes the WASM module's
      // exported register inside the capability-bound sandbox. The rest
      // of the loader treats it the same as a JS extension.
      //
      // Note today's WASM ABI is small (log, db_*, fetch_*, crypto*,
      // env_read, fs_*). Route registration from inside WASM isn't yet
      // wired through the imports table — that arrives with the
      // companion tooling wave. So WASM extensions today are
      // compute-only or background-only. JS first-party extensions
      // continue to handle the HTTP surface.
      let extension: ZveltioExtension;
      if (extRuntime === 'wasm') {
        const wasmPath = join(extDir, 'engine', 'extension.wasm');
        if (!existsSync(wasmPath)) {
          this.lastLoadError.set(
            extName,
            `manifest.runtime = "wasm" but engine/extension.wasm is missing`,
          );
          return;
        }
        const { loadWasmExtension } = await import('./wasm-extension-host.js');
        const wasm = await loadWasmExtension(wasmPath, { extName });
        // Synthetic ZveltioExtension that proxies into the WASM handle.
        extension = {
          name: extName,
          category: extCategory,
          mountStrategy: 'global',
          async register(_app, _ctx) {
            // WASM register() runs inside the sandbox. It can't bind
            // Hono routes today; that requires a routing-bridge ABI.
            // Compute / background work happens here.
            await wasm.register();
          },
        };
        // Keep a reference so reloads + unloads can call shutdown().
        (extension as ZveltioExtension & { __wasmHandle?: unknown }).__wasmHandle = wasm;
      } else {
        // Import and register extension.
        //
        // History: we previously appended `?v=<timestamp>` whenever
        // NODE_ENV !== 'production' for hot-reload during dev. In a
        // compiled Bun binary, the `?v=…` suffix becomes part of the
        // importer path, which breaks the node_modules walk-up that
        // resolves bare specifiers like `kysely`. The fix is to:
        //
        //   1. Gate the cache-buster on an EXPLICIT dev-reload flag
        //      (ZVELTIO_EXTENSION_DEV_RELOAD=1) rather than NODE_ENV.
        //      Detecting "compiled binary" via Bun.embeddedFiles was
        //      fragile across Bun versions.
        //   2. Import via `pathToFileURL(...).href` so resolution is
        //      anchored to the file's own location (which has a path
        //      walk to <EXTENSIONS_DIR>/node_modules) and not to the
        //      binary's CWD.
        //   3. Re-run maybeSymlinkNodeModules at every load — first-time
        //      install adds new node_modules at the EXTENSIONS_DIR but
        //      the CWD symlink only gets refreshed by ensureExtensionCoreDeps,
        //      which runs once at boot.
        // Manifest v2: when `engine.bundled: true` the extension ships
        // a pre-built engine/index.js with hono/zod/kysely/@hono/zod-validator
        // inlined. The Bun compiled binary CAN'T resolve those bare
        // specifiers from disk-installed node_modules at runtime, so
        // bundling is the ONLY path that works on production binaries.
        // When bundled, we skip the CORE_NPM_PACKAGES presence check
        // and import the .js artifact directly.
        const isBundled = manifest?.engine?.bundled === true;

        // Phase 2 — MARKETPLACE-POLICY.md §2 publisher-tier gate. Pure helper;
        // its failure reports the exact console.error line + lastLoadError the
        // pre-split inline gate used.
        const tierPhase = await enforcePublisherTier(extName, manifest);
        if (!tierPhase.ok) {
          if (tierPhase.logLevel !== 'none') {
            console[tierPhase.logLevel](...tierPhase.logArgs);
          }
          if (tierPhase.lastLoadError !== null) {
            this.lastLoadError.set(extName, tierPhase.lastLoadError);
          }
          return;
        }

        // Phase 3 — resolve the on-disk module path (bundled entry + integrity +
        // bundlePeers, or legacy .ts + core-dep presence). Same verbatim-replay
        // contract for its failures.
        const entryPhase = await resolveEntryPath(extName, extDir, enginePath, manifest);
        if (!entryPhase.ok) {
          if (entryPhase.logLevel !== 'none') {
            console[entryPhase.logLevel](...entryPhase.logArgs);
          }
          if (entryPhase.lastLoadError !== null) {
            this.lastLoadError.set(extName, entryPhase.lastLoadError);
          }
          return;
        }
        const resolvedPath = entryPhase.value;

        const useCacheBuster = !isBundled && process.env.ZVELTIO_EXTENSION_DEV_RELOAD === '1';
        const importHref = useCacheBuster
          ? `${pathToFileURL(resolvedPath).href}?v=${Date.now()}`
          : pathToFileURL(resolvedPath).href;
        const module = await import(importHref);
        extension = module.default;
      }

      if (!extension || typeof extension.register !== 'function') {
        console.warn(`⚠️  Extension "${extName}": missing default export or register() function`);
        return;
      }

      // Cache module for re-registration during hot-reload (avoids re-importing)
      this.modules.set(extName, extension);

      // Run extension migrations
      const migrationPaths = extension.getMigrations?.() ?? [];
      if (migrationPaths.length > migrationsLimit) {
        const err = new QuotaExceededError(
          'migrations',
          migrationPaths.length,
          migrationsLimit,
          extName,
        );
        console.warn(`⚠️  ${err.message}`);
        this.lastLoadError.set(extName, err.message);
        return;
      }
      if (migrationPaths.length > 0) {
        await this.runExtensionMigrations(extension, ctx.db);
      }

      // Register new field types contributed by extension
      if (extension.registerFieldTypes) {
        extension.registerFieldTypes(ctx.fieldTypeRegistry);
      }

      // Build allowed-tables set from migration CREATE TABLE statements + explicit grants.
      const allowedTables = await buildAllowedTables(migrationPaths);
      for (const t of EXTENSION_TABLE_GRANTS[extName] ?? []) allowedTables.add(t);

      // Pass a RestrictedDb proxy — extensions cannot query zv_* system tables.
      // Also inject the full public API (checkPermission, auth, DDLManager…) and
      // ctx.internals.* so extensions never have to relative-import engine modules.
      const restrictedCtx: ExtensionContext = {
        ...ctx,
        db: createRestrictedDb(ctx.db, extName, allowedTables),
        // Per-request tenant-scoped DB: the request's tenant transaction (so
        // FORCE-RLS'd rows are visible + isolated), wrapped in the same table
        // guard. Data-touching extension handlers MUST use ctx.reqDb(c); ctx.db
        // (global pool) bypasses tenant isolation. See MULTI-TENANT-ENABLEMENT §5.
        reqDb: (c: Context) =>
          createRestrictedDb(
            (c?.get?.('tenantTrx') as Database | null) ?? ctx.db,
            extName,
            allowedTables,
          ),
        checkPermission: ctx.checkPermission ?? checkPermission,
        getUserRoles: ctx.getUserRoles ?? getUserRoles,
        DDLManager: ctx.DDLManager ?? DDLManager,
        // Hand each extension a scoped view of the registry so its register()
        // calls are tagged for cleanup on unload. Idempotent on hot-reload.
        services: serviceRegistry.scope(extName),
        queryAlter: queryAlterRegistry.scope(extName),
        entityAccess: entityAccessRegistry.scope(extName),
        // Escape hatch: extensions on `mountStrategy: 'subapp'` may need a few
        // routes outside the `/ext/<name>/` namespace (public CDN links, dynamic
        // user-deployed endpoints). registerPublicRoute mounts them on the
        // global `app` directly. They disappear on the next rebuild like every
        // other extension route, so disable still works correctly.
        registerPublicRoute: (spec) => {
          const m = (spec.method ?? 'GET').toLowerCase() as Lowercase<typeof spec.method>;
          const fn = (app as unknown as Record<string, HonoRouteFn | undefined>)[m];
          if (typeof fn !== 'function') {
            console.warn(
              `[extension-loader] ${extName} requested unsupported HTTP method "${spec.method}" — skipped`,
            );
            return;
          }
          try {
            fn.call(app, spec.path, spec.handler);
            console.log(
              `🛣️  Extension "${extName}" registered public route: ${spec.method} ${spec.path}`,
            );
          } catch (err) {
            console.warn(
              `[extension-loader] ${extName} public route ${spec.method} ${spec.path} failed:`,
              (err as Error).message,
            );
          }
        },
        internals: ctx.internals,
      };

      // Register routes — if the live app's Hono matcher is already built (happens
      // after the first request during hot-load), swallow that specific error and
      // still mark the extension as loaded. triggerReload() will rebuild a fresh
      // Hono app where routes register correctly.
      //
      // S3-01: extensions with `mountStrategy: 'subapp'` get a fresh per-extension
      // Hono instance; the engine mounts it at `/ext/<name>`. Disable simply
      // drops the sub-app on the next app rebuild — no orphan routes.
      // The default 'global' path remains unchanged for backward compatibility.
      //
      // C-minimal worker isolation (manifest.engine.isolation === 'worker'):
      // delegate register() to WorkerExtensionHost. The worker spawns,
      // re-imports the SAME bundle, and runs register() in its own thread.
      // Migrations + field types + services etc. already ran in this main
      // thread above. Worker is responsible only for serving routes.
      let routeRegistrationDeferred = false;
      const mountStrategy = extension.mountStrategy ?? 'global';
      const workerIsolation =
        manifest?.engine?.isolation === 'worker' && manifest?.engine?.bundled === true;
      try {
        if (workerIsolation) {
          const host = _getWorkerHost(app);
          await host.start(extName, extDir, manifest!.engine!.entry);
        } else if (mountStrategy === 'subapp') {
          const subApp = new Hono();
          await extension.register(subApp, restrictedCtx);
          app.route(`/ext/${extName}`, subApp);
        } else {
          await extension.register(app, restrictedCtx);
        }
      } catch (regErr: unknown) {
        if ((regErr as Error)?.message?.includes('matcher is already built')) {
          routeRegistrationDeferred = true;
        } else {
          throw regErr;
        }
      }

      // Register native schedules. Failure here is non-fatal — log and
      // continue so the extension is otherwise functional.
      if (typeof extension.schedules === 'function') {
        try {
          const schedules = extension.schedules() ?? [];
          for (const s of schedules) {
            cronRunner.register(extName, s as ExtensionSchedule);
          }
          if (schedules.length > 0) {
            console.log(`⏰ Extension "${extName}" registered ${schedules.length} schedule(s)`);
          }
        } catch (err) {
          console.warn(
            `[cron-runner] failed to read schedules() for "${extName}":`,
            (err as Error).message,
          );
        }
      }

      this.loaded.set(extName, {
        name: extName,
        cleanup:
          typeof extension.cleanup === 'function' ? extension.cleanup.bind(extension) : undefined,
        registeredRoutes: true,
        allowedTables,
      });
      console.log(`🔌 Extension loaded: ${extName}`);

      // Audit trail — record successful load. No userId: system events
      // are tracked by event type, and 'system' is not a real user id —
      // setting it triggers the zv_audit_log_user_id_fkey FK violation.
      auditLog(ctx.db, {
        type: 'extension.loaded',
        resourceId: extName,
        resourceType: 'extension',
        metadata: { version: extension.name, actor: 'system' },
      }).catch((err: Error) => {
        console.error('[extension-loader] audit log failed:', err.message);
      });
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      console.error(`❌ Failed to load extension "${extName}":`, err);
      this.lastLoadError.set(extName, errMsg);
      // Audit trail — record load failure
      if (this.ctx) {
        auditLog(this.ctx.db, {
          type: 'extension.load_failed',
          resourceId: extName,
          resourceType: 'extension',
          metadata: { error: (err as Error).message, actor: 'system' },
        }).catch((err: Error) => {
          console.error('[extension-loader] audit log failed:', err.message);
        });
      }
    }
  }

  /**
   * Auto-install npm peerDependencies declared in an extension's manifest.json.
   * Skips packages that are already resolvable (already installed in the workspace).
   * Uses `bun add` in the workspace root so packages are available to the engine process.
   */
  private async runExtensionMigrations(extension: ZveltioExtension, db: Database): Promise<void> {
    // Body extracted to lib/extensions/migration-runner.ts (H-04 split). Bare
    // call resolves to the imported function, not this method.
    return runExtensionMigrations(extension, db);
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
    if (!this.ctx) throw new Error('ExtensionLoader not initialized — call loadAll() first');
    this.lastLoadError.delete(name);
    await this.loadExtension(name, app, this.ctx);
    // loadExtension returns void on silent failure (files not found, bad manifest, etc.)
    // Verify the extension actually landed in this.loaded before declaring success.
    if (!this.isActive(name)) {
      const realError = this.lastLoadError.get(name);
      const extBase = resolveExtensionsBase();
      const fallback = `engine/index.ts not found at ${extBase}/${name}/. Ensure EXTENSIONS_DIR is set and the extension package is deployed.`;
      throw new Error(realError ?? fallback);
    }
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
    const ext = this.loaded.get(name);
    if (!ext) {
      return {
        unloaded: false,
        needs_restart: false,
        message: `Extension "${name}" is not loaded.`,
      };
    }

    // Call extension-provided cleanup if available
    if (ext.cleanup) {
      try {
        await ext.cleanup();
        console.log(`🔌 Extension "${name}" cleanup() completed.`);
      } catch (err) {
        console.error(`🔌 Extension "${name}" cleanup() threw an error:`, err);
      }
    }

    // Remove all services this extension published. Without this, hot-reload
    // would throw on duplicate name when the extension is re-enabled.
    serviceRegistry.unregisterAll(name);
    // Drop the extension's query alters so post-unload selects don't keep
    // applying its filters.
    queryAlterRegistry.unregisterAll(name);
    // Drop the extension's entity-access checks too, for the same reason.
    entityAccessRegistry.unregisterAll(name);
    // Drop the extension's scheduled tasks so the runner stops invoking them.
    cronRunner.unregisterAll(name);

    this.loaded.delete(name);
    console.log(`🔌 Extension unloaded from memory: ${name}`);

    // Audit trail — record unload (system-triggered; userId omitted to
    // avoid FK violation against 'user' table)
    if (this.ctx) {
      auditLog(this.ctx.db, {
        type: 'extension.unloaded',
        resourceId: name,
        resourceType: 'extension',
        metadata: { needs_restart: ext.registeredRoutes, actor: 'system' },
      }).catch((err: Error) => {
        console.error('[extension-loader] audit log failed:', err.message);
      });
    }

    const needsRestart = ext.registeredRoutes;
    return {
      unloaded: true,
      needs_restart: needsRestart,
      message: needsRestart
        ? `Extension "${name}" unloaded. Routes are still active — restart the server to remove them.`
        : `Extension "${name}" unloaded successfully.`,
    };
  }

  /**
   * Re-register a loaded extension's routes onto a fresh Hono app.
   * Used by buildHonoApp() during hot-reload — does NOT re-run migrations or npm installs.
   * Safe to call multiple times: only registers routes, no side effects.
   */
  async reRegisterExtension(name: string, app: Hono): Promise<void> {
    const extension = this.modules.get(name);
    if (!extension || !this.ctx) return;

    const allowedTables = this.loaded.get(name)?.allowedTables;
    const restrictedCtx: ExtensionContext = {
      ...this.ctx,
      db: createRestrictedDb(this.ctx.db, name, allowedTables),
      reqDb: (c: Context) =>
        createRestrictedDb(
          (c?.get?.('tenantTrx') as Database | null) ?? this.ctx!.db,
          name,
          allowedTables,
        ),
      checkPermission: this.ctx.checkPermission ?? checkPermission,
      getUserRoles: this.ctx.getUserRoles ?? getUserRoles,
      DDLManager: this.ctx.DDLManager ?? DDLManager,
      services: serviceRegistry.scope(name),
      queryAlter: queryAlterRegistry.scope(name),
      entityAccess: entityAccessRegistry.scope(name),
      registerPublicRoute: (spec) => {
        const m = (spec.method ?? 'GET').toLowerCase() as Lowercase<typeof spec.method>;
        const fn = (app as unknown as Record<string, HonoRouteFn | undefined>)[m];
        if (typeof fn !== 'function') {
          console.warn(
            `[extension-loader] ${name} requested unsupported HTTP method "${spec.method}" — skipped`,
          );
          return;
        }
        try {
          fn.call(app, spec.path, spec.handler);
        } catch (err) {
          console.warn(
            `[extension-loader] ${name} public route ${spec.method} ${spec.path} failed:`,
            (err as Error).message,
          );
        }
      },
      internals: this.ctx.internals,
    };

    try {
      const mountStrategy = extension.mountStrategy ?? 'global';
      if (mountStrategy === 'subapp') {
        const subApp = new Hono();
        await extension.register(subApp, restrictedCtx);
        app.route(`/ext/${name}`, subApp);
      } else {
        await extension.register(app, restrictedCtx);
      }

      // Re-register schedules on hot-reload. unregisterAll is idempotent and
      // we want the new definitions to win.
      cronRunner.unregisterAll(name);
      if (typeof extension.schedules === 'function') {
        try {
          for (const s of extension.schedules() ?? []) {
            cronRunner.register(name, s as ExtensionSchedule);
          }
        } catch (err) {
          console.warn(
            `[cron-runner] schedules() threw on hot-reload of "${name}":`,
            (err as Error).message,
          );
        }
      }
    } catch (err) {
      console.error(`❌ Hot-reload: failed to re-register extension "${name}":`, err);
    }
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
    if (!this.modules.has(name) && !this.loaded.has(name)) {
      return {
        ok: false,
        error: `extension "${name}" is not currently loaded — restart the engine first`,
      };
    }
    this.modules.delete(name);
    this.loaded.delete(name);
    this.lastLoadError.delete(name);
    serviceRegistry.unregisterAll(name);
    queryAlterRegistry.unregisterAll(name);
    entityAccessRegistry.unregisterAll(name);
    cronRunner.unregisterAll(name);
    await triggerReload(`dev-reload:${name}`);
    if (this.lastLoadError.has(name)) {
      return { ok: false, error: this.lastLoadError.get(name)! };
    }
    return this.isActive(name)
      ? { ok: true }
      : { ok: false, error: 'extension failed to load — check engine logs' };
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
