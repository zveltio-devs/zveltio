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

import { unregisterExtensionListeners } from './register.js';
import { auditLog } from '../audit.js';
import { serviceRegistry } from '../service-registry.js';
import { queryAlterRegistry } from '../data/index.js';
import { entityAccessRegistry } from '../tenancy/index.js';
import { cronRunner } from '../runtime/index.js';
import { unregisterExtensionPublicRoutes } from '../../middleware/extension-auth-gate.js';
import { join } from 'node:path';
import { checkExtensionDependencies } from '../version-checker.js';
import { getWorkerHostIfInitialized } from '../worker-extension-host.js';
import { invalidateFilesPresent, resolveExtensionsBase } from './extension-paths.js';
import { invalidateActivationCache } from './activation.js';
import { withExtensionLock } from './extension-utils.js';
import { Hono } from 'hono';
import type { ExtensionLoader } from './extension-loader.js';
import { unregisterJobs } from './jobs.js';

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

  // End the worker process, for extensions that have one.
  //
  // Unloading dropped every main-thread trace of the extension — services,
  // query alters, cron — and left its worker running. That worker is the whole
  // isolation story for community-tier extensions: it holds the SQL bridge and
  // its own timers, so a "disabled" third-party extension kept querying the
  // database. `stop()` has existed on the host since workers were introduced;
  // nothing called it.
  //
  // Done first so the worker cannot issue further bridge calls while the
  // registries below are being torn down. Deliberately best-effort: an
  // extension that fails to stop must still be removed from memory, or a
  // wedged worker would make it impossible to disable anything.
  try {
    const { getWorkerHostIfInitialized } = await import('../worker-extension-host.js');
    const host = getWorkerHostIfInitialized();
    if (host?.isRunning(name)) {
      await host.stop(name);
      console.log(`🔌 Extension "${name}" worker terminated.`);
    }
  } catch (err) {
    console.error(`🔌 Extension "${name}" worker failed to stop:`, err);
  }

  // Remove all services this extension published. Without this, hot-reload
  // would throw on duplicate name when the extension is re-enabled.
  serviceRegistry.unregisterAll(name);

  // Drop the extension's public-route patterns.
  //
  // `unregisterExtensionPublicRoutes` was written for exactly this moment,
  // exported, and documented "on unload" — and called from nowhere. The
  // patterns it holds are what the `/ext/*` gate consults to decide which
  // paths skip authentication, so an unloaded extension left its exemptions
  // behind for the lifetime of the process. A helper that names the moment it
  // is for and is never invoked at that moment reads, to anyone auditing, as
  // the cleanup having been done.
  unregisterExtensionPublicRoutes(name);
  // Drop the extension's query alters so post-unload selects don't keep
  // applying its filters.
  queryAlterRegistry.unregisterAll(name);

  // Event listeners, for the same reason as the services above: without this,
  // a reloaded extension's handlers accumulate and one event runs them all.
  const droppedListeners = unregisterExtensionListeners(name);
  if (droppedListeners > 0) {
    console.log(`🔌 Extension "${name}": removed ${droppedListeners} event listener(s).`);
  }
  // Drop the extension's entity-access checks too, for the same reason.
  entityAccessRegistry.unregisterAll(name);
  // Drop the extension's scheduled tasks so the runner stops invoking them.
  cronRunner.unregisterAll(name);
  // And its job workers: a queued job waits for the extension to load again.
  await unregisterJobs(name);

  loader.loaded.delete(name);
  loader.forgetExtensionMessages(name);
  console.log(`🔌 Extension unloaded from memory: ${name}`);

  // Audit trail — record unload (system-triggered; userId omitted to
  // avoid FK violation against 'user' table)
  if (loader.ctx) {
    auditLog(loader.ctx.db, {
      type: 'extension.unloaded',
      tenantId: null,
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
  await refreshTooOldDependents(loader, name);
}

/**
 * `name` has just loaded, perhaps at a newer version: a loaded extension that
 * found it below its optional `minVersion` asks again, so an upgrade reaches
 * it without reloading it. Its `serviceDeps` is the map its `ctx.services`
 * scope and the worker broker read, so marking the dependency callable there
 * is the whole change.
 */
async function refreshTooOldDependents(loader: ExtensionLoader, name: string): Promise<void> {
  const versions = new Map(Array.from(loader.loaded, ([n, l]) => [n, l.version]));
  for (const [dependent, entry] of loader.loaded) {
    const deps = entry.serviceDeps as Map<string, boolean> | undefined;
    const dir = loader.extDirs.get(dependent);
    if (deps?.get(name) !== false || !dir || !loader.ctx) continue;
    try {
      const manifest = JSON.parse(await Bun.file(join(dir, 'manifest.json')).text()) as {
        optionalDependencies?: Array<{ name: string; minVersion?: string }>;
      };
      const pin = manifest.optionalDependencies?.find((d) => d.name === name);
      if (!pin) continue;
      const { tooOld } = await checkExtensionDependencies(loader.ctx.db, [pin], versions);
      if (!tooOld.includes(name)) {
        deps.set(name, true);
        // A worker dependent answers `has()` from its own copy of the map.
        getWorkerHostIfInitialized()?.resyncServices();
      }
    } catch (err) {
      // Left absent, as at its load: the dependent's next reload asks again.
      console.warn(
        `[extensions] "${dependent}": could not re-check optional "${name}":`,
        (err as Error).message,
      );
    }
  }
}

/**
 * Another replica enabled, disabled or uninstalled `name`: bring this one's copy
 * in line with the registry's instance-wide row, which is what that replica's
 * route acted on. Loads the way its enable did (the migrations are on record
 * there, so none runs again) or unloads the way its disable did, then rebuilds
 * the served app. A no-op when this replica is already there, its own
 * announcement included.
 *
 * Under the extension lock, so it waits for the other replica's operation to
 * finish and reads what that one committed.
 */
export async function syncWithRegistry(
  loader: ExtensionLoader,
  name: string,
  triggerReload: (reason: string) => Promise<void>,
): Promise<void> {
  const db = loader.ctx?.db;
  if (!db) return;
  await withExtensionLock(db, name, async () => {
    const row = await db
      .selectFrom('zv_extension_registry')
      .select(['is_enabled'])
      .where('name', '=', name)
      .where('tenant_id', 'is', null)
      .executeTakeFirst();
    const wanted = row?.is_enabled === true;
    invalidateActivationCache(name);
    invalidateFilesPresent(join(resolveExtensionsBase(), name));
    if (wanted === loader.isActive(name)) return;
    if (wanted) {
      try {
        // Routes land on a throwaway app, as at boot: the rebuild below mounts them.
        await loadDynamic(loader, name, new Hono());
      } catch (err) {
        // The originating replica recorded its own outcome; this one only says why here.
        console.warn(
          `[extensions] "${name}" enabled elsewhere, not loaded here:`,
          (err as Error).message,
        );
        return;
      }
    } else {
      await unloadExtension(loader, name);
    }
    await triggerReload(`${wanted ? 'enable' : 'disable'}-elsewhere:${name}`);
  });
}

/**
 * After a bus outage: every extension with an instance-wide row, for a change
 * announced meanwhile.
 */
export async function syncAllWithRegistry(
  loader: ExtensionLoader,
  triggerReload: (reason: string) => Promise<void>,
): Promise<void> {
  const db = loader.ctx?.db;
  if (!db) return;
  // ponytail: an extension purged meanwhile has no row left to find, so this
  // replica keeps it loaded until it restarts; telling it apart from one loaded
  // from ZVELTIO_EXTENSIONS (no row either) needs the boot's load set.
  const rows = await db
    .selectFrom('zv_extension_registry')
    .select(['name'])
    .where('tenant_id', 'is', null)
    .execute();
  for (const { name } of rows) await syncWithRegistry(loader, name, triggerReload);
}

/**
 * Dev-only: drop the cached module + scoped state for `name`, re-import it
 * from disk onto the live app, then trigger a full app rebuild so the fresh
 * module is also wired into the next `_currentApp`. Returns the load status
 * so the `zveltio extension dev` watcher can surface failures back to the
 * developer's terminal instead of leaving the engine running on stale code.
 *
 * Scope-cleanup matches what `disable` does:
 *   - module cache, loaded map, lastLoadError
 *   - serviceRegistry, queryAlterRegistry, entityAccessRegistry
 *   - cronRunner schedules
 *
 * NOT cleaned (intentionally): migrations already applied. SQL changes
 * still require an explicit migration file — `runExtensionMigrations` skips
 * anything already recorded in `zv_migrations`.
 *
 * `triggerReload`'s callback (`buildHonoApp`) only RE-REGISTERS extensions
 * already present in `loader.loaded` via `reRegisterExtension`, which reads
 * from the cached module — it never imports anything from disk. Deleting
 * `name` from `loaded`/`modules` above and then only calling `triggerReload`
 * (the pre-fix behaviour) therefore dropped the extension instead of
 * reloading it: the rebuild would skip it entirely, `isActive(name)` would
 * stay false, and every dev-reload would report "extension failed to load"
 * with nothing actually attempted. `loadDynamic` — the same helper the
 * enable-extension route uses — performs the real disk import and mounts
 * routes directly onto `app` (the live, currently-served instance, captured
 * by the dev-reload endpoint's closure), which is what actually makes the
 * edited code live. `triggerReload` afterwards folds the now-fresh cached
 * module into the next full rebuild too, the same order the enable route
 * follows.
 */
export async function reloadExtensionFromDisk(
  loader: ExtensionLoader,
  name: string,
  app: Hono,
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
  loader.forgetExtensionMessages(name);
  serviceRegistry.unregisterAll(name);
  queryAlterRegistry.unregisterAll(name);
  entityAccessRegistry.unregisterAll(name);
  cronRunner.unregisterAll(name);
  try {
    await loadDynamic(loader, name, app);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  await triggerReload(`dev-reload:${name}`);
  if (loader.lastLoadError.has(name)) {
    return { ok: false, error: loader.lastLoadError.get(name)! };
  }
  return loader.isActive(name)
    ? { ok: true }
    : { ok: false, error: 'extension failed to load — check engine logs' };
}
