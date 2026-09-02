// `reflect-metadata` must be the first import — tsyringe (pulled in
// transitively via @better-auth/passkey → @simplewebauthn/server →
// @peculiar/x509 → tsyringe) initialises decorators at module load
// and throws "tsyringe requires a reflect polyfill" without this.
// The dev path works because something else in the test/HMR runtime
// happens to load reflect first; the `bun build --compile` binary
// has a tighter load order and exposes the bug, which is exactly
// what alpha.97's install on WSL hit.
import 'reflect-metadata';

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { logger } from 'hono/logger';
import { sql } from 'kysely';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { join, resolve } from 'path';
import { getStudioFile, studioEmbedActive } from './studio-embed/index.js';
import { initDatabase, recycleActivePool } from './db/index.js';
import { setTenantScopedTables } from './lib/tenancy/index.js';
import { problemNormalizer, problemOnError } from './lib/problem.js';
import { enrichDenial } from './middleware/enrich-denial.js';
import { initAuth } from './lib/auth.js';
import { initPermissions, checkPermission, getUserRoles } from './lib/tenancy/index.js';
import { initRls } from './lib/tenancy/index.js';
import { createRequestScopedDb } from './lib/tenancy/index.js';
import { fieldTypeRegistry } from './lib/data/index.js';
import {
  extensionLoader,
  buildExtensionInternals,
  isSupportedLocaleName,
  serviceRegistry,
} from './lib/extensions/index.js';
import { queryAlterRegistry } from './lib/data/index.js';
import { entityAccessRegistry } from './lib/tenancy/index.js';
import { registerHealthCheck } from './lib/health-registry.js';
import { cronRunner } from './lib/runtime/index.js';
import { registerCoreFieldTypes } from './field-types/index.js';
import { registerCoreRoutes } from './routes/index.js';
import { websocketHandler } from './routes/ws.js';
import { realtimeBus, PgNotifyRealtimeBus } from './lib/runtime/index.js';
import { WebhookManager } from './lib/webhooks.js';
import { webhookWorker } from './lib/webhook-worker.js';
import { cancelPendingCleanups, sweepGhostOrphans } from './lib/data/index.js';
import { contractImportLogs } from './lib/data/index.js';
import { DDLManager } from './lib/data/index.js';
import { flowScheduler } from './lib/flows/index.js';
import {
  applyFailClosedTenantSetting,
  initRlsEnforcementRole,
  rlsBootFailure,
  initTenantManager,
  reconcileTenantRLS,
  reconcileExtensionTenantRLS,
  warnIfDbRoleBypassesRls,
} from './lib/tenancy/index.js';
import { sessionPrefetch } from './middleware/session-prefetch.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { tenantMembershipMiddleware } from './middleware/tenant-membership.js';
import { initValidationEngine } from './lib/validation-engine.js';
import { extensionAuthGate } from './middleware/extension-auth-gate.js';
import { extRateLimit } from './middleware/rate-limit.js';
import {
  initTelemetry,
  getDomainMetricsLines,
  gaugeLine,
  httpRequests,
  httpRequestDuration,
} from './lib/runtime/index.js';
import { engineEvents } from './lib/runtime/index.js';
import { checkSchemaCompatibility, ENGINE_VERSION } from './version.js';
import { getMemoryReport } from './lib/runtime/index.js';

/**
 * `/api/thing/` should reach `/api/thing`.
 *
 * Hono matches paths exactly, so a trailing slash produced a 404 on every route
 * in the product — `/ext/crm/contacts` 200, `/ext/crm/contacts/` 404. Uniform,
 * and uniformly misleading: it reads as a missing route rather than a spelling.
 *
 * 308 preserves the method and body, so a POST stays a POST. A 301 would turn it
 * into a GET and answer 405 to a caller who did nothing wrong.
 */
const trailingSlashRedirect: MiddlewareHandler = async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
    if (url.pathname !== '') return c.redirect(url.toString(), 308);
  }
  await next();
};

// ─── Mutable app reference for hot-reload ────────────────────────────────────
// The fetch handler passed to Bun.serve() is a stable closure that always
// delegates to _currentApp. When an extension is installed/removed we rebuild
// _currentApp (a fresh Hono instance) and swap the reference — Bun routes all
// new requests to the updated handler while in-flight requests drain normally.
let _currentApp = new Hono();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
let _bootstrapCtx: { db: any; auth: any } | null = null;
let _server: ReturnType<typeof Bun.serve> | null = null;
// Metrics counters persist across hot-reloads (module-level, not app-level)
const _serverStartTime = Date.now();
let _totalRequestCount = 0;

// ─── Static file paths ────────────────────────────────────────
// Runtime paths — relative to CWD (Docker: /data, Native: install dir)
const STUDIO_DIST = process.env.STUDIO_DIST_PATH || join(process.cwd(), 'studio-dist');
const CLIENT_DIST = process.env.CLIENT_DIST_PATH || join(process.cwd(), 'client-dist');

/**
 * Warn when the Studio bundle was not built for this engine.
 *
 * `studio-dist/` is served as static files with nothing tying it to the engine
 * that serves it. A dist from an older release still loads — the HTML is valid,
 * the assets resolve — and then calls an API shape that has changed, so the
 * page renders black with no message anywhere. An audit lost its entire Studio
 * pass to exactly that and reported the UI as broken; the UI was fine, the
 * pairing was not.
 *
 * The Studio's build writes `.zveltio-studio-version` into its output
 * (`scripts/stamp-version.ts`). Missing means a dist built before this existed,
 * which is not an error — the operator is told once, and told what to do.
 *
 * A warning rather than a refusal: an engine that will not start because its UI
 * is stale is worse than one that starts and says so. The API still works, and
 * that is what most of an instance is.
 */
async function warnIfStudioDistMismatched(): Promise<void> {
  try {
    const marker = Bun.file(join(STUDIO_DIST, '.zveltio-studio-version'));
    if (!(await marker.exists())) {
      // Only worth mentioning if a Studio is actually deployed here.
      const index = Bun.file(join(STUDIO_DIST, 'index.html'));
      if (await index.exists()) {
        console.warn(
          `⚠️  studio-dist carries no version marker, so it cannot be checked against ` +
            `engine ${ENGINE_VERSION}. Rebuild the Studio to stamp one.`,
        );
      }
      return;
    }

    const studioVersion = (await marker.text()).trim();
    if (studioVersion !== ENGINE_VERSION) {
      console.warn(
        `⚠️  Studio/engine version mismatch: studio-dist is ${studioVersion}, engine is ` +
          `${ENGINE_VERSION}. The admin UI may render blank or fail on API calls that ` +
          `changed between them. Deploy the studio.tar.gz from this release, or set ` +
          `STUDIO_DIST_PATH to a matching build.`,
      );
    }
  } catch {
    /* never block boot on a diagnostic */
  }
}

