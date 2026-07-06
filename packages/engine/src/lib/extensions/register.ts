/**
 * Route-registration core for `ExtensionLoader` (H-04 split).
 *
 * Two dense areas of the loader BOTH build a `restrictedCtx` and register an
 * extension's routes: the tail of `loadExtension` (first load) and
 * `reRegisterExtension` (hot-reload rebuild). This module extracts the shared
 * machinery — `buildRestrictedContext()` + `registerExtensionRoutes()` — plus
 * the two orchestrators that use them (`finalizeExtensionLoad`,
 * `reRegisterExtension`), removing the biggest duplication in the loader.
 *
 * The orchestrators need loader state (`modules`, `loaded`, `lastLoadError`,
 * `ctx`, `runExtensionMigrations`). They take the `ExtensionLoader` instance via
 * a TYPE-ONLY import (no runtime cycle); the loader keeps thin delegating
 * methods so call sites are unchanged. Every `console.*` string, error message,
 * branch order, and `this.*` state write is byte-identical to the pre-split
 * inline code — zero behaviour change.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Database } from '../../db/index.js';
import { auditLog } from '../audit.js';
import { checkPermission, getUserRoles } from '../permissions.js';
import { DDLManager } from '../data/index.js';
import { createRestrictedDb } from '../extension-context.js';
import { serviceRegistry } from '../service-registry.js';
import { queryAlterRegistry } from '../data/index.js';
import { entityAccessRegistry } from '../entity-access.js';
import { cronRunner } from '../runtime/index.js';
import type { ExtensionSchedule, ZveltioExtension } from '@zveltio/sdk/extension';
import { getWorkerHost as _getWorkerHost } from '../worker-extension-host.js';
import type { ExtensionManifest } from './manifest-schema.js';
import type { ExtensionContext } from './internals.js';
import type { ExtensionLoader } from '../extension-loader.js';

/**
 * A Hono route-registration method (`app.get`/`post`/…). Used for the dynamic
 * `app[method]` dispatch in `registerPublicRoute`, where the method name is only
 * known at runtime from the extension's spec.
 */
export type HonoRouteFn = (
  path: string,
  handler: (c: Context) => Response | Promise<Response>,
) => unknown;

// ── Extension table access helpers ───────────────────────────────────────────
// Some extensions access specific core engine tables that fall outside their
// auto-detected `zv_{extname}_*` namespace. Declare those grants here so the
// RestrictedDb proxy allows them through.
export const EXTENSION_TABLE_GRANTS: Record<string, string[]> = {
  'content/drafts': ['zv_revisions'],
  'developer/validation': ['zv_validation_rules'],
};

export async function buildAllowedTables(migrationPaths: string[]): Promise<Set<string>> {
  const tables = new Set<string>();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
  for (const p of migrationPaths) {
    try {
      const content = await Bun.file(p).text();
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(content)) !== null) tables.add(m[1]);
    } catch {
      /* skip unreadable files */
    }
  }
  return tables;
}

/**
 * Build the per-extension `restrictedCtx` handed to `extension.register()`.
 *
 * Shared by first-load (`finalizeExtensionLoad`) and hot-reload
 * (`reRegisterExtension`). The only difference between the two call sites is
 * whether the `registerPublicRoute` escape hatch logs a success line on each
 * mounted route (first-load does, hot-reload does not) — controlled by
 * `logPublicRoute`. Everything else is identical.
 */
