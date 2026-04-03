import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { join } from 'path';
import { initDatabase } from './db/index.js';
import { initAuth } from './lib/auth.js';
import { initPermissions } from './lib/permissions.js';
import { fieldTypeRegistry } from './lib/field-type-registry.js';
import { extensionLoader } from './lib/extension-loader.js';
import { registerCoreFieldTypes } from './field-types/index.js';
import { registerCoreRoutes } from './routes/index.js';
import { websocketHandler } from './routes/ws.js';
import { realtimeManager } from './lib/realtime.js';
import { initAIProviders } from './lib/ai-provider.js';
import { WebhookManager } from './lib/webhooks.js';
import { webhookWorker } from './lib/webhook-worker.js';
import { flowScheduler } from './lib/flow-scheduler.js';
import { initTenantManager } from './lib/tenant-manager.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { initTelemetry, getZoneMetricsLines } from './lib/telemetry.js';
import { engineEvents } from './lib/event-bus.js';
import { checkSchemaCompatibility, ENGINE_VERSION } from './version.js';
import { getMemoryReport } from './lib/memory-monitor.js';

const app = new Hono();

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
  // Prevent directory traversal
  const safe = urlPath.replace(/\.\./g, '').replace(/\/+/g, '/') || '/';

  const candidates = [join(distRoot, safe), join(distRoot, safe, 'index.html')];

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

// ─── Middleware ───────────────────────────────────────────────
app.use('*', logger());

// Global body size limit — prevents OOM from huge requests
// Exception: /api/storage/upload and /api/import have their own limits
app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  if (path === '/api/storage/upload' || path.startsWith('/api/import')) {
    return next();
  }
  return bodyLimit({ maxSize: 10 * 1024 * 1024 })(c, next); // 10 MB
});

app.use(
  '/api/*',
  cors({
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true,
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Slug',
      'X-Environment',
    ],
  }),
);
app.use('/api/*', tenantMiddleware);

// ─── CLI subcommands ─────────────────────────────────────────
const _cmd = process.argv[2];

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

  // 3. Permissions
  await initPermissions(db);
  console.log('✅ Permissions initialized');

  // 4. Field Type Registry — core types
  registerCoreFieldTypes(fieldTypeRegistry);
  console.log(
    `✅ Field types registered: ${fieldTypeRegistry.list().join(', ')}`,
  );

  // 5. Core routes
  await registerCoreRoutes(app, { db, auth });
  console.log('✅ Core routes registered');

  // 5b. Marketplace routes — always-on, registered on the loader itself
  extensionLoader.registerMarketplace(app, db);

  // 6c. WebhookManager — init with db so trigger() can query webhooks
  WebhookManager.init(db);

  // ═══ PARALLEL — independent services ═══
  const parallelStart = Date.now();
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
      .loadAll(app, { db, auth, fieldTypeRegistry, events: engineEvents })
      .then(() => extensionLoader.loadFromDB(db, app))
      .then(() => {
        console.log(
          `✅ Extensions loaded: ${extensionLoader.getActive().join(', ') || 'none'}`,
        );
      })
      .catch((err: Error) => {
        console.warn('⚠️ Extension loading failed (non-fatal):', err.message);
      }),

    // Realtime LISTEN/NOTIFY — must connect directly to PostgreSQL, not through
    // PgDog/PgBouncer, because LISTEN requires a persistent dedicated connection.
    // NATIVE_DATABASE_URL bypasses the pooler; falls back to DATABASE_URL if unset.
    (() => {
      const realtimeUrl =
        process.env.NATIVE_DATABASE_URL || process.env.DATABASE_URL;
      return realtimeUrl
        ? realtimeManager.start(realtimeUrl)
        : Promise.resolve();
    })().catch((err: Error) => {
      console.warn('⚠️ Realtime init failed (non-fatal):', err.message);
    }),
  ]);
  console.log(
    `✅ Parallel services started in ${Date.now() - parallelStart}ms`,
  );

  // ═══ Background workers (fire-and-forget) ═══
  webhookWorker.start(1000);
  console.log('✅ Webhook worker started');

  await flowScheduler.start(db);
  console.log('✅ Flow scheduler started');

  // 7. Studio — security headers registered BEFORE static file serving.
  // Note: the Studio is a pre-built SvelteKit static export, so runtime nonce
  // injection into HTML is not possible. script-src uses 'unsafe-inline' as
  // required by SvelteKit's compiled hydration scripts.
  app.use('/admin/*', async (c, next) => {
    // Set headers BEFORE await next() so they are always included in the response,
    // regardless of whether the handler returns early (redirect, 404, etc.)
    c.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        // SvelteKit generates inline <script> tags for hydration — unsafe-inline is required.
        // A hash-based CSP could replace this but requires recalculating hashes at build time.
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
    await next();
  });

  // 7b. Studio static files — served at /admin/ (SvelteKit base: '/admin')
  app.get('/admin', (c) => c.redirect('/admin/'));
  app.use('/admin/*', async (c, next) => {
    const path = c.req.path.replace(/^\/admin/, '') || '/';
    const res = await serveStaticFile(STUDIO_DIST, path);
    if (res) return res;
    return next();
  });

  // 9. API: active extensions list (Studio consumes this)
  // Returns only bundle URLs (needed for UI loading), not the full list
  app.get('/api/extensions', async (c) => {
    return c.json({
      bundles: extensionLoader.getBundles(),
    });
  });

  // 10. Health check — liveness probe, always 200 if engine is running.
  // DB connectivity is verified at startup (initDatabase retries until ready).
  // Full readiness check is at /api/health.
  app.get('/health', (c) => c.json({ status: 'ok' }, 200));

  // 11. Prometheus-compatible metrics
  const startTime = Date.now();
  let requestCount = 0;
  app.use('*', async (c, next) => {
    requestCount++;
    await next();
  });
  app.get('/metrics', (c) => {
    const metricsToken = process.env.METRICS_TOKEN;
    if (metricsToken) {
      const provided =
        c.req.header('Authorization')?.replace('Bearer ', '') ??
        c.req.query('token');
      if (provided !== metricsToken) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    const uptime = (Date.now() - startTime) / 1000;
    const memoryReport = getMemoryReport();
    const lines = [
      '# HELP zveltio_uptime_seconds Server uptime in seconds',
      '# TYPE zveltio_uptime_seconds gauge',
      `zveltio_uptime_seconds ${uptime.toFixed(3)}`,
      '# HELP zveltio_requests_total Total HTTP requests received',
      '# TYPE zveltio_requests_total counter',
      `zveltio_requests_total ${requestCount}`,
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

  // 11b. API 404 — any unmatched /api/* returns JSON, not the SPA index.html.
  // Without this, Hono falls through to the SPA catch-all below and serves
  // index.html, which the client then tries to JSON.parse → "Unexpected token '<'".
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // 12. Client SPA — catch-all (must be registered AFTER all API/admin routes)
  app.use('/*', async (c) => {
    const res = await serveStaticFile(CLIENT_DIST, c.req.path);
    if (res) return res;
    return c.notFound();
  });

  // Start server
  const port = parseInt(process.env.PORT || '3000');
  const host = process.env.HOST || '0.0.0.0';

  Bun.serve({
    fetch(req, server) {
      // Pass `server` through env so Hono's /api/ws route can call server.upgrade().
      // Auth is checked inside the /api/ws Hono handler before upgrading.
      return app.fetch(req, { server });
    },
    websocket: websocketHandler,
    port,
    hostname: host,
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
