import { Hono } from 'hono';
import { z } from 'zod';
import { sql as _sql } from 'kysely';
import type { Database } from '../db/index.js';
import type { FieldTypeRegistry } from './field-type-registry.js';
// Extension install/load is naturally a synchronous filesystem operation
// (unpack archive, copy node_modules, build vite bundles, symlink shared
// deps). The project rule prefers Bun.file/Bun.spawn for runtime IO, but
// Bun deliberately exposes node:fs as the native install-time API — there
// is no synchronous Bun.file equivalent for mkdir/symlink/writeFile. The
// explicit `node:` prefix makes that intent visible.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'node:url';
import { isCompatible, checkExtensionDependencies, getEngineVersion } from './version-checker.js';
import type { EventBus } from './event-bus.js';
import { auth } from './auth.js';
import { checkPermission, getUserRoles } from './permissions.js';
import { DDLManager } from './ddl-manager.js';
import { fieldTypeRegistry as _fieldTypeRegistry } from './field-type-registry.js';
import {
  resolvePublisherTier,
  tierAllowsInline,
  type ExtensionCatalogEntry,
} from './extension-catalog.js';
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
import type { ServiceRegistry, ZveltioExtension } from '@zveltio/sdk/extension';
import { isPackageAllowed } from './peer-deps-allowlist.js';
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
  directorySizeBytes,
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
import {
  maybeSymlinkNodeModules,
  ensureExtensionCoreDeps,
  CORE_NPM_PACKAGES,
} from './extension-deps.js';
import { REGISTRY_URL, fetchRegistryCatalog, downloadExtension } from './extension-download.js';
import { registerMarketplaceRoutes } from './extension-marketplace-routes.js';
import { DEFAULT_QUOTAS, QuotaExceededError, DownMissingError } from './extension-errors.js';

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

const ManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default('1.0.0'),
    category: z.string().default('custom'),
    zveltioMinVersion: z.string().optional(),
    zveltioMaxVersion: z.string().nullable().optional(),
    dependencies: z
      .array(
        z.object({
          name: z.string(),
          minVersion: z.string().optional(),
        }),
      )
      .default([]),
    /** npm packages auto-installed when extension is activated (e.g. node-saml, ldapts) */
    peerDependencies: z.record(z.string(), z.string()).optional(),
    /** PostgreSQL extensions required in the database (e.g. postgis, pg_trgm) */
    requires: z
      .object({
        postgres_extensions: z.array(z.string()).optional(),
      })
      .optional(),
    permissions: z.array(z.string()).default([]),
    contributes: z
      .object({
        engine: z.boolean().default(true),
        studio: z.boolean().default(false),
        client: z.boolean().default(false),
        fieldTypes: z.array(z.string()).default([]),
        stepTypes: z.array(z.string()).default([]),
        collections: z.array(z.string()).default([]),
      })
      .optional(),
    /**
     * Resource quotas. Extensions exceeding any limit fail install with
     * EXT_QUOTA_EXCEEDED. Defaults are generous enough for current extensions;
     * publishers wanting a smaller footprint can tighten them per-extension.
     */
    quotas: z
      .object({
        bundleSizeKbMax: z.number().int().positive().default(50_000),
        nodeModulesSizeMbMax: z.number().int().positive().default(200),
        migrationsMax: z.number().int().positive().default(100),
      })
      .optional(),
    /**
     * Extension runtime. `"js"` (default) loads via dynamic
     * import of `engine/index.ts`. `"wasm"` loads via `WasmExtensionHost`
     * — the engine reads `engine/extension.wasm` and runs it inside a
     * capability-bound WebAssembly instance. WASM extensions get real
     * isolation (separate linear memory, no V8 heap access) at the cost
     * of a small ABI surface; see `docs/EXTENSION-DEVELOPER-GUIDE.md` §16.
     */
    runtime: z.enum(['js', 'wasm']).default('js').optional(),
    /**
     * v2 engine block. When present with `bundled: true`, the loader
     * imports `engine.entry` (a pre-built `.js` artifact) directly
     * without checking for the CORE_NPM_PACKAGES on disk — the bundle
     * has them inlined. See docs/EXTENSIONS-V2-PHASE1.md.
     */
    engine: z
      .object({
        entry: z.string(),
        format: z.literal('esm').default('esm'),
        target: z.enum(['bun', 'node', '*']).default('bun'),
        bundled: z.boolean(),
        bundlePeers: z.boolean().default(false),
        /**
         * Isolation strategy. `'inline'` (default) runs the extension
         * in the engine's main thread — same as today, max speed and
         * full access. `'worker'` spawns a Bun.Worker per enabled
         * extension; the worker has no DATABASE_URL, no service
         * registry write access, and all SQL is proxied through the
         * host. Use for third-party / untrusted extensions where
         * security trumps the +0.5-2ms IPC overhead per route hit.
         * See docs/EXTENSIONS-V2-PHASE1.md §10 for the threat model.
         */
        isolation: z.enum(['inline', 'worker']).default('inline'),
      })
      .optional(),
    integrity: z
      .object({
        engineSha256: z.string().regex(/^[a-f0-9]{64}$/),
        // archiveSha256 is computed by the registry on upload. The pack
        // command writes an empty string as a placeholder (registry fills
        // it in later); accept either missing/empty OR a valid hash.
        archiveSha256: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{64}$/)]).optional(),
      })
      .optional(),
  })
  .passthrough();

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
    dynamicInsert: dynamicInsert as ExtensionInternals['dynamicInsert'],
    introspectSchema: introspectSchema as ExtensionInternals['introspectSchema'],
    runQualityScan: runQualityScan as ExtensionInternals['runQualityScan'],
    invalidateRulesCache,
    runEdgeFunction: runEdgeFunction as ExtensionInternals['runEdgeFunction'],
    extensionRegistry,
    generatePDFAsync: generatePDFAsync as ExtensionInternals['generatePDFAsync'],
    renderTemplate,
    generatePDF: generatePDF as ExtensionInternals['generatePDF'],
    moveToTrash: moveToTrash as ExtensionInternals['moveToTrash'],
    scheduleFileIndexing: scheduleFileIndexing as ExtensionInternals['scheduleFileIndexing'],
    DataLoaderRegistry,
    checkQueryDepth,
    enqueueDDLJob: enqueueDDLJob as ExtensionInternals['enqueueDDLJob'],
    validatePublicUrl: validatePublicUrl as ExtensionInternals['validatePublicUrl'],
    extractTextFromFile: extractTextFromFile as ExtensionInternals['extractTextFromFile'],
    sendNotification: sendNotification as ExtensionInternals['sendNotification'],
    createBetterAuthSession:
      createBetterAuthSession as ExtensionInternals['createBetterAuthSession'],
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
export interface ExtensionContext {
  db: Database;
  /** Per-request tenant-scoped DB (request's tenant transaction + table guard).
   * Data handlers should use `ctx.reqDb(c)`; `ctx.db` is the global pool. */

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  reqDb?: (c: any) => Database;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    handler: (c: any) => any;
  }) => void;
  internals: ExtensionInternals;
}

/**
 * Engine-internal helpers exposed to official extensions via ctx.internals.*.
 * Lazy-loaded at first access to avoid forcing every extension into pulling
 * heavy modules (PDF rendering, edge sandbox, etc.) when they don't need them.
 */
