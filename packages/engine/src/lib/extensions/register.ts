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

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { tenantMiddleware } from '../../middleware/tenant.js';
import type { Context } from 'hono';
import type { Database } from '../../db/index.js';
import { auditLog } from '../audit.js';
import {
  checkPermission,
  getUserRoles,
  getCurrentTenantTrx,
  materializeDefaultGrants,
  registerSensitiveResources,
  describeDenial,
} from '../tenancy/index.js';
import { DDLManager } from '../data/index.js';
import { createRestrictedDb, createDeniedAdminDb } from './extension-context.js';
import {
  activationMiddlewareFor,
  guardListenerArgs,
  guardExtensionApp,
  guardPublicHandler,
  guardScheduleHandler,
} from './activation.js';
import { serviceRegistry } from '../service-registry.js';
import { clearExtensionHealthChecks, registerHealthCheck } from '../health-registry.js';
import { queryAlterRegistry } from '../data/index.js';
import { entityAccessRegistry } from '../tenancy/index.js';
import { cronRunner } from '../runtime/index.js';
import { registerExtensionPublicRoutes } from '../../middleware/extension-auth-gate.js';
import { problemOnError } from '../problem.js';
import type { ExtensionSchedule, ZveltioExtension } from '@zveltio/sdk/extension';
import { getWorkerHost as _getWorkerHost } from '../worker-extension-host.js';
import type { ExtensionManifest } from './manifest-schema.js';
import type { ExtensionContext } from './internals.js';
import { gateInternals } from './capabilities.js';
import { buildExtensionConfig } from './config.js';
import { readGranted, resolveCapabilities } from './consent.js';
import type { ExtensionLoader } from './extension-loader.js';

/**
 * A Hono route-registration method (`app.get`/`post`/…). Used for the dynamic
 * `app[method]` dispatch in `registerPublicRoute`, where the method name is only
 * known at runtime from the extension's spec.
 */
export type HonoRouteFn = (
  path: string,
  // Hono accepts any number of middlewares before the handler; public routes are
  // mounted with `tenantMiddleware` in front of theirs.
  // biome-ignore lint/suspicious/noExplicitAny: Hono's variadic handler signature
  ...handlers: any[]
) => unknown;

