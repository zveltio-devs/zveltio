import type { Hono } from 'hono';
import type { Database } from '../db/index.js';
import type { FieldTypeRegistry } from './field-type-registry.js';
import { existsSync, writeFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import { isCompatible, checkExtensionDependencies, getEngineVersion } from './version-checker.js';
import type { EventBus } from './event-bus.js';
import { auth } from './auth.js';
import { checkPermission, getUserRoles } from './permissions.js';
import { DDLManager } from './ddl-manager.js';
import { fieldTypeRegistry as _fieldTypeRegistry } from './field-type-registry.js';
import { EXTENSION_CATALOG, type ExtensionCatalogEntry } from './extension-catalog.js';
import { createRestrictedDb } from './extension-context.js';
import { auditLog } from './audit.js';

// ── Registry catalog cache ────────────────────────────────────────────────────
const REGISTRY_URL = process.env.REGISTRY_URL || 'https://apps.zveltio.com';
const CATALOG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let catalogCache: ExtensionCatalogEntry[] | null = null;
let catalogCacheExpiry = 0;

async function fetchRegistryCatalog(): Promise<ExtensionCatalogEntry[]> {
  if (catalogCache && Date.now() < catalogCacheExpiry) return catalogCache;
  try {
    const res = await fetch(`${REGISTRY_URL}/api/extensions/list`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Registry returned ${res.status}`);
    const data = await res.json() as { extensions: any[] };
    const entries: ExtensionCatalogEntry[] = (data.extensions ?? []).map((e: any) => ({
      name:        e.name,
      displayName: e.display_name ?? e.name,
      description: e.description ?? '',
      category:    e.category ?? 'other',
      version:     e.version ?? '1.0.0',
      author:      e.developer_username ?? e.author ?? 'Zveltio',
      tags:        e.tags ?? [],
      bundled:     false,
      permissions: e.permissions ?? [],
    }));
    if (entries.length > 0) {
      catalogCache = entries;
      catalogCacheExpiry = Date.now() + CATALOG_CACHE_TTL;
      return entries;
    }
  } catch (err) {
    console.warn('[marketplace] Registry fetch failed, using local catalog:', (err as Error).message);
  }
  // fallback
  return EXTENSION_CATALOG;
}

// ── Extension engine-import shims ─────────────────────────────────────────────
// Extensions loaded from EXTENSIONS_DIR are TypeScript files that import from
// the engine source tree (e.g. ../../../../packages/engine/src/lib/permissions.js).
// In production the engine runs as a compiled binary — those source paths do not
// exist on disk.  We register a Bun plugin that intercepts these import paths and
// returns virtual modules backed by the singletons already live in this process.
let _shimsInstalled = false;

function installExtensionShims(): void {
  if (_shimsInstalled) return;
  _shimsInstalled = true;

  const shims: Record<string, string> = {
    permissions: `
const _s = globalThis.__zveltioEngineShims;
export const checkPermission = _s.checkPermission;
export const getUserRoles = _s.getUserRoles;
`,
    auth: `
const _s = globalThis.__zveltioEngineShims;
export const auth = _s.auth;
`,
    'ddl-manager': `
const _s = globalThis.__zveltioEngineShims;
export const DDLManager = _s.DDLManager;
export const GhostDDL = _s.GhostDDL ?? _s.DDLManager;
`,
    'field-type-registry': `
const _s = globalThis.__zveltioEngineShims;
export const fieldTypeRegistry = _s.fieldTypeRegistry;
`,
  };

  // Store live singletons for virtual modules to reference
  (globalThis as any).__zveltioEngineShims = {
    checkPermission,
    getUserRoles,
    auth,
    DDLManager,
    fieldTypeRegistry: _fieldTypeRegistry,
  };

  // Lazily populate one-off singletons (may not exist in all engine builds)
  const tryShim = (key: string, mod: string, exported: string[]) => {
    try {
      import(mod).then((m) => {
        for (const k of exported) {
          if (m[k]) (globalThis as any).__zveltioEngineShims[k] = m[k];
        }
      }).catch(() => {});
    } catch (_e) { /* module not available in this build — skip */ }
  };
  tryShim('GhostDDL',          './ghost-ddl.js',              ['GhostDDL']);
  tryShim('aiProviderManager', './ai-provider.js',            ['aiProviderManager']);
  tryShim('dynamicInsert',     '../db/dynamic.js',            ['dynamicInsert']);
  tryShim('introspectSchema',  './introspection.js',          ['introspectSchema']);

  try {
    // Bun.plugin is only available in Bun runtime (not Node/test environments)
    if (typeof Bun === 'undefined' || typeof (Bun as any).plugin !== 'function') return;

    (Bun as any).plugin({
      name: 'zveltio-engine-shims',
      setup(build: any) {
        // ── Match any import that contains an engine source path pattern ─────────
        // Covers: ../../../../packages/engine/src/lib/permissions.js
        //         ../../../packages/engine/src/lib/auth.js
        //         @zveltio/engine-permissions
        //         @zveltio/engine/lib/ddl-manager.js
        //         @zveltio/engine-db  (type-only, returns empty module)
        build.onResolve({ filter: /packages\/engine\/src|@zveltio\/engine/ }, (args: any) => {
          const p: string = args.path;

          if (p.includes('/permissions') || p === '@zveltio/engine-permissions')
            return { path: 'shim:permissions', namespace: 'zveltio-shims' };

          if (p.includes('/auth') && !p.includes('/auth/'))
            return { path: 'shim:auth', namespace: 'zveltio-shims' };

          if (p.includes('/ddl-manager') || p.includes('/ghost-ddl') ||
              p === '@zveltio/engine/lib/ddl-manager.js')
            return { path: 'shim:ddl-manager', namespace: 'zveltio-shims' };

          if (p.includes('/field-type-registry'))
            return { path: 'shim:field-type-registry', namespace: 'zveltio-shims' };

          // Catch-all for remaining engine paths (db/index, extension-loader types, etc.)
          // These are type-only imports at runtime — return an empty module.
          return { path: 'shim:empty', namespace: 'zveltio-shims' };
        });

        build.onLoad({ filter: /.*/, namespace: 'zveltio-shims' }, ({ path }: any) => {
          const src = shims[path.replace('shim:', '')];
          return { contents: src ?? 'export {};', loader: 'js' };
        });
      },
    });
  } catch (err) {
    console.warn('[extension-shims] Bun.plugin registration failed:', (err as Error).message);
  }
}

export type { EventBus };

const ManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'),
  category: z.string().default('custom'),
  zveltioMinVersion: z.string().optional(),
  zveltioMaxVersion: z.string().nullable().optional(),
  dependencies: z.array(z.object({
    name: z.string(),
    minVersion: z.string().optional(),
  })).default([]),
  /** npm packages auto-installed when extension is activated (e.g. node-saml, ldapts) */
  peerDependencies: z.record(z.string(), z.string()).optional(),
  permissions: z.array(z.string()).default([]),
  contributes: z.object({
    engine: z.boolean().default(true),
    studio: z.boolean().default(false),
    client: z.boolean().default(false),
    fieldTypes: z.array(z.string()).default([]),
    stepTypes: z.array(z.string()).default([]),
    collections: z.array(z.string()).default([]),
  }).optional(),
}).passthrough();

export interface ExtensionContext {
  db: Database;
  auth: any;
  fieldTypeRegistry: FieldTypeRegistry;
  /** Typed event bus — extensions subscribe to record lifecycle events without touching core routes. */
  events: EventBus;
  /** Check if a user has permission for a resource/action. Injected automatically — no engine import needed. */
  checkPermission?: (userId: string, resource: string, action: string) => Promise<boolean>;
  /** Get all roles for a user. Injected automatically — no engine import needed. */
  getUserRoles?: (userId: string) => Promise<string[]>;
  /** DDLManager class (static methods). Injected automatically — no engine import needed. */
  DDLManager?: typeof DDLManager;
}

export interface ZveltioExtension {
  name: string;
  category: string;
  register: (app: Hono, ctx: ExtensionContext) => Promise<void>;
  registerFieldTypes?: (registry: FieldTypeRegistry) => void;
  getMigrations?: () => string[]; // paths to SQL files
  /**
   * Optional cleanup function — called when the extension is unloaded.
   * Use to close connections, clear timers, etc.
   * NOTE: Hono routes registered by the extension cannot be removed at runtime
   * (Hono does not support de-registration). Those require a process restart.
   */
  cleanup?: () => Promise<void>;
}

interface LoadedExtension {
  name: string;
  bundleUrl?: string;
  /** Cleanup callback captured from the extension module, if exported. */
  cleanup?: () => Promise<void>;
  /** True if the extension registered HTTP routes — unload requires restart. */
  registeredRoutes: boolean;
}

class ExtensionLoader {
  private loaded: Map<string, LoadedExtension> = new Map();
  private ctx?: ExtensionContext;

  async loadAll(app: Hono, ctx: ExtensionContext): Promise<void> {
    // Install Bun plugin shims so extensions can import from engine source paths
    installExtensionShims();

    this.ctx = ctx;
    const activeExtensions = this.getActiveExtensionNames();

    for (const extName of activeExtensions) {
      await this.loadExtension(extName, app, ctx);
    }

    // Also load from external path if configured
    const externalPath = process.env.ZVELTIO_EXTENSIONS_PATH;
    if (externalPath && existsSync(externalPath)) {
      const externalExts = await this.discoverExternal(externalPath);
      for (const extName of externalExts) {
        await this.loadExtension(extName, app, ctx, externalPath);
      }
    }
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
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
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
      // Priority: explicit basePath > EXTENSIONS_DIR env var > default relative path.
      const defaultBase = process.env.EXTENSIONS_DIR
        || join(import.meta.dir, '../../../extensions');
      const extDir = basePath
        ? join(basePath, extName)
        : join(defaultBase, extName);

      const enginePath = join(extDir, 'engine/index.js');

      if (!existsSync(enginePath)) {
        // Try TypeScript source (dev mode)
        const engineTsPath = join(extDir, 'engine/index.ts');
        if (!existsSync(engineTsPath)) {
          console.warn(`⚠️  Extension "${extName}": engine/index.js not found at ${enginePath}`);
          return;
        }
      }

      // Validate manifest.json if present, then check compatibility + dependencies
      const manifestPath = join(extDir, 'manifest.json');
      if (existsSync(manifestPath)) {
        let manifest: any;
        try {
          const rawManifest = JSON.parse(await Bun.file(manifestPath).text());
          manifest = ManifestSchema.parse(rawManifest);
        } catch (err) {
          console.warn(`⚠️  Extension "${extName}": invalid manifest.json —`, (err as Error).message);
          return;
        }

        // Engine version compatibility
        const compat = isCompatible(getEngineVersion(), manifest.zveltioMinVersion, manifest.zveltioMaxVersion);
        if (!compat.compatible) {
          console.warn(`⚠️  Extension "${extName}" incompatible: ${compat.reason}`);
          return;
        }

        // Extension dependencies (other Zveltio extensions)
        if (manifest.dependencies && manifest.dependencies.length > 0) {
          const deps = await checkExtensionDependencies(ctx.db, manifest.dependencies);
          if (!deps.satisfied) {
            console.warn(`⚠️  Extension "${extName}" missing dependencies: ${deps.missing.join(', ')}`);
            return;
          }
        }

        // npm peerDependencies — auto-install before loading
        if (manifest.peerDependencies && Object.keys(manifest.peerDependencies).length > 0) {
          await this.installNpmDependencies(extName, manifest.peerDependencies);
        }
      }

      // Import and register extension
      const resolvedPath = existsSync(enginePath) ? enginePath : join(extDir, 'engine/index.ts');
      const module = await import(resolvedPath);
      const extension: ZveltioExtension = module.default;

      if (!extension || typeof extension.register !== 'function') {
        console.warn(`⚠️  Extension "${extName}": missing default export or register() function`);
        return;
      }

      // Run extension migrations
      if (extension.getMigrations) {
        await this.runExtensionMigrations(extension, ctx.db);
      }

      // Register new field types contributed by extension
      if (extension.registerFieldTypes) {
        extension.registerFieldTypes(ctx.fieldTypeRegistry);
      }

      // Pass a RestrictedDb proxy — extensions cannot query zv_* system tables
      // Also inject checkPermission, getUserRoles, DDLManager so new-style extensions
      // can use ctx.* instead of relative engine imports.
      const restrictedCtx: ExtensionContext = {
        ...ctx,
        db: createRestrictedDb(ctx.db, extName),
        checkPermission: ctx.checkPermission ?? checkPermission,
        getUserRoles: ctx.getUserRoles ?? getUserRoles,
        DDLManager: ctx.DDLManager ?? DDLManager,
      };

      // Register routes
      await extension.register(app, restrictedCtx);

      // Register Studio bundle if it exists
      const studioBundlePath = join(extDir, 'studio/dist/bundle.js');
      const bundleKey = extName.replace(/\//g, '_');
      const bundleUrl = existsSync(studioBundlePath)
        ? `/ext/${bundleKey}/bundle.js`
        : undefined;

      if (bundleUrl) {
        app.get(bundleUrl, async (c) => {
          const content = await Bun.file(studioBundlePath).text();
          c.header('Content-Type', 'application/javascript');
          c.header('Cache-Control', 'public, max-age=3600');
          return c.body(content);
        });
      }

      this.loaded.set(extName, {
        name: extName,
        bundleUrl,
        cleanup: typeof extension.cleanup === 'function' ? extension.cleanup.bind(extension) : undefined,
        // Mark as route-registering so unload() can warn about restart requirement
        registeredRoutes: true,
      });
      console.log(`🔌 Extension loaded: ${extName}${bundleUrl ? ' (with Studio UI)' : ''}`);

      // Audit trail — record successful load
      auditLog(ctx.db, {
        type: 'extension.loaded',
        userId: 'system',
        resourceId: extName,
        resourceType: 'extension',
        metadata: { version: extension.name },
      }).catch(() => {});

    } catch (err) {
      console.error(`❌ Failed to load extension "${extName}":`, err);
      // Audit trail — record load failure
      if (this.ctx) {
        auditLog(this.ctx.db, {
          type: 'extension.load_failed',
          userId: 'system',
          resourceId: extName,
          resourceType: 'extension',
          metadata: { error: (err as Error).message },
        }).catch(() => {});
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
    // Install into EXTENSIONS_DIR so the packages sit in a node_modules that
    // extensions can reach via Bun's module resolution (walks up parent dirs).
    // Falls back to the monorepo root for development.
    const workspaceRoot = process.env.EXTENSIONS_DIR
      || join(import.meta.dir, '../../../../');

    const toInstall: string[] = [];
    for (const [pkg, versionRange] of Object.entries(peerDeps)) {
      // Check if already resolvable via Bun's module resolution
      try {
        await import.meta.resolve(pkg);
        // Already installed — skip
      } catch {
        // Not found — queue for installation
        const spec = versionRange && versionRange !== '*'
          ? `${pkg}@${versionRange.replace(/^\^|^~/, '')}`
          : pkg;
        toInstall.push(spec);
      }
    }

    if (toInstall.length === 0) return;

    // Ensure a package.json exists in the install dir so `bun add` works.
    const pkgJsonPath = join(workspaceRoot, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      writeFileSync(pkgJsonPath, JSON.stringify({
        name: 'zveltio-extensions',
        private: true,
        type: 'module',
      }, null, 2));
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
    }

    console.log(`📦 Extension "${extName}": installing npm packages: ${toInstall.join(', ')}`);

    const proc = Bun.spawn(['bun', 'add', ...toInstall], {
      cwd: workspaceRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`npm install failed for extension "${extName}": ${stderr.trim()}`);
    }

    console.log(`✅ Extension "${extName}": packages installed successfully`);
  }

  private async runExtensionMigrations(
    extension: ZveltioExtension,
    db: Database,
  ): Promise<void> {
    const migrations = extension.getMigrations?.() || [];
    for (const migrationPath of migrations) {
      const name = `ext:${extension.name}:${migrationPath.split('/').pop()?.replace('.sql', '')}`;

      // Check if already run
      const existing = await db
        .selectFrom('zv_migrations' as any)
        .select('id')
        .where('name' as any, '=', name)
        .executeTakeFirst()
        .catch(() => null);

      if (existing) continue;

      const sqlContent = await Bun.file(migrationPath).text();
      await db.transaction().execute(async (trx) => {
        await (trx as any).executeQuery({ sql: sqlContent, parameters: [] });
        await trx
          .insertInto('zv_migrations' as any)
          .values({ name } as any)
          .execute();
      });

      console.log(`  ✓ Extension migration: ${name}`);
    }
  }

  async loadFromDB(db: Database, app: Hono): Promise<void> {
    try {
      const rows = await (db as any)
        .selectFrom('zv_extension_registry')
        .select(['name'])
        .where('is_enabled' as any, '=', true)
        .execute();

      for (const row of rows) {
        if (!this.loaded.has(row.name) && this.ctx) {
          await this.loadExtension(row.name, app, this.ctx);
        }
      }
    } catch {
      // Table may not exist on first run — silently skip
    }
  }

  async loadDynamic(name: string, app: Hono): Promise<void> {
    if (!this.ctx) throw new Error('ExtensionLoader not initialized — call loadAll() first');
    await this.loadExtension(name, app, this.ctx);
  }

  /**
   * Register the marketplace routes (/api/marketplace).
   * Called from bootstrap after core routes — always available, not optional.
   * Moved here from routes/marketplace.ts to eliminate the inverted dependency
   * where the engine route was importing from the extension-loader lib.
   */
  registerMarketplace(app: Hono, db: Database): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this; // capture ExtensionLoader instance for hot-load access

    // Admin-only guard
    async function requireAdmin(c: any): Promise<boolean> {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return false;
      const isAdmin = await checkPermission(session.user.id, 'admin', '*');
      return isAdmin;
    }

    // GET /api/marketplace — catalog fetched from registry (fallback: local) merged with DB state
    app.get('/api/marketplace', async (c) => {
      if (!await requireAdmin(c)) return c.json({ error: 'Unauthorized or admin required' }, 401);

      const [catalog, rows] = await Promise.all([
        fetchRegistryCatalog(),
        (db as any).selectFrom('zv_extension_registry').selectAll().execute().catch(() => []),
      ]);

      const dbMap = new Map(rows.map((r: any) => [r.name, r]));

      const extensions = catalog.map((entry) => {
        const dbEntry = dbMap.get(entry.name) as any;
        const runtimeActive = self.isActive(entry.name);

        return {
          ...entry,
          is_installed:  dbEntry?.is_installed ?? runtimeActive,
          is_enabled:    dbEntry?.is_enabled   ?? runtimeActive,
          is_running:    runtimeActive,
          needs_restart: (dbEntry?.is_enabled && !runtimeActive) ||
                         (!dbEntry?.is_enabled && runtimeActive && dbEntry !== undefined),
          config:        dbEntry?.config       ?? {},
          installed_at:  dbEntry?.installed_at ?? null,
          enabled_at:    dbEntry?.enabled_at   ?? null,
        };
      });

      return c.json({ extensions });
    });

    // POST /api/marketplace/:name/install
    app.post('/api/marketplace/:name{.+}/install', async (c) => {
      if (!await requireAdmin(c)) return c.json({ error: 'Unauthorized or admin required' }, 401);

      const name = c.req.param('name');
      const catalog = await fetchRegistryCatalog();
      const entry = catalog.find((e) => e.name === name);
      if (!entry) return c.json({ error: 'Extension not found in catalog' }, 404);

      await (db as any)
        .insertInto('zv_extension_registry')
        .values({
          name:         entry.name,
          display_name: entry.displayName,
          description:  entry.description,
          category:     entry.category,
          version:      entry.version,
          author:       entry.author,
          is_installed: true,
          is_enabled:   false,
          installed_at: new Date(),
        })
        .onConflict((oc: any) =>
          oc.column('name').doUpdateSet({ is_installed: true, installed_at: new Date() }),
        )
        .execute();

      return c.json({
        success: true,
        message: `Extension ${name} installed. Enable it to activate.`,
      });
    });

    // POST /api/marketplace/:name/enable
    app.post('/api/marketplace/:name{.+}/enable', async (c) => {
      if (!await requireAdmin(c)) return c.json({ error: 'Unauthorized or admin required' }, 401);

      const name = c.req.param('name');
      // Use live registry catalog (with local fallback) so extensions from apps.zveltio.com work
      const catalog = await fetchRegistryCatalog();
      const entry = catalog.find((e) => e.name === name);
      if (!entry) return c.json({ error: 'Extension not found in catalog' }, 404);

      await (db as any)
        .insertInto('zv_extension_registry')
        .values({
          name:         entry.name,
          display_name: entry.displayName,
          description:  entry.description,
          category:     entry.category,
          version:      entry.version,
          author:       entry.author,
          is_installed: true,
          is_enabled:   true,
          installed_at: new Date(),
          enabled_at:   new Date(),
        })
        .onConflict((oc: any) =>
          oc.column('name').doUpdateSet({
            is_installed: true,
            is_enabled:   true,
            enabled_at:   new Date(),
          }),
        )
        .execute();

      let hotLoaded = false;
      if (!self.isActive(name)) {
        try {
          await self.loadDynamic(name, app);
          hotLoaded = true;
        } catch (e) {
          console.warn(`Hot-load failed for ${name}:`, e);
        }
      } else {
        hotLoaded = true;
      }

      return c.json({
        success:       true,
        hot_loaded:    hotLoaded,
        needs_restart: !hotLoaded,
        message:       hotLoaded
          ? `Extension ${name} is now active.`
          : `Extension ${name} will be active after restart.`,
      });
    });

    // POST /api/marketplace/:name/disable
    app.post('/api/marketplace/:name{.+}/disable', async (c) => {
      if (!await requireAdmin(c)) return c.json({ error: 'Unauthorized or admin required' }, 401);

      const name = c.req.param('name');

      await (db as any)
        .insertInto('zv_extension_registry')
        .values({
          name,
          display_name: name,
          category:     'custom',
          version:      '1.0.0',
          author:       '',
          is_installed: true,
          is_enabled:   false,
        })
        .onConflict((oc: any) =>
          oc.column('name').doUpdateSet({ is_enabled: false }),
        )
        .execute();

      const isRunning = self.isActive(name);

      return c.json({
        success:       true,
        needs_restart: isRunning,
        message:       isRunning
          ? `Extension ${name} will be disabled after restart.`
          : `Extension ${name} is disabled.`,
      });
    });

    // PUT /api/marketplace/:name/config
    app.put('/api/marketplace/:name{.+}/config', async (c) => {
      if (!await requireAdmin(c)) return c.json({ error: 'Unauthorized or admin required' }, 401);

      const name = c.req.param('name');
      const config = await c.req.json();

      await (db as any)
        .insertInto('zv_extension_registry')
        .values({
          name,
          display_name: name,
          category:     'custom',
          version:      '1.0.0',
          author:       '',
          is_installed: true,
          is_enabled:   false,
          config,
        })
        .onConflict((oc: any) =>
          oc.column('name').doUpdateSet({ config }),
        )
        .execute();

      return c.json({ success: true });
    });

    // POST /api/marketplace/:name/uninstall
    app.post('/api/marketplace/:name{.+}/uninstall', async (c) => {
      if (!await requireAdmin(c)) return c.json({ error: 'Unauthorized or admin required' }, 401);

      const name = c.req.param('name');

      await (db as any)
        .deleteFrom('zv_extension_registry')
        .where('name' as any, '=', name)
        .execute();

      return c.json({
        success:       true,
        needs_restart: self.isActive(name),
        message:       `Extension ${name} uninstalled.`,
      });
    });
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
  async unload(name: string): Promise<{ unloaded: boolean; needs_restart: boolean; message: string }> {
    const ext = this.loaded.get(name);
    if (!ext) {
      return { unloaded: false, needs_restart: false, message: `Extension "${name}" is not loaded.` };
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

    this.loaded.delete(name);
    console.log(`🔌 Extension unloaded from memory: ${name}`);

    // Audit trail — record unload
    if (this.ctx) {
      auditLog(this.ctx.db, {
        type: 'extension.unloaded',
        userId: 'system',
        resourceId: name,
        resourceType: 'extension',
        metadata: { needs_restart: ext.registeredRoutes },
      }).catch(() => {});
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

  getActive(): string[] {
    return [...this.loaded.keys()];
  }

  getBundles(): Array<{ name: string; url: string }> {
    return [...this.loaded.values()]
      .filter((e) => e.bundleUrl)
      .map((e) => ({ name: e.name, url: e.bundleUrl! }));
  }

  isActive(name: string): boolean {
    return this.loaded.has(name);
  }

  /** Mark a bundled extension as active without going through the full dynamic load path. */
  markActive(name: string): void {
    if (!this.loaded.has(name)) {
      this.loaded.set(name, { name, registeredRoutes: true });
    }
  }
}

export const extensionLoader = new ExtensionLoader();
