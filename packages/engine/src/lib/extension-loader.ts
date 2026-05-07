import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql as _sql, Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import type { FieldTypeRegistry } from './field-type-registry.js';
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { isCompatible, checkExtensionDependencies, getEngineVersion } from './version-checker.js';
import type { EventBus } from './event-bus.js';
import { auth } from './auth.js';
import { checkPermission, getUserRoles } from './permissions.js';
import { DDLManager } from './ddl-manager.js';
import { fieldTypeRegistry as _fieldTypeRegistry } from './field-type-registry.js';
import { EXTENSION_CATALOG, type ExtensionCatalogEntry } from './extension-catalog.js';
import { createRestrictedDb } from './extension-context.js';
import { auditLog } from './audit.js';
import { aiProviderManager } from './ai-provider.js';
import { dynamicInsert } from '../db/dynamic.js';
import { introspectSchema } from './introspection.js';
import { runQualityScan } from './data-quality.js';
import { invalidateRulesCache } from './validation-engine.js';
import { runFunction as runEdgeFunction } from './edge-functions/sandbox.js';
import { extensionRegistry } from './extension-registry.js';
import { generatePDFAsync } from './pdf-queue.js';
import { renderTemplate, generatePDF } from './doc-generator.js';
import { moveToTrash } from './cloud/trash.js';
import { scheduleFileIndexing } from './cloud/document-indexer.js';
import { DataLoaderRegistry, checkQueryDepth } from './graphql-dataloader.js';
import type { ZveltioExtension } from '@zveltio/sdk/extension';

// ── Extension base directory resolution ───────────────────────────────────────
/**
 * Resolve where extension files live.  Checked in priority order:
 *  1. EXTENSIONS_DIR env var (explicit config — always wins)
 *  2. ./extensions/ relative to the process CWD (Docker / production binary)
 *  3. Sibling zveltio-extensions repo (monorepo dev: ../../../../../zveltio-extensions)
 *  4. ./extensions/ as creation target even if it doesn't exist yet
 */
function resolveExtensionsBase(): string {
  if (process.env.EXTENSIONS_DIR) return process.env.EXTENSIONS_DIR;
  const cwdPath = join(process.cwd(), 'extensions');
  if (existsSync(cwdPath)) return cwdPath;
  // Dev: zveltio-extensions is a sibling of the main monorepo repo.
  // packages/engine/src/lib → 4 levels up → monorepo root → 1 more up → ecosystem root.
  const devPath = join(import.meta.dir, '../../../../../zveltio-extensions');
  if (existsSync(devPath)) return devPath;
  return cwdPath; // default target for first download
}

// ── Registry catalog cache ────────────────────────────────────────────────────
// Default points at the Cloudflare Worker registry (registry.zveltio.com).
// `apps.zveltio.com` is the marketplace UI (SvelteKit) — it does NOT expose /api/*.
const REGISTRY_URL = process.env.REGISTRY_URL || 'https://registry.zveltio.com';
const CATALOG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let catalogCache: ExtensionCatalogEntry[] | null = null;
let catalogCacheExpiry = 0;

