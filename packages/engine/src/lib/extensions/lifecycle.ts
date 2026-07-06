/**
 * Extension lifecycle operations for `ExtensionLoader` (H-04 split).
 *
 * `unloadExtension`, `loadDynamic`, and `reloadExtensionFromDisk` are the
 * imperative lifecycle methods extracted out of the loader class. They mutate
 * loader state (`loaded`, `modules`, `lastLoadError`) and call loader methods
 * (`loadExtension`, `isActive`), so they take the `ExtensionLoader` instance via
 * a TYPE-ONLY import (no runtime cycle). The loader keeps thin delegating
 * methods so the external call sites (`extensionLoader.unload`,
 * `.loadDynamic`, `.reloadExtensionFromDisk`, and the dev-reload endpoint) are
 * unchanged.
 *
 * `reloadExtensionFromDisk` calls the module-private `triggerReload` that still
 * lives in `extension-loader.ts`; it is passed in as a parameter to avoid
 * importing loader-module runtime state. Every `console.*` string, error
 * message, branch order, and state write is byte-identical to the pre-split
 * inline code — zero behaviour change.
 */

import { auditLog } from '../audit.js';
import { serviceRegistry } from '../service-registry.js';
import { queryAlterRegistry } from '../data/index.js';
import { entityAccessRegistry } from '../entity-access.js';
import { cronRunner } from '../runtime/index.js';
import { resolveExtensionsBase } from '../extension-paths.js';
import type { Hono } from 'hono';
import type { ExtensionLoader } from '../extension-loader.js';

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
export async function unloadExtension(
  loader: ExtensionLoader,
  name: string,
): Promise<{ unloaded: boolean; needs_restart: boolean; message: string }> {
  const ext = loader.loaded.get(name);
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

  loader.loaded.delete(name);
  console.log(`🔌 Extension unloaded from memory: ${name}`);

  // Audit trail — record unload (system-triggered; userId omitted to
  // avoid FK violation against 'user' table)
  if (loader.ctx) {
    auditLog(loader.ctx.db, {
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

export async function loadDynamic(loader: ExtensionLoader, name: string, app: Hono): Promise<void> {
  if (!loader.ctx) throw new Error('ExtensionLoader not initialized — call loadAll() first');
  loader.lastLoadError.delete(name);
  await loader.loadExtension(name, app, loader.ctx);
  // loadExtension returns void on silent failure (files not found, bad manifest, etc.)
  // Verify the extension actually landed in this.loaded before declaring success.
  if (!loader.isActive(name)) {
    const realError = loader.lastLoadError.get(name);
    const extBase = resolveExtensionsBase();
    const fallback = `engine/index.ts not found at ${extBase}/${name}/. Ensure EXTENSIONS_DIR is set and the extension package is deployed.`;
    throw new Error(realError ?? fallback);
  }
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
export async function reloadExtensionFromDisk(
  loader: ExtensionLoader,
  name: string,
  triggerReload: (reason: string) => Promise<void>,
): Promise<{ ok: boolean; error?: string }> {
  if (!loader.modules.has(name) && !loader.loaded.has(name)) {
    return {
      ok: false,
      error: `extension "${name}" is not currently loaded — restart the engine first`,
    };
  }
  loader.modules.delete(name);
  loader.loaded.delete(name);
  loader.lastLoadError.delete(name);
  serviceRegistry.unregisterAll(name);
  queryAlterRegistry.unregisterAll(name);
  entityAccessRegistry.unregisterAll(name);
  cronRunner.unregisterAll(name);
  await triggerReload(`dev-reload:${name}`);
  if (loader.lastLoadError.has(name)) {
    return { ok: false, error: loader.lastLoadError.get(name)! };
  }
  return loader.isActive(name)
    ? { ok: true }
    : { ok: false, error: 'extension failed to load — check engine logs' };
}
