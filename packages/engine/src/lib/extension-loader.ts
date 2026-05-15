import { Hono } from 'hono';
import { z } from 'zod';
import { sql as _sql } from 'kysely';
import type { Database } from '../db/index.js';
import type { FieldTypeRegistry } from './field-type-registry.js';
import { existsSync, writeFileSync, mkdirSync, unlinkSync, symlinkSync } from 'fs';
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
import { sendNotification } from './notifications.js';
import { serviceRegistry } from './service-registry.js';
import { queryAlterRegistry, type QueryAlterScope } from './query-alter.js';
import { entityAccessRegistry, type EntityAccessScope } from './entity-access.js';
import { cronRunner } from './cron-runner.js';
import type { ServiceRegistry, ZveltioExtension } from '@zveltio/sdk/extension';
import { isPackageAllowed } from './peer-deps-allowlist.js';
import {
  parseSignature,
  verifySignature,
  SignatureMissingError,
  SignatureInvalidError,
} from './signature-verify.js';

export { serviceRegistry } from './service-registry.js';

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
// Trade-off: when a wrapped operation runs an external long task (download,
// npm install) the advisory-lock transaction stays open for that duration,
// holding one DB connection. Lifecycle ops are infrequent admin actions so
// this is acceptable. The pool default of 10 connections has plenty of headroom.
const extensionLifecycleLocks = new Map<string, Promise<unknown>>();

/**
 * Pure same-process mutex keyed by string. Concurrent calls with the same key
 * are serialized; different keys run in parallel. The map self-cleans when no
 * call is in flight for a key.
 *
 * Exported for tests; production callers should prefer withExtensionLock which
 * layers on the Postgres advisory lock for cross-replica safety.
 */
export async function inMemoryMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = extensionLifecycleLocks.get(key);
  if (prior) {
    await prior.catch(() => { /* swallow — not our concern */ });
  }
  const current = fn();
  extensionLifecycleLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (extensionLifecycleLocks.get(key) === current) {
      extensionLifecycleLocks.delete(key);
    }
  }
}

export async function withExtensionLock<T>(
  db: Database,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `ext:${name}`;
  return inMemoryMutex(key, async () =>
    // Cross-process: acquire a Postgres advisory lock for the duration.
    // hashtext returns int4; pg_advisory_xact_lock accepts int8 — Postgres
    // implicitly widens. Different extension names hash to different keys
    // (collisions are theoretically possible but harmless — at worst two
    // unrelated extensions would serialize each other).
    db.transaction().execute(async (trx) => {
      await _sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`.execute(trx);
      return fn();
    }),
  );
}

async function buildAllowedTables(migrationPaths: string[]): Promise<Set<string>> {
  const tables = new Set<string>();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
  for (const p of migrationPaths) {
    try {
      const content = await Bun.file(p).text();
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(content)) !== null) tables.add(m[1]);
    } catch { /* skip unreadable files */ }
  }
  return tables;
}

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

  let remoteEntries: ExtensionCatalogEntry[] = [];
  try {
    const res = await fetch(`${REGISTRY_URL}/api/extensions/list`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Registry returned ${res.status}`);
    const data = await res.json() as { extensions: any[] };
    remoteEntries = (data.extensions ?? []).map((e: any) => ({
      name:         e.name,
      displayName:  e.display_name ?? e.displayName ?? e.name,
      description:  e.description ?? '',
      category:     e.category ?? 'other',
      version:      e.version ?? '1.0.0',
      author:       e.developer_username ?? e.author ?? 'Zveltio',
      tags:         e.tags ?? [],
      permissions:  e.permissions ?? [],
      download_url: e.download_url
        ?? `${REGISTRY_URL}/api/extensions/by-name/${encodeURIComponent(e.name)}/download`,
    }));
  } catch (err) {
    console.warn('[marketplace] Registry fetch failed, using local catalog:', (err as Error).message);
  }

  // Always merge: remote entries win over local for the same name,
  // but local catalog fills in anything the registry doesn't list
  // (local/dev extensions, self-hosted, extensions not yet published).
  const remoteNames = new Set(remoteEntries.map((e) => e.name));
  const merged = [
    ...remoteEntries,
    ...EXTENSION_CATALOG.filter((e) => !remoteNames.has(e.name)),
  ];
  const result = merged.length > 0 ? merged : EXTENSION_CATALOG;

  if (remoteEntries.length > 0) {
    catalogCache = result;
    catalogCacheExpiry = Date.now() + CATALOG_CACHE_TTL;
  }

  return result;
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
export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const delays = [500, 2000, 5000];
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      const res = await fetch(url, init);
      // 4xx (except 429) — client error, retry won't help.
      if (!res.ok && res.status >= 400 && res.status < 500 && res.status !== 429) {
        return res;
      }
      // 5xx or 429 — transient, retry unless this was the last attempt.
      if (!res.ok && attempt < delays.length - 1) {
        await Bun.sleep(delays[attempt]);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err as Error;
      if (attempt < delays.length - 1) {
        await Bun.sleep(delays[attempt]);
        continue;
      }
    }
  }
  // Exhausted retries on network errors — surface the last one.
  throw lastError ?? new Error(`fetchWithRetry exhausted retries for ${url}`);
}

