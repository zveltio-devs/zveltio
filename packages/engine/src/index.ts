import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { join, resolve } from 'path';
import { initDatabase } from './db/index.js';
import { initAuth } from './lib/auth.js';
import { initPermissions, checkPermission, getUserRoles } from './lib/permissions.js';
import { initRls } from './lib/rls.js';
import { fieldTypeRegistry } from './lib/field-type-registry.js';
import { extensionLoader, buildExtensionInternals } from './lib/extension-loader.js';
import { registerCoreFieldTypes } from './field-types/index.js';
import { registerCoreRoutes } from './routes/index.js';
import { websocketHandler } from './routes/ws.js';
import { realtimeManager } from './lib/realtime.js';
import { initAIProviders } from './lib/ai-provider.js';
import { WebhookManager } from './lib/webhooks.js';
import { webhookWorker } from './lib/webhook-worker.js';
import { cancelPendingCleanups } from './lib/ghost-ddl.js';
import { DDLManager } from './lib/ddl-manager.js';
import { flowScheduler } from './lib/flow-scheduler.js';
import { initTenantManager } from './lib/tenant-manager.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { initTelemetry, getZoneMetricsLines } from './lib/telemetry.js';
import { engineEvents } from './lib/event-bus.js';
import { checkSchemaCompatibility, ENGINE_VERSION } from './version.js';
import { getMemoryReport } from './lib/memory-monitor.js';

// ─── Mutable app reference for hot-reload ────────────────────────────────────
// The fetch handler passed to Bun.serve() is a stable closure that always
// delegates to _currentApp. When an extension is installed/removed we rebuild
// _currentApp (a fresh Hono instance) and swap the reference — Bun routes all
// new requests to the updated handler while in-flight requests drain normally.
let _currentApp = new Hono();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _bootstrapCtx: { db: any; auth: any } | null = null;
let _server: ReturnType<typeof Bun.serve> | null = null;
// Metrics counters persist across hot-reloads (module-level, not app-level)
const _serverStartTime = Date.now();
let _totalRequestCount = 0;

// ─── Static file paths ────────────────────────────────────────
// Runtime paths — relative to CWD (Docker: /data, Native: install dir)
const STUDIO_DIST =
  process.env.STUDIO_DIST_PATH || join(process.cwd(), 'studio-dist');
