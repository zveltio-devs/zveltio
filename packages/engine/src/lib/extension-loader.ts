import type { Hono } from 'hono';
import type { Database } from '../db/index.js';
import type { FieldTypeRegistry } from './field-type-registry.js';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';

export interface ExtensionContext {
  db: Database;
  auth: any;
  fieldTypeRegistry: FieldTypeRegistry;
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

  async loadAll(app: Hono, ctx: ExtensionContext): Promise<void> {
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