// ── Extension table access helpers ───────────────────────────────────────────
// Some extensions access specific core engine tables that fall outside their
// auto-detected `zv_{extname}_*` namespace. Declare those grants here so the
// RestrictedDb proxy allows them through.
export const EXTENSION_TABLE_GRANTS: Record<string, string[]> = {
  'content/drafts': [
    'zv_revisions',
    // Owned by this extension, but still present in the engine's 001_initial
    // from before the feature moved out. See the note below.
  ],
  'developer/validation': ['zv_validation_rules'],
  // ── Tables an extension owns that the engine also declares ──────────────
  //
  // Every case where an extension's migrations and the engine's create the same
  // table. `buildAllowedTables` refuses engine tables by default, so without an
  // entry here those extensions would lose access to their own data. Anything NOT
  // here — `zv_api_keys`, `zv_tenants`, `casbin_rule`, `session`, `user` — stays
  // refused, which is the point.
  //
  // No count is written down, deliberately: two have stood here and both went
  // stale. An entry goes inert the moment the engine stops declaring its table,
  // and a number in a comment cannot follow that.
  //
  // 22 inert names were removed once the engine's baseline stopped declaring
  // them. The rule that made each removal safe, and the one that has to hold for
  // the next: an entry may go only when THAT extension creates THAT table in its
  // own migrations, because then `buildAllowedTables` grants it unaided. Where it
  // does not, the entry is the only thing standing — `content/documents` reads
  // `zv_document_templates`, which `content/document-templates` creates, so its
  // grant stays and is the single cross-extension one left.
  //
  // `check:table-owners` reports which tables the engine still declares; that is
  // the list to check an entry against before deleting it.
  // `ai` relaxes a CHECK constraint on `zv_flows` so a flow can carry AI
  // trigger types. Measured, not assumed — it is the only extension that
  // reshapes an engine table it does not otherwise own.
  ai: ['zv_flows'],
  'analytics/quality': ['zv_quality_issues', 'zv_quality_scans'],
  // `zv_document_templates` is engine-declared and also redeclared by
  // `content/document-templates`; this extension reads the templates it
  // generates documents from. Two of its seven GET routes answered 500 without
  // this, `/templates` among them.
  'content/documents': ['zv_document_templates'],
  'content/media': [
    'zv_storage_quotas',
    // The media library's own tables. The engine declares them too because the
    // feature started there; the extension is what maintains them now, which
    // its migrations show and the runtime allowlist had already missed.
    'zv_media_files',
    'zv_media_folders',
    'zv_media_tags',
    'zv_media_file_tags',
  ],
  // `content/page-builder` and `content/portals` merged into `content/pages`.
  // The four `zvd_*` tables from portals are migrated into this set by the
  // extension's own migrations; what it owns now is the `zv_page*` family.
  // Edge functions are the ENGINE's: it owns the table, the sandbox, and the
  // `/api/fn` invoke route (which is why `/api/fn` was given back to it in
  // DEV-EF-1). This extension is the administration surface the Studio actually
  // calls — and it has no migrations of its own, so it owned nothing and the
  // table guard refused every query it made. `GET /ext/developer/edge-functions`
  // answered 500 with an ExtensionSecurityError on a fresh install: the page
  // that lists edge functions could not list them.
  'developer/edge-functions': ['zv_edge_functions', 'zv_edge_function_logs'],
  'data/import': ['zv_import_logs'],
  // The media library's tables, because `storage/cloud` is the other half of
  // that feature: it serves the bytes and validates the share tokens for files
  // `content/media` owns. All three are engine-declared (`001_initial.sql`,
  // plus `028_media_file_visibility.sql` for shares), so the table guard was
  // right to refuse them and the extension was right to need them — nobody had
  // written the grant.
  //
  // Measured cost of the omission: four of `storage/cloud`'s thirteen GET
  // routes answered 500, including `/files`, which is the extension's main
  // purpose. Shipped, and broken on every install since.
  'storage/cloud': ['zv_storage_quotas', 'zv_media_files', 'zv_media_folders', 'zv_media_shares'],
};

/**
 * Every table the ENGINE creates, read once from its own migration SQL.
 *
 * This is the list an extension must not be able to add itself to. Deriving it
 * from the same files the engine actually applies means it cannot drift: a
 * table added in migration 062 is protected the day it lands, with nothing to
 * remember to update here.
 */
let _engineTables: Set<string> | null = null;
export async function engineOwnedTables(): Promise<Set<string>> {
  if (_engineTables) return _engineTables;
  const tables = new Set<string>();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi;

  const collect = (content: string): void => {
    re.lastIndex = 0;
    for (const m of content.matchAll(re)) tables.add(m[1].toLowerCase());
  };

  // Source mode reads the .sql files; a compiled binary has no filesystem to
  // read them from and carries them as `EMBEDDED_MIGRATIONS` instead. Same
  // fork the migration runner makes — and getting it wrong here is not
  // cosmetic: the first release built after this landed refused to load ANY
  // extension, because `readdirSync` threw on a directory that does not exist
  // inside the binary and this function fails loud by design.
  const dir = join(import.meta.dir, '..', '..', 'db', 'migrations', 'sql');
  let readFromDisk = false;
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) collect(await Bun.file(join(dir, file)).text());
    readFromDisk = files.length > 0;
  } catch {
    /* not source mode — fall through to the embedded copy */
  }

  if (!readFromDisk) {
    const { EMBEDDED_MIGRATIONS } = await import('../../db/migrations/embedded.js');
    for (const file of Object.keys(EMBEDDED_MIGRATIONS).sort()) {
      collect(EMBEDDED_MIGRATIONS[file] as string);
    }
  }

  if (tables.size === 0) {
    // Fail LOUD rather than open: an empty set would silently restore the
    // self-grant this guard exists to stop.
    throw new Error(
      'Could not determine the engine-owned tables from either the migrations ' +
        'directory or the embedded copy. Refusing to grant extension table access ' +
        'against an empty protected list.',
    );
  }

  _engineTables = tables;
  return tables;
}

