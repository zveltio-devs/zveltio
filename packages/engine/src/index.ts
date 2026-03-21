import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
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
import { initTelemetry } from './lib/telemetry.js';
import { engineEvents } from './lib/event-bus.js';
import { checkSchemaCompatibility, ENGINE_VERSION } from './version.js';
import { sql } from 'kysely';

const app = new Hono();

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
  registerCoreRoutes(app, { db, auth });
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

    // Realtime LISTEN/NOTIFY — enables cross-instance WebSocket broadcasts
    (process.env.DATABASE_URL
      ? realtimeManager.start(process.env.DATABASE_URL)
      : Promise.resolve()
    ).catch((err: Error) => {
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
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
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

  // 7b. Studio — serve embedded static files at /admin
  app.get('/admin', (c) => c.redirect('/admin/'));
  app.use('/admin/*', async (c) => {
    let path = c.req.path.replace('/admin', '') || '/';
    if (path === '/') path = '/index.html';

    // Try to load from embedded files first (binary mode), then disk (dev mode)
    let fileContent: string | Uint8Array | null = null;

    // Attempt embedded (generated at build time)
    try {
      // @ts-ignore — studio-embed is generated at build time
      const { getStudioFile } = await import('./studio-embed/index.js');
      let result = getStudioFile(path);
      // SPA fallback
      if (!result) result = getStudioFile('/index.html');
      if (result) {
        fileContent = result.content;
      }
    } catch {
      // Embedded not available — fall through to disk serving (dev mode)
    }

    // Disk fallback (dev mode: studio-dist/ on filesystem)
    if (fileContent === null) {
      const diskPath = `${import.meta.dir}/studio-dist${path}`;
      const diskFile = Bun.file(diskPath);
      if (await diskFile.exists()) {
        fileContent = await diskFile
          .arrayBuffer()
          .then((b) => new Uint8Array(b));
      } else {
        // SPA fallback
        const indexFile = Bun.file(`${import.meta.dir}/studio-dist/index.html`);
        if (await indexFile.exists()) {
          fileContent = await indexFile.text();
        }
      }
    }

    if (fileContent === null) {
      return c.text('Studio not built. Run: bun run build:studio', 404);
    }

    c.header('Content-Type', getContentType(path));
    if (path.match(/\.(js|css|woff2?)(\?.*)?$/)) {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    }
    return c.body(fileContent as any);
  });

  // 9. API: active extensions list (Studio consumes this)
  // Returns only bundle URLs (needed for UI loading), not the full list
  app.get('/api/extensions', async (c) => {
    return c.json({
      bundles: extensionLoader.getBundles(),
    });
  });

  // 10. Health check — public endpoint, returns MINIMAL: just status
  // (full details at /api/admin/status — authenticated)
  app.get('/health', async (c) => {
    const checks: Record<string, 'ok' | 'error'> = {};
    try {
      await sql`SELECT 1`.execute(db);
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    return c.json(
      { status: allOk ? 'healthy' : 'degraded' },
      allOk ? 200 : 503,
    );
  });

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
    ];
    return c.text(lines.join('\n') + '\n', 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
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