// ── License key helper ────────────────────────────────────────────────────────
// Per-extension license keys are stored in zv_settings as ext_license:<name>.
// Free extensions need no key. Paid extensions send it as Authorization: Bearer.
async function getLicenseKey(db: any, extensionName: string): Promise<string | undefined> {
  try {
    const row = await db
      .selectFrom('zv_settings')
      .select('value')
      .where('key', '=', `ext_license:${extensionName}`)
      .executeTakeFirst();
    return row?.value ?? undefined;
  } catch {
    return undefined;
  }
}

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
      name:         e.name,
      displayName:  e.display_name ?? e.displayName ?? e.name,
      description:  e.description ?? '',
      category:     e.category ?? 'other',
      version:      e.version ?? '1.0.0',
      author:       e.developer_username ?? e.author ?? 'Zveltio',
      tags:         e.tags ?? [],
      permissions:  e.permissions ?? [],
      // Prefer the explicit download_url from the registry; fall back to the
      // by-name endpoint (works for both registry.zveltio.com and self-hosted).
      download_url: e.download_url
        ?? `${REGISTRY_URL}/api/extensions/by-name/${encodeURIComponent(e.name)}/download`,
    }));
    if (entries.length > 0) {
      catalogCache = entries;
      catalogCacheExpiry = Date.now() + CATALOG_CACHE_TTL;
      return entries;
    }
  } catch (err) {
    console.warn('[marketplace] Registry fetch failed, using local catalog:', (err as Error).message);
  }
  // fallback — local catalog has no download_url, so install will fail
  // with a clear message until the registry is reachable.
  return EXTENSION_CATALOG;
}

// ── Extension package download ────────────────────────────────────────────────

/**
 * Download and extract an extension package into EXTENSIONS_DIR.
 *
 * URL resolution order:
 *   1. `entry.download_url` from the registry catalog (explicit, preferred)
 *   2. `${REGISTRY_URL}/api/extensions/by-name/${name}/download` (convention)
 *
 * Format detection: the response body is sniffed for a magic number to decide
 * between ZIP (`PK\x03\x04`) and gzip (`\x1f\x8b`). ZIPs are extracted with
 * `unzip`, tarballs with `tar`. If the archive contains a single top-level
 * directory matching the extension slug (or anything else), we flatten it so
 * `engine/`, `studio/`, `manifest.json` land directly inside `EXTENSIONS_DIR/<name>/`.
 */
async function downloadExtension(entry: ExtensionCatalogEntry, destBase: string, licenseKey?: string): Promise<void> {
  const downloadUrl = entry.download_url
    ?? `${REGISTRY_URL}/api/extensions/by-name/${encodeURIComponent(entry.name)}/download`;

  console.log(`📥 Downloading extension "${entry.name}" from ${downloadUrl} …`);

  const headers: Record<string, string> = {
    'User-Agent': 'zveltio-engine',
    'Accept': 'application/octet-stream',
  };
  if (licenseKey) {
    headers['Authorization'] = `Bearer ${licenseKey}`;
  }

  const res = await fetch(downloadUrl, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Registry returned ${res.status} for extension "${entry.name}" download${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  const destDir = join(destBase, entry.name);
  mkdirSync(destDir, { recursive: true });

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 4) {
    throw new Error(`Empty package received for "${entry.name}"`);
  }

  // Magic-number sniffing — content-type from R2/Cloudflare can be unreliable.
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;

  const fs = await import('fs');
  const path = await import('path');

  // Stage into a temp dir so we can detect & flatten a single top-level folder
  // before moving files into the final destination.
  const stageDir = join(destDir, '_stage');
  // Clean any leftover stage from a previous failed run
  try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(stageDir, { recursive: true });

  const pkgPath = join(destDir, isZip ? '_pkg.zip' : '_pkg.tar.gz');
  fs.writeFileSync(pkgPath, buf);

  let proc: ReturnType<typeof Bun.spawn>;
  if (isZip) {
    proc = Bun.spawn(['unzip', '-qq', '-o', pkgPath, '-d', stageDir], { stdout: 'pipe', stderr: 'pipe' });
  } else if (isGzip) {
    proc = Bun.spawn(['tar', '-xzf', pkgPath, '-C', stageDir], { stdout: 'pipe', stderr: 'pipe' });
  } else {
    try { fs.unlinkSync(pkgPath); } catch { /* ignore */ }
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(`Unknown archive format for "${entry.name}" (expected ZIP or gzip)`);
  }

  const exitCode = await proc.exited;
  try { fs.unlinkSync(pkgPath); } catch { /* ignore */ }

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(`Extraction failed for "${entry.name}": ${stderr.trim() || `exit ${exitCode}`}`);
  }

  // If the archive wrapped everything in a single top-level dir, unwrap it.
  // Allowed layouts:
  //   stage/engine/index.ts + stage/manifest.json   ← already flat
  //   stage/<anything>/engine/...                    ← flatten to destDir
  let sourceDir = stageDir;
  const stageEntries = fs.readdirSync(stageDir);
  if (stageEntries.length === 1) {
    const only = path.join(stageDir, stageEntries[0]);
    if (fs.statSync(only).isDirectory()) sourceDir = only;
  }

  // Move every entry from sourceDir into destDir (replacing any prior files).
  for (const e of fs.readdirSync(sourceDir)) {
    const src = path.join(sourceDir, e);
    const dst = path.join(destDir, e);
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.renameSync(src, dst);
  }
  try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`✅ Extension "${entry.name}" extracted to ${destDir}`);
}

