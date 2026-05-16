/**
 * Loads extension Studio bundles into the running Studio (S3-02 + S3-03
 * enabling infrastructure).
 *
 * Today's contract:
 *
 *   1. Engine exposes `GET /api/extensions` returning `{ bundles: [{ name,
 *      url }] }` (already implemented in `packages/engine/src/index.ts`).
 *   2. Each bundle is an IIFE built by the extension's
 *      `studio/vite.config.ts` (`formats: ['iife']`). On execution it
 *      reads `window.__zveltio` and calls `registerRoute` /
 *      `registerSlot` / `registerFormAlter` to contribute to Studio.
 *   3. This loader fetches each bundle URL, evaluates it via dynamic
 *      blob-URL import, and surfaces errors per bundle so one bad
 *      extension can't kill the rest.
 *
 * Why blob URLs instead of `<script src>` tags:
 *   - Same-origin requirement: bundles live at `/ext/<name>/bundle.js` on
 *     the engine, but Studio in dev mode runs at 5173. Adding `<script
 *     src="http://localhost:3000/...">` works but pollutes the global
 *     scope with one tag per extension and is hard to clean up on HMR.
 *   - Blob URLs let us treat the bundle as data + run it once.
 *
 * Failure mode: a bundle that throws is logged and skipped. The other
 * bundles still run. Console message includes the extension name so
 * developers can spot the offender.
 */

import { ENGINE_URL } from './config.js';
import { installGlobalApi } from './extension-api.svelte.js';

interface EngineExtensionsResponse {
  extensions?: string[];
  bundles?: Array<{ name: string; url: string }>;
  meta?: unknown[];
}

let _loaded = false;
let _activeBlobUrls: string[] = [];

/**
 * Idempotent: safe to call from `onMount` of the admin layout. Returns
 * the count of bundles loaded successfully (for diagnostics + tests).
 */
export async function loadExtensionBundles(): Promise<{ loaded: number; failed: string[] }> {
  if (typeof window === 'undefined') return { loaded: 0, failed: [] };

  // Set up the global ONCE before any bundle runs.
  installGlobalApi(ENGINE_URL);

  if (_loaded) return { loaded: 0, failed: [] };
  _loaded = true;

  let payload: EngineExtensionsResponse;
  try {
    const res = await fetch(`${ENGINE_URL}/api/extensions`, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = (await res.json()) as EngineExtensionsResponse;
  } catch (err) {
    console.warn('[bundle-loader] /api/extensions fetch failed; skipping bundle load:', (err as Error).message);
    return { loaded: 0, failed: [] };
  }

  const bundles = payload.bundles ?? [];
  let loaded = 0;
  const failed: string[] = [];

  for (const { name, url } of bundles) {
    const fullUrl = url.startsWith('http') ? url : `${ENGINE_URL}${url}`;
    try {
      const res = await fetch(fullUrl, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${fullUrl}`);
      const code = await res.text();
      // Wrap in blob → dynamic import. The bundle runs in its own module
      // scope so its top-level `var`s don't pollute Studio's globals.
      const blob = new Blob([code], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      _activeBlobUrls.push(blobUrl);
      // Vite + ESM-mode browsers accept blob: URLs for dynamic import.
      // The extension's IIFE bundle self-invokes on load.
      await import(/* @vite-ignore */ blobUrl);
      loaded++;
    } catch (err) {
      console.error(`[bundle-loader] ${name} failed to load:`, (err as Error).message);
      failed.push(name);
    }
  }

  console.log(`[bundle-loader] ${loaded} extension Studio bundle(s) loaded${failed.length ? `, ${failed.length} failed` : ''}`);
  return { loaded, failed };
}

/** Test-only: revoke blob URLs + reset state. */
export function _resetForTests(): void {
  for (const u of _activeBlobUrls) {
    try { URL.revokeObjectURL(u); } catch { /* */ }
  }
  _activeBlobUrls = [];
  _loaded = false;
}
