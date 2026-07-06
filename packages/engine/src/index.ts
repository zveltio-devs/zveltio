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
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { join, resolve } from 'path';
import { initDatabase } from './db/index.js';
import { initAuth } from './lib/auth.js';
import { initPermissions, checkPermission, getUserRoles } from './lib/permissions.js';
import { initRls } from './lib/rls.js';
import { fieldTypeRegistry } from './lib/data/index.js';
import {
  extensionLoader,
  buildExtensionInternals,
  serviceRegistry,
} from './lib/extension-loader.js';
import { queryAlterRegistry } from './lib/data/index.js';
import { entityAccessRegistry } from './lib/entity-access.js';
import { cronRunner } from './lib/runtime/index.js';
import { registerCoreFieldTypes } from './field-types/index.js';
import { registerCoreRoutes } from './routes/index.js';
import { websocketHandler } from './routes/ws.js';
import { realtimeBus, PgNotifyRealtimeBus } from './lib/runtime/index.js';
import { WebhookManager } from './lib/webhooks.js';
import { webhookWorker } from './lib/webhook-worker.js';
import { cancelPendingCleanups } from './lib/data/index.js';
import { DDLManager } from './lib/data/index.js';
import { flowScheduler } from './lib/flows/index.js';
import {
  initTenantManager,
  reconcileTenantRLS,
  warnIfDbRoleBypassesRls,
} from './lib/tenant-manager.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { tenantMembershipMiddleware } from './middleware/tenant-membership.js';
import { initTelemetry, getZoneMetricsLines } from './lib/runtime/index.js';
import { engineEvents } from './lib/runtime/index.js';
import { checkSchemaCompatibility, ENGINE_VERSION } from './version.js';
import { getMemoryReport } from './lib/runtime/index.js';

// ─── Mutable app reference for hot-reload ────────────────────────────────────
// The fetch handler passed to Bun.serve() is a stable closure that always
// delegates to _currentApp. When an extension is installed/removed we rebuild
// _currentApp (a fresh Hono instance) and swap the reference — Bun routes all
// new requests to the updated handler while in-flight requests drain normally.
let _currentApp = new Hono();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let _bootstrapCtx: { db: any; auth: any } | null = null;
let _server: ReturnType<typeof Bun.serve> | null = null;
// Metrics counters persist across hot-reloads (module-level, not app-level)
const _serverStartTime = Date.now();
let _totalRequestCount = 0;

// ─── Static file paths ────────────────────────────────────────
// Runtime paths — relative to CWD (Docker: /data, Native: install dir)
const STUDIO_DIST = process.env.STUDIO_DIST_PATH || join(process.cwd(), 'studio-dist');
const CLIENT_DIST = process.env.CLIENT_DIST_PATH || join(process.cwd(), 'client-dist');

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