// ── Hot-reload callback ───────────────────────────────────────────────────────
// Set by index.ts after Bun.serve() starts. Called after enable/disable so the
// server swaps to a freshly built Hono app without restarting the process.
type ReloadCallback = () => Promise<void>;
let _reloadCallback: ReloadCallback | null = null;

export function setReloadCallback(fn: ReloadCallback): void {
  _reloadCallback = fn;
}

async function triggerReload(reason: string): Promise<void> {
  if (!_reloadCallback) return;
  try {
    console.log(`🔄 Hot-reloading server routes (${reason}) …`);
    await _reloadCallback();
    console.log('✅ Server routes reloaded (zero downtime)');
  } catch (err) {
    console.error('❌ Hot-reload failed:', (err as Error).message);
  }
}

// ── Engine-internal access for extensions ────────────────────────────────────
// Extensions receive engine internals (`auth`, `checkPermission`, `DDLManager`,
// `aiProviderManager`, etc.) via the `ctx.*` object passed into `register()`.
// They never import these directly — the SDK type `ExtensionContext` is the
// authoritative public surface. See `EXTENSION-AUTHORING.md`.
//
// Core npm packages (`hono`, `zod`, `kysely`, `@hono/zod-validator`) are
// installed into `<EXTENSIONS_DIR>/node_modules/` by `ensureExtensionCoreDeps()`
// at first startup. Bun's normal filesystem resolution then finds them — no
// `Bun.plugin` shimming required, which doesn't work for dynamic imports in
// compiled binaries anyway.

export type { EventBus };

/**
 * Ensure core npm packages (hono, zod, kysely, @hono/zod-validator) are available
 * in the extensions base directory. In production (compiled binary) Bun.plugin shims
 * may not intercept dynamic imports, so we rely on Bun's normal file-system resolution.
 * Exits fast when node_modules/hono already exists.
 *
 * Strategy:
 *   1. Try `bun install` (works in dev when bun is on PATH).
 *   2. Fall back to direct npm tarball fetch + tar extract — needed in production
 *      compiled binaries where bun is not separately installed (e.g. systemd service).
 */
async function ensureExtensionCoreDeps(extBase: string): Promise<void> {
  const honoPath = join(extBase, 'node_modules', 'hono');
  if (existsSync(honoPath)) return;

  const pkgJsonPath = join(extBase, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({
      name: 'zveltio-extensions',
      private: true,
      type: 'module',
      dependencies: {
        'hono': '^4.4.0',
        'zod': '^4.0.0',
        'kysely': '^0.27.6',
        '@hono/zod-validator': '^0.7.6',
      },
    }, null, 2));
  }

  console.log('[extensions] Installing core packages (first-time setup)…');

  if (await tryBunInstall(extBase)) {
    console.log('[extensions] Core packages installed via bun.');
    return;
  }

  console.log('[extensions] bun CLI unavailable; fetching tarballs from npm registry…');
  try {
    await installCorePackagesFromNpm(extBase);
    console.log('[extensions] Core packages installed via npm tarball fetch.');
  } catch (err) {
    console.warn('[extensions] Core package install failed:', (err as Error).message);
    console.warn('[extensions] Extensions with engine routes will not load. Install bun or run `npm install` in', extBase);
  }
}

