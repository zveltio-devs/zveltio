import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { initDatabase } from './db/index.js';
import { initAuth } from './lib/auth.js';
import { initPermissions } from './lib/permissions.js';
import { fieldTypeRegistry } from './lib/field-type-registry.js';
import { extensionLoader } from './lib/extension-loader.js';
import { registerCoreFieldTypes } from './field-types/index.js';
import { registerCoreRoutes } from './routes/index.js';
import { websocketHandler } from './routes/ws.js';
import { initAIProviders } from './lib/ai-provider.js';
import { WebhookManager } from './lib/webhooks.js';
import { webhookWorker } from './lib/webhook-worker.js';
import { flowScheduler } from './lib/flow-scheduler.js';

const app = new Hono();

// ─── Static file content type helper ─────────────────────────
function getContentType(path: string): string {
  const ext = path.includes('?')
    ? path.substring(path.lastIndexOf('.'), path.indexOf('?')).toLowerCase()
    : path.substring(path.lastIndexOf('.')).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ttf':  'font/ttf',
    '.json': 'application/json',
    '.txt':  'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

// ─── Middleware ───────────────────────────────────────────────
app.use('*', logger());
app.use('/api/*', cors({
  origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
}));

// ─── Bootstrap ───────────────────────────────────────────────
async function bootstrap() {
  console.log('🚀 Zveltio starting...');

  // 1. Database
  const db = await initDatabase();
  console.log('✅ Database connected');

  // 2. Auth
  const auth = await initAuth(db);
  console.log('✅ Auth initialized');

  // 3. Permissions
  await initPermissions(db);
  console.log('✅ Permissions initialized');

  // 4. Field Type Registry — core types
  registerCoreFieldTypes(fieldTypeRegistry);
  console.log(`✅ Field types registered: ${fieldTypeRegistry.list().join(', ')}`);

  // 5. Core routes
  registerCoreRoutes(app, { db, auth });
  console.log('✅ Core routes registered');

  // 6. Extensions — env-var configured
  await extensionLoader.loadAll(app, { db, auth, fieldTypeRegistry });
  console.log(`✅ Extensions loaded: ${extensionLoader.getActive().join(', ') || 'none'}`);

  // 6b-extra. Extensions enabled via DB marketplace (hot-enable without env var)
  await extensionLoader.loadFromDB(db, app);
  console.log(`✅ DB-enabled extensions checked`);

  // 6b. AI providers — init after extensions so extension providers can register too
  await initAIProviders(db);

  // 6c. WebhookManager — init with db so trigger() can query webhooks
  WebhookManager.init(db);

  // 6d. Webhook worker — processes Redis queue (no-op if Redis not configured)
  webhookWorker.start(1000);
  console.log('✅ Webhook worker started');

  // 6e. Flow scheduler — runs cron flows (no-op until automation/flows extension registers executor)
  await flowScheduler.start();
  console.log('✅ Flow scheduler started');
  const aiCount = (await import('./lib/ai-provider.js')).aiProviderManager.list().length;
  if (aiCount > 0) {
    console.log(`✅ AI providers initialized: ${aiCount} provider(s)`);
  }

  // 7. Studio — serve embedded static files at /admin
  app.get('/admin', (c) => c.redirect('/admin/'));
  app.use('/admin/*', async (c) => {
    let path = c.req.path.replace('/admin', '') || '/';
    if (path === '/') path = '/index.html';

    // Try to load from embedded files first (binary mode), then disk (dev mode)
    let fileContent: string | Uint8Array | null = null;
    let isBinary = false;

    // Attempt embedded (generated at build time)
    try {
      const { getStudioFile } = await import('./studio-embed/index.js');
      let result = getStudioFile(path);
      // SPA fallback
      if (!result) result = getStudioFile('/index.html');
      if (result) {
        fileContent = result.content;
        isBinary = result.isBinary;
      }
    } catch {
      // Embedded not available — fall through to disk serving (dev mode)
    }

    // Disk fallback (dev mode: studio-dist/ on filesystem)
    if (fileContent === null) {
      const diskPath = `${import.meta.dir}/studio-dist${path}`;
      const diskFile = Bun.file(diskPath);
      if (await diskFile.exists()) {
        fileContent = await diskFile.arrayBuffer().then((b) => new Uint8Array(b));
        isBinary = true; // serve raw bytes from disk
      } else {
        // SPA fallback
        const indexFile = Bun.file(`${import.meta.dir}/studio-dist/index.html`);
        if (await indexFile.exists()) {
          fileContent = await indexFile.text();
        }
      }
    }

    if (fileContent === null) {
      return c.text('Studio not built. Run: pnpm build:studio', 404);
    }

    c.header('Content-Type', getContentType(path));
    if (path.match(/\.(js|css|woff2?)(\?.*)?$/)) {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    }
    return c.body(fileContent as any);
  });

  // 7b. CSP for /admin
  app.use('/admin/*', async (c, next) => {
    await next();
    c.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
      ].join('; '),
    );
  });

  // 9. API: active extensions list (Studio consumes this)
  app.get('/api/extensions', (c) => {
    return c.json({
      extensions: extensionLoader.getActive(),
      bundles: extensionLoader.getBundles(),
    });
  });

  // 10. Health check
  app.get('/health', (c) => c.json({
    status: 'ok',
    version: '2.0.0',
    uptime: process.uptime(),
    extensions: extensionLoader.getActive(),
  }));

  // 11. Prometheus-compatible metrics
  const startTime = Date.now();
  let requestCount = 0;
  app.use('*', async (c, next) => { requestCount++; await next(); });
  app.get('/metrics', (c) => {
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
      // Upgrade WebSocket connections at /api/ws
      if (req.headers.get('upgrade') === 'websocket' && new URL(req.url).pathname === '/api/ws') {
        const upgraded = server.upgrade(req);
        if (upgraded) return undefined as any;
      }
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
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

bootstrap().catch((err) => {
  console.error('❌ Bootstrap failed:', err);
  process.exit(1);
});

export default app;