/**
 * Fetch `<download_url>.sig` and verify the archive's Ed25519 signature.
 *
 * Behaviour controlled by env:
 *   - `REQUIRE_EXTENSION_SIGNATURES=true`  → missing or invalid signature
 *     throws (SignatureMissingError / SignatureInvalidError).
 *   - default (unset or "false")           → missing signature logs a warning
 *     and proceeds; an INVALID signature still throws (we never accept a
 *     present-but-broken signature, regardless of the gate).
 */
async function verifyArchiveSignature(
  extensionName: string,
  downloadUrl: string,
  headers: Record<string, string>,
  archive: Uint8Array,
): Promise<void> {
  const required = process.env.REQUIRE_EXTENSION_SIGNATURES === 'true';
  const sigUrl = `${downloadUrl}.sig`;

  let sigBody: unknown = null;
  try {
    const sigRes = await fetchWithRetry(sigUrl, { headers });
    if (sigRes.ok) {
      sigBody = await sigRes.json();
    } else if (sigRes.status === 404) {
      sigBody = null;
    } else {
      // 5xx / non-404 — treat as missing for the purposes of the gate, but log
      // so operators can investigate.
      console.warn(`[signature] ${extensionName}: signature fetch returned ${sigRes.status}; treating as missing`);
    }
  } catch (err) {
    console.warn(`[signature] ${extensionName}: signature fetch failed: ${(err as Error).message}; treating as missing`);
  }

  if (sigBody === null) {
    if (required) throw new SignatureMissingError(extensionName);
    console.warn(`[signature] ${extensionName}: no signature.sig found — install proceeded because REQUIRE_EXTENSION_SIGNATURES is not set`);
    return;
  }

  const parsed = parseSignature(sigBody, extensionName);
  await verifySignature(archive, parsed, extensionName);
  console.log(`🔐 Extension "${extensionName}": signature verified (keyId=${parsed.keyId})`);
}

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

  const res = await fetchWithRetry(downloadUrl, {
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

  // S1-01: signature verification. Try to fetch `<download_url>.sig` next to
  // the archive. The registry publishes the sig file as a sibling of the
  // tarball. Missing-signature behaviour is gated by REQUIRE_EXTENSION_SIGNATURES.
  await verifyArchiveSignature(entry.name, downloadUrl, headers, new Uint8Array(buf));

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

  // Warn if no pre-built Studio bundle — extension will show generic page until a bundle is present.
  const bundlePath = path.join(destDir, 'studio/dist/bundle.js');
  if (fs.existsSync(path.join(destDir, 'studio/vite.config.ts')) && !fs.existsSync(bundlePath)) {
    console.warn(`⚠️  Extension "${entry.name}" has a Studio UI but the package does not include a pre-built bundle (studio/dist/bundle.js). The extension will show a generic page in the Studio. Re-upload the package with the bundle included.`);
  }

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
// at first startup.  A CWD-level symlink (maybeSymlinkNodeModules) makes them
// visible to the compiled binary's module resolver, which walks from CWD upward.

export type { EventBus };

/**
 * When running as a compiled binary (e.g. /opt/zveltio/zveltio), Bun resolves
 * dynamic-import module specifiers starting from the process's working directory,
 * not from the imported file's filesystem location.  The extensions live under
 * EXTENSIONS_DIR (e.g. /opt/zveltio/extensions/) but the binary's CWD is typically
 * one level up (/opt/zveltio/).  A symlink from CWD/node_modules to
 * extBase/node_modules makes all packages installed by ensureExtensionCoreDeps and
 * installNpmDependencies visible to the binary's module resolver.
 */
function maybeSymlinkNodeModules(extBase: string): void {
  const extModules = join(extBase, 'node_modules');
  const cwdModules = join(process.cwd(), 'node_modules');
  if (extModules === cwdModules) return;       // already the same location
  if (existsSync(cwdModules)) return;          // already exists (real dir or prior symlink)
  try {
    symlinkSync(extModules, cwdModules);
  } catch { /* non-fatal — may fail on unusual setups or missing permissions */ }
}

async function ensureExtensionCoreDeps(extBase: string): Promise<void> {
  const honoPath = join(extBase, 'node_modules', 'hono');
  if (existsSync(honoPath)) {
    maybeSymlinkNodeModules(extBase);
    return;
  }

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
    maybeSymlinkNodeModules(extBase);
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
  maybeSymlinkNodeModules(extBase);
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
  /** PostgreSQL extensions required in the database (e.g. postgis, pg_trgm) */
  requires: z.object({
    postgres_extensions: z.array(z.string()).optional(),
  }).optional(),
  permissions: z.array(z.string()).default([]),
  contributes: z.object({
    engine: z.boolean().default(true),
    studio: z.boolean().default(false),
    client: z.boolean().default(false),
    fieldTypes: z.array(z.string()).default([]),
    stepTypes: z.array(z.string()).default([]),
    collections: z.array(z.string()).default([]),
  }).optional(),
  /**
   * Resource quotas. Extensions exceeding any limit fail install with
   * EXT_QUOTA_EXCEEDED. Defaults are generous enough for current extensions;
   * publishers wanting a smaller footprint can tighten them per-extension.
   */
  quotas: z.object({
    bundleSizeKbMax: z.number().int().positive().default(50_000),
    nodeModulesSizeMbMax: z.number().int().positive().default(200),
    migrationsMax: z.number().int().positive().default(100),
  }).optional(),
}).passthrough();

// Default quotas exposed for callers that don't have a full manifest yet.
export const DEFAULT_QUOTAS = {
  bundleSizeKbMax: 50_000,
  nodeModulesSizeMbMax: 200,
  migrationsMax: 100,
} as const;

export class QuotaExceededError extends Error {
  constructor(
    public readonly quota: 'bundleSizeKb' | 'nodeModulesSizeMb' | 'migrations',
    public readonly observed: number,
    public readonly limit: number,
    extName: string,
  ) {
    super(
      `Extension "${extName}" exceeded ${quota} quota: observed ${observed}, limit ${limit}. ` +
      `Raise the limit in manifest.json "quotas" or reduce the extension's footprint.`,
    );
    this.name = 'QuotaExceededError';
  }
}

export class DownMissingError extends Error {
  constructor(
    public readonly extensionName: string,
    public readonly missingMigrations: string[],
  ) {
    super(
      `Extension "${extensionName}" cannot be purged: ${missingMigrations.length} migration(s) ` +
      `have no DOWN section recorded: ${missingMigrations.join(', ')}. ` +
      `Either edit the migrations to add a "-- DOWN" section before retrying, or roll them back manually.`,
    );
    this.name = 'DownMissingError';
  }
}

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
export async function isPathInsideBase(base: string, target: string): Promise<boolean> {
  const { resolve, sep } = await import('path');
  const safeBase = resolve(base);
  const safeTarget = resolve(target);
  if (safeTarget === safeBase) return false;
  // Ensure base ends with a separator before the prefix check so
  // resolve('/foo') vs resolve('/foobar') is not a false match.
  const baseWithSep = safeBase.endsWith(sep) ? safeBase : safeBase + sep;
  return safeTarget.startsWith(baseWithSep);
}

/**
 * Parsed SQL migration with separated UP / DOWN sections.
 *
 * The DOWN section starts at the first line that matches `-- DOWN` (case
 * insensitive). Everything before the marker is UP; everything after the
 * marker line is DOWN. If the marker is absent, the whole file is UP and
 * DOWN is null.
 */
export interface ParsedMigration {
  up: string;
  down: string | null;
}

export function parseMigrationSql(raw: string): ParsedMigration {
  const downIdx = raw.search(/^--\s*DOWN\b/im);
  if (downIdx < 0) {
    return { up: raw.trim(), down: null };
  }
  const up = raw.slice(0, downIdx).trim();
  // Skip the marker line itself, keep everything after the next newline.
  const downSection = raw.slice(downIdx);
  const firstNewline = downSection.indexOf('\n');
  const downBody = firstNewline >= 0 ? downSection.slice(firstNewline + 1).trim() : '';
  return { up, down: downBody.length > 0 ? downBody : null };
}

/**
 * Compute the total size of a directory recursively, in bytes.
 * Returns 0 if the directory does not exist or any traversal fails.
 */
export async function directorySizeBytes(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    const { readdir, stat } = await import('fs/promises');
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          const st = await stat(full);
          total += st.size;
        }
      }
    }
  } catch {
    // Permission or transient FS errors — be lenient. A check that can't read
    // the directory shouldn't block install; better than false-positive quotas.
  }
  return total;
}

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
  /** Inter-extension service registry — see service-registry.ts */
  services: ServiceRegistry;
  /** Query-alter registry — see query-alter.ts. Extensions add global WHERE
   * filters here (tenant isolation, soft-delete masks, redaction). */
  queryAlter: QueryAlterScope;
  /** Entity-access registry — see entity-access.ts. Per-record allow/deny
   * callbacks; first deny wins across all extensions. */
  entityAccess: EntityAccessScope;
  internals: ExtensionInternals;
}

