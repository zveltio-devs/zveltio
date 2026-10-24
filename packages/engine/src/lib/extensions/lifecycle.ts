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
import { clearExtensionBroadcasts } from './broadcast.js';
import { auditLog } from '../audit.js';
import { serviceRegistry } from '../service-registry.js';
import { queryAlterRegistry } from '../data/index.js';
import { entityAccessRegistry } from '../tenancy/index.js';
import { cronRunner } from '../runtime/index.js';
import { unregisterExtensionPublicRoutes } from '../../middleware/extension-auth-gate.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkExtensionDependencies } from '../version-checker.js';
import { getWorkerHostIfInitialized } from '../worker-extension-host.js';
import {
  extensionFilesPresent,
  invalidateFilesPresent,
  resolveExtensionsBase,
} from './extension-paths.js';
import {
  downloadExtension,
  fetchRegistryCatalog,
  stageExtensionDir,
  type StagedExtension,
} from './extension-download.js';
import { getLicenseKey } from './extension-license.js';
import { checkRevoked, revocationCheckRequired, revocationMessage } from './revocations.js';
import type { Database } from '../../db/index.js';
import { invalidateActivationCache } from './activation.js';
import { withExtensionLock } from './extension-utils.js';
import { isPendingMigrationsRefusal } from './migration-runner.js';
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
  clearExtensionBroadcasts(name);
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