export function buildRestrictedContext(
  ctx: ExtensionContext,
  extName: string,
  app: Hono,
  allowedTables: Set<string> | undefined,
  logPublicRoute: boolean,
): ExtensionContext {
  return {
    ...ctx,
    db: createRestrictedDb(ctx.db, extName, allowedTables),
    // Per-request tenant-scoped DB: the request's tenant transaction (so
    // FORCE-RLS'd rows are visible + isolated), wrapped in the same table
    // guard. Data-touching extension handlers MUST use ctx.reqDb(c); ctx.db
    // (global pool) bypasses tenant isolation. See MULTI-TENANT-ENABLEMENT §5.
    reqDb: (c: Context) =>
      createRestrictedDb(
        (c?.get?.('tenantTrx') as Database | null) ?? ctx.db,
        extName,
        allowedTables,
      ),
    checkPermission: ctx.checkPermission ?? checkPermission,
    getUserRoles: ctx.getUserRoles ?? getUserRoles,
    DDLManager: ctx.DDLManager ?? DDLManager,
    // Hand each extension a scoped view of the registry so its register()
    // calls are tagged for cleanup on unload. Idempotent on hot-reload.
    services: serviceRegistry.scope(extName),
    queryAlter: queryAlterRegistry.scope(extName),
    entityAccess: entityAccessRegistry.scope(extName),
    // Escape hatch: extensions on `mountStrategy: 'subapp'` may need a few
    // routes outside the `/ext/<name>/` namespace (public CDN links, dynamic
    // user-deployed endpoints). registerPublicRoute mounts them on the
    // global `app` directly. They disappear on the next rebuild like every
    // other extension route, so disable still works correctly.
    registerPublicRoute: (spec) => {
      const m = (spec.method ?? 'GET').toLowerCase() as Lowercase<typeof spec.method>;
      const fn = (app as unknown as Record<string, HonoRouteFn | undefined>)[m];
      if (typeof fn !== 'function') {
        console.warn(
          `[extension-loader] ${extName} requested unsupported HTTP method "${spec.method}" — skipped`,
        );
        return;
      }
      try {
        fn.call(app, spec.path, spec.handler);
        if (logPublicRoute) {
          console.log(
            `🛣️  Extension "${extName}" registered public route: ${spec.method} ${spec.path}`,
          );
        }
      } catch (err) {
        console.warn(
          `[extension-loader] ${extName} public route ${spec.method} ${spec.path} failed:`,
          (err as Error).message,
        );
      }
    },
    internals: ctx.internals,
  };
}

/**
 * Mount an extension's routes according to its `mountStrategy` / worker
 * isolation. Shared by first-load and hot-reload. Worker isolation only applies
 * on first load (`manifest` present); hot-reload passes `manifest = null` so it
 * never takes the worker branch.
 */
async function registerExtensionRoutes(
  extension: ZveltioExtension,
  restrictedCtx: ExtensionContext,
  app: Hono,
  extName: string,
  extDir: string,
  manifest: ExtensionManifest | null,
): Promise<void> {
  const mountStrategy = extension.mountStrategy ?? 'global';
  const workerIsolation =
    manifest?.engine?.isolation === 'worker' && manifest?.engine?.bundled === true;
  if (workerIsolation) {
    const host = _getWorkerHost(app);
    await host.start(extName, extDir, manifest!.engine!.entry);
  } else if (mountStrategy === 'subapp') {
    const subApp = new Hono();
    await extension.register(subApp, restrictedCtx);
    app.route(`/ext/${extName}`, subApp);
  } else {
    await extension.register(app, restrictedCtx);
  }
}

/**
 * The register-core of `loadExtension`, run after the module is imported,
 * migrations + field types are done, and the allowed-tables set is built:
 * build `restrictedCtx`, register routes (worker/subapp/global with the
 * matcher-already-built swallow), register cron schedules, capture the loaded
 * entry + cleanup, and write the success audit log.
 *
 * Kept together so the state writes (`loader.modules` was already set by the
 * caller; here `loader.loaded`) happen in the same order with the same values
 * as the pre-split inline code.
 */