async function tryBunInstall(cwd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['bun', 'install'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    // ENOENT — bun not on PATH (typical for compiled-binary production installs)
    return false;
  }
}

const CORE_NPM_PACKAGES = ['hono', 'zod', 'kysely', '@hono/zod-validator'];

/**
 * Direct npm install fallback for production compiled binaries.
 * For each core package:
 *   1. GET https://registry.npmjs.org/<name>/latest → metadata with tarball URL
 *   2. Download tarball
 *   3. Extract via system `tar` into node_modules/<name>/, stripping the
 *      'package/' top-level directory that npm tarballs always contain
 *
 * These 4 packages have zero runtime dependencies between them (zod-validator
 * lists hono and zod as peer deps which we install separately), so we don't
 * need a full dependency resolver.
 */
async function installCorePackagesFromNpm(extBase: string): Promise<void> {
  const nodeModules = join(extBase, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });

  for (const pkg of CORE_NPM_PACKAGES) {
    const metaRes = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!metaRes.ok) {
      throw new Error(`npm metadata fetch failed for ${pkg}: ${metaRes.status}`);
    }
    const meta = await metaRes.json() as { version: string; dist: { tarball: string } };

    const tarRes = await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(60_000) });
    if (!tarRes.ok) {
      throw new Error(`tarball download failed for ${pkg}@${meta.version}: ${tarRes.status}`);
    }
    const buf = Buffer.from(await tarRes.arrayBuffer());

    const targetDir = join(nodeModules, pkg);
    mkdirSync(targetDir, { recursive: true });

    // Stage the tarball next to the target so concurrent extractions don't collide.
    const tmpFile = join(nodeModules, `.${pkg.replace('/', '__')}.tgz`);
    writeFileSync(tmpFile, buf);

    const proc = Bun.spawn(
      ['tar', '-xzf', tmpFile, '-C', targetDir, '--strip-components=1'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const exitCode = await proc.exited;
    try { unlinkSync(tmpFile); } catch { /* ignore cleanup error */ }

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tar extraction failed for ${pkg}: ${stderr.trim() || `exit ${exitCode}`}`);
    }

    console.log(`[extensions]   ✓ ${pkg}@${meta.version}`);
  }
}

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
    aiProviderManager,
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
  };
}

/**
 * Internal extension context — extends the public ExtensionContext from the SDK
 * with concrete engine types (Database, FieldTypeRegistry, EventBus, DDLManager).
 * Extensions receive this at runtime but only see the public interface.
 */
export interface ExtensionContext {
  db: Database;
  auth: any;
  fieldTypeRegistry: FieldTypeRegistry;
  events: EventBus;
  checkPermission: (userId: string, resource: string, action: string) => Promise<boolean>;
  getUserRoles: (userId: string) => Promise<string[]>;
  DDLManager: typeof DDLManager;
  internals: ExtensionInternals;
}

/**
 * Engine-internal helpers exposed to official extensions via ctx.internals.*.
 * Lazy-loaded at first access to avoid forcing every extension into pulling
 * heavy modules (PDF rendering, edge sandbox, etc.) when they don't need them.
 */
export interface ExtensionInternals {
  aiProviderManager: any;
  dynamicInsert: (db: any, collection: string, values: Record<string, unknown>) => Promise<unknown>;
  introspectSchema: (
    db: any,
    schemaName?: string,
    excludePatterns?: string[],
    dryRun?: boolean,
  ) => Promise<any[]>;
  runQualityScan: (...args: any[]) => Promise<unknown>;
  invalidateRulesCache: (collection: string) => void;
  runEdgeFunction: (...args: any[]) => Promise<unknown>;
  extensionRegistry: any;
  generatePDFAsync: (html: string, options?: Record<string, unknown>) => Promise<unknown>;
  renderTemplate: (template: string, variables: Record<string, unknown>) => string;
  generatePDF: (...args: any[]) => Promise<unknown>;
  moveToTrash: (...args: any[]) => Promise<unknown>;
  scheduleFileIndexing: (...args: any[]) => Promise<unknown>;
  DataLoaderRegistry: any;
  checkQueryDepth: (query: string, maxDepth?: number) => string | null;
}

interface LoadedExtension {
  name: string;
  bundleUrl?: string;
  /** Cleanup callback captured from the extension module, if exported. */
  cleanup?: () => Promise<void>;
  /** True if the extension registered HTTP routes — unload requires restart. */
  registeredRoutes: boolean;
}

interface ManifestMeta {
  displayName?: string;
  description?: string;
  contributes?: { engine?: boolean; studio?: boolean; client?: boolean };
  studio?: { pages?: Array<{ path: string; label: string; icon?: string }> };
}

class ExtensionLoader {
  private loaded: Map<string, LoadedExtension> = new Map();
  private manifestMeta: Map<string, ManifestMeta> = new Map();
  private ctx?: ExtensionContext;
  /** Module cache: name → imported ZveltioExtension, kept for re-registration on hot-reload. */
  private modules: Map<string, ZveltioExtension> = new Map();
  /** Last load error per extension name — used by loadDynamic() to surface the real error. */
  private lastLoadError: Map<string, string> = new Map();

  async loadAll(app: Hono, ctx: ExtensionContext): Promise<void> {
    // ctx must be set FIRST — ensureExtensionCoreDeps may throw and loadAll() is
    // called inside Promise.all() with a .catch(); if ctx is set late it stays null.
    this.ctx = ctx;

    const extBase = resolveExtensionsBase();
    await ensureExtensionCoreDeps(extBase).catch((err: Error) => {
      console.warn('[extensions] Core dep install failed (non-fatal):', err.message);
    });

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
      // Priority: explicit basePath > resolveExtensionsBase() (EXTENSIONS_DIR, CWD, dev sibling).
      const defaultBase = resolveExtensionsBase();
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

        // Cache UI-relevant manifest fields for the /api/extensions Studio endpoint
        this.manifestMeta.set(extName, {
          displayName: (manifest as any).displayName,
          description: (manifest as any).description,
          contributes: manifest.contributes as ManifestMeta['contributes'],
          studio: (manifest as any).studio,
        });
      }

      // Import and register extension
      const resolvedPath = existsSync(enginePath) ? enginePath : join(extDir, 'engine/index.ts');
      const module = await import(resolvedPath);
      const extension: ZveltioExtension = module.default;

      if (!extension || typeof extension.register !== 'function') {
        console.warn(`⚠️  Extension "${extName}": missing default export or register() function`);
        return;
      }

      // Cache module for re-registration during hot-reload (avoids re-importing)
      this.modules.set(extName, extension);

      // Run extension migrations
      if (extension.getMigrations) {
        await this.runExtensionMigrations(extension, ctx.db);
      }

      // Register new field types contributed by extension
      if (extension.registerFieldTypes) {
        extension.registerFieldTypes(ctx.fieldTypeRegistry);
      }

      // Pass a RestrictedDb proxy — extensions cannot query zv_* system tables.
      // Also inject the full public API (checkPermission, auth, DDLManager…) and
      // ctx.internals.* so extensions never have to relative-import engine modules.
      const restrictedCtx: ExtensionContext = {
        ...ctx,
        db: createRestrictedDb(ctx.db, extName),
        checkPermission: ctx.checkPermission ?? checkPermission,
        getUserRoles: ctx.getUserRoles ?? getUserRoles,
        DDLManager: ctx.DDLManager ?? DDLManager,
        internals: ctx.internals,
      };

      // Register routes — if the live app's Hono matcher is already built (happens
      // after the first request during hot-load), swallow that specific error and
      // still mark the extension as loaded. triggerReload() will rebuild a fresh
      // Hono app where routes register correctly.
      let routeRegistrationDeferred = false;
      try {
        await extension.register(app, restrictedCtx);
      } catch (regErr: any) {
        if ((regErr as Error)?.message?.includes('matcher is already built')) {
          routeRegistrationDeferred = true;
        } else {
          throw regErr;
        }
      }

      // Register Studio bundle if it exists (skip if route registration was deferred)
      const studioBundlePath = join(extDir, 'studio/dist/bundle.js');
      const bundleKey = extName.replace(/\//g, '_');
      const bundleUrl = existsSync(studioBundlePath)
        ? `/ext/${bundleKey}/bundle.js`
        : undefined;

      if (bundleUrl && !routeRegistrationDeferred) {
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
      const errMsg = (err as Error).message ?? String(err);
      console.error(`❌ Failed to load extension "${extName}":`, err);
      this.lastLoadError.set(extName, errMsg);
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
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this; // capture ExtensionLoader instance for hot-load access

    // Admin-only guard
    async function requireAdmin(c: any): Promise<boolean> {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return false;
      const isAdmin = await checkPermission(session.user.id, 'admin', '*');
      return isAdmin;
    }

    // ── License key management ────────────────────────────────────────────────
    // Free extensions need no license key — they download without auth.
    // Paid extensions require a license key purchased on apps.zveltio.com.
    // Keys are stored per-extension in zv_settings as ext_license:<name>.

    // POST /api/marketplace/license/:name — store (and optionally verify) a license key
    app.post('/api/marketplace/license/:name{.+}', async (c) => {
      if (!await requireAdmin(c)) return c.json({ error: 'Unauthorized' }, 401);

      const name = c.req.param('name');
      const body = await c.req.json().catch(() => ({})) as any;
      const key = body?.license_key as string | undefined;
      if (!key?.trim()) return c.json({ error: 'license_key is required' }, 400);

      // Verify with the registry before storing
      const res = await fetch(`${REGISTRY_URL}/api/licenses/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extension: name, license_key: key }),
        signal: AbortSignal.timeout(8_000),
      }).catch(() => null);

      if (res && !res.ok) {
        const err = await res.json().catch(() => null) as any;
        return c.json({ error: err?.message || 'Invalid license key' }, 400);
      }

      await (db as any)
        .insertInto('zv_settings')
        .values({ key: `ext_license:${name}`, value: key.trim(), is_public: false })
        .onConflict((oc: any) => oc.column('key').doUpdateSet({ value: key.trim() }))
        .execute();

      return c.json({ ok: true });
    });

    // DELETE /api/marketplace/license/:name — remove a stored license key
    app.delete('/api/marketplace/license/:name{.+}', async (c) => {
      if (!await requireAdmin(c)) return c.json({ error: 'Unauthorized' }, 401);

      const name = c.req.param('name');
      await db
        .deleteFrom('zv_settings' as any)
        .where('key' as any, '=', `ext_license:${name}`)
        .execute()
        .catch(() => {});

      return c.json({ ok: true });
    });

    // GET /api/marketplace — catalog fetched from registry (fallback: local) merged with DB state
    app.get('/api/marketplace', async (c) => {
      if (!await requireAdmin(c)) return c.json({ error: 'Unauthorized or admin required' }, 401);

      const extBase = resolveExtensionsBase();

      const [catalog, rows, licenseRows] = await Promise.all([
        fetchRegistryCatalog(),
        (db as any).selectFrom('zv_extension_registry').selectAll().execute().catch(() => []),
        (db as any).selectFrom('zv_settings').select(['key']).where('key' as any, 'like', 'ext_license:%').execute().catch(() => []),
      ]);

      const dbMap = new Map(rows.map((r: any) => [r.name, r]));
      const licenseSet = new Set((licenseRows as any[]).map((r: any) => r.key.replace('ext_license:', '')));

      const extensions = catalog.map((entry) => {
        const dbEntry = dbMap.get(entry.name) as any;
        const runtimeActive = self.isActive(entry.name);
        const extDir = join(extBase, entry.name);
        const filesOnDisk = existsSync(join(extDir, 'engine/index.ts'))
                         || existsSync(join(extDir, 'engine/index.js'));

        return {
          ...entry,
          is_installed:  dbEntry?.is_installed ?? runtimeActive,
          is_enabled:    dbEntry?.is_enabled   ?? runtimeActive,
          is_running:    runtimeActive,
          files_on_disk: filesOnDisk,
          has_license:   licenseSet.has(entry.name),
          // needs_restart only when files exist but process hasn't loaded them yet
          needs_restart: filesOnDisk &&
                         ((dbEntry?.is_enabled && !runtimeActive) ||
                          (!dbEntry?.is_enabled && runtimeActive && dbEntry !== undefined)),
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

      // Determine where extension files should live
      const extBase = resolveExtensionsBase();
      const extDir = join(extBase, name);
      const engineTs = join(extDir, 'engine/index.ts');
      const engineJs = join(extDir, 'engine/index.js');

      // Download extension package if not already on disk
      const authToken = await getLicenseKey(db, name);
      let downloaded = false;
      let downloadError = '';
      if (!existsSync(engineTs) && !existsSync(engineJs)) {
        try {
          await downloadExtension(entry, extBase, authToken);
          downloaded = true;
        } catch (err) {
          downloadError = (err as Error).message;
          console.warn(`[marketplace] Could not download "${name}":`, downloadError);
        }
      }

      // Also accept engine/routes.ts as a valid entry point (manifest.engine.routes)
      let altEntry: string | undefined;
      const manifestPathCheck = join(extDir, 'manifest.json');
      if (existsSync(manifestPathCheck)) {
        try {
          const m = JSON.parse(await Bun.file(manifestPathCheck).text());
          if (m.engine?.routes) {
            altEntry = join(extDir, (m.engine.routes as string).replace(/^\.\//, ''));
          }
        } catch { /* ignore */ }
      }
      const filesOnDisk = existsSync(engineTs) || existsSync(engineJs) || (!!altEntry && existsSync(altEntry));

      // If files are still not on disk after the download attempt, fail loudly so the
      // Studio shows a real error instead of "installed but won't enable".
      if (!filesOnDisk) {
        const msg = `Extension "${name}" could not be installed: ` +
                    (downloadError || 'Registry unavailable.') +
                    ` Set EXTENSIONS_DIR to the extensions directory and retry.`;
        return c.json({ success: false, downloaded: false, files_on_disk: false, error: msg, message: msg }, 422);
      }

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
        success:        true,
        downloaded,
        files_on_disk:  true,
        message:        `Extension "${name}" installed successfully. Enable it to activate.`,
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

      // If extension files are not on disk yet, try to download them now before
      // marking it enabled in the DB. This covers the case where Install succeeded
      // via registry but files were not present, or the user clicked Enable directly.
      const extBase = resolveExtensionsBase();
      const extDir  = join(extBase, name);
      if (!existsSync(join(extDir, 'engine/index.ts')) && !existsSync(join(extDir, 'engine/index.js'))) {
        try {
          const authToken = await getLicenseKey(db, name);
          await downloadExtension(entry, extBase, authToken);
        } catch (downloadErr) {
          const msg = `Extension "${name}" files not found and download failed: ${(downloadErr as Error).message}. ` +
                      `Set EXTENSIONS_DIR to the extensions directory and retry.`;
          return c.json({ success: false, hot_loaded: false, needs_restart: false, error: msg, message: msg }, 422);
        }
      }

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
      let loadError = '';
      if (!self.isActive(name)) {
        try {
          await self.loadDynamic(name, app);
          hotLoaded = true;
        } catch (e) {
          loadError = (e as Error).message;
          console.warn(`Hot-load failed for ${name}:`, loadError);
          // Revert: roll back is_enabled so the DB stays consistent with reality.
          // Without this, every server restart tries to load a broken extension.
          await (db as any)
            .updateTable('zv_extension_registry')
            .set({ is_enabled: false })
            .where('name' as any, '=', name)
            .execute()
            .catch(() => {});
        }
      } else {
        hotLoaded = true;
      }

      // Rebuild and swap the Hono app so the new extension's routes are live
      // without restarting the process. No-op if _reloadCallback isn't set yet.
      if (hotLoaded) {
        await triggerReload(`enable:${name}`);
      }

      const nowActive = self.isActive(name);
      return c.json({
        success:       nowActive,
        hot_loaded:    hotLoaded,
        needs_restart: false,
        message:       nowActive
          ? `Extension ${name} is now active.`
          : `Extension ${name} could not be loaded: ${loadError || 'check server logs'}.`,
        ...(loadError ? { error_detail: loadError } : {}),
      }, nowActive ? 200 : 422);
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

      // Remove from in-memory registry so buildHonoApp() won't re-register routes
      const wasRunning = self.isActive(name);
      if (wasRunning) {
        await self.unload(name);
      }

      // Rebuild Hono app without this extension's routes (zero-downtime)
      await triggerReload(`disable:${name}`);

      return c.json({
        success:       true,
        needs_restart: false,
        message:       `Extension ${name} disabled.`,
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

  /**
   * Re-register a loaded extension's routes onto a fresh Hono app.
   * Used by buildHonoApp() during hot-reload — does NOT re-run migrations or npm installs.
   * Safe to call multiple times: only registers routes, no side effects.
   */
  async reRegisterExtension(name: string, app: Hono): Promise<void> {
    const extension = this.modules.get(name);
    if (!extension || !this.ctx) return;

    const restrictedCtx: ExtensionContext = {
      ...this.ctx,
      db: createRestrictedDb(this.ctx.db, name),
      checkPermission: this.ctx.checkPermission ?? checkPermission,
      getUserRoles:    this.ctx.getUserRoles ?? getUserRoles,
      DDLManager:      this.ctx.DDLManager ?? DDLManager,
      internals:       this.ctx.internals,
    };

    try {
      await extension.register(app, restrictedCtx);

      // Re-register Studio bundle route
      const extBase = resolveExtensionsBase();
      const studioBundlePath = join(extBase, name, 'studio/dist/bundle.js');
      if (existsSync(studioBundlePath)) {
        const bundleKey = name.replace(/\//g, '_');
        app.get(`/ext/${bundleKey}/bundle.js`, async (c) => {
          const content = await Bun.file(studioBundlePath).text();
          c.header('Content-Type', 'application/javascript');
          c.header('Cache-Control', 'public, max-age=3600');
          return c.body(content);
        });
      }
    } catch (err) {
      console.error(`❌ Hot-reload: failed to re-register extension "${name}":`, err);
    }
  }

  /** Register the hot-reload callback. Called from index.ts after Bun.serve() starts. */
  setReloadCallback(fn: ReloadCallback): void {
    _reloadCallback = fn;
  }

  getActive(): string[] {
    return [...this.loaded.keys()];
  }

  getBundles(): Array<{ name: string; url: string }> {
    return [...this.loaded.values()]
      .filter((e) => e.bundleUrl)
      .map((e) => ({ name: e.name, url: e.bundleUrl! }));
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

  /** Mark an extension as active (used after manual enable without a full dynamic load). */
  markActive(name: string): void {
    if (!this.loaded.has(name)) {
      this.loaded.set(name, { name, registeredRoutes: true });
    }
  }
}

export const extensionLoader = new ExtensionLoader();