if (_cmd === 'status') {
  // Lightweight status check that doesn't require a working DB connection.
  const port = process.env.PORT || '3000';
  const host = process.env.HOST || '0.0.0.0';
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    .insertInto('account' as any)
    .values({
      id: crypto.randomUUID(),
      accountId: _id,
      providerId: 'credential',
      userId: _id,
      password: _hash,
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
// Auto-activate content/page-builder on first start if:
//   1. It is not yet in the registry (first boot)
//   2. Its files are present on disk (EXTENSIONS_DIR or monorepo default)
// If the files are missing and the registry is unreachable we skip silently —
// the server starts normally and the user can activate from marketplace later.

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
async function ensureDefaultExtensions(db: any): Promise<void> {
  const defaults = [
    {
      name: 'content/page-builder',
      display_name: 'Page Builder',
      description: 'Visual CMS page builder with blocks, SEO fields, and publish workflow',
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
    const existing = await db
      .selectFrom('zv_extension_registry')
      .select('name')
      .where('name', '=', def.name)
      .executeTakeFirst()
      .catch(() => null);

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
        // Unique-constraint races are expected when multiple replicas
        // boot together — log at debug level so unexpected errors still
        // surface but the common case stays quiet.
        if (!/duplicate key|unique constraint/i.test(err.message)) {
          console.warn(
            `[bootstrap] default extension activation (${def.name}) failed:`,
            err.message,
          );
        }
      });
    console.log(`🔌 Default extension auto-activated: ${def.name}`);
  }
}

async function buildHonoApp(): Promise<Hono> {
  if (!_bootstrapCtx) throw new Error('buildHonoApp called before bootstrap()');
  const { db, auth } = _bootstrapCtx;

  const app = new Hono();

  // ── Middleware (identical to original bootstrap) ──────────────────────────
  app.use('*', logger());
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (path === '/api/storage/upload' || path.startsWith('/api/import')) return next();
    return bodyLimit({ maxSize: 10 * 1024 * 1024 })(c, next);
  });
  app.use(
    '/api/*',
    cors({
      origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Slug', 'X-Environment'],
    }),
  );
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
  // to another tenant via X-Tenant-Slug. See docs/MULTI-TENANT-ENABLEMENT.md §3.
  app.use('/api/*', tenantMembershipMiddleware(auth, db));
  app.use('/ext/*', tenantMembershipMiddleware(auth, db));

  // ── Core routes ───────────────────────────────────────────────────────────
  await registerCoreRoutes(app, { db, auth });

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
    const studioIndex = Bun.file(join(STUDIO_DIST, 'index.html'));
    if (!(await studioIndex.exists())) {
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const dbEnabled = await (db as any)
      .selectFrom('zv_extension_registry')
      .select('name')
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      .where('is_enabled' as any, '=', true)
      .execute()
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      .catch(() => [] as any[]);
    const allActive = [
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      ...new Set([...extensionLoader.getActive(), ...dbEnabled.map((r: any) => r.name as string)]),
    ];
    return c.json({
      extensions: allActive,
      meta: extensionLoader.getExtensionMeta(),
    });
  });

  // ── Health + Prometheus metrics (counters are module-level, survive hot-reloads) ─
  app.get('/health', (c) => c.json({ status: 'ok' }, 200));

  app.use('*', async (c, next) => {
    _totalRequestCount++;
    await next();
  });
  app.get('/metrics', (c) => {
    const metricsToken = process.env.METRICS_TOKEN;
    if (metricsToken) {
      const provided =
        c.req.header('Authorization')?.replace('Bearer ', '') ?? c.req.query('token');
      if (provided !== metricsToken) return c.json({ error: 'Unauthorized' }, 401);
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
      ...getZoneMetricsLines(),
    ];
    return c.text(lines.join('\n') + '\n', 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });

  // ── API 404 guard ─────────────────────────────────────────────────────────
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // ── Client SPA catch-all ──────────────────────────────────────────────────
  app.use('/*', async (c) => {
    const res = await serveStaticFile(CLIENT_DIST, c.req.path);
    if (res) return res;
    // No client app deployed at the root → send visitors to the Studio instead
    // of a bare 404 (an evaluator's first request on a fresh install is `/`).
    if (c.req.path === '/' || c.req.path === '') return c.redirect('/admin/');
    return c.notFound();
  });

  return app;
}

// ─── Bootstrap ───────────────────────────────────────────────
async function bootstrap() {
  // OTel — no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set
  await initTelemetry();

  console.log('🚀 Zveltio starting...');

  // 1. Database
  const db = await initDatabase();
  console.log('✅ Database connected');

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
  console.log('✅ Permissions + RLS initialized');

  // 3a. Field encryption sanity check — warn loudly if FIELD_ENCRYPTION_KEY
  // is unset while collections have encrypted: true fields, so the operator
  // notices that sensitive columns are landing on disk in plaintext.
  const { checkFieldEncryptionAtBoot } = await import('./lib/data/index.js');
  await checkFieldEncryptionAtBoot(db);

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
          execute: async (sqlText: string) => {
            const { sql } = await import('kysely');
            return sql.raw(sqlText).execute(db);
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
  console.log(`✅ Parallel services started in ${Date.now() - parallelStart}ms`);

  // ═══ Tenant row-level security ═══
  // Apply FORCE RLS + the tenant_isolation policy to every collection data table
  // so reads/writes are isolated by the `zveltio.current_tenant` GUC. Runs after
  // collections + extension tables exist. Single-tenant installs run as the
  // default tenant (GUC always set), so this is transparent there.
  await warnIfDbRoleBypassesRls(db);
  try {
    const n = await reconcileTenantRLS(db);
    console.log(`🔒 Tenant RLS reconciled on ${n} collection table(s)`);
  } catch (err) {
    console.warn('⚠️ Tenant RLS reconcile failed (non-fatal):', (err as Error).message);
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

bootstrap().catch((err) => {
  console.error('❌ Bootstrap failed:', err);
  process.exit(1);
});