export async function finalizeExtensionLoad(
  loader: ExtensionLoader,
  extension: ZveltioExtension,
  extName: string,
  extDir: string,
  app: Hono,
  ctx: ExtensionContext,
  manifest: ExtensionManifest | null,
  allowedTables: Set<string>,
): Promise<void> {
  // Pass a RestrictedDb proxy — extensions cannot query zv_* system tables.
  // Also inject the full public API (checkPermission, auth, DDLManager…) and
  // ctx.internals.* so extensions never have to relative-import engine modules.
  const restrictedCtx = buildRestrictedContext(ctx, extName, app, allowedTables, true);

  // Register routes — if the live app's Hono matcher is already built (happens
  // after the first request during hot-load), swallow that specific error and
  // still mark the extension as loaded. triggerReload() will rebuild a fresh
  // Hono app where routes register correctly.
  //
  // S3-01: extensions with `mountStrategy: 'subapp'` get a fresh per-extension
  // Hono instance; the engine mounts it at `/ext/<name>`. Disable simply
  // drops the sub-app on the next app rebuild — no orphan routes.
  // The default 'global' path remains unchanged for backward compatibility.
  //
  // C-minimal worker isolation (manifest.engine.isolation === 'worker'):
  // delegate register() to WorkerExtensionHost. The worker spawns,
  // re-imports the SAME bundle, and runs register() in its own thread.
  // Migrations + field types + services etc. already ran in this main
  // thread above. Worker is responsible only for serving routes.
  let routeRegistrationDeferred = false;
  try {
    await registerExtensionRoutes(extension, restrictedCtx, app, extName, extDir, manifest);
  } catch (regErr: unknown) {
    if ((regErr as Error)?.message?.includes('matcher is already built')) {
      routeRegistrationDeferred = true;
    } else {
      throw regErr;
    }
  }

  // Register native schedules. Failure here is non-fatal — log and
  // continue so the extension is otherwise functional.
  if (typeof extension.schedules === 'function') {
    try {
      const schedules = extension.schedules() ?? [];
      for (const s of schedules) {
        cronRunner.register(extName, s as ExtensionSchedule);
      }
      if (schedules.length > 0) {
        console.log(`⏰ Extension "${extName}" registered ${schedules.length} schedule(s)`);
      }
    } catch (err) {
      console.warn(
        `[cron-runner] failed to read schedules() for "${extName}":`,
        (err as Error).message,
      );
    }
  }

  loader.loaded.set(extName, {
    name: extName,
    cleanup:
      typeof extension.cleanup === 'function' ? extension.cleanup.bind(extension) : undefined,
    registeredRoutes: true,
    allowedTables,
  });
  console.log(`🔌 Extension loaded: ${extName}`);

  // Audit trail — record successful load. No userId: system events
  // are tracked by event type, and 'system' is not a real user id —
  // setting it triggers the zv_audit_log_user_id_fkey FK violation.
  auditLog(ctx.db, {
    type: 'extension.loaded',
    resourceId: extName,
    resourceType: 'extension',
    metadata: { version: extension.name, actor: 'system' },
  }).catch((err: Error) => {
    console.error('[extension-loader] audit log failed:', err.message);
  });
}

/**
 * Re-register a loaded extension's routes onto a fresh Hono app.
 * Used by buildHonoApp() during hot-reload — does NOT re-run migrations or npm installs.
 * Safe to call multiple times: only registers routes, no side effects.
 */
export async function reRegisterExtension(
  loader: ExtensionLoader,
  name: string,
  app: Hono,
): Promise<void> {
  const extension = loader.modules.get(name);
  if (!extension || !loader.ctx) return;

  const allowedTables = loader.loaded.get(name)?.allowedTables;
  const restrictedCtx = buildRestrictedContext(loader.ctx, name, app, allowedTables, false);

  try {
    await registerExtensionRoutes(extension, restrictedCtx, app, name, '', null);

    // Re-register schedules on hot-reload. unregisterAll is idempotent and
    // we want the new definitions to win.
    cronRunner.unregisterAll(name);
    if (typeof extension.schedules === 'function') {
      try {
        for (const s of extension.schedules() ?? []) {
          cronRunner.register(name, s as ExtensionSchedule);
        }
      } catch (err) {
        console.warn(
          `[cron-runner] schedules() threw on hot-reload of "${name}":`,
          (err as Error).message,
        );
      }
    }
  } catch (err) {
    console.error(`❌ Hot-reload: failed to re-register extension "${name}":`, err);
  }
}