/**
 * Engine-internal helpers exposed to official extensions via ctx.internals.*.
 * Lazy-loaded at first access to avoid forcing every extension into pulling
 * heavy modules (PDF rendering, edge sandbox, etc.) when they don't need them.
 */
export interface ExtensionInternals {
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
  enqueueDDLJob: (...args: any[]) => Promise<unknown>;
  validatePublicUrl: (url: string) => Promise<URL>;
  extractTextFromFile: (buffer: ArrayBuffer | Buffer | Uint8Array, mimeType: string) => Promise<string>;
  sendNotification: (db: any, input: any) => Promise<void>;
}

interface LoadedExtension {
  name: string;
  bundleUrl?: string;
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
  private async topoSortExtensions(names: string[], baseDir: string): Promise<string[]> {
    if (names.length <= 1) return names;

    const depsMap = new Map<string, string[]>();
    for (const name of names) {
      const manifestPath = join(baseDir, name, 'manifest.json');
      let deps: string[] = [];
      if (existsSync(manifestPath)) {
        try {
          const m = JSON.parse(await Bun.file(manifestPath).text()) as { dependencies?: Array<{ name: string }> };
          deps = (m.dependencies ?? []).map((d) => d.name);
        } catch { /* ignore — extension will fail later in loadExtension with proper error */ }
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
          console.warn(`[extensions] "${name}" depends on "${dep}" which is not in the load set — "${name}" will load anyway, but ctx.services.get('${dep}.*') may return null until "${dep}" is also activated.`);
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

      // Migrations quota is determined from manifest (or defaults if no manifest).
      // Hoisted out of the if-block so the check after getMigrations() can see it.
      let migrationsLimit = DEFAULT_QUOTAS.migrationsMax;

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

        // Resource quota: bundle size (extension folder excluding node_modules).
        // node_modules sits in the shared workspace root, not inside extDir, so
        // a recursive walk of extDir captures only this extension's own files.
        const quotas = manifest.quotas ?? DEFAULT_QUOTAS;
        migrationsLimit = quotas.migrationsMax;
        const bundleBytes = await directorySizeBytes(extDir);
        const bundleKb = Math.ceil(bundleBytes / 1024);
        if (bundleKb > quotas.bundleSizeKbMax) {
          const err = new QuotaExceededError('bundleSizeKb', bundleKb, quotas.bundleSizeKbMax, extName);
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
        const requiredPgExts: string[] = (manifest as any).requires?.postgres_extensions ?? [];
        if (requiredPgExts.length > 0) {
          try {
            const result = await _sql<{ extname: string }>`
              SELECT extname FROM pg_extension WHERE extname = ANY(${requiredPgExts as any})
            `.execute(ctx.db);
            const installed = new Set(result.rows.map((r) => r.extname));
            const missing = requiredPgExts.filter((e) => !installed.has(e));
            if (missing.length > 0) {
              const msg = `Extension "${extName}" requires PostgreSQL extension(s) not installed: ${missing.join(', ')}. ` +
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
            const err = new QuotaExceededError('nodeModulesSizeMb', nmMb, quotas.nodeModulesSizeMbMax, extName);
            console.warn(`⚠️  ${err.message}`);
            this.lastLoadError.set(extName, err.message);
            return;
          }
        }

        // Cache UI-relevant manifest fields for the /api/extensions Studio endpoint
        this.manifestMeta.set(extName, {
          displayName: (manifest as any).displayName,
          description: (manifest as any).description,
          contributes: manifest.contributes as ManifestMeta['contributes'],
          studio: (manifest as any).studio,
        });
      }

      // Import and register extension. In development, append a cache-buster
      // query string so re-loading an edited extension picks up changes; in
      // production the module is loaded once at startup and the cache is a feature.
      const resolvedPath = existsSync(enginePath) ? enginePath : join(extDir, 'engine/index.ts');
      const cacheBuster = process.env.NODE_ENV === 'production' ? '' : `?v=${Date.now()}`;
      const module = await import(`${resolvedPath}${cacheBuster}`);
      const extension: ZveltioExtension = module.default;

      if (!extension || typeof extension.register !== 'function') {
        console.warn(`⚠️  Extension "${extName}": missing default export or register() function`);
        return;
      }

      // Cache module for re-registration during hot-reload (avoids re-importing)
      this.modules.set(extName, extension);

      // Run extension migrations
      const migrationPaths = extension.getMigrations?.() ?? [];
      if (migrationPaths.length > migrationsLimit) {
        const err = new QuotaExceededError('migrations', migrationPaths.length, migrationsLimit, extName);
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
      for (const t of (EXTENSION_TABLE_GRANTS[extName] ?? [])) allowedTables.add(t);

      // Pass a RestrictedDb proxy — extensions cannot query zv_* system tables.
      // Also inject the full public API (checkPermission, auth, DDLManager…) and
      // ctx.internals.* so extensions never have to relative-import engine modules.
      const restrictedCtx: ExtensionContext = {
        ...ctx,
        db: createRestrictedDb(ctx.db, extName, allowedTables),
        checkPermission: ctx.checkPermission ?? checkPermission,
        getUserRoles: ctx.getUserRoles ?? getUserRoles,
        DDLManager: ctx.DDLManager ?? DDLManager,
        // Hand each extension a scoped view of the registry so its register()
        // calls are tagged for cleanup on unload. Idempotent on hot-reload.
        services: serviceRegistry.scope(extName),
        queryAlter: queryAlterRegistry.scope(extName),
        entityAccess: entityAccessRegistry.scope(extName),
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
      let routeRegistrationDeferred = false;
      const mountStrategy = extension.mountStrategy ?? 'global';
      try {
        if (mountStrategy === 'subapp') {
          const subApp = new Hono();
          await extension.register(subApp, restrictedCtx);
          app.route(`/ext/${extName}`, subApp);
        } else {
          await extension.register(app, restrictedCtx);
        }
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

      // Register native schedules (S2-05). Failure here is non-fatal — log
      // and continue so the extension is otherwise functional.
      if (typeof extension.schedules === 'function') {
        try {
          const schedules = extension.schedules() ?? [];
          for (const s of schedules) {
            cronRunner.register(extName, s as any);
          }
          if (schedules.length > 0) {
            console.log(`⏰ Extension "${extName}" registered ${schedules.length} schedule(s)`);
          }
        } catch (err) {
          console.warn(`[cron-runner] failed to read schedules() for "${extName}":`, (err as Error).message);
        }
      }

      this.loaded.set(extName, {
        name: extName,
        bundleUrl,
        cleanup: typeof extension.cleanup === 'function' ? extension.cleanup.bind(extension) : undefined,
        registeredRoutes: true,
        allowedTables,
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

  private async runExtensionMigrations(
    extension: ZveltioExtension,
    db: Database,
  ): Promise<void> {
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
        .selectFrom('zv_migrations' as any)
        .select('id')
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
        await (trx as any).executeQuery({ sql: m.up, parameters: [] });
        // Persist DOWN alongside the migration row so a future uninstall with
        // purgeData=true can replay rollbacks without the original files.
        await trx
          .insertInto('zv_migrations' as any)
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
  private async purgeExtensionData(extensionName: string, db: Database): Promise<void> {
    const prefix = `ext:${extensionName}:`;
    const rows = await db
      .selectFrom('zv_migrations' as any)
      .select(['id' as any, 'name' as any, 'down_sql' as any])
      .where('name' as any, 'like', `${prefix}%`)
      .orderBy('id' as any, 'desc')
      .execute()
      .catch(() => [] as any[]);

    if (rows.length === 0) return;

    const missing = rows.filter((r: any) => !r.down_sql || (r.down_sql as string).trim() === '');
    if (missing.length > 0) {
      throw new DownMissingError(
        extensionName,
        missing.map((r: any) => r.name as string),
      );
    }

    await db.transaction().execute(async (trx) => {
      for (const r of rows as any[]) {
        const downSql = r.down_sql as string;
        await (trx as any).executeQuery({ sql: downSql, parameters: [] });
        await trx
          .deleteFrom('zv_migrations' as any)
          .where('id' as any, '=', r.id)
          .execute();
        console.log(`  ✓ Extension purge: rolled back ${r.name}`);
      }
    });
  }

  async loadFromDB(db: Database, app: Hono): Promise<void> {
    try {
      const rows = await (db as any)
        .selectFrom('zv_extension_registry')
        .select(['name'])
        .where('is_enabled' as any, '=', true)
        .execute();

      const pending = rows
        .map((r: any) => r.name as string)
        .filter((name: string) => !this.loaded.has(name));
      if (pending.length === 0 || !this.ctx) return;

      const extBase = resolveExtensionsBase();
      const sorted = await this.topoSortExtensions(pending, extBase);
      for (const name of sorted) {
        await this.loadExtension(name, app, this.ctx);
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

    // Resolve optional tenant scope from X-Tenant-Id header.
    // null = global (no tenant filter); string = scoped to that tenant.
    function getTenantId(c: any): string | null {
      return (c.req.header('x-tenant-id') as string | undefined) ?? null;
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

      const tenantId = getTenantId(c);
      const extBase  = resolveExtensionsBase();

      const [catalog, rows, licenseRows] = await Promise.all([
        fetchRegistryCatalog(),
        (db as any).selectFrom('zv_extension_registry').selectAll().execute().catch(() => []),
        (db as any).selectFrom('zv_settings').select(['key']).where('key' as any, 'like', 'ext_license:%').execute().catch(() => []),
      ]);

      // When a tenant is specified: prefer tenant-scoped row, fall back to global (tenant_id IS NULL).
      // When no tenant: return the global row (admin view).
      const rowsFiltered = tenantId
        ? (() => {
            const tenantRows = (rows as any[]).filter((r) => r.tenant_id === tenantId);
            const globalRows = (rows as any[]).filter((r) => r.tenant_id === null || r.tenant_id === undefined);
            // Merge: tenant row wins over global for the same extension name
            const merged = new Map<string, any>();
            for (const r of globalRows) merged.set(r.name, r);
            for (const r of tenantRows)  merged.set(r.name, r); // override with tenant row
            return [...merged.values()];
          })()
        : (rows as any[]).filter((r) => r.tenant_id === null || r.tenant_id === undefined);

      const dbMap = new Map(rowsFiltered.map((r: any) => [r.name, r]));
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
          tenant_id:     dbEntry?.tenant_id    ?? null,
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
      return withExtensionLock(db, name, async () => {
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

        const tenantId = getTenantId(c);

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
            tenant_id:    tenantId,
          })
          .onConflict((oc: any) =>
            oc.column('name').doUpdateSet({ is_installed: true, installed_at: new Date(), tenant_id: tenantId }),
          )
          .execute();

        return c.json({
          success:        true,
          downloaded,
          files_on_disk:  true,
          message:        `Extension "${name}" installed successfully. Enable it to activate.`,
        });
      });
    });

    // POST /api/marketplace/:name/enable
    app.post('/api/marketplace/:name{.+}/enable', async (c) => {
      if (!await requireAdmin(c)) return c.json({ error: 'Unauthorized or admin required' }, 401);

      const name = c.req.param('name');
      return withExtensionLock(db, name, async () => {
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

        const tenantId = getTenantId(c);

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
            tenant_id:    tenantId,
          })
          .onConflict((oc: any) =>
            oc.column('name').doUpdateSet({
              is_installed: true,
              is_enabled:   true,
              enabled_at:   new Date(),
              tenant_id:    tenantId,
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

        // Rebuild Studio SPA if source dir is configured (non-blocking fire-and-forget)
        const { rebuildStudio } = await import('./studio-builder.js');
        rebuildStudio(self.getActive(), resolveExtensionsBase()).catch((err) =>
          console.warn('[studio-builder] Rebuild error:', err),
        );

        const nowActive = self.isActive(name);
        return c.json({
          success:       nowActive,
          hot_loaded:    hotLoaded,
          needs_restart: false,
          studio_rebuild: (process.env.STUDIO_BUILDER_URL || process.env.STUDIO_SRC_DIR) ? 'triggered' : 'skipped',
          message:       nowActive
            ? `Extension ${name} is now active.`
            : `Extension ${name} could not be loaded: ${loadError || 'check server logs'}.`,
          ...(loadError ? { error_detail: loadError } : {}),
        }, nowActive ? 200 : 422);
      });
    });

    // POST /api/marketplace/:name/disable
    app.post('/api/marketplace/:name{.+}/disable', async (c) => {
      if (!await requireAdmin(c)) return c.json({ error: 'Unauthorized or admin required' }, 401);

      const name = c.req.param('name');
      return withExtensionLock(db, name, async () => {
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

        // Rebuild Studio SPA without this extension's pages (fire-and-forget)
        const { rebuildStudio } = await import('./studio-builder.js');
        rebuildStudio(self.getActive(), resolveExtensionsBase()).catch((err) =>
          console.warn('[studio-builder] Rebuild error:', err),
        );

        return c.json({
          success:       true,
          needs_restart: false,
          studio_rebuild: (process.env.STUDIO_BUILDER_URL || process.env.STUDIO_SRC_DIR) ? 'triggered' : 'skipped',
          message:       `Extension ${name} disabled.`,
        });
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

    // POST /api/marketplace/:name/uninstall[?purgeData=true]
    //
    // Default (purgeData=false or omitted): soft uninstall — mark
    // is_installed=false in the registry, keep the extension's tables and
    // migration history. A future reinstall picks up where we left off.
    //
    // Purge (purgeData=true): run DOWN migrations in reverse, delete migration
    // rows, remove files from disk, delete the registry row. Fully destructive.
    app.post('/api/marketplace/:name{.+}/uninstall', async (c) => {
      if (!await requireAdmin(c)) return c.json({ error: 'Unauthorized or admin required' }, 401);

      const name = c.req.param('name');
      const purgeData = c.req.query('purgeData') === 'true';

      return withExtensionLock(db, name, async () => {
        // Always unload from memory + trigger reload so live routes stop.
        // The Hono matcher still holds the routes until restart (a known
        // limitation tracked as S3-01); the reload at least re-runs setup
        // without the extension in this.loaded.
        const wasActive = self.isActive(name);
        if (wasActive) {
          await self.unload(name);
        }

        if (!purgeData) {
          // Soft path: keep tables + migrations + files, just deactivate.
          await (db as any)
            .updateTable('zv_extension_registry')
            .set({ is_installed: false, is_enabled: false })
            .where('name' as any, '=', name)
            .execute();

          if (wasActive) {
            await triggerReload(`uninstall:${name}`);
          }

          return c.json({
            success: true,
            purged: false,
            needs_restart: wasActive,
            message: `Extension ${name} uninstalled. Tables and data preserved. Pass ?purgeData=true to drop them.`,
          });
        }

        // Hard purge path: roll back DDL, remove files, drop registry row.
        try {
          await self.purgeExtensionData(name, db);
        } catch (err) {
          if (err instanceof DownMissingError) {
            return c.json({
              success: false,
              purged: false,
              error: 'EXT_DOWN_MISSING',
              missing_migrations: err.missingMigrations,
              message: err.message,
            }, 422);
          }
          throw err;
        }

        // Remove extension files from disk, guarded against path-traversal.
        const extBase = resolveExtensionsBase();
        const extDir = join(extBase, name);
        if (await isPathInsideBase(extBase, extDir)) {
          const fs = await import('fs');
          try { fs.rmSync(extDir, { recursive: true, force: true }); }
          catch (err) { console.warn(`[marketplace] could not remove ${extDir}:`, err); }
        } else {
          console.warn(`[marketplace] refusing to remove "${extDir}" — not inside extensions base`);
        }

        await (db as any)
          .deleteFrom('zv_extension_registry')
          .where('name' as any, '=', name)
          .execute();

        if (wasActive) {
          await triggerReload(`uninstall-purge:${name}`);
        }

        return c.json({
          success: true,
          purged: true,
          needs_restart: wasActive,
          message: `Extension ${name} uninstalled and purged.`,
        });
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

    const allowedTables = this.loaded.get(name)?.allowedTables;
    const restrictedCtx: ExtensionContext = {
      ...this.ctx,
      db: createRestrictedDb(this.ctx.db, name, allowedTables),
      checkPermission: this.ctx.checkPermission ?? checkPermission,
      getUserRoles:    this.ctx.getUserRoles ?? getUserRoles,
      DDLManager:      this.ctx.DDLManager ?? DDLManager,
      services:        serviceRegistry.scope(name),
      queryAlter:      queryAlterRegistry.scope(name),
      entityAccess:    entityAccessRegistry.scope(name),
      internals:       this.ctx.internals,
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
          for (const s of (extension.schedules() ?? [])) {
            cronRunner.register(name, s as any);
          }
        } catch (err) {
          console.warn(`[cron-runner] schedules() threw on hot-reload of "${name}":`, (err as Error).message);
        }
      }

      // Re-register Studio bundle route and update cached bundleUrl
      const extBase = resolveExtensionsBase();
      const studioBundlePath = join(extBase, name, 'studio/dist/bundle.js');
      const bundleKey = name.replace(/\//g, '_');
      const bundleUrl = existsSync(studioBundlePath) ? `/ext/${bundleKey}/bundle.js` : undefined;
      if (bundleUrl) {
        app.get(bundleUrl, async (c) => {
          const content = await Bun.file(studioBundlePath).text();
          c.header('Content-Type', 'application/javascript');
          c.header('Cache-Control', 'public, max-age=3600');
          return c.body(content);
        });
      }
      // Keep bundleUrl in sync so getBundles() reflects current state
      const entry = this.loaded.get(name);
      if (entry) this.loaded.set(name, { ...entry, bundleUrl });
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
