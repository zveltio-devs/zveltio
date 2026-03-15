import type { Hono } from 'hono';
import type { Database } from '../db/index.js';
import type { FieldTypeRegistry } from './field-type-registry.js';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import { isCompatible, checkExtensionDependencies, getEngineVersion } from './version-checker.js';
import { engineEvents } from './event-bus.js';
import type { EventBus } from './event-bus.js';
import { auth } from './auth.js';
import { checkPermission } from './permissions.js';
import { EXTENSION_CATALOG } from './extension-catalog.js';

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
}

export interface ZveltioExtension {
  name: string;
  category: string;
  register: (app: Hono, ctx: ExtensionContext) => Promise<void>;
  registerFieldTypes?: (registry: FieldTypeRegistry) => void;
  getMigrations?: () => string[]; // paths to SQL files
}

interface LoadedExtension {
  name: string;
  bundleUrl?: string;
}

class ExtensionLoader {
  private loaded: Map<string, LoadedExtension> = new Map();
  private ctx?: ExtensionContext;

  async loadAll(app: Hono, ctx: ExtensionContext): Promise<void> {
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
      // Resolve extension directory
      const extDir = basePath
        ? join(basePath, extName)
        : join(import.meta.dir, '../../../extensions', extName);

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

      // Register routes
      await extension.register(app, ctx);

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

      this.loaded.set(extName, { name: extName, bundleUrl });
      console.log(`🔌 Extension loaded: ${extName}${bundleUrl ? ' (with Studio UI)' : ''}`);

    } catch (err) {
      console.error(`❌ Failed to load extension "${extName}":`, err);
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
    // Find workspace root (directory that contains bun.lockb or package.json)
    const workspaceRoot = join(import.meta.dir, '../../../../');

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
      await (db as any).executeQuery({ sql: sqlContent, parameters: [] });

      await db
        .insertInto('zv_migrations' as any)
        .values({ name } as any)
        .execute();

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
    const self = this; // capture ExtensionLoader instance for hot-load access

    // Admin-only guard
    async function requireAdmin(c: any): Promise<boolean> {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return false;
      const isAdmin = await checkPermission(session.user.id, 'admin', '*');
      return isAdmin;
    }

    // GET /api/marketplace — catalog merged with DB state + runtime state
    app.get('/api/marketplace', async (c) => {
      if (!await requireAdmin(c)) return c.json({ error: 'Unauthorized or admin required' }, 401);

      const rows = await (db as any)
        .selectFrom('zv_extension_registry')
        .selectAll()
        .execute()
        .catch(() => []);

      const dbMap = new Map(rows.map((r: any) => [r.name, r]));

      const extensions = EXTENSION_CATALOG.map((entry) => {
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
      const entry = EXTENSION_CATALOG.find((e) => e.name === name);
      if (!entry) return c.json({ error: 'Extension not found in catalog' }, 404);
      if (!entry.bundled) return c.json({ error: 'External install not yet supported' }, 501);

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
      const entry = EXTENSION_CATALOG.find((e) => e.name === name);
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
}

export const extensionLoader = new ExtensionLoader();