/**
 * Tables an extension may reach, auto-detected from its own migrations.
 *
 * The detection is `CREATE TABLE` in files the extension ships, which made the
 * extension the author of its own permissions: a migration containing
 * `CREATE TABLE IF NOT EXISTS zv_api_keys` added `zv_api_keys` to this set and
 * `createRestrictedDb` let it through. The statement does not even have to do
 * anything — `IF NOT EXISTS` against a table the engine already owns is a
 * silent no-op that leaves the grant behind.
 *
 * The clamp is deliberately "not an ENGINE table" rather than "inside the
 * extension's own `zv_<ext>_*` namespace". The namespace rule reads better and
 * is what `assertWorkerSqlAllowed` enforces for worker SQL, but the installed
 * ecosystem does not follow it: 109 of ~300 extension tables are named for the
 * feature rather than the folder — `workflow/approvals` owns `zv_approval_*`,
 * `geospatial/postgis` owns `zv_geofences`. Those are still the extension's own
 * tables. Rejecting them would break a third of the catalogue to restate a
 * convention, while the thing actually worth refusing is narrower and exact.
 *
 * Reaching an engine table stays possible through `EXTENSION_TABLE_GRANTS`: a
 * short list in this repo, changed by a pull request rather than by the
 * extension asking for itself.
 */
