export interface ExtensionCatalogEntry {
  name: string;
  displayName: string;
  description: string;
  category: string;
  version: string;
  author: string;
  tags: string[];
  permissions: string[];
  /** Direct download URL for the extension package (.tar.gz). Present when the registry serves packages. */
  download_url?: string;
  /**
   * First-party extension (Zveltio-published, audited, allowed to use
   * `engine.isolation: 'inline'`). Third-party (community) extensions
   * MUST declare `isolation: 'worker'` per `docs/extensions/marketplace-policy.md`
   * §2 — the loader hard-fails the enable otherwise.
   *
   * Local hardcoded entries default to `true` (the 54 official + the
   * smoke fixtures); the registry-merged path sets this from the
   * `is_official` column on the marketplace DB.
   *
   * @deprecated Prefer `publisher_tier` — `is_official` is retained for
   * backward compatibility with older registries that don't surface the
   * tier. Treat `is_official === true` as `publisher_tier === 'first-party'`.
   */
  is_official?: boolean;
  /**
   * Publisher trust tier (marketplace-policy.md §2). Drives isolation
   * enforcement at enable:
   *   - `first-party` / `verified` → may run `isolation: 'inline'`
   *   - `community` (or unknown)   → MUST declare `isolation: 'worker'`
   *
   * Populated from the registry catalog (`publisher_tier` column, added
   * in registry migration 010). When absent — older registries, local
   * hardcoded entries — the loader falls back to `is_official`:
   * official → first-party, otherwise → community.
   */
  publisher_tier?: 'first-party' | 'verified' | 'community';
}

/**
 * Resolve the effective publisher tier for an entry, with the
 * `is_official` fallback for catalogs that predate `publisher_tier`.
 * Single source of truth so the catalog mapper and the enable-time
 * enforcement agree.
 */
export function resolvePublisherTier(
  entry: Pick<ExtensionCatalogEntry, 'publisher_tier' | 'is_official'>,
): 'first-party' | 'verified' | 'community' {
  if (entry.publisher_tier) return entry.publisher_tier;
  return entry.is_official ? 'first-party' : 'community';
}

/** Whether a tier may run inline (vs. requiring worker isolation). */
export function tierAllowsInline(tier: 'first-party' | 'verified' | 'community'): boolean {
  return tier === 'first-party' || tier === 'verified';
}

/**
 * The catalog is delivered data, not source.
 *
 * The 60 entries below used to be a TypeScript array in this file, 749 lines of
 * it, compiled into the engine binary. That made adding one extension to the
 * catalogue a new engine release — for a list whose whole job is to change more
 * often than the engine does.
 *
 * Owner decision, 2026-08-30: keep the catalogue (isolated installs must be able
 * to see what they can install, with no registry reachable — that is the target
 * market), but ship it as versioned data.
 *
 * ── Where it comes from, in order ─────────────────────────────
 *
 *   1. `ZVELTIO_CATALOG_PATH`, if set — an operator pointing at their own file
 *   2. `<extensions dir>/catalog.json`, if present — the delivered copy, which
 *      can be replaced without recompiling anything
 *   3. the bundled `catalog.json`, imported here
 *
 * The bundled copy is imported rather than read, so the compiled binary carries
 * it and an install with no file and no registry still has a catalogue. That is
 * not the same as compiling the list into source: replacing the file overrides
 * it, and nothing needs rebuilding.
 *
 * A malformed override does NOT silently fall back to a stale catalogue and
 * pretend all is well — it says so and then falls back, because an operator who
 * edited a file and saw no effect has no way to find out otherwise.
 *
 * Two notes that lived as comments inside the old array, kept because they are
 * not obvious from the data:
 *   - `hello-ext` and `hello-ext-worker` are smoke fixtures used by the release
 *     binary job. Studio filters category `fixture` out of the marketplace UI;
 *     install/enable through the API works because the catalog decides.
 *   - Entries carry no `publisher_tier`, so `resolvePublisherTier` falls back to
 *     `is_official`, and a local entry with neither is treated as community —
 *     which means worker isolation is required for it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import bundled from './catalog.json' with { type: 'json' };

interface CatalogFile {
  catalog_version?: string;
  entries: ExtensionCatalogEntry[];
}

function isEntry(v: unknown): v is ExtensionCatalogEntry {
  const e = v as Partial<ExtensionCatalogEntry> | null;
  return (
    !!e &&
    typeof e.name === 'string' &&
    e.name !== '' &&
    typeof e.displayName === 'string' &&
    typeof e.category === 'string' &&
    typeof e.version === 'string'
  );
}

function readOverride(path: string): ExtensionCatalogEntry[] | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CatalogFile;
    const entries = parsed?.entries;
    if (!Array.isArray(entries) || !entries.every(isEntry)) {
      console.warn(
        `[extension-catalog] ${path} is not a catalog file (expected { entries: [...] } ` +
          'with name/displayName/category/version on each) — using the bundled catalog.',
      );
      return null;
    }
    return entries;
  } catch (err) {
    console.warn(
      `[extension-catalog] ${path} could not be read — using the bundled catalog:`,
      (err as Error).message,
    );
    return null;
  }
}

let _cached: ExtensionCatalogEntry[] | null = null;

/** Reset the resolved catalog. Tests use it; nothing else should need to. */
export function _resetCatalogForTests(): void {
  _cached = null;
}

/**
 * The catalogue this instance offers. Resolved once, from the first source that
 * yields a usable file.
 */
export function getExtensionCatalog(): ExtensionCatalogEntry[] {
  if (_cached) return _cached;

  const candidates: string[] = [];
  const fromEnv = process.env.ZVELTIO_CATALOG_PATH;
  if (fromEnv) candidates.push(fromEnv);
  const extDir = process.env.EXTENSIONS_DIR;
  if (extDir) candidates.push(join(extDir, 'catalog.json'));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const entries = readOverride(path);
    if (entries) {
      _cached = entries;
      return _cached;
    }
  }

  _cached = (bundled as CatalogFile).entries;
  return _cached;
}

/** Which catalogue the bundled copy is. Shown at boot so an operator can tell
 *  whether an override took effect. */
export const BUNDLED_CATALOG_VERSION = (bundled as CatalogFile).catalog_version ?? 'unknown';

/**
 * Back-compatible view. Kept as a getter rather than an array so an override is
 * picked up by every existing reader without touching it.
 */
export const EXTENSION_CATALOG: ExtensionCatalogEntry[] = new Proxy([] as ExtensionCatalogEntry[], {
  get(_t, prop, recv) {
    return Reflect.get(getExtensionCatalog(), prop, recv);
  },
  has(_t, prop) {
    return Reflect.has(getExtensionCatalog(), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(getExtensionCatalog());
  },
  getOwnPropertyDescriptor(_t, prop) {
    return Reflect.getOwnPropertyDescriptor(getExtensionCatalog(), prop);
  },
});