// ─── Static file content type helper ─────────────────────────
function getContentType(path: string): string {
  const ext = path.includes('?')
    ? path.substring(path.lastIndexOf('.'), path.indexOf('?')).toLowerCase()
    : path.substring(path.lastIndexOf('.')).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.json': 'application/json',
    '.txt': 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

// ─── Static file serving ──────────────────────────────────────
/**
 * Inject a CSP nonce into every <script> tag in an HTML document.
 *
 * SvelteKit's static adapter emits inline `<script>__sveltekit_xxx = {...}</script>`
 * blobs for client hydration. Without `'unsafe-inline'` in the CSP these
 * scripts would be blocked, but with `'unsafe-inline'` any reflected XSS
 * can also run. The nonce-based approach is the modern middle ground:
 * tag every legitimate script with a per-request nonce, then allow only
 * that nonce in script-src. Browsers that honour the nonce stop accepting
 * `'unsafe-inline'` once a nonce is present (per CSP3).
 */
function injectCspNonce(html: string, nonce: string): string {
  // Add the attribute to both `<script>` and `<script type="module">` etc.
  // We intentionally avoid touching <script src="..."> with an explicit
  // nonce too — adding a `nonce="..."` to a sourced script is also fine
  // and matches what 'strict-dynamic' expects.
  return html
    .replace(/<script(\s)/g, `<script nonce="${nonce}"$1`)
    .replace(/<script>/g, `<script nonce="${nonce}">`);
}

async function serveStaticFile(
  distRoot: string,
  urlPath: string,
  cspNonce?: string,
): Promise<Response | null> {
  // Prevent directory traversal — resolve the full path and verify it stays within distRoot.
  // URL-decode first to catch %2e%2e encoded traversals.
  // Normalise both forward and back slashes — `resolve` handles both on
  // Windows hosts but the prefix check must match the normalisation.
  const decoded = decodeURIComponent(urlPath).replace(/\\/g, '/');
  const resolved = resolve(distRoot, decoded.replace(/^\/+/, ''));
  const rootResolved = resolve(distRoot);
  // Trailing separator ensures `/srv/dist` cannot match `/srv/distEVIL`.
  const rootWithSep =
    rootResolved.endsWith('/') || rootResolved.endsWith('\\')
      ? rootResolved
      : rootResolved + (process.platform === 'win32' ? '\\' : '/');
  if (resolved !== rootResolved && !resolved.startsWith(rootWithSep)) {
    return null; // traversal attempt — return 404 implicitly
  }
  const safe = resolved;

  const candidates = [safe, join(safe, 'index.html')];

  for (const candidate of candidates) {
    const file = Bun.file(candidate);
    if (await file.exists()) {
      const ct = getContentType(candidate);
      const immutable = safe.includes('/_app/immutable/');
      // For HTML responses, rewrite inline <script> tags to carry the
      // per-request CSP nonce so we can drop 'unsafe-inline' from CSP.
      const body =
        ct.startsWith('text/html') && cspNonce ? injectCspNonce(await file.text(), cspNonce) : file;
      return new Response(body, {
        headers: {
          'Content-Type': ct,
          'Cache-Control': immutable
            ? 'public, max-age=31536000, immutable'
            : ct.startsWith('text/html')
              ? 'no-store'
              : 'public, max-age=3600',
        },
      });
    }
  }

  // SPA fallback — serve index.html for client-side routing
  const fallback = Bun.file(join(distRoot, 'index.html'));
  if (await fallback.exists()) {
    const body = cspNonce ? injectCspNonce(await fallback.text(), cspNonce) : fallback;
    return new Response(body, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  return null;
}

/**
 * Serve Studio assets from the compile-time embed (`src/studio-embed/`).
 *
 * Disk `studio-dist/` always wins when present (Docker / native installs).
 * The embed covers single-binary runs that did not mount a separate Studio
 * tree — generate-studio-embed inlines the build before `bun --compile`.
 */
function serveEmbeddedStudio(urlPath: string, cspNonce?: string): Response | null {
  if (!studioEmbedActive()) return null;

  const decoded = decodeURIComponent(urlPath).replace(/\\/g, '/');
  if (decoded.includes('..')) return null;

  let key = decoded.startsWith('/') ? decoded : `/${decoded}`;
  if (key === '/') key = '/index.html';

  let hit = getStudioFile(key);
  if (!hit && !key.includes('.')) {
    hit = getStudioFile(`${key.replace(/\/$/, '')}/index.html`);
  }
  if (!hit) {
    // SPA client route — same fallback as disk serveStaticFile
    hit = getStudioFile('/index.html');
  }
  if (!hit) return null;

  const ct = getContentType(key.includes('.') ? key : '/index.html');
  const immutable = key.includes('/_app/immutable/');
  let body: BodyInit = hit.content as BodyInit;
  if (ct.startsWith('text/html') && cspNonce && typeof hit.content === 'string') {
    body = injectCspNonce(hit.content, cspNonce);
  }

  return new Response(body, {
    headers: {
      'Content-Type': ct,
      'Cache-Control': immutable
        ? 'public, max-age=31536000, immutable'
        : ct.startsWith('text/html')
          ? 'no-store'
          : 'public, max-age=3600',
    },
  });
}

// ─── CLI subcommands ─────────────────────────────────────────
const _cmd = process.argv[2];

// Read package version once at module load (compiled into binary).
async function _zveltioVersion(): Promise<string> {
  try {
    const pkg = (await import('../package.json', { with: { type: 'json' } })) as {
      default: { version: string };
    };
    return pkg.default.version;
  } catch {
    return 'unknown';
  }
}

if (_cmd === 'version' || _cmd === '--version' || _cmd === '-v') {
  const v = await _zveltioVersion();
  console.log(`zveltio ${v}`);
  process.exit(0);
}

if (_cmd === 'help' || _cmd === '--help' || _cmd === '-h') {
  const v = await _zveltioVersion();
  console.log(`zveltio ${v}

USAGE
  zveltio <command> [options]

COMMANDS
  start                              Start the engine (default if no command).
  migrate                            Run pending database migrations.
  create-god --email E --password P  Create a god-role user.
  status                             Show service status.
  update                             How to update (points to update.sh).
  version                            Print version.
  help                               Show this message.

ENVIRONMENT
  DATABASE_URL is required for migrate/create-god/start.
  When called via the /usr/local/bin/zveltio wrapper, /opt/zveltio/.env is
  loaded automatically, so plain "sudo zveltio migrate" works from anywhere.

EXAMPLES
  sudo zveltio migrate
  sudo zveltio status
  sudo zveltio create-god --email me@example.com --password secret123
`);
  process.exit(0);
}

if (_cmd === 'update' || _cmd === 'upgrade') {
  // The engine can't self-replace while running (it would have to swap its own
  // binary + restart the service), so `update` is a script, not a subcommand.
  // Users naturally type `zveltio update`; without this it fell through to
  // `start` and died on EADDRINUSE. Point them at the real tool instead.
  const v = await _zveltioVersion();
  console.log(`zveltio ${v}

"update" is not an engine subcommand — updates run through a script that swaps the
binary + UI bundles and restarts the service, preserving your .env and data:

  sudo bash /opt/zveltio/update.sh                      # latest
  sudo ZVELTIO_VERSION=v3.0.0-beta.31 bash /opt/zveltio/update.sh   # a specific version

If /opt/zveltio/update.sh is missing (older installs), fetch it first:
  sudo curl -fsSL https://raw.githubusercontent.com/zveltio-devs/zveltio/master/install/update.sh -o /opt/zveltio/update.sh
`);
  process.exit(0);
}

if (_cmd === 'status') {
  // Lightweight status check that doesn't require a working DB connection.
  const port = process.env.PORT || '3000';
  const host = process.env.HOST || '0.0.0.0';
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const body: any = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`✅ zveltio is running on ${url}`);
      if (body.status) console.log(`   status: ${body.status}`);
      process.exit(0);
    } else {
      console.log(`⚠️  zveltio responded with HTTP ${res.status} at ${url}`);
      process.exit(1);
    }
  } catch (err) {
    console.log(`❌ zveltio is not reachable at ${url}: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (_cmd === 'migrate') {
  // NATIVE_DATABASE_URL can be set to bypass PgDog (e.g. if pgdog-init failed).
  // Otherwise initDatabase() retries up to 20× until PgDog is ready.
  if (process.env.NATIVE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.NATIVE_DATABASE_URL;
  }
  const { initDatabase: _initDb } = await import('./db/index.js');
  await _initDb();
  console.log('✅ Migrations complete');
  process.exit(0);
}

if (_cmd === 'create-god') {
  // NATIVE_DATABASE_URL can be set to bypass PgDog — same as migrate above.
  if (process.env.NATIVE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.NATIVE_DATABASE_URL;
  }
  const _args = process.argv.slice(3);
  let _email = '';
  let _password = '';
  for (let i = 0; i < _args.length; i++) {
    if (_args[i] === '--email' && _args[i + 1]) _email = _args[i + 1];
    if (_args[i] === '--password' && _args[i + 1]) _password = _args[i + 1];
  }
  if (!_email || !_password) {
    console.error('Usage: zveltio-engine create-god --email <email> --password <password>');
    process.exit(1);
  }
  const { initDatabase: _initDb2 } = await import('./db/index.js');
  const _db = await _initDb2();
  // Use argon2id via Bun.password — matches auth.ts password.hash config.
  // Defaults (4 MB / 3 iters) keep create-god usable on small VMs;
  // ARGON_MEMORY_COST_KIB / ARGON_TIME_COST env vars bump it in prod.
  const _memoryEnv = parseInt(process.env.ARGON_MEMORY_COST_KIB || '', 10);
  const _timeEnv = parseInt(process.env.ARGON_TIME_COST || '', 10);
  const _hash = await Bun.password.hash(_password, {
    algorithm: 'argon2id',
    memoryCost:
      Number.isFinite(_memoryEnv) && _memoryEnv >= 1024 && _memoryEnv <= 1_048_576
        ? _memoryEnv
        : 4096,
    timeCost: Number.isFinite(_timeEnv) && _timeEnv >= 1 && _timeEnv <= 20 ? _timeEnv : 3,
  });
  const _now = new Date();
  const _id = crypto.randomUUID();
  await _db
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    .insertInto('user' as any)
    .values({
      id: _id,
      email: _email,
      name: 'Admin',
      emailVerified: true,
      role: 'god',
      createdAt: _now,
      updatedAt: _now,
    })
    .execute();
  await _db
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    .insertInto('account' as any)
    .values({
      id: crypto.randomUUID(),
      accountId: _id,
      providerId: 'credential',
      userId: _id,
      password: _hash,
      // Better Auth 1.7 stamps this on every credential account it writes, and
      // looks for it when signing one in. This row is written directly through
      // Kysely rather than through the library, so it has to match by hand —
      // without it, sign-in answers "User not found" for an account that plainly
      // exists, which is what upgrading from 1.6.23 produced.
      issuer: 'local:credential',
      createdAt: _now,
      updatedAt: _now,
    })
    .execute();
  console.log(`✅ God user created: ${_email}`);
  process.exit(0);
}

// ─── Hot-reload: rebuild Hono app ─────────────────────────────────────────────
/**
 * Build a fresh Hono instance with all middleware, core routes, extension routes,
 * and static file handlers.  Called once at startup and again after each
 * extension enable/disable to swap _currentApp (zero-downtime hot-reload).
 *
 * Stateful singletons (db, auth, webhookWorker, flowScheduler, …) are NOT
 * re-created — they live in _bootstrapCtx and are reused across rebuilds.
 */
// Auto-activate content/pages on first start if:
//   1. It is not yet in the registry (first boot)
//   2. Its files are present on disk (EXTENSIONS_DIR or monorepo default)
// If the files are missing and the registry is unreachable we skip silently —
// the server starts normally and the user can activate from marketplace later.

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
async function ensureDefaultExtensions(db: any): Promise<void> {
  const defaults = [
    {
      // `content/page-builder` until the merge. That extension no longer exists —
      // it and `content/portals` became `content/pages`, and the engine's own
      // catalogue records the merge — so every boot was auto-activating a name
      // nothing can resolve, and the directory check below quietly skipped it.
      name: 'content/pages',
      display_name: 'Pages',
      description:
        'Public sites and authenticated portals: pages built from blocks, live collection data, SEO, revisions and publish workflow',
      category: 'content',
    },
    {
      name: 'ai',
      display_name: 'AI',
      description:
        'AI capabilities: providers, chat, embeddings, semantic search, text-to-SQL, schema generation, agentic workflows',
      category: 'intelligence',
    },
  ];

  const extBase = process.env.EXTENSIONS_DIR || join(import.meta.dir, '../../../extensions');

  for (const def of defaults) {
    // `.catch(() => null)` meant "not registered yet", so a failed read fell
    // through to the INSERT below. That insert tolerates a duplicate key, so the
    // net effect was a no-op — and the success line at the end of the loop
    // printed anyway. Migrations have already run by this point, so this table
    // exists; a failure here is a real one and is said out loud.
    //
    // Caught per default rather than thrown, though. This function sits in a
    // `.then()` chain immediately before `extensionLoader.loadFromDB`, so
    // throwing skips it and NO extension loads at all — one unreadable row for
    // one default would take out the whole catalogue. Skipping this default and
    // continuing costs at most one auto-activation.
    let existing: { name: string } | undefined;
    try {
      existing = await db
        .selectFrom('zv_extension_registry')
        .select('name')
        .where('name', '=', def.name)
        .executeTakeFirst();
    } catch (err) {
      console.error(
        `[bootstrap] could not check whether "${def.name}" is registered, so it was ` +
          `not auto-activated. Other extensions still load. Cause:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    if (existing) continue;

    const engineEntry = join(extBase, def.name, 'engine/index.ts');
    const filesOnDisk = await Bun.file(engineEntry)
      .exists()
      .catch(() => false);

    if (!filesOnDisk) {
      console.log(
        `ℹ️  ${def.name} not on disk — skipping auto-activate (install from marketplace when ready)`,
      );
      continue;
    }

    let activated = true;
    await db
      .insertInto('zv_extension_registry')
      .values({
        ...def,
        version: '1.0.0',
        is_installed: true,
        is_enabled: true,
        installed_at: new Date(),
        enabled_at: new Date(),
      })
      .execute()
      .catch((err: Error) => {
        activated = false;
        // Unique-constraint races are expected when multiple replicas boot
        // together — log at debug level so unexpected errors still surface but the
        // common case stays quiet.
        if (!/duplicate key|unique constraint/i.test(err.message)) {
          console.warn(
            `[bootstrap] default extension activation (${def.name}) failed:`,
            err.message,
          );
        }
      });
    // Only when it actually happened. This line used to print after the catch
    // regardless, so an operator watching boot was told an extension had been
    // auto-activated on the runs where the insert had just failed.
    if (activated) console.log(`🔌 Default extension auto-activated: ${def.name}`);
  }
}

async function buildHonoApp(): Promise<Hono> {
  if (!_bootstrapCtx) throw new Error('buildHonoApp called before bootstrap()');
  const { db, auth } = _bootstrapCtx;
  const scopedDb = createRequestScopedDb(db);

  const app = new Hono();

  // ── Middleware (identical to original bootstrap) ──────────────────────────
  //
  // A trailing slash used to 404 on every route in the product, uniformly:
  // `/ext/crm/contacts` answered 200 and `/ext/crm/contacts/` answered 404, and
  // the same on `/api/users`. Consistent, and consistently surprising — an
  // auditor first read it as six extensions whose create route was unreachable,
  // which is exactly the wrong conclusion it invites.
  //
  // 308 rather than 301: it preserves the method and the body, so a POST to
  // `/plans/` still arrives as a POST. A 301 would turn it into a GET and the
  // caller would see a confusing 405 instead of their created row.
  //
  // Only for API surfaces, and never for the bare root. `/admin/` and the studio
  // asset paths are served by their own handlers where a trailing slash is
  // meaningful, and rewriting those would break the Studio.
  app.use('/api/*', trailingSlashRedirect);
  app.use('/ext/*', trailingSlashRedirect);
  app.use('*', logger());
  // Unified error envelope (H-13): thrown errors → problem+json; and every
  // non-2xx a route RETURNS under /api|/ext gets rewrapped into the envelope.
  // Registered outermost (before tenant/cors) so it wraps all inner responses.
  app.onError(problemOnError);
  app.use('/api/*', problemNormalizer());
  // Before the normalizer, which would flatten a refusal into a generic
  // envelope and lose the fields that tell a person what to do next.
  app.use('/api/*', enrichDenial(db));
  app.use('/ext/*', enrichDenial(db));
  app.use('/ext/*', problemNormalizer());
  // Upload and import legitimately carry bodies larger than the 10 MB default,
  // so they used to be exempted from the limit entirely — which is not the same
  // thing. Both handlers call `c.req.formData()`, which buffers the whole body,
  // and only then compare `file.size` against their own maximum. A single
  // multi-gigabyte request was therefore read into memory in full before
  // anything looked at its size, and one request could take the process down.
  //
  // They get a HIGHER ceiling instead of none, sized a little above what each
  // handler will accept so the in-handler check still produces the friendly
  // error for merely-too-large files, while an absurd body is cut off at the
  // socket.
  const UPLOAD_MAX =
    (parseInt(process.env.MAX_UPLOAD_BYTES ?? '') || 50 * 1024 * 1024) + 5 * 1024 * 1024;
  const IMPORT_MAX = 100 * 1024 * 1024 + 5 * 1024 * 1024;
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (path === '/api/storage/upload') return bodyLimit({ maxSize: UPLOAD_MAX })(c, next);
    return bodyLimit({ maxSize: 10 * 1024 * 1024 })(c, next);
  });
  // `/ext/*` had no limit at all — the reasoning above applies to it more, not
  // less. Extension handlers call `c.req.formData()` the same way (media
  // upload, CSV import, SAML POST), and they are third-party code the engine
  // does not review, so "the handler checks the size itself" is an assumption
  // rather than a guarantee. An unbounded body here took the process down
  // whatever the extension intended.
  //
  // One ceiling rather than the per-path table above: extension routes are not
  // knowable here, and a new extension must not arrive unbounded by default.
  // It is sized to the largest a shipped extension accepts (data/import's
  // 100 MB) so nothing that works today starts failing, and tunable for an
  // operator whose extension needs more.
  const EXT_MAX = parseInt(process.env.MAX_EXT_BODY_BYTES ?? '') || IMPORT_MAX;
  app.use('/ext/*', bodyLimit({ maxSize: EXT_MAX }));
  const corsOptions = {
    // No cross-origin by default — see comment block on `/api/*` below.
    origin: process.env.CORS_ORIGINS?.split(',') ?? [],
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Slug', 'X-Environment'],
  };
  app.use('/ext/*', cors(corsOptions));
  app.use(
    '/api/*',
    cors({
      // No cross-origin by default.
      //
      // The fallback was `['http://localhost:3000']`, which is an origin the
      // operator never chose. With `credentials: true` that means a page served
      // from port 3000 on a user's own machine could make authenticated
      // requests to their Zveltio instance, and a production deployment that
      // simply never set CORS_ORIGINS carried the allowance silently.
      //
      // An empty list is the honest default: the Studio and Client are served
      // by this same engine, so same-origin requests are unaffected and nothing
      // in a normal install needs this. An operator hosting a front end
      // elsewhere sets CORS_ORIGINS, which is the moment to decide who may ask.
      ...corsOptions,
    }),
  );
  // BEFORE tenantMiddleware, deliberately: it resolves the session while the
  // request is still on a pool connection as the engine's own role. Inside the
  // tenant transaction the role is `zveltio_rls`, which is forbidden to read
  // `session` — and that refusal aborts the transaction, taking the rest of the
  // request with it. See the header of session-prefetch.ts.
  app.use('/api/*', sessionPrefetch(auth));
  app.use('/ext/*', sessionPrefetch(auth));
  app.use('/api/*', tenantMiddleware);
  // Extension + SDUI traffic flows through /ext/* — it MUST get the same tenant
  // isolation as /api/*, or extension handlers using ctx.reqDb(c) fall back to
  // the global pool with no `zveltio.current_tenant` GUC (cross-tenant leak in
  // multi-tenant; fail-closed on FORCE-RLS tables). Registered BEFORE the
  // extension subapps are mounted below so it wraps their routes. Single-tenant
  // installs run as the default tenant (always-one-tenant), so the transaction
  // opens on data routes there too — see TXN_SKIP_PREFIXES for the exceptions.
  app.use('/ext/*', tenantMiddleware);
  // Membership enforcement: an authenticated user may only act within a tenant
  // they belong to (zv_tenant_users). Runs after tenantMiddleware so the tenant
  // is resolved. No-op for the default tenant (single-tenant space) + public
  // requests + god/super-admin; only blocks a logged-in non-member from pivoting
  // to another tenant via X-Tenant-Slug. See docs/private/MULTI-TENANT-ENABLEMENT.md §3.
  app.use('/api/*', tenantMembershipMiddleware(auth, scopedDb));
  app.use('/ext/*', tenantMembershipMiddleware(auth, scopedDb));

  // Fail-closed authentication for extension routes. `/ext/<name>/*` requires a
  // valid session unless the extension's manifest declares the sub-path in
  // `publicRoutes`. Registered BEFORE the extension subapps below so it wraps
  // them. Inverts the old fail-open model where a forgotten in-extension guard
  // meant silent anonymous exposure. See middleware/extension-auth-gate.ts.
  app.use('/ext/*', extensionAuthGate(auth));
  // Throttle extension traffic (per user / per IP) so a compromised or abusive
  // client can't hammer extension routes. Generous cap — SDUI bursts are fine.
  app.use('/ext/*', extRateLimit);

  // ── Core routes ───────────────────────────────────────────────────────────
  await registerCoreRoutes(app, { db: scopedDb, poolDb: db, auth });

  // ── Marketplace routes ────────────────────────────────────────────────────
  extensionLoader.registerMarketplace(app, db);

  // ── Dev-only reload endpoint (S4-03) ──────────────────────────────────────
  // Mounted on every rebuild so the CLI watcher can keep posting. Becomes a
  // no-op in production (gated inside registerDevEndpoints).
  extensionLoader.registerDevEndpoints(app);

  // ── Extension routes (all currently active extensions) ────────────────────
  for (const extName of extensionLoader.getActive()) {
    await extensionLoader.reRegisterExtension(extName, app);
  }

  // ── Studio security headers ───────────────────────────────────────────────
  // Per-request CSP nonce: 16 random bytes, base64-encoded. Stored on the
  // Hono context so the static-file handler below can splice it into
  // <script> tags before sending the HTML response.
  app.use('/admin/*', async (c, next) => {
    const nonceBytes = new Uint8Array(16);
    crypto.getRandomValues(nonceBytes);
    const nonce = Buffer.from(nonceBytes).toString('base64');
    c.set('cspNonce' as never, nonce);

    // script-src uses 'strict-dynamic' alongside the nonce so that any
    // script loaded by a nonced script also passes — required because
    // SvelteKit's hydration script imports its module chunks dynamically.
    // 'unsafe-inline' is kept ONLY as the legacy fallback that modern
    // browsers ignore once a nonce is present (per CSP3); older browsers
    // (pre-2018) will continue to allow inline as before.
    c.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; '),
    );
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    await next();
  });

  // ── Studio static files ───────────────────────────────────────────────────
  app.get('/admin', (c) => c.redirect('/admin/'));
  app.use('/admin/*', async (c, next) => {
    const path = c.req.path.replace(/^\/admin/, '') || '/';
    const nonce = c.get('cspNonce' as never) as string | undefined;
    const res = await serveStaticFile(STUDIO_DIST, path, nonce);
    if (res) return res;
    const embedded = serveEmbeddedStudio(path, nonce);
    if (embedded) return embedded;
    const studioIndex = Bun.file(join(STUDIO_DIST, 'index.html'));
    if (!(await studioIndex.exists()) && !studioEmbedActive()) {
      return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Zveltio Studio — Setup Required</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0d0d12;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem}
    .card{background:#13131f;border:1px solid #2e2e3a;border-radius:12px;padding:2.5rem;max-width:520px;width:100%}
    h1{font-size:1.4rem;font-weight:700;color:#818cf8;margin-bottom:0.5rem}
    p{color:#94a3b8;margin:0.75rem 0;line-height:1.6}
    pre{background:#0d0d12;border:1px solid #2e2e3a;border-radius:6px;padding:0.75rem 1rem;font-size:0.82rem;color:#a5f3fc;overflow-x:auto;margin:0.5rem 0}
    .ok{color:#34d399}
    .warn{color:#fbbf24}
    a{color:#818cf8}
  </style>
</head>
<body>
  <div class="card">
    <h1>⚙️ Zveltio Studio not found</h1>
    <p>The engine is running <span class="ok">✓</span> but the Studio UI files are missing from <code>studio-dist/</code>.</p>
    <p class="warn">This is expected on alpha releases — Studio assets must be downloaded separately.</p>
    <p>Run this on the server to download Studio:</p>
    <pre>curl -fsSL https://github.com/zveltio-devs/zveltio/releases/download/v${ENGINE_VERSION}/studio.tar.gz -o studio.tar.gz
tar -xzf studio.tar.gz -C studio-dist/
rm studio.tar.gz</pre>
    <p>Or reinstall using the latest installer:</p>
    <pre>curl -fsSL https://get.zveltio.com/install.sh | bash</pre>
    <p style="margin-top:1.5rem;font-size:0.8rem">
      API is available at <a href="/api/health">/api/health</a> &nbsp;·&nbsp;
      Engine v${ENGINE_VERSION}
    </p>
  </div>
</body>
</html>`);
    }
    return next();
  });

  // ── Extensions list (Studio consumes this to load UI bundles) ────────────
  app.get('/api/extensions', async (c) => {
    // Which modules a company runs describes the company.
    //
    // `hr/payroll`, `finance/banking`, `compliance/ro/saft`, `operations/pos`
    // together say the size of the business, the country it files in, and
    // whether it sells over a counter — to anyone who can spell the URL, with
    // no account and no log entry that looks unusual. It also hands an attacker
    // the exact list of route prefixes worth probing, which is the difference
    // between guessing at an instance and knowing it.
    //
    // The Studio is the only consumer (`lib/extensions.svelte.ts`, through
    // `api.fetch`, which carries the session), and it asks in order to load UI
    // bundles for a signed-in user. An anonymous visitor has no bundles to
    // load, so requiring a session costs nothing. Checked before the query, so
    // an unauthenticated caller does not get to make the instance do work.
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    // No `.catch(() => [])`. This route reports which extensions are ACTIVE, and a
    // failed read silently narrows the answer to what the in-process loader happens
    // to hold — so an extension enabled in the database but not yet loaded simply
    // vanishes from the list an operator uses to check that it is on.
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const dbEnabled = await (db as any)
      .selectFrom('zv_extension_registry')
      .select('name')
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      .where('is_enabled' as any, '=', true)
      .execute();
    const allActive = [
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      ...new Set([...extensionLoader.getActive(), ...dbEnabled.map((r: any) => r.name as string)]),
    ];
    const meta = extensionLoader.getExtensionMeta();

    // `?messages=<locale>` — opt-in, because the Studio never needs it.
    //
    // The Studio compiles its strings at build time (Paraglide), so for the
    // host we ship, these bytes would be pure waste on every page load. A host
    // built on another framework cannot do that: it receives an SDUI page
    // schema whose labels are keys (`crm.col.organization`) and, without this,
    // has nowhere to resolve them — the screen renders the keys themselves.
    //
    // Each extension's catalogue is attached to ITS OWN entry and never merged
    // here. The engine carries an extension's catalogue the way it carries its
    // page schema — as that extension's artefact — and does not become the
    // owner of a global namespace; `routes/translations.ts` was deleted on
    // 2026-08-10 for being exactly that. The caller merges, because the caller
    // owns `common.*` and decides precedence.
    const locale = c.req.query('messages');
    if (locale !== undefined) {
      if (!isSupportedLocaleName(locale)) {
        return c.json(
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: `"${locale}" is not a locale name (expected e.g. "en" or "pt-BR").`,
          },
          400,
        );
      }
      await Promise.all(
        meta.map(async (entry) => {
          const messages = await extensionLoader.getExtensionMessages(entry.name, locale);
          if (messages !== undefined) entry.messages = messages;
        }),
      );
    }

    return c.json({ extensions: allActive, meta });
  });

  // ── Health + Prometheus metrics (counters are module-level, survive hot-reloads) ─
  app.get('/health', (c) => c.json({ status: 'ok' }, 200));

  app.use('*', async (c, next) => {
    _totalRequestCount++;
    // Skip self-monitoring endpoints so scrapes/health-checks don't inflate the
    // app-traffic metrics the overview dashboard shows.
    const p = c.req.path;
    if (p === '/metrics' || p === '/health' || p === '/api/health/ready') {
      await next();
      return;
    }
    const start = performance.now();
    const method = c.req.method;
    try {
      await next();
    } finally {
      const seconds = (performance.now() - start) / 1000;
      httpRequests.inc({ method, status: String(c.res.status) });
      httpRequestDuration.observe({ method }, seconds);
    }
  });
  app.get('/metrics', async (c) => {
    const metricsToken = process.env.METRICS_TOKEN;
    if (metricsToken) {
      const provided =
        c.req.header('Authorization')?.replace('Bearer ', '') ?? c.req.query('token');
      if (provided !== metricsToken) return c.json({ error: 'Unauthorized' }, 401);
    } else if (process.env.METRICS_ALLOW_UNAUTHENTICATED !== '1') {
      // Fail-CLOSED: with no METRICS_TOKEN configured, refuse rather than leak
      // uptime / heap / request-count internals to any anonymous caller (an
      // information-disclosure surface flagged in the 3.0.0 security review).
      // Operators scraping over a trusted private network can opt back into
      // unauthenticated exposure with METRICS_ALLOW_UNAUTHENTICATED=1.
      return c.json(
        {
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          code: 'metrics_auth_required',
          detail:
            'Metrics require a METRICS_TOKEN (Bearer or ?token=), or set ' +
            'METRICS_ALLOW_UNAUTHENTICATED=1 to expose them unauthenticated.',
        },
        401,
      );
    }
    const uptime = (Date.now() - _serverStartTime) / 1000;
    const memoryReport = getMemoryReport();
    const lines = [
      '# HELP zveltio_uptime_seconds Server uptime in seconds',
      '# TYPE zveltio_uptime_seconds gauge',
      `zveltio_uptime_seconds ${uptime.toFixed(3)}`,
      '# HELP zveltio_requests_total Total HTTP requests received',
      '# TYPE zveltio_requests_total counter',
      `zveltio_requests_total ${_totalRequestCount}`,
      '# HELP zveltio_extensions_active Number of active extensions',
      '# TYPE zveltio_extensions_active gauge',
      `zveltio_extensions_active ${extensionLoader.getActive().length}`,
      '# HELP zveltio_memory_heap_used_bytes Current heap used in bytes',
      '# TYPE zveltio_memory_heap_used_bytes gauge',
      `zveltio_memory_heap_used_bytes ${memoryReport.current.heapUsed}`,
      '# HELP zveltio_memory_heap_total_bytes Current heap total in bytes',
      '# TYPE zveltio_memory_heap_total_bytes gauge',
      `zveltio_memory_heap_total_bytes ${memoryReport.current.heapTotal}`,
      '# HELP zveltio_memory_rss_bytes Resident set size in bytes',
      '# TYPE zveltio_memory_rss_bytes gauge',
      `zveltio_memory_rss_bytes ${memoryReport.current.rss}`,
      '# HELP zveltio_memory_heap_usage_percent Heap usage percentage',
      '# TYPE zveltio_memory_heap_usage_percent gauge',
      `zveltio_memory_heap_usage_percent ${memoryReport.efficiency.heapUsagePercent}`,
      '# HELP zveltio_memory_peak_heap_used_bytes Peak heap used in bytes',
      '# TYPE zveltio_memory_peak_heap_used_bytes gauge',
      `zveltio_memory_peak_heap_used_bytes ${memoryReport.peak.peakHeapUsed}`,
      '# HELP zveltio_memory_peak_rss_bytes Peak RSS in bytes',
      '# TYPE zveltio_memory_peak_rss_bytes gauge',
      `zveltio_memory_peak_rss_bytes ${memoryReport.peak.peakRSS}`,
      ...getDomainMetricsLines(),
    ];

    // Point-in-time gauges the webhooks dashboard reads. Best-effort: a metrics
    // scrape must never fail or block on the DB, so any error is swallowed.
    try {
      const db = _bootstrapCtx?.db;
      if (db) {
        const pending = await sql<{ n: string }>`
          SELECT count(*)::text AS n FROM zvd_webhook_deliveries WHERE delivered_at IS NULL
        `.execute(db);
        const subs = await sql<{ n: string }>`
          SELECT count(*)::text AS n FROM zvd_webhooks WHERE active = true
        `.execute(db);
        lines.push(
          ...gaugeLine(
            'webhook_queue_pending',
            'Undelivered webhook deliveries',
            Number(pending.rows[0]?.n ?? 0),
          ),
          ...gaugeLine(
            'webhook_subscriptions_active',
            'Active webhook subscriptions',
            Number(subs.rows[0]?.n ?? 0),
          ),
        );
      }
    } catch {
      /* metrics must not fail on a DB hiccup */
    }

    return c.text(lines.join('\n') + '\n', 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });

  // ── API 404 guard ─────────────────────────────────────────────────────────
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // ── Extension 404 guard ───────────────────────────────────────────────────
  // A /ext/* path with no mounted extension (not installed/enabled) must return
  // a JSON 404 — NOT fall through to the SPA catch-all below, which would serve
  // index.html for an API path and mislead callers (e.g. the web host probing an
  // optional page-builder homepage got HTML instead of a clean 404). Mounted
  // extensions register earlier, so they still match first.
  app.all('/ext/*', (c) => c.json({ error: 'Not found' }, 404));

  // ── Client SPA catch-all ──────────────────────────────────────────────────
  app.use('/*', async (c) => {
    // Security headers for the PUBLIC web host, mirroring the /admin studio
    // hardening. The 3.0.0 security review flagged that /admin carried a strict
    // CSP + anti-clickjacking headers while the public client at / carried
    // none — leaving public pages open to framing and without a CSP. Use the
    // same per-request nonce + strict-dynamic policy (proven against the
    // SvelteKit studio, which the client is built the same way as).
    const nonceBytes = new Uint8Array(16);
    crypto.getRandomValues(nonceBytes);
    const nonce = Buffer.from(nonceBytes).toString('base64');
    const res = await serveStaticFile(CLIENT_DIST, c.req.path, nonce);
    if (res) {
      res.headers.set(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline'`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: https:",
          "font-src 'self' data:",
          "connect-src 'self' ws: wss:",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join('; '),
      );
      res.headers.set('X-Content-Type-Options', 'nosniff');
      res.headers.set('X-Frame-Options', 'DENY');
      res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      return res;
    }
    // No client app deployed at the root → send visitors to the Studio instead
    // of a bare 404 (an evaluator's first request on a fresh install is `/`).
    if (c.req.path === '/' || c.req.path === '') return c.redirect('/admin/');
    return c.notFound();
  });

  return app;
}

/**
 * Test-only: build the real Hono app in the CURRENT process so the
 * in-process handler-coverage harness (`src/testing/app-harness.ts`) can
 * drive routes via `app.request()` and have coverage see the handlers,
 * write-pipeline, and middleware execute — which the out-of-process
 * integration engine (a separate `bun src/index.ts`) is blind to.
 *
 * Runs the SAME essential init sequence bootstrap() does (minus telemetry,
 * extensions, cron, and Bun.serve), reusing the exact symbols already wired
 * above so there is one definition of "what the app needs". The caller
 * supplies an already-migrated test database.
 */
export async function _createAppForTests(
  db: Awaited<ReturnType<typeof initDatabase>>,
): Promise<Hono> {
  const auth = await initAuth(db);
  initTenantManager(db);
  await initPermissions(db);
  initRls(db);
  // Tests must take the same database path as production. Without this the
  // harness ran every request as the connecting superuser, so RLS applied to
  // nothing and the suite could not have noticed a missing grant — the tests
  // would pass precisely because the isolation they exercise was switched off.
  await initRlsEnforcementRole(db);
  initValidationEngine(db);
  const { checkFieldEncryptionAtBoot } = await import('./lib/data/index.js');
  await checkFieldEncryptionAtBoot(db);
  registerCoreFieldTypes(fieldTypeRegistry);
  WebhookManager.init(db);
  _bootstrapCtx = { db, auth };
  return buildHonoApp();
}

// ─── Bootstrap ───────────────────────────────────────────────
async function bootstrap() {
  // OTel — no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set
  await initTelemetry();

  console.log('🚀 Zveltio starting...');

  // 0. Configuration that must not reach production. Before the database, so a
  //    misconfigured deploy fails in a second instead of after migrations.
  const { assertProductionConfig } = await import('./lib/startup-guards.js');
  assertProductionConfig();

  // 1. Database
  const db = await initDatabase();
  console.log('✅ Database connected');

  // What ceiling is this instance actually running under? Advisory, printed
  // once — the number was invisible until somebody measured it.
  const { reportConcurrencyCeiling } = await import('./lib/startup-guards.js');
  await reportConcurrencyCeiling(db);

  // 1a. Auto-migrate (S4-10) — applies pending migrations under a pg
  // advisory lock so concurrent replicas don't race. Opt out with
  // MIGRATIONS_AUTO=false (CI / explicit-control deploys).
  const { autoMigrate } = await import('./db/auto-migrate.js');
  await autoMigrate(db);

  // 1b. Schema compatibility check — exits if schema is incompatible
  await checkSchemaCompatibility(db);
  console.log(`✅ Zveltio Engine v${ENGINE_VERSION}`);

  // 2. Auth
  const auth = await initAuth(db);
  console.log('✅ Auth initialized');

  // 2b. Tenant manager — must be initialized before routes handle requests
  initTenantManager(db);
  console.log('✅ Tenant manager initialized');

  // 3. Permissions + RLS
  await initPermissions(db);
  initRls(db);
  initValidationEngine(db);
  console.log('✅ Permissions + RLS initialized');

  // 3a. Field encryption sanity check — warn loudly if FIELD_ENCRYPTION_KEY
  // is unset while collections have encrypted: true fields, so the operator
  // notices that sensitive columns are landing on disk in plaintext.
  const { checkFieldEncryptionAtBoot } = await import('./lib/data/index.js');
  await checkFieldEncryptionAtBoot(db);

  // 3b. Webhooks created before alpha.32 carry no signing secret and have been
  // delivering unsigned payloads ever since. Repaired here rather than in a
  // migration because the column is encrypted by application code.
  const { repairUnsignedWebhooksAtBoot } = await import('./lib/webhooks.js');
  await repairUnsignedWebhooksAtBoot(db);

  // Layer admin-saved storage config (zv_settings) over env, so a driver/S3
  // endpoint set from the Studio takes effect at boot.
  const { loadStorageSettings } = await import('./routes/admin/storage-routes.js');
  await loadStorageSettings(db);
  // Warn loudly if the local storage dir isn't writable (else the first upload
  // 502s silently). Runs after the overlay is applied so it checks the real dir.
  const { checkStorageAtBoot } = await import('./lib/storage/index.js');
  await checkStorageAtBoot();

  // 4. Field Type Registry — core types
  registerCoreFieldTypes(fieldTypeRegistry);
  console.log(`✅ Field types registered: ${fieldTypeRegistry.list().join(', ')}`);

  // Store context so buildHonoApp() can access db/auth without being passed them
  _bootstrapCtx = { db, auth };

  // WebhookManager — init with db so trigger() can query webhooks
  WebhookManager.init(db);

  // ═══ PARALLEL — independent services ═══
  const parallelStart = Date.now();
  // _tempApp receives extension routes during loadAll/loadFromDB (routes discarded
  // after this block — buildHonoApp() re-registers them via reRegisterExtension)
  const _tempApp = new Hono();

  await Promise.all([
    // AI providers are now initialised by the `ai` extension itself when it loads.

    // Extensions — env-var configured + DB marketplace
    extensionLoader
      .loadAll(_tempApp, {
        db,
        auth,
        fieldTypeRegistry,
        events: engineEvents,
        checkPermission,
        getUserRoles,
        DDLManager,
        // Each extension gets a scoped view via serviceRegistry.scope(extName) inside
        // the loader; this top-level value is just a type placeholder for the bootstrap
        // ExtensionContext shape and is overridden per-extension.
        services: serviceRegistry.scope('engine'),
        queryAlter: queryAlterRegistry.scope('engine'),
        entityAccess: entityAccessRegistry.scope('engine'),
        onHealthCheck: (name, run, opts) => registerHealthCheck(name, run, opts),
        // Bootstrap context: routes registered through this stub during load
        // are tagged as engine-owned, not extension-owned. Real extensions
        // get an `app`-bound version from extension-loader's loadExtension.
        registerPublicRoute: () => {
          console.warn(
            '[extension-loader] registerPublicRoute called from engine bootstrap context — no-op',
          );
        },
        internals: buildExtensionInternals(),
      })
      .then(() => ensureDefaultExtensions(db))
      .then(() => extensionLoader.loadFromDB(db, _tempApp))
      .then(() => {
        console.log(`✅ Extensions loaded: ${extensionLoader.getActive().join(', ') || 'none'}`);
      })
      .catch((err: Error) => {
        console.warn('⚠️ Extension loading failed (non-fatal):', err.message);
      }),

    // Cross-instance realtime bus. Picks Valkey if VALKEY_URL is
    // set, otherwise pg_notify. The pg_notify backend must connect
    // directly to Postgres (not through PgDog/PgBouncer) because LISTEN
    // requires a persistent dedicated connection.
    (async () => {
      const bus = realtimeBus();
      if (bus.backend === 'pg-notify') {
        const realtimeUrl = process.env.NATIVE_DATABASE_URL || process.env.DATABASE_URL;
        if (!realtimeUrl) return;
        // Plug the Kysely instance so publish() can pg_notify on our pool.
        (bus as PgNotifyRealtimeBus).setPublisher({
          notify: async (_channel, payload) => {
            const { sql } = await import('kysely');
            return sql`SELECT pg_notify('zveltio_changes', ${payload})`.execute(db);
          },
        });
        await bus.start();
      } else if (bus.backend === 'valkey') {
        await bus.start();
      }
    })().catch((err: Error) => {
      console.warn('⚠️ Realtime bus init failed (non-fatal):', err.message);
    }),
  ]);

  // Extension migrations just ran, and some of them alter tables the ENGINE
  // owns — ten today, `zvd_collections` among them. The boot steps above
  // (auth, tenant manager, permissions, the webhook repair) already queried the
  // database, so the pool is holding prepared plans built against the shape
  // those tables had a moment ago. The next request to draw such a connection
  // gets `0A000 cached plan must not change result type`, and inside the request
  // transaction the dialect deliberately does not retry — so it reaches the
  // caller as a 500.
  //
  // Measured in CI with a DDL event trigger: engine start at 18:52:55.23, then
  // `ALTER TABLE zvd_collections` twice at 18:52:56.51 from the `ai` extension's
  // migration, adding three columns. Intermittent because it depends on whether
  // a connection prepared the statement inside that window and is reused after.
  //
  // Here and not earlier: this is the first point where every migration, engine
  // and extension, has finished. `Bun.serve` has not started, so nothing is
  // mid-request.
  await recycleActivePool();

  // Teach the request-scoped handle which tables carry a tenant.
  //
  // `createRequestScopedDb` resolves `getCurrentTenantTrx() ?? pool`, and that
  // `??` is the quietest failure in the engine: with no transaction, a read runs
  // on the raw pool as the engine's own role — a SUPERUSER, which bypasses
  // row-level security entirely. Measured: the same table returns both tenants'
  // rows on the pool and one tenant's inside the transaction. The policy is real;
  // it is armed by the `SET LOCAL ROLE` that lives in that transaction.
  //
  // Counting those falls needs to know which tables have a tenant to protect,
  // and here is the first point where every migration — engine and extension —
  // has finished, so the answer is final.
  try {
    const rows = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND column_name = 'tenant_id'
    `.execute(db);
    setTenantScopedTables(rows.rows.map((r) => r.table_name));
  } catch {
    // A diagnostic must never be the reason a boot fails. Left unpopulated, the
    // counter simply stays silent.
  }

  console.log(`✅ Parallel services started in ${Date.now() - parallelStart}ms`);

  // ═══ Tenant row-level security ═══
  // Apply FORCE RLS + the tenant_isolation policy to every collection data table
  // so reads/writes are isolated by the `zveltio.current_tenant` GUC. Runs after
  // collections + extension tables exist. Single-tenant installs run as the
  // default tenant (GUC always set), so this is transparent there.
  // Whether Postgres will apply RLS to this connection at all. A stock install
  // connects as the image's POSTGRES_USER, which is a SUPERUSER, and FORCE RLS
  // does not bind superusers — so `withTenantIsolation` drops to a plain role
  // for the duration of each tenant transaction. See migration 030.
  const rlsMode = await initRlsEnforcementRole(db);
  if (rlsMode === 'enforced') {
    console.log('🔒 Tenant RLS enforced via the zveltio_rls role');
  } else if (rlsMode === 'native') {
    // Printed rather than left silent: the safe state and a check that never
    // ran look identical in a log that says nothing, and an operator who has
    // just been told to move off the superuser needs to see that it took.
    console.log('🔒 Tenant RLS enforced natively — the engine role is bound by RLS');
  } else if (rlsMode === 'unavailable') {
    const message =
      '[tenant-rls] The zveltio_rls role is unavailable AND this connection can bypass RLS. ' +
      'Tenant isolation is NOT enforced by the database: FORCE ROW LEVEL SECURITY does not bind ' +
      'a SUPERUSER or BYPASSRLS role, and there is no plain role to drop to. Every tenant can ' +
      'read every other tenant. Either let migration 030 create the role, or run the engine as a ' +
      'plain (NOSUPERUSER, no BYPASSRLS) role.';

    // Fatal in production. This was a warning, and a warning is the wrong
    // instrument: it scrolls past during a deploy, it does not fail a readiness
    // probe, and the thing it is warning about is that every tenant can read
    // every other tenant's data. An install that cannot enforce isolation must
    // not accept traffic that assumes it.
    //
    // Left as a warning outside production, because a single-tenant development
    // box on the stock postgres superuser is a normal thing to run and blocking
    // it would only teach people to set the escape hatch permanently.
    const overridden = process.env.ZVELTIO_ALLOW_UNENFORCED_RLS === '1';
    if (
      rlsBootFailure({
        mode: rlsMode,
        nodeEnv: process.env.NODE_ENV,
        override: overridden,
      })
    ) {
      console.error(`❌ ${message}`);
      throw new Error(
        `${message} Refusing to start in production. Set ZVELTIO_ALLOW_UNENFORCED_RLS=1 to ` +
          'override, which is appropriate only for a single-tenant install you accept the risk on.',
      );
    }
    console.warn(`⚠️  ${message}`);
    if (overridden) {
      console.warn(
        '⚠️  [tenant-rls] ZVELTIO_ALLOW_UNENFORCED_RLS=1 is set — starting anyway. ' +
          'This is only defensible on a single-tenant install.',
      );
    }
  }
  // Mode-aware on purpose. This used to print "row-level security is BYPASSED,
  // so tenant isolation is NOT enforced" on every superuser connection —
  // including one where the line directly above had just reported isolation
  // ENFORCED through the zveltio_rls role. Two contradictory sentences at boot
  // do not make an operator careful; they make both easy to ignore.
  await warnIfDbRoleBypassesRls(db, rlsMode);
  await applyFailClosedTenantSetting(db);
  // The contract half of migration 048, which only an operator can time. See
  // lib/data/import-logs-contract.ts — no-op unless ZVELTIO_IMPORT_LOGS_CONTRACT=1.
  try {
    const n = await contractImportLogs(db);
    if (n > 0) console.log(`🧹 zv_import_logs: ${n} engine-era column(s) dropped`);
  } catch (err) {
    console.warn('⚠️ import-logs contract failed (non-fatal):', (err as Error).message);
  }
  try {
    const n = await reconcileTenantRLS(db);
    console.log(`🔒 Tenant RLS reconciled on ${n} collection table(s)`);
  } catch (err) {
    console.warn('⚠️ Tenant RLS reconcile failed (non-fatal):', (err as Error).message);
  }
  // The same reconcile, for authorization rather than isolation.
  //
  // Migration 034 wrote out the resources that existed when it ran. Anything
  // that appeared since — a collection created on an older engine, an extension
  // installed after the upgrade — would otherwise be reachable only by
  // administrators, with no error message that points at the cause. Idempotent,
  // so on a settled install this writes nothing and costs one query.
  try {
    const { listKnownResources, materializeDefaultGrants } = await import('./lib/tenancy/index.js');
    const { resolveExtensionsBase } = await import('./lib/extensions/index.js');
    // The extensions directory is resolved here and handed over: `tenancy`
    // reaching into `extensions` for it closes an import cycle (see the note on
    // `resourcesDeclaredOnDisk`).
    const n = await materializeDefaultGrants(
      db,
      await listKnownResources(db, resolveExtensionsBase()),
    );
    // Row rules onto the tables, for an install that already has rules and no
    // policies — which is every install upgrading into this. A feature that only
    // protected collections created afterwards would protect the ones with no
    // data in them.
    try {
      const { reconcileRowRulePolicies } = await import('./lib/tenancy/index.js');
      const applied = await reconcileRowRulePolicies(db);
      if (applied > 0)
        console.log(`🔒 Row rules enforced in the database on ${applied} collection(s)`);
    } catch (err) {
      console.warn('⚠️ Row-rule policies not reconciled (non-fatal):', (err as Error).message);
    }
    if (n > 0) console.log(`🔑 Default access granted on ${n} new resource permission(s)`);
  } catch (err) {
    console.warn('⚠️ Default grant reconcile failed (non-fatal):', (err as Error).message);
  }
  // Extensions install their own isolation policies, and every copy of the
  // template was fail-open — a query with no tenant context read every
  // tenant's rows, where the same mistake against an engine table read none.
  // This puts them all on the host's predicate, including extensions that do
  // not live in this repository.
  try {
    const n = await reconcileExtensionTenantRLS(db);
    if (n > 0) console.log(`🔒 Tenant RLS reconciled on ${n} extension table(s)`);
  } catch (err) {
    console.warn('⚠️ Extension RLS reconcile failed (non-fatal):', (err as Error).message);
  }

  // A Ghost DDL swap schedules its own DROP sixty seconds out, in memory. Any
  // exit before then — including the graceful one, which cancels the timer —
  // leaves a full, policy-less copy of the table behind for good. Boot is the
  // one moment we know those timers are gone, so it is where they get reclaimed.
  try {
    const swept = await sweepGhostOrphans(db);
    if (swept.dropped.length > 0) {
      console.log(`🧹 Reclaimed ${swept.dropped.length} orphaned Ghost DDL table(s)`);
    }
    for (const { table, reason } of swept.failed) {
      console.warn(`⚠️  [ghost-ddl] could not drop orphan ${table}: ${reason}`);
    }
    if (swept.abandonedGhosts.length > 0) {
      console.warn(
        `⚠️  [ghost-ddl] ${swept.abandonedGhosts.length} ghost table(s) present — ` +
          'left alone in case a run on another instance is still copying into them: ' +
          swept.abandonedGhosts.join(', '),
      );
    }
  } catch (err) {
    console.warn('⚠️ Ghost DDL orphan sweep failed (non-fatal):', (err as Error).message);
  }

  // ═══ Background workers (fire-and-forget) ═══
  webhookWorker.start(1000);
  console.log('✅ Webhook worker started');

  await flowScheduler.start(db);
  console.log('✅ Flow scheduler started');

  // Native extension schedules (S2-05) — start the runner with a base ctx.
  // Per-extension handlers get the scoped ctx via cronRunner internals.
  cronRunner.start(db, {
    db,
    auth,
    fieldTypeRegistry,
    events: engineEvents,
    checkPermission,
    getUserRoles,
    DDLManager,
    services: serviceRegistry.scope('engine'),
    queryAlter: queryAlterRegistry.scope('engine'),
    entityAccess: entityAccessRegistry.scope('engine'),
    onHealthCheck: (name, run, opts) => registerHealthCheck(name, run, opts),
    // Cron handlers cannot register routes (no app reference in runtime).
    registerPublicRoute: () => {
      console.warn('[cron-runner] schedules cannot register public routes — no-op');
    },
    internals: buildExtensionInternals(),
  });
  console.log('✅ Extension cron runner started');

  // Build initial Hono app — all middleware, core routes, extension routes
  _currentApp = await buildHonoApp();
  console.log('✅ Routes built');

  await warnIfStudioDistMismatched();

  // Start server with a stable proxy fetch so hot-reload can swap _currentApp
  // without restarting the server process.
  const port = parseInt(process.env.PORT || '3000');
  const host = process.env.HOST || '0.0.0.0';
  _server = Bun.serve({
    fetch(req, server) {
      // Pass `server` through env so Hono's /api/ws route can call server.upgrade().
      return _currentApp.fetch(req, { server });
    },
    websocket: websocketHandler,
    port,
    hostname: host,
  });

  // Wire hot-reload: after every extension enable/disable the loader calls this
  // to atomically swap _currentApp with a freshly built Hono instance.
  extensionLoader.setReloadCallback(async () => {
    _currentApp = await buildHonoApp();
  });

  console.log(`\n✨ Zveltio running at http://${host}:${port}`);
  console.log(`   Admin:  http://localhost:${port}/admin`);
  console.log(`   API:    http://localhost:${port}/api`);
  console.log(`   Health: http://localhost:${port}/health\n`);
}

// Graceful shutdown
async function shutdown() {
  console.log('\n🛑 Shutting down gracefully...');
  webhookWorker.stop();
  flowScheduler.stop();
  cancelPendingCleanups();
  realtimeBus()
    .stop()
    .catch((err: Error) => {
      console.warn('[shutdown] realtimeBus.stop() failed:', err.message);
    });
  // Stop pg-boss so its connection pool drains cleanly. Best-effort.
  try {
    const { stopDDLQueue } = await import('./lib/data/index.js');
    await stopDDLQueue();
  } catch {
    /* not initialized yet */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Bun crashes the process on any unhandled promise rejection. A handful
// of recoverable error classes shouldn't take the engine down:
//
//   - ERR_POSTGRES_CONNECTION_CLOSED: the Bun SQL pool can race idle
//     timeout against a transaction release; the connection is already
//     gone, no work to roll back. Surfaced live alpha.112 during
//     concurrent marketplace enable + studio rebuild.
//
//   - ECONNRESET / EPIPE on websocket peers: client navigated away,
//     not our problem.
//
// Everything else still aborts so real bugs aren't masked.
function isRecoverableDbError(err: { code?: string; message?: string } | undefined): boolean {
  const code = err?.code;
  const msg = err?.message ?? '';
  return (
    code === 'ERR_POSTGRES_CONNECTION_CLOSED' ||
    /Connection closed/i.test(msg) ||
    /must be a PostgresSQLConnection/i.test(msg) ||
    code === 'ECONNRESET' ||
    code === 'EPIPE'
  );
}

process.on('unhandledRejection', (reason: unknown) => {
  const err = reason as { code?: string; message?: string } | undefined;
  if (isRecoverableDbError(err)) {
    console.warn(
      `[engine] swallowed recoverable rejection: ${err?.code ?? 'unknown'} — ${err?.message}`,
    );
    return;
  }
  console.error('❌ unhandledRejection:', reason);
  process.exit(1);
});

// Bun.SQL's C++ transaction handler throws synchronously when the
// underlying socket dies mid-transaction (`connection must be a
// PostgresSQLConnection`). That throw escapes await context and lands
// as an uncaughtException, NOT a Promise rejection — the
// unhandledRejection handler above doesn't see it. Mirror the
// recoverable-error gate here so the engine survives a transient
// connection death instead of crash-restarting (verified live during
// alpha.121 → .125 WSL testing).
process.on('uncaughtException', (err: Error & { code?: string }) => {
  if (isRecoverableDbError(err)) {
    console.warn(
      `[engine] swallowed recoverable uncaught exception: ${err.code ?? 'unknown'} — ${err.message}`,
    );
    return;
  }
  console.error('❌ uncaughtException:', err);
  process.exit(1);
});

// An argument that reached here is either `start` or unrecognized. An unknown
// command must NOT silently boot the engine — that binds the port and confuses
// operators (e.g. `zveltio update` used to fall through to start → EADDRINUSE).
// Only `start` (or no command at all) proceeds to bootstrap. Guarded on
// import.meta.main so tests that `import` this module are unaffected.
if (import.meta.main && _cmd && _cmd !== 'start') {
  console.error(`zveltio: unknown command "${_cmd}". Run "zveltio help" for usage.`);
  process.exit(2);
}

// Only auto-boot when run as the entrypoint (`bun src/index.ts`, the compiled
// binary). Guarding on import.meta.main lets tests `import` this module — for
// the in-process app-harness (_createAppForTests) — WITHOUT starting a real
// server, database, cron, and Bun.serve on a port.
if (import.meta.main) {
  bootstrap().catch((err) => {
    console.error('❌ Bootstrap failed:', err);
    process.exit(1);
  });
}