export interface ExtensionInternals {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  dynamicInsert: (db: any, collection: string, values: Record<string, unknown>) => Promise<unknown>;
  introspectSchema: (
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    db: any,
    schemaName?: string,
    excludePatterns?: string[],
    dryRun?: boolean,
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  ) => Promise<any[]>;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  runQualityScan: (...args: any[]) => Promise<unknown>;
  invalidateRulesCache: (collection: string) => void;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  runEdgeFunction: (...args: any[]) => Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  extensionRegistry: any;
  generatePDFAsync: (html: string, options?: Record<string, unknown>) => Promise<unknown>;
  renderTemplate: (template: string, variables: Record<string, unknown>) => string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  generatePDF: (...args: any[]) => Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  moveToTrash: (...args: any[]) => Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  scheduleFileIndexing: (...args: any[]) => Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  DataLoaderRegistry: any;
  checkQueryDepth: (query: string, maxDepth?: number) => string | null;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  enqueueDDLJob: (...args: any[]) => Promise<unknown>;
  validatePublicUrl: (url: string) => Promise<URL>;
  extractTextFromFile: (
    buffer: ArrayBuffer | Buffer | Uint8Array,
    mimeType: string,
  ) => Promise<string>;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  sendNotification: (db: any, input: any) => Promise<void>;
  createBetterAuthSession: (
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    db: any,
    userId: string,
    opts?: {
      ipAddress?: string;
      userAgent?: string;
      ttlSeconds?: number;
      crossDomain?: boolean;
    },
  ) => Promise<{ token: string; setCookie: string }>;
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

interface ManifestMeta {
  displayName?: string;
  description?: string;
  category?: string;
  contributes?: { engine?: boolean; studio?: boolean; client?: boolean };
  studio?: {
    navGroup?: string;
    pages?: Array<{
      path: string;
      label: string;
      icon?: string;
      /** Declarative page: a relative path under studio/ to a JSON schema
       * (in the manifest), replaced at load time by the parsed schema object
       * + `render: 'schema'` so the Studio renders it without per-host build. */
      schema?: unknown;
      render?: 'schema';
    }>;
  };
}

/**
 * For each manifest studio page that names a JSON schema file, read + parse it
 * and inline the parsed object (so /api/extensions delivers it with no extra
 * round-trip and no per-host build). Read once at load; failures degrade
 * gracefully (the page is left as-is).
 */
async function embedPageSchemas(
  extDir: string,
  studio: ManifestMeta['studio'],
): Promise<ManifestMeta['studio']> {
  if (!studio?.pages?.length) return studio;
  const pages = await Promise.all(
    studio.pages.map(async (p) => {
      if (typeof p.schema !== 'string') return p;
      try {
        const raw = await Bun.file(join(extDir, 'studio', p.schema)).text();
        return { ...p, schema: JSON.parse(raw) as unknown, render: 'schema' as const };
      } catch (e) {
        console.warn(`⚠️  Extension schema "${p.schema}" failed to load: ${(e as Error).message}`);
        return p;
      }
    }),
  );
  return { ...studio, pages };
}

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

      // Migrations quota is determined from manifest (or defaults if no manifest).
      // Hoisted out of the if-block so the check after getMigrations() can see it.
      let migrationsLimit = DEFAULT_QUOTAS.migrationsMax;
      // Extension category — hoisted so the WASM branch below can reach it
      // for the synthetic ZveltioExtension. Default matches the manifest schema.
      let extCategory: string = 'custom';
      // Runtime selector ('js' | 'wasm'). Hoisted for the same reason as
      // migrationsLimit + extCategory. Defaults to 'js' for back-compat.
      let extRuntime: 'js' | 'wasm' = 'js';

      // Hoisted out of the if-block so the v2 `engine.bundled` check
      // below (in the JS-runtime path) can see it.
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      let manifest: any = null;