export async function loadDynamic(
  loader: ExtensionLoader,
  name: string,
  app: Hono,
  /** False when only a firm's row asks for the load: pending migrations refuse it. */
  migrate = true,
): Promise<void> {
  if (!loader.ctx) throw new Error('ExtensionLoader not initialized — call loadAll() first');
  loader.lastLoadError.delete(name);
  await loader.loadExtension(name, app, loader.ctx, undefined, migrate);
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
 * `name`'s registry rows changed (enable, disable, uninstall, a firm's activate
 * or deactivate, here or on another replica): bring this replica's copy in line.
 * The code is loaded while ANY row is enabled — a firm's row overrides god's on
 * or off (activation.ts), so god's default being off does not stop the firm that
 * turned it on; boot (`loadFromDB`) asks the same. Loads the way an enable does
 * (migrations already on record are skipped; with god's row off, any pending one
 * refuses the load, since migrations are god's decision) or unloads the way a disable does,
 * then rebuilds the served app. A no-op when this replica is already there, its
 * own announcement included.
 *
 * Under the extension lock, so it waits for the other replica's operation to
 * finish and reads what that one committed. Answers why a load it attempted
 * was refused, if it was.
 */
export async function syncWithRegistry(
  loader: ExtensionLoader,
  name: string,
  triggerReload: (reason: string) => Promise<void>,
): Promise<string | undefined> {
  const db = loader.ctx?.db;
  if (!db) return;
  return withExtensionLock(db, name, async (): Promise<string | undefined> => {
    const rows = await db
      .selectFrom('zv_extension_registry')
      .select(['tenant_id', 'is_enabled', 'version', 'installed_version', 'installed_sha256'])
      .where('name', '=', name)
      .execute();
    const wanted = rows.some((r) => r.is_enabled);
    // God's row holds the version and digest on record, whoever turned it on.
    const row = rows.find((r) => r.tenant_id === null);
    const godOn = row?.is_enabled === true;
    const extBase = resolveExtensionsBase();
    const extDir = join(extBase, name);
    invalidateActivationCache(name);
    invalidateFilesPresent(extDir);
    // Another replica updated it (POST /update): this disk still holds the version before.
    const behind = wanted && row !== undefined && bundleBehindRecord(extDir, row);
    // Loaded, but another version is on disk now: reload it, as boot would.
    const stale = wanted && (behind || loadedVersionStale(loader, name));
    if (wanted === loader.isActive(name) && !stale) return;
    if (wanted) {
      let unloaded = false;
      let staged: StagedExtension | null = null;
      try {
        // Fetched before the unload: a bundle that fails a check leaves the old one running.
        if (row && (behind || !extensionFilesPresent(extDir)))
          staged = await fetchEnabledBundle(db, name, extBase, row);
        // Unloaded before the swap: the old code never runs over the new files.
        if (staged ? loader.isActive(name) : loadedVersionStale(loader, name)) {
          await unloadExtension(loader, name);
          unloaded = true;
        }
        staged?.swap();
        invalidateFilesPresent(extDir);
        // Routes land on a throwaway app, as at boot: the rebuild below mounts them.
        // Only god's row may run migrations; a firm's alone loads with none pending.
        await loadDynamic(loader, name, new Hono(), godOn);
      } catch (err) {
        const why = (err as Error).message;
        // The new version does not load here: the old one comes back, as on the
        // replica that ran the update. Its migrations are on record already.
        if (staged) {
          try {
            staged.rollback();
            invalidateFilesPresent(extDir);
            if (unloaded) await loadDynamic(loader, name, new Hono(), godOn);
          } catch (e) {
            console.error(`[extensions] "${name}": the previous version did not come back:`, e);
          }
        }
        // The originating replica recorded its own outcome; this one only says why
        // here. A refusal for a firm's row has no god route behind it to record it.
        console.warn(`[extensions] "${name}" enabled elsewhere, not loaded here:`, why);
        if (isPendingMigrationsRefusal(why)) {
          await db
            .updateTable('zv_extension_registry')
            .set({ last_load_error: why, last_load_at: new Date() })
            .where('name', '=', name)
            .execute()
            .catch(() => {});
        }
        // Unloaded above for the version it now refuses: the rebuild drops the old
        // routes, or mounts the old version put back.
        if (unloaded) await triggerReload(`disable-elsewhere:${name}`);
        return why;
      }
      try {
        staged?.commit();
      } catch (e) {
        console.warn(`[extensions] "${name}": the previous version's files were not removed:`, e);
      }
    } else {
      await unloadExtension(loader, name);
    }
    await triggerReload(`${wanted ? 'enable' : 'disable'}-elsewhere:${name}`);
  });
}

/**
 * `name` is loaded, but the manifest on disk names another version: someone put
 * a newer bundle there while it ran. An enable or a sync that sees it active must
 * still load that one, or the old code keeps running and the new migrations
 * wait for the next boot.
 */
export function loadedVersionStale(loader: ExtensionLoader, name: string): boolean {
  const loaded = loader.loaded.get(name);
  if (!loaded) return false;
  const dir = loader.extDirs.get(name) ?? join(resolveExtensionsBase(), name);
  try {
    const { version } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    return typeof version === 'string' && version !== loaded.version;
  } catch {
    return false; // no manifest to compare: nothing says it moved
  }
}

/**
 * The registry row records a NEWER version than the manifest in `dir`: another
 * replica updated the extension (POST /api/marketplace/<name>/update) onto its
 * own disk. Only newer: a version on disk ahead of the record was put there by
 * hand (EXTENSIONS_DIR, a dev checkout) and is not overwritten from the registry.
 */
export function bundleBehindRecord(
  dir: string,
  row: { installed_version: string | null },
): boolean {
  if (!row.installed_version) return false; // never downloaded: nothing on record to fetch
  try {
    const { version } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    return typeof version === 'string' && Bun.semver.order(row.installed_version, version) > 0;
  } catch {
    return false; // no manifest (fetched when the files are missing) or not semver
  }
}

/**
 * `name` is enabled (for the instance or a firm) but its bundle is not on this
 * replica's disk, or is behind the version on record (`bundleBehindRecord`):
 * the replica that installed it downloaded it onto its own, and the extensions
 * directory is not a shared volume. Fetch the version on record from the
 * registry through the install path's `downloadExtension`, which refuses before
 * extracting anything when the bytes miss the digest pinned at install, the
 * registry's declared SHA-256 or the Ed25519 signature.
 *
 * The registry serves only an extension's current version, so one that has
 * moved on is refused rather than loaded in place of what the others run.
 *
 * Also called at boot (`loadFromDB`): a replica that restarts or scales out
 * after the enable has the same empty disk.
 *
 * Answers the staged bundle when an older one is on disk (the caller swaps it in
 * once the old code is unloaded, and commits or rolls back), null when it
 * downloaded straight into the empty directory.
 */
export async function fetchEnabledBundle(
  db: Database,
  name: string,
  extBase: string,
  row: {
    version: string | null;
    installed_version: string | null;
    installed_sha256: string | null;
  },
): Promise<StagedExtension | null> {
  const version = row.installed_version ?? row.version;
  if (!version) throw new Error('bundle not on disk and no installed version on record to fetch');
  // The registry must answer: with it down, the catalog baked into this binary would vouch for the version.
  const entry = (await fetchRegistryCatalog({ requireRemote: true })).find((e) => e.name === name);
  if (!entry) throw new Error('bundle not on disk and not in the registry catalog');
  if (entry.version !== version) {
    throw new Error(
      `bundle not on disk; the registry serves ${entry.version}, the version enabled is ${version}`,
    );
  }
  // As install does, before any bytes are fetched: revoked since its enable, the
  // load would refuse it, but the extracted files would stay for a later boot
  // whose revocation list is unreachable (fail-open) to load.
  const verdict = await checkRevoked(name, version);
  if (verdict.revoked && verdict.entry)
    throw new Error(revocationMessage(name, version, verdict.entry));
  if (verdict.unknown && revocationCheckRequired()) {
    throw new Error(
      'bundle not on disk; cannot verify it is not revoked (registry unreachable, ZVELTIO_REQUIRE_REVOCATION_CHECK set)',
    );
  }
  // The digest the update (or install) recorded for this version: other bytes are refused.
  const pin = row.installed_version === version ? row.installed_sha256 : null;
  const key = await getLicenseKey(db, name);
  const dir = join(extBase, name);
  // An older version is here, perhaps loaded: staged beside it for the caller to swap.
  if (extensionFilesPresent(dir))
    return stageExtensionDir(entry, extBase, (b) => downloadExtension(entry, b, key, pin));
  await downloadExtension(entry, extBase, key, pin);
  invalidateFilesPresent(dir);
  return null;
}

/**
 * After a bus outage: every extension the registry knows, for a change
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
  const rows = await db.selectFrom('zv_extension_registry').select(['name']).distinct().execute();
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
  // Under the extension lock, as every other load: never halfway through an update's swap.
  const db = loader.ctx?.db;
  const run = () => reloadUnlocked(loader, name, app, triggerReload);
  return db ? withExtensionLock(db, name, run) : run();
}

async function reloadUnlocked(
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