export async function buildAllowedTables(
  migrationPaths: string[],
  extName: string,
): Promise<Set<string>> {
  const engineTables = await engineOwnedTables();
  const granted = new Set((EXTENSION_TABLE_GRANTS[extName] ?? []).map((t) => t.toLowerCase()));
  // The grants SEED the set. They used not to.
  //
  // `granted` was read in exactly one place — the guard below, which suppresses
  // the warning on a `CREATE TABLE` the extension already wrote — and never
  // added to `tables`. So a granted engine table that the extension does not
  // itself CREATE never entered the allowlist, and `createRestrictedDb` refused
  // it: `permitted` is the `zvd_` prefix, or the owned prefix, or
  // `allowedTables.has(...)`, and the grant reached none of the three.
  //
  // Measured over the whole registry: 5 of 18 entries reached the allowlist and
  // 13 did not — and every one of the five is a table the extension also
  // CREATEs, which is why it worked, and why it would have worked without the
  // grant too. The list was doing nothing it was written to do.
  //
  // The comment above has the rule backwards for the same reason: it says an
  // entry may be removed only where the extension does not create the table,
  // because there the entry is "the only thing standing". Those are precisely
  // the inert ones.
  const tables = new Set<string>(granted);
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi;
  for (const p of migrationPaths) {
    try {
      // Comments stripped first. This reads migration files to decide which
      // tables an extension may be granted, and it was reading PROSE: a comment
      // saying `CREATE TABLE IF NOT EXISTS` (backtick-quoted, so no space after
      // EXISTS) made the optional group fail and the capture land on "IF" —
      // whereupon the engine announced it would not grant access to a table
      // called IF. Harmless there, but the same misparse in the other direction
      // would grant on the strength of a sentence.
      const content = (await Bun.file(p).text()).replace(/--[^\n]*/g, '');
      for (const m of content.matchAll(re)) {
        const name = m[1];
        const lower = name.toLowerCase();
        if (engineTables.has(lower) && !granted.has(lower)) {
          console.warn(
            `[extensions] "${extName}" has a CREATE TABLE for ${name} in its migrations, ` +
              `which is an ENGINE table. Not granting access — the statement cannot have ` +
              `created it, and a migration is not a place to award permissions. Add it to ` +
              `EXTENSION_TABLE_GRANTS if the extension genuinely needs it.`,
          );
          continue;
        }
        tables.add(name);
      }
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

/**
 * Unsubscribe callbacks for every event listener an extension registered.
 *
 * `unloadExtension` already tears down services, cron schedules, query alters
 * and auth exemptions — with a comment on the services one saying, in as many
 * words, that hot-reload leaks without it. Event listeners were never given the
 * same treatment, so `ctx.events.on(...)` in an extension's `register()` piled
 * up a fresh listener on every reload: the same handler ran two, then three
 * times for one event.
 *
 * Observed on `compliance/ro/efactura`, whose auto-draft ran three times for a
 * single invoice after two reloads. It looked harmless only because that
 * handler happens to check for an existing row first; a listener that appends,
 * charges or notifies would have done it three times.
 */
const extensionListeners = new Map<string, Array<() => void>>();

/** Drop every listener an extension registered. Called by unloadExtension. */
export function unregisterExtensionListeners(extName: string): number {
  const unsubs = extensionListeners.get(extName) ?? [];
  for (const off of unsubs) {
    try {
      off();
    } catch {
      /* a listener already removed by other means is not a failure */
    }
  }
  extensionListeners.delete(extName);
  return unsubs.length;
}

export function buildRestrictedContext(
  ctx: ExtensionContext,
  extName: string,
  app: Hono,
  allowedTables: Set<string> | undefined,
  logPublicRoute: boolean,
  capabilities: readonly string[] = [],
  /** Declared-but-unapproved capabilities — for the denial message only. */
  pendingCapabilities: readonly string[] = [],
): ExtensionContext {
  const hasAdminDb = capabilities.includes('db:admin');
  // Drop any health checks this extension registered on a previous load so a
  // hot-reload never leaves a stale probe pointing at unloaded code (H-1.4).
  clearExtensionHealthChecks(extName);
  // Every listener this extension registers is remembered, so unloading it can
  // take them away again — see `extensionListeners`.
  unregisterExtensionListeners(extName);
  //
  // `Object.create`, NOT a spread. Spreading copies own enumerable properties
  // only, and the bus is a class instance whose methods live on the prototype —
  // so `{ ...ctx.events, on }` produced an object with exactly the two methods
  // defined below and nothing else. `ctx.events.emitAsync` became "not a
  // function" for every extension, which is to say every invoice, every record
  // event, every hook. Delegating through the prototype keeps the rest intact
  // and still lets `on` be overridden.
  //
  // Guarded because a context may arrive without a bus at all — the unit tests
  // build one to check route mounting and nothing else. `Object.create(undefined)`
  // throws, where the old spread quietly produced an object carrying the two
  // methods below and no bus behind them, which would have thrown later and
  // further from the cause. No bus in, no bus out.
  const trackedEvents: typeof ctx.events = !ctx.events
    ? ctx.events
    : Object.assign(Object.create(ctx.events), {
        // Signatures borrowed from the bus itself rather than widened to `any`.
        // The wrapper is generic over every event, but it never needs to look
        // inside one — it forwards the arguments untouched and only keeps the
        // unsubscribe function, so `Parameters<…>` says exactly that.
        on: (...args: Parameters<typeof ctx.events.on>) => {
          const off = ctx.events.on(...guardListenerArgs(args, extName, ctx.db));
          const list = extensionListeners.get(extName) ?? [];
          list.push(off);
          extensionListeners.set(extName, list);
          return off;
        },
        onBefore: (...args: Parameters<NonNullable<typeof ctx.events.onBefore>>) => {
          const off = ctx.events.onBefore?.(...guardListenerArgs(args, extName, ctx.db));
          if (typeof off === 'function') {
            const list = extensionListeners.get(extName) ?? [];
            list.push(off);
            extensionListeners.set(extName, list);
          }
          return off;
        },
      });

  return {
    ...ctx,
    events: trackedEvents,
    // H-12: `ctx.db` is now TENANT-SCOPED. It resolves the current request/job
    // tenant transaction (with the RLS GUC set) via the ALS on every query,
    // falling back to the global pool only outside any tenant context
    // (boot/CLI). So an extension can no longer read or write across tenants by
    // reaching for `ctx.db` instead of `reqDb(c)` — the last multi-tenant hole.
    db: createRestrictedDb(() => getCurrentTenantTrx() ?? ctx.db, extName, allowedTables),
    // Configuration resolved host-side, so extensions stop reading the engine's
    // whole environment (and stop missing the admin's Studio storage settings).
    config: buildExtensionConfig(capabilities, extName),
    // Explicit, capability-gated cross-tenant handle (the global pool). Present
    // only when the manifest declares the `db:admin` permission — otherwise any
    // use throws, so the escape hatch is visible at review + install time.
    adminDb: hasAdminDb
      ? createRestrictedDb(ctx.db, extName, allowedTables)
      : createDeniedAdminDb(extName),
    // Per-request tenant-scoped DB (explicit form, when the handler has `c`):
    // the request's tenant transaction wrapped in the same table guard.
    reqDb: (c: Context) =>
      createRestrictedDb(
        (c?.get?.('tenantTrx') as Database | null) ?? ctx.db,
        extName,
        allowedTables,
      ),
    checkPermission: ctx.checkPermission ?? checkPermission,
    // So `permissionGate` can tell the person who to ask, instead of naming an
    // internal permission at them. Handed to every extension rather than left
    // for each to reinvent — the refusal is the host's contract with the user,
    // and fifty-seven versions of it is how a product stops feeling like one.
    describeDenial: (resource: string, action: string) =>
      describeDenial(getCurrentTenantTrx() ?? ctx.db, resource, action),
    getUserRoles: ctx.getUserRoles ?? getUserRoles,
    DDLManager: ctx.DDLManager ?? DDLManager,
    // Hand each extension a scoped view of the registry so its register()
    // calls are tagged for cleanup on unload. Idempotent on hot-reload.
    services: serviceRegistry.scope(extName),
    queryAlter: queryAlterRegistry.scope(extName),
    entityAccess: entityAccessRegistry.scope(extName),
    // Subsystem health checks (H-1.4). Namespaced + cleared here so a hot-reload
    // drops the previous registration before the extension re-adds it.
    onHealthCheck: (name, run, opts) => registerHealthCheck(`ext:${extName}:${name}`, run, opts),
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
        // Behind `tenantMiddleware`, like `/api/*` and `/ext/*`.
        //
        // A public route is outside both prefixes by design — an IdP wants
        // `/scim/v2/Users`, not `/ext/auth/scim/...` — and that meant it ran with
        // NO tenant context at all: `ctx.db` falls through to the global pool
        // with `zveltio.current_tenant` unset, and the SCIM tables carry FORCE
        // ROW LEVEL SECURITY. With the GUC unset the policy resolves to the
        // default tenant, so on a correctly-configured (non-superuser) engine
        // role every non-default tenant's SCIM token lookup returned zero rows
        // and answered `401 Invalid bearer token`, permanently and with no
        // diagnostic. On a superuser role the policies were skipped and RLS
        // provided no second layer at all.
        //
        // "Public" here has only ever meant "outside the /ext namespace" and
        // "no session required" — it was never meant to mean "no tenant". When
        // the request cannot name a tenant the middleware falls through exactly
        // as before, so a genuinely tenant-less public route is unaffected.
        //
        // This does not by itself make multi-tenant SCIM work: the bearer token
        // IS the tenant identity, so the token lookup has to happen before a
        // tenant can be resolved from the request. That is the extension's
        // question to answer; this is the engine no longer removing the context
        // when the request does carry one (per-tenant hostname, x-tenant-slug).
        fn.call(
          app,
          spec.path,
          tenantMiddleware,
          guardPublicHandler(spec.handler, extName, ctx.db),
        );
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
    // Capability-gated: each guarded internals member throws unless the
    // manifest declared it. Enforcement sits here, on the HOST side of the
    // boundary — the previous capability policy died because its only live
    // call site was inside the WASM host, so no denial was ever reachable for
    // a JS extension.
    internals: gateInternals(extName, ctx.internals, capabilities, pendingCapabilities),
  };
}

/**
 * Mount an extension's routes according to its `mountStrategy` / worker
 * isolation. Shared by first-load and hot-reload.
 *
 * `isolation` is resolved from the manifest on first load and from the
 * persisted `loaded` record on hot-reload. It used to be derived from the
 * manifest alone, and hot-reload passed `manifest = null` — so an extension the
 * publisher-tier gate had deliberately confined to a worker came back inline in
 * the main thread on the next enable/disable, running untrusted third-party
 * code with the engine's own privileges.
 */
/**
 * Give an extension's routers the engine's error handler, since Hono cannot.
 *
 * `app.route(path, sub)` decides whether the parent's error handling applies by
 * comparing `sub.errorHandler` against its own module-level default — an
 * IDENTITY check on a function object. Every extension bundles its own copy of
 * Hono (4.12.28 today, against the engine's 4.13.0), because the compiled Bun
 * binary cannot resolve bare specifiers from a dynamically-imported bundle and
 * so `extension pack` inlines everything. Two copies mean two different default
 * `errorHandler` objects, so that check can NEVER succeed, and Hono takes the
 * other branch: it wraps every route in `compose([], sub.errorHandler)` — the
 * EXTENSION's default handler, which answers a bare 500 and prints the raw
 * error.
 *
 * So no error raised inside any extension has ever reached `problemOnError`.
 * Not the 22P02 → 400 mapping that was written for exactly these routes and
 * unit-tested in isolation; not the engine's error logging either. Two audit
 * rounds read that mapping, agreed it was correct, and it was — it just never
 * ran. `problemNormalizer` re-dressed the 500 into a problem+json envelope
 * afterwards, which is why the response looked handled and only the status
 * betrayed it.
 *
 * Measured, not deduced: `problemOnError` logs when it runs, and for
 * `/api/revisions/not-a-uuid` it does while for `/ext/crm/contacts/not-a-uuid`
 * it does not — same Postgres error underneath. The identity mechanism was then
 * confirmed against a single Hono copy by giving a sub-app any custom handler:
 * the parent's stops applying, exactly as with two copies.
 *
 * Setting `sub.onError(problemOnError)` puts the engine's handler in the branch
 * Hono actually takes. Nested routers keep working: once a router carries this,
 * anything routed INTO it is compared against the extension's own default, that
 * check succeeds within one copy, and the whole tree ends up under this
 * handler.
 *
 * Overriding rather than preserving is safe here and was checked: no extension
 * bundle calls `.onError(` on its own app. If one ever does, this replaces it —
 * which is the right default for a host that owns the error contract, and the
 * extension can still handle errors inside its own handlers.
 */
/**
 * Just enough of a router to mount it and hand it an error handler. Typed
 * structurally rather than as `Hono`, because the object an extension passes
 * comes from its own bundled copy and is not this module's `Hono` class.
 */
interface MountableApp {
  onError?: (handler: typeof problemOnError) => unknown;
}

function propagateErrorHandler(target: Hono): () => void {
  const original = target.route.bind(target);
  type RouteFn = typeof original;
  const patched = ((path: string, sub: MountableApp) => {
    try {
      sub?.onError?.(problemOnError);
    } catch {
      /* not Hono-shaped — mounting it is the caller's problem, not ours */
    }
    return original(path, sub as Parameters<RouteFn>[1]);
  }) as RouteFn;

  (target as unknown as { route: RouteFn }).route = patched;
  return () => {
    (target as unknown as { route: RouteFn }).route = original;
  };
}

async function registerExtensionRoutes(
  extension: ZveltioExtension,
  restrictedCtx: ExtensionContext,
  app: Hono,
  extName: string,
  isolation: { entry: string; extDir: string } | null,
  db: Database,
): Promise<void> {
  const mountStrategy = extension.mountStrategy ?? 'global';
  if (isolation) {
    const host = _getWorkerHost(app);
    // Stop first: this runs on hot-reload as well as first load, and `start`
    // refuses to spawn a second worker for the same extension. Carrying the
    // isolation decision across a reload without this turned a silent downgrade
    // to inline into a hard failure — the throw aborted re-registration, so the
    // extension's routes were never mounted and every /ext/<name>/* request
    // 404'd after an enable or disable. `stop` is a no-op when nothing is
    // running, so first load is unaffected. The proxy routes are re-mounted by
    // the new worker, and the old ones are unmounted by stop().
    await host.stop(extName);
    await host.start(extName, isolation.extDir, isolation.entry);
  } else if (mountStrategy === 'subapp') {
    const subApp = new Hono();
    subApp.onError(problemOnError);
    // On the sub-app itself, not on `/ext/<name>` in the parent, so it holds
    // wherever the sub-app ends up mounted.
    subApp.use('*', activationMiddlewareFor(extName, db));
    const restore = propagateErrorHandler(subApp);
    try {
      await extension.register(subApp, restrictedCtx);
    } finally {
      restore();
    }
    app.route(`/ext/${extName}`, subApp);
  } else {
    // The engine's own app is the target here, so the patch is removed as soon
    // as this extension has registered — a later caller must not inherit it.
    const restore = propagateErrorHandler(app);
    try {
      // `mountStrategy: 'global'` hands over the ENGINE'S OWN app, and the
      // extension picks its own paths — so the gate goes on the handle, not on
      // a prefix. Every handler registered through it is wrapped.
      await extension.register(guardExtensionApp(app, extName, db), restrictedCtx);
    } finally {
      restore();
    }
  }
}

/**
 * Gate one extension schedule.
 *
 * `cron-runner.ts` calls `schedule.handler(ctx, runId)` once, with no firm in
 * scope, so there is nobody to ask the per-firm question — see
 * `isExtensionActiveAnywhere`. All this can enforce is that a schedule
 * belonging to an extension no firm has turned on does not run.
 */
function guardedSchedule(s: ExtensionSchedule, extName: string, db: Database): ExtensionSchedule {
  const handler = (s as { handler?: unknown }).handler;
  if (typeof handler !== 'function') return s;
  return {
    ...s,
    handler: guardScheduleHandler(handler as (...a: unknown[]) => unknown, extName, db),
  } as ExtensionSchedule;
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
  // What the manifest DECLARES is only a request. What an administrator
  // consented to is what the gate enforces — otherwise an extension widens its
  // own power by shipping a new manifest, and the contract means nothing on the
  // one path that matters (update). See consent.ts.
  const declared = manifest?.permissions ?? [];
  const granted = await readGranted(ctx.db, extName).catch(() => null);
  const { effective, pending, grandfathered } = resolveCapabilities(declared, granted);
  if (pending.length > 0) {
    console.warn(
      `🔒 Extension "${extName}" requests capabilities that were never approved: ` +
        `${pending.join(', ')}. It is running WITHOUT them — approve at ` +
        `POST /api/marketplace/${extName}/capabilities/approve to grant.`,
    );
  }

  // The resources this extension guards, and which of them are confidential.
  //
  // Both halves were documented and neither was wired. `registerSensitiveResources`
  // was exported with a comment saying "extensions may add their own" and had no
  // caller anywhere outside its own test — so a third-party extension holding
  // medical records or disciplinary files had no way to say so, and the only
  // route was editing the engine's source. And the CI gate that requires
  // `manifest.resources` tells authors that "grants for a resource are created
  // from this declaration", which nothing read at runtime: an extension arriving
  // after migration 034 got no default grants at all, so under deny-by-default
  // every one of its routes answered 403 to everyone but an administrator.
  //
  // Sensitive first, then materialize, because the order decides the outcome:
  // `materializeDefaultGrants` skips what `isSensitiveResource` withholds, and
  // doing it the other way round would hand out read access to exactly the data
  // the extension asked to keep closed.
  const sensitive = manifest?.sensitiveResources ?? [];
  if (sensitive.length > 0) registerSensitiveResources(sensitive);
  const declaredResources = manifest?.resources ?? [];
  if (declaredResources.length > 0) {
    try {
      const written = await materializeDefaultGrants(ctx.db, declaredResources);
      if (written > 0) {
        console.log(`   🔑 ${extName}: default access granted on ${written} permission(s)`);
      }
    } catch (err) {
      console.warn(
        `   ⚠  ${extName}: could not grant default access to its resources — ` +
          `they stay administrator-only until the next boot:`,
        (err as Error).message,
      );
    }
  }

  // Pass a RestrictedDb proxy — extensions cannot query zv_* system tables.
  // Also inject the full public API (checkPermission, auth, DDLManager…) and
  // ctx.internals.* so extensions never have to relative-import engine modules.
  const restrictedCtx = buildRestrictedContext(
    ctx,
    extName,
    app,
    allowedTables,
    true,
    effective,
    pending,
  );

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
    await registerExtensionRoutes(
      extension,
      restrictedCtx,
      app,
      extName,
      manifest?.engine?.isolation === 'worker' && manifest?.engine?.bundled === true
        ? { entry: manifest.engine.entry, extDir }
        : null,
      ctx.db,
    );
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
        cronRunner.register(extName, guardedSchedule(s as ExtensionSchedule, extName, ctx.db));
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

  // Register the extension's declared public routes with the `/ext/*` auth gate.
  // Anything NOT listed here is fail-closed (401 for anonymous callers) — see
  // middleware/extension-auth-gate.ts.
  const publicRoutes = (manifest as { publicRoutes?: string[] } | null)?.publicRoutes ?? [];
  registerExtensionPublicRoutes(extName, publicRoutes);

  loader.loaded.set(extName, {
    name: extName,
    cleanup:
      typeof extension.cleanup === 'function' ? extension.cleanup.bind(extension) : undefined,
    registeredRoutes: true,
    allowedTables,
    // The EFFECTIVE set, so a hot-reload re-asserts consent rather than
    // quietly re-reading the manifest and granting what it asks for.
    permissions: effective,
    declaredCapabilities: [...declared],
    pendingCapabilities: pending,
    capabilitiesGrandfathered: grandfathered,
    publicRoutes,
    workerIsolation:
      manifest?.engine?.isolation === 'worker' && manifest?.engine?.bundled === true
        ? { entry: manifest.engine.entry, extDir }
        : undefined,
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

  const loaded = loader.loaded.get(name);
  // Re-assert the public-route allowlist on hot-reload (the registry is process
  // -global, but this keeps it correct if the module map was rebuilt).
  registerExtensionPublicRoutes(name, loaded?.publicRoutes ?? []);
  const restrictedCtx = buildRestrictedContext(
    loader.ctx,
    name,
    app,
    loaded?.allowedTables,
    false,
    loaded?.permissions ?? [],
    loaded?.pendingCapabilities ?? [],
  );

  try {
    // Carry the first-load isolation decision across the reload, so a
    // worker-confined extension is restarted in its worker rather than
    // quietly re-registered inline.
    await registerExtensionRoutes(
      extension,
      restrictedCtx,
      app,
      name,
      loaded?.workerIsolation ?? null,
      loader.ctx.db,
    );

    // Re-register schedules on hot-reload. unregisterAll is idempotent and
    // we want the new definitions to win.
    cronRunner.unregisterAll(name);
    if (typeof extension.schedules === 'function') {
      try {
        for (const s of extension.schedules() ?? []) {
          cronRunner.register(name, guardedSchedule(s as ExtensionSchedule, name, loader.ctx.db));
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