const CLIENT_DIST =
  process.env.CLIENT_DIST_PATH || join(process.cwd(), 'client-dist');

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
async function serveStaticFile(
  distRoot: string,
  urlPath: string,
): Promise<Response | null> {
  // Prevent directory traversal — resolve the full path and verify it stays within distRoot.
  // URL-decode first to catch %2e%2e encoded traversals.
  const decoded = decodeURIComponent(urlPath);
  const resolved = resolve(distRoot, decoded.replace(/^\/+/, ''));
  if (!resolved.startsWith(resolve(distRoot))) {
    return null; // traversal attempt — return 404 implicitly
  }
  const safe = resolved;

  const candidates = [safe, join(safe, 'index.html')];

  for (const candidate of candidates) {
    const file = Bun.file(candidate);
    if (await file.exists()) {
      const ct = getContentType(candidate);
      const immutable = safe.includes('/_app/immutable/');
      return new Response(file, {
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
    return new Response(fallback, {
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
    const pkg = await import('../package.json', { with: { type: 'json' } }) as { default: { version: string } };
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
    console.error(
      'Usage: zveltio-engine create-god --email <email> --password <password>',
    );
    process.exit(1);
  }
  const { initDatabase: _initDb2 } = await import('./db/index.js');
  const _db = await _initDb2();
  // Use argon2id via Bun.password — matches auth.ts password.hash config.
  // argon2id(memoryCost=4096) uses only ~4 MB RAM, works on small VMs.
  const _hash = await Bun.password.hash(_password, {
    algorithm: 'argon2id',
    memoryCost: 4096,
    timeCost: 3,
  });
  const _now = new Date();
  const _id = crypto.randomUUID();
  await _db
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
async function ensureDefaultExtensions(db: any): Promise<void> {
  const existing = await db
    .selectFrom('zv_extension_registry')
    .select('name')
    .where('name', '=', 'content/page-builder')
    .executeTakeFirst()
    .catch(() => null);

  if (existing) return; // already registered (any previous boot)

  // Verify extension files are on disk before marking as installed.
  const extBase = process.env.EXTENSIONS_DIR
    || join(import.meta.dir, '../../../extensions');
  const engineEntry = join(extBase, 'content/page-builder/engine/index.ts');
  const filesOnDisk = await Bun.file(engineEntry).exists().catch(() => false);

  if (!filesOnDisk) {
    console.log('ℹ️  content/page-builder not on disk — skipping auto-activate (install from marketplace when ready)');
    return;
  }

  await db
    .insertInto('zv_extension_registry')
    .values({
      name: 'content/page-builder',
      display_name: 'Page Builder',
      description: 'Visual CMS page builder with blocks, SEO fields, and publish workflow',
      category: 'content',
      version: '1.0.0',
      is_installed: true,
      is_enabled: true,
      installed_at: new Date(),
      enabled_at: new Date(),
    })
    .execute()
    .catch(() => {}); // ignore race (unique constraint)
  console.log('🔌 Default extension auto-activated: content/page-builder');
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
  app.use('/api/*', cors({
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Slug', 'X-Environment'],
  }));
  app.use('/api/*', tenantMiddleware);

  // ── Core routes ───────────────────────────────────────────────────────────
  await registerCoreRoutes(app, { db, auth });

  // ── Marketplace routes ────────────────────────────────────────────────────
  extensionLoader.registerMarketplace(app, db);

  // ── Extension routes (all currently active extensions) ────────────────────
  for (const extName of extensionLoader.getActive()) {
    await extensionLoader.reRegisterExtension(extName, app);
  }

  // ── Studio security headers ───────────────────────────────────────────────
  app.use('/admin/*', async (c, next) => {
    c.header('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '));
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
    const res = await serveStaticFile(STUDIO_DIST, path);
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
    const dbEnabled = await (db as any)
      .selectFrom('zv_extension_registry')
      .select('name')
      .where('is_enabled' as any, '=', true)
      .execute()
      .catch(() => [] as any[]);
    const allActive = [...new Set([
      ...extensionLoader.getActive(),
      ...dbEnabled.map((r: any) => r.name as string),
    ])];
    return c.json({ extensions: allActive, bundles: extensionLoader.getBundles(), meta: extensionLoader.getExtensionMeta() });
  });

  // ── Health + Prometheus metrics (counters are module-level, survive hot-reloads) ─
  app.get('/health', (c) => c.json({ status: 'ok' }, 200));

  app.use('*', async (c, next) => { _totalRequestCount++; await next(); });
  app.get('/metrics', (c) => {
    const metricsToken = process.env.METRICS_TOKEN;
    if (metricsToken) {
      const provided = c.req.header('Authorization')?.replace('Bearer ', '') ?? c.req.query('token');
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
    return c.text(lines.join('\n') + '\n', 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
  });

  // ── API 404 guard ─────────────────────────────────────────────────────────
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // ── Client SPA catch-all ──────────────────────────────────────────────────
  app.use('/*', async (c) => {
    const res = await serveStaticFile(CLIENT_DIST, c.req.path);
    if (res) return res;
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
    // AI providers — init after extensions so extension providers can register too
    initAIProviders(db)
      .then(async () => {
        const { aiProviderManager } = await import('./lib/ai-provider.js');
        const aiCount = aiProviderManager.list().length;
        if (aiCount > 0)
          console.log(`✅ AI providers initialized: ${aiCount} provider(s)`);
      })
      .catch((err: Error) => {
        console.warn('⚠️ AI providers failed (non-fatal):', err.message);
      }),

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

    // Realtime LISTEN/NOTIFY — must connect directly to PostgreSQL, not through
    // PgDog/PgBouncer, because LISTEN requires a persistent dedicated connection.
    (() => {
      const realtimeUrl = process.env.NATIVE_DATABASE_URL || process.env.DATABASE_URL;
      return realtimeUrl ? realtimeManager.start(realtimeUrl) : Promise.resolve();
    })().catch((err: Error) => {
      console.warn('⚠️ Realtime init failed (non-fatal):', err.message);
    }),
  ]);
  console.log(`✅ Parallel services started in ${Date.now() - parallelStart}ms`);

  // ═══ Background workers (fire-and-forget) ═══
  webhookWorker.start(1000);
  console.log('✅ Webhook worker started');

  await flowScheduler.start(db);
  console.log('✅ Flow scheduler started');

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
function shutdown() {
  console.log('\n🛑 Shutting down gracefully...');
  webhookWorker.stop();
  flowScheduler.stop();
  cancelPendingCleanups();
  realtimeManager.stop().catch(() => {
    /* ignore */
  });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

bootstrap().catch((err) => {
  console.error('❌ Bootstrap failed:', err);
  process.exit(1);
});
