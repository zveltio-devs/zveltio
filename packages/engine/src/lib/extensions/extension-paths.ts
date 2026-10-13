// Extension base-directory resolution + on-disk presence checks.
//
// Extracted from extension-loader.ts (loader split). Pure filesystem helpers
// with their own short-TTL presence cache; no loader state.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'path';

/**
 * Resolve where extension files live.  Checked in priority order:
 *  1. EXTENSIONS_DIR env var (explicit config — always wins)
 *  2. ./extensions/ relative to the process CWD (Docker / production binary)
 *  3. Sibling zveltio-extensions repo (monorepo dev: ../../../../../zveltio-extensions)
 *  4. ./extensions/ as creation target even if it doesn't exist yet
 */
export function resolveExtensionsBase(): string {
  if (process.env.EXTENSIONS_DIR) return process.env.EXTENSIONS_DIR;
  const cwdPath = join(process.cwd(), 'extensions');
  if (existsSync(cwdPath)) return cwdPath;
  // Dev: zveltio-extensions is a sibling of the main monorepo repo.
  // packages/engine/src/lib → 4 levels up → monorepo root → 1 more up → ecosystem root.
  const devPath = join(import.meta.dir, '../../../../../zveltio-extensions');
  if (existsSync(devPath)) return devPath;
  return cwdPath; // default target for first download
}

/**
 * Are an extension's files present on disk (i.e. nothing left to download)?
 *
 * An extension is "present" when it has an engine entry point
 * (`engine/index.{ts,js}` or the manifest's `engine.routes`) OR when it is a
 * UI-only extension (`contributes.engine === false`) whose `manifest.json` is on
 * disk. UI-only extensions (e.g. `developer/views`, `content/pdf-viewer`) ship no
 * engine by design — the load path registers them from manifest + Studio assets
 * alone (see loadExtension, the `contributes.engine === false` early-return).
 * Without the UI-only branch the install/enable handlers wrongly treat them as
 * "no files found / registry unreachable" even after a successful download.
 */
export function extensionFilesPresent(extDir: string): boolean {
  if (existsSync(join(extDir, 'engine/index.ts')) || existsSync(join(extDir, 'engine/index.js')))
    return true;
  const manifestPath = join(extDir, 'manifest.json');
  if (!existsSync(manifestPath)) return false;
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // Alternate engine entry declared in the manifest (manifest.engine.routes).
    if (m?.engine?.routes) {
      const alt = join(extDir, (m.engine.routes as string).replace(/^\.\//, ''));
      if (existsSync(alt)) return true;
    }
    // UI-only: manifest present + no engine contributed → nothing to download.
    if (m?.contributes?.engine === false) return true;
  } catch {
    /* malformed manifest — treat as not present so the caller surfaces it */
  }
  return false;
}

// Short-TTL cache for the marketplace LISTING only. GET /api/marketplace calls
// extensionFilesPresent once per catalog entry (54+ sync existsSync/readFileSync)
// on every admin poll. Disk state only changes on install/uninstall, so a few
// seconds of staleness is fine — and those handlers call invalidateFilesPresent
// for immediate accuracy. Install/enable themselves use the UNCACHED function so
// a just-finished download is seen right away.
const FILES_PRESENT_TTL_MS = 5000;
const filesPresentCache = new Map<string, { present: boolean; exp: number }>();

export function extensionFilesPresentCached(extDir: string): boolean {
  const hit = filesPresentCache.get(extDir);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.present;
  const present = extensionFilesPresent(extDir);
  filesPresentCache.set(extDir, { present, exp: now + FILES_PRESENT_TTL_MS });
  return present;
}

export function invalidateFilesPresent(extDir?: string): void {
  if (extDir) filesPresentCache.delete(extDir);
  else filesPresentCache.clear();
}