      // Validate manifest.json if present, then check compatibility + dependencies
      const manifestPath = join(extDir, 'manifest.json');
      if (existsSync(manifestPath)) {
        try {
          const rawManifest = JSON.parse(await Bun.file(manifestPath).text());
          manifest = ManifestSchema.parse(rawManifest);
        } catch (err) {
          const msg = `invalid manifest.json — ${(err as Error).message}`;
          this.lastLoadError.set(extName, msg);
          console.warn(`⚠️  Extension "${extName}": ${msg}`);
          return;
        }
        if (typeof manifest.category === 'string') extCategory = manifest.category;
        if (manifest.runtime === 'wasm') extRuntime = 'wasm';

        // Engine version compatibility
        const compat = isCompatible(
          getEngineVersion(),
          manifest.zveltioMinVersion,
          manifest.zveltioMaxVersion,
        );
        if (!compat.compatible) {
          console.warn(`⚠️  Extension "${extName}" incompatible: ${compat.reason}`);
          return;
        }

        // Resource quota: bundle size (extension folder excluding node_modules).
        // node_modules sits in the shared workspace root, not inside extDir, so
        // a recursive walk of extDir captures only this extension's own files.
        const quotas = manifest.quotas ?? DEFAULT_QUOTAS;
        migrationsLimit = quotas.migrationsMax;
        const bundleBytes = await directorySizeBytes(extDir);
        const bundleKb = Math.ceil(bundleBytes / 1024);
        if (bundleKb > quotas.bundleSizeKbMax) {
          const err = new QuotaExceededError(
            'bundleSizeKb',
            bundleKb,
            quotas.bundleSizeKbMax,
            extName,
          );
          console.warn(`⚠️  ${err.message}`);
          this.lastLoadError.set(extName, err.message);
          return;
        }

        // Extension dependencies (other Zveltio extensions)
        if (manifest.dependencies && manifest.dependencies.length > 0) {
          const deps = await checkExtensionDependencies(ctx.db, manifest.dependencies);
          if (!deps.satisfied) {
            const msg = `Missing required extensions: ${deps.missing.join(', ')}. Enable them first.`;
            console.warn(`⚠️  Extension "${extName}" ${msg}`);
            this.lastLoadError.set(extName, msg);
            return;
          }
        }

        // PostgreSQL extension requirements (e.g. postgis)
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        const requiredPgExts: string[] = (manifest as any).requires?.postgres_extensions ?? [];
        if (requiredPgExts.length > 0) {
          try {
            const result = await _sql<{ extname: string }>`
              SELECT extname FROM pg_extension WHERE extname = ANY(${
                // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
                requiredPgExts as any
              })
            `.execute(ctx.db);
            const installed = new Set(result.rows.map((r) => r.extname));
            const missing = requiredPgExts.filter((e) => !installed.has(e));
            if (missing.length > 0) {
              const msg =
                `Extension "${extName}" requires PostgreSQL extension(s) not installed: ${missing.join(', ')}. ` +
                `Install them in psql: ${missing.map((e) => `CREATE EXTENSION "${e}";`).join(' ')} then retry.`;
              console.warn(`⚠️  ${msg}`);
              this.lastLoadError.set(extName, msg);
              return;
            }
          } catch {
            // pg_extension query is non-fatal — continue and let the migration surface the real error.
          }
        }

        // npm peerDependencies — auto-install before loading. Failure is fatal
        // (an extension that needs `imapflow` but couldn't install it will crash
        // when imported). Cache the error for the marketplace HTTP response.
        if (manifest.peerDependencies && Object.keys(manifest.peerDependencies).length > 0) {
          try {
            await this.installNpmDependencies(extName, manifest.peerDependencies);
          } catch (err) {
            const msg = (err as Error).message;
            console.warn(`⚠️  ${msg}`);
            this.lastLoadError.set(extName, msg);
            return;
          }

          // Resource quota: total node_modules size in the shared workspace.
          // This is a coarse guard against accidentally pulling in multi-GB
          // packages. Note: it counts ALL extensions' deps, not just this one's,
          // so the limit needs headroom for the ecosystem total.
          const nodeModulesDir = join(resolveExtensionsBase(), 'node_modules');
          const nmBytes = await directorySizeBytes(nodeModulesDir);
          const nmMb = Math.ceil(nmBytes / (1024 * 1024));
          if (nmMb > quotas.nodeModulesSizeMbMax) {
            const err = new QuotaExceededError(
              'nodeModulesSizeMb',
              nmMb,
              quotas.nodeModulesSizeMbMax,
              extName,
            );
            console.warn(`⚠️  ${err.message}`);
            this.lastLoadError.set(extName, err.message);
            return;
          }
        }

        // Cache UI-relevant manifest fields for the /api/extensions Studio endpoint
        this.manifestMeta.set(extName, {
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
          displayName: (manifest as any).displayName,
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
          description: (manifest as any).description,
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
          category: (manifest as any).category,
          contributes: manifest.contributes as ManifestMeta['contributes'],
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
          studio: await embedPageSchemas(extDir, (manifest as any).studio),
        });
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
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        (extension as any).__wasmHandle = wasm;
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
        const isBundled = manifest.engine?.bundled === true;
        const extBase = resolveExtensionsBase();

        // MARKETPLACE-POLICY.md §2 enforcement: publisher tier governs
        // whether an extension may run inline. The registry catalog
        // carries `publisher_tier` (migration 010); older registries
        // omit it and resolvePublisherTier() falls back to is_official
        // (official → first-party, otherwise → community). Local
        // hardcoded catalog entries default to is_official=true, so the
        // 54 first-party + smoke fixtures stay exempt.
        //
        //   first-party / verified → inline allowed
        //   community (or unknown) → worker REQUIRED
        //
        // Two operator overrides:
        //   ZVELTIO_ALLOW_INLINE_THIRD_PARTY=1 — trusted self-hosted,
        //     accept inline for any extension (skip the gate entirely)
        //   ZVELTIO_REQUIRE_CATALOG=1 — fail-closed: if catalog fetch
        //     fails (network, registry down) refuse rather than
        //     fall through to local-only assumptions
        if (
          process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY !== '1' &&
          manifest.engine?.isolation !== 'worker'
        ) {
          let catalog: ExtensionCatalogEntry[] | null = null;
          let catalogFetchFailed = false;
          try {
            catalog = await fetchRegistryCatalog();
          } catch {
            catalogFetchFailed = true;
          }
          if (catalogFetchFailed && process.env.ZVELTIO_REQUIRE_CATALOG === '1') {
            const msg =
              `Extension "${extName}" cannot be enabled: catalog fetch ` +
              `failed and ZVELTIO_REQUIRE_CATALOG=1 forbids falling back ` +
              `to local-only first-party assumptions. Retry when the ` +
              `registry is reachable, or unset the env var.`;
            this.lastLoadError.set(extName, msg);
            console.error(`❌ ${msg}`);
            return;
          }
          if (catalog) {
            // An extension present in a successfully-loaded catalog uses
            // its declared tier; one that's ABSENT is unknown/unaudited
            // and must be treated as community (the strictest tier) —
            // otherwise a sideloaded inline extension that nobody
            // published would slip past the gate. The local hardcoded
            // catalog (the 54 first-party + smoke fixtures) is merged in
            // by fetchRegistryCatalog(), so genuine first-party
            // extensions are always found. Trusted self-hosted installs
            // that deliberately sideload inline code use
            // ZVELTIO_ALLOW_INLINE_THIRD_PARTY=1.
            const catEntry = catalog.find((e) => e.name === extName);
            const tier = catEntry ? resolvePublisherTier(catEntry) : 'community';
            if (!tierAllowsInline(tier)) {
              const what = catEntry
                ? `is a ${tier} submission`
                : `is not in the marketplace catalog (treated as ${tier})`;
              const msg =
                `Extension "${extName}" ${what} but does ` +
                `not declare engine.isolation: "worker". Per ` +
                `MARKETPLACE-POLICY §2, ${tier} extensions must run in ` +
                `worker isolation. Republish with isolation: "worker" ` +
                `or, for trusted self-hosted installs, set ` +
                `ZVELTIO_ALLOW_INLINE_THIRD_PARTY=1.`;
              this.lastLoadError.set(extName, msg);
              console.error(`❌ ${msg}`);
              return;
            }
          }
        }

        let resolvedPath: string;
        if (isBundled) {
          const bundledEntry = join(extDir, manifest.engine!.entry);
          if (!existsSync(bundledEntry)) {
            const msg =
              `Extension "${extName}" manifest declares engine.bundled=true ` +
              `but engine.entry "${manifest.engine!.entry}" is not on disk at ${bundledEntry}. ` +
              `Run \`zveltio extension pack\` before publishing.`;
            this.lastLoadError.set(extName, msg);
            console.error(`❌ ${msg}`);
            return;
          }
          // Optional: verify integrity hash if the manifest declares one.
          if (manifest.integrity?.engineSha256) {
            const { createHash } = await import('node:crypto');
            const actual = createHash('sha256').update(readFileSync(bundledEntry)).digest('hex');
            if (actual !== manifest.integrity.engineSha256) {
              const msg =
                `Extension "${extName}" integrity check failed: ` +
                `manifest declares engineSha256=${manifest.integrity.engineSha256} ` +
                `but the on-disk bundle hashes to ${actual}. ` +
                `Re-pack and re-publish, or the bundle was tampered with.`;
              this.lastLoadError.set(extName, msg);
              console.error(`❌ ${msg}`);
              return;
            }
          }
          // Bundled extensions that declare peer deps must inline them
          // (`engine.bundlePeers: true` at pack time). The compiled
          // Bun binary cannot resolve bare specifiers from dynamic
          // imports of disk files — neither via CWD node_modules nor
          // adjacent-to-the-bundle node_modules walks (verified live
          // alpha.112: imapflow import threw despite the peer being
          // installed in EXTENSIONS_DIR/node_modules AND a CWD
          // symlink AND a sibling engine/node_modules). For native
          // bindings that cannot be bundled, the extension author
          // must ship them via a separate engine plugin instead.
          if (
            manifest.peerDependencies &&
            Object.keys(manifest.peerDependencies).length > 0 &&
            manifest.engine?.bundlePeers !== true
          ) {
            const peers = Object.keys(manifest.peerDependencies).join(', ');
            const msg =
              `Extension "${extName}" declares peerDependencies (${peers}) but ` +
              `engine.bundlePeers is not true. Bun's compiled binary cannot ` +
              `resolve bare specifiers from a dynamically-imported disk file, ` +
              `so peers must be inlined at pack time. Re-pack with ` +
              `\`engine.bundlePeers: true\` in manifest.json, or remove the ` +
              `peerDependencies entry if the import was inadvertent.`;
            this.lastLoadError.set(extName, msg);
            console.error(`❌ ${msg}`);
            return;
          }
          resolvedPath = bundledEntry;
        } else {
          // Legacy / dev path: .ts source + on-disk core deps.
          // Refuse legacy .ts in production. ZVELTIO_EXTENSION_DEV_RELOAD=1
          // keeps the door open for local development against unbundled
          // extensions, but the production binary should never load a
          // .ts because that pulls in the kysely/hono module-resolution
          // bug we spent 16 alpha releases fixing. Hard-fail here
          // surfaces "this extension wasn't packed" loudly instead of
          // letting it slip through to a cryptic dynamic-import throw.
          const allowLegacy = process.env.ZVELTIO_EXTENSION_DEV_RELOAD === '1';
          if (!allowLegacy && process.env.NODE_ENV === 'production') {
            const msg =
              `Extension "${extName}" is not bundled (manifest.engine.bundled !== true). ` +
              `Production refuses legacy .ts extensions because Bun's compiled-binary ` +
              `resolver cannot find core deps via disk node_modules walks. ` +
              `Run \`zveltio extension pack --dir <ext>\` and re-deploy the ` +
              `extension, or set ZVELTIO_EXTENSION_DEV_RELOAD=1 in dev environments.`;
            this.lastLoadError.set(extName, msg);
            console.error(`❌ ${msg}`);
            return;
          }
          resolvedPath = existsSync(enginePath) ? enginePath : join(extDir, 'engine/index.ts');
          maybeSymlinkNodeModules(extBase);
          for (const pkg of CORE_NPM_PACKAGES) {
            const pkgFolder = pkg.startsWith('@') ? pkg : pkg.split('/')[0];
            if (!existsSync(join(extBase, 'node_modules', pkgFolder))) {
              const msg =
                `Core package '${pkg}' not found in ${join(extBase, 'node_modules')}. ` +
                `Boot-time install of core deps failed or the directory is missing. ` +
                `Fix: ensure EXTENSIONS_DIR is set correctly and writable, then restart the engine. ` +
                `(Or migrate this extension to manifest v2 with engine.bundled=true via \`zveltio extension pack\`.)`;
              this.lastLoadError.set(extName, msg);
              console.error(`❌ Extension "${extName}":`, msg);
              return;
            }
          }
        }

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
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        reqDb: (c: any) =>
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
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
          const fn = (app as any)[m];
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
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      } catch (regErr: any) {
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
            // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
            cronRunner.register(extName, s as any);
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
  private async installNpmDependencies(
    extName: string,
    peerDeps: Record<string, string>,
  ): Promise<void> {
    // Install into the extensions base directory — the same place ensureExtensionCoreDeps
    // puts hono/zod/kysely so that dynamically-imported extension modules can resolve all
    // packages via the standard Node.js filesystem walk from their location.
    // Using resolveExtensionsBase() keeps peerDeps co-located with core deps and works
    // correctly whether running as a compiled binary, in dev, or inside Docker.
    const workspaceRoot = resolveExtensionsBase();

    const extNodeModules = join(workspaceRoot, 'node_modules');
    const toInstall: string[] = [];
    for (const [pkg, versionRange] of Object.entries(peerDeps)) {
      // Check via Bun's module resolution first, then fall back to a direct filesystem check
      // against the extensions node_modules (import.meta.resolve runs in engine binary context
      // and cannot see packages installed in the extensions directory).
      // Only check the extensions node_modules — import.meta.resolve runs in
      // the engine's bundle context and would find engine-bundled packages
      // (hono, zod, etc.) even though they're not available to dynamically
      // imported extension files that look up from their own directory.
      const pkgFolder = pkg.startsWith('@') ? pkg : pkg.split('/')[0];
      const alreadyInstalled = existsSync(join(extNodeModules, pkgFolder));
      if (!alreadyInstalled) {
        const spec =
          versionRange && versionRange !== '*'
            ? `${pkg}@${versionRange.replace(/^\^|^~/, '')}`
            : pkg;
        toInstall.push(spec);
      }
    }

    if (toInstall.length === 0) return;

    // Ensure a package.json exists in the install dir so `bun add` works.
    const pkgJsonPath = join(workspaceRoot, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      writeFileSync(
        pkgJsonPath,
        JSON.stringify(
          {
            name: 'zveltio-extensions',
            private: true,
            type: 'module',
          },
          null,
          2,
        ),
      );
    }

    // SECURITY: validate package names and version ranges before spawning bun add.
    // A malicious manifest.json could inject shell metacharacters or use non-registry
    // protocols (file:, git:, link:) to run arbitrary code or access the filesystem.
    const SAFE_PACKAGE_NAME = /^(@[a-z0-9-_]+\/)?[a-z0-9-_.]+$/;
    const SAFE_VERSION = /^[\d.*^~>=<| -]+$/;
    for (const [pkg, ver] of Object.entries(peerDeps)) {
      if (!SAFE_PACKAGE_NAME.test(pkg) || !SAFE_VERSION.test(ver)) {
        throw new Error(
          `Extension "${extName}" declared unsafe peerDependency: "${pkg}@${ver}". ` +
            `Only scoped/unscoped npm package names with semver ranges are allowed.`,
        );
      }
      // SECURITY: enforce platform allow-list. Unknown packages cannot be auto-installed
      // — a publisher must request inclusion in peer-deps-allowlist.ts via PR review.
      if (!isPackageAllowed(pkg)) {
        throw new Error(
          `Extension "${extName}" declared disallowed peerDependency: "${pkg}". ` +
            `Only packages on the platform allow-list may be auto-installed. ` +
            `See packages/engine/src/lib/peer-deps-allowlist.ts to request inclusion.`,
        );
      }
    }

    console.log(`📦 Extension "${extName}": installing npm packages: ${toInstall.join(', ')}`);

    // Try bun add first; fall back to npm install if bun is not on PATH
    let installed = false;

    try {
      const proc = Bun.spawn(['bun', 'add', ...toInstall], {
        cwd: workspaceRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        installed = true;
      } else {
        const stderr = await new Response(proc.stderr).text();
        console.warn(`[extensions] bun add failed for "${extName}": ${stderr.trim()}`);
      }
    } catch {
      // ENOENT — bun not on PATH; try npm
    }

    if (!installed) {
      try {
        const npmProc = Bun.spawn(['npm', 'install', '--save', ...toInstall], {
          cwd: workspaceRoot,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const exitCode = await npmProc.exited;
        if (exitCode === 0) {
          installed = true;
        } else {
          const stderr = await new Response(npmProc.stderr).text();
          console.warn(`[extensions] npm install failed for "${extName}": ${stderr.trim()}`);
        }
      } catch {
        // npm not on PATH either
      }
    }

    if (!installed) {
      // S1-02: fail-close. Previously this was a warning + return, but an
      // extension whose peerDeps fail to install will crash at runtime when it
      // tries to import the missing module. Surface the failure now so the
      // install / enable HTTP response carries an actionable error to the user.
      throw new Error(
        `Extension "${extName}": could not install peer packages ${toInstall.join(', ')}. ` +
          `Install them manually in ${workspaceRoot}: bun add ${toInstall.join(' ')}`,
      );
    }

    console.log(`✅ Extension "${extName}": packages installed successfully`);
  }

  private async runExtensionMigrations(extension: ZveltioExtension, db: Database): Promise<void> {
    const migrations = extension.getMigrations?.() || [];
    if (migrations.length === 0) return;

    // Phase 1 — read all migrations + skip the ones already applied. Done
    // outside the outer transaction so an early-skipped chain (everything
    // already applied) doesn't open a useless transaction.
    type Pending = { name: string; up: string; down: string | null };
    const pending: Pending[] = [];
    for (const migrationPath of migrations) {
      const name = `ext:${extension.name}:${migrationPath.split('/').pop()?.replace('.sql', '')}`;
      const existing = await db
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        .selectFrom('zv_migrations' as any)
        .select('id')
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        .where('name' as any, '=', name)
        .executeTakeFirst()
        .catch(() => null);
      if (existing) continue;

      const rawSql = await Bun.file(migrationPath).text();
      const { up, down } = parseMigrationSql(rawSql);
      pending.push({ name, up, down });
    }

    if (pending.length === 0) return;

    // Phase 2 — run the entire chain in ONE outer transaction. If any UP
    // fails, Postgres rolls back the whole chain (DDL is transactional for
    // CREATE TABLE / ALTER / DROP / most CREATE INDEX variants). Migrations
    // that need CONCURRENTLY or other non-transactional DDL cannot use this
    // path — they must be expressed differently (e.g. split into a separate
    // non-extension migration applied by an admin).
    await db.transaction().execute(async (trx) => {
      for (const m of pending) {
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        await (trx as any).executeQuery({ sql: m.up, parameters: [] });
        // Persist DOWN alongside the migration row so a future uninstall with
        // purgeData=true can replay rollbacks without the original files.
        await trx
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
          .insertInto('zv_migrations' as any)
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
          .values({ name: m.name, down_sql: m.down } as any)
          .execute();
        console.log(`  ✓ Extension migration: ${m.name}`);
      }
    });
  }

  /**
   * Reverse-apply every migration this extension has on record, in reverse
   * order, then delete the zv_migrations rows. The whole operation runs in a
   * single transaction — if any DOWN fails the chain is rolled back.
   *
   * Throws DownMissingError listing the migrations that have no DOWN section.
   * In that case nothing is dropped — the operator can either run those DOWNs
   * manually or accept that purge cannot proceed.
   */
  /** internal — also called by registerMarketplaceRoutes (loader split). */
  async purgeExtensionData(extensionName: string, db: Database): Promise<void> {
    const prefix = `ext:${extensionName}:`;
    const rows = await db
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      .selectFrom('zv_migrations' as any)
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      .select(['id' as any, 'name' as any, 'down_sql' as any])
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      .where('name' as any, 'like', `${prefix}%`)
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      .orderBy('id' as any, 'desc')
      .execute()
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      .catch(() => [] as any[]);

    if (rows.length === 0) return;

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const missing = rows.filter((r: any) => !r.down_sql || (r.down_sql as string).trim() === '');
    if (missing.length > 0) {
      throw new DownMissingError(
        extensionName,
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        missing.map((r: any) => r.name as string),
      );
    }

    await db.transaction().execute(async (trx) => {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      for (const r of rows as any[]) {
        const downSql = r.down_sql as string;
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        await (trx as any).executeQuery({ sql: downSql, parameters: [] });
        await trx
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
          .deleteFrom('zv_migrations' as any)
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
          .where('id' as any, '=', r.id)
          .execute();
        console.log(`  ✓ Extension purge: rolled back ${r.name}`);
      }
    });
  }

  async loadFromDB(db: Database, app: Hono): Promise<void> {
    try {
      const rows = await db
        .selectFrom('zv_extension_registry')
        .select(['name'])
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        .where('is_enabled' as any, '=', true)
        .execute();

      const pending = rows
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        .map((r: any) => r.name as string)
        .filter((name: string) => !this.loaded.has(name));
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
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
          .where('name' as any, '=', name)
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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      reqDb: (c: any) =>
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
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        const fn = (app as any)[m];
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
            // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
            cronRunner.register(name, s as any);
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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      let body: any;
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
