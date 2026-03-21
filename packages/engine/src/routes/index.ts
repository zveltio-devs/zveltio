import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { collectionsRoutes } from './collections.js';
import { dataRoutes } from './data.js';
import { authRoutes } from './auth.js';
import { usersRoutes } from './users.js';
import { permissionsRoutes } from './permissions.js';
import { storageRoutes } from './storage.js';
import { webhooksRoutes } from './webhooks.js';
import { settingsRoutes } from './settings.js';
import { adminRoutes } from './admin.js';
import { wsRoutes } from './ws.js';
import { relationsRoutes } from './relations.js';
import { revisionsRoutes } from './revisions.js';
import { realtimeRoutes } from './realtime.js';
import { notificationsRoutes } from './notifications.js';
import { healthRoutes } from './health.js';
import { flowsRoutes } from './flows.js';
import { tenantsRoutes } from './tenants.js';
import { aiRoutes } from './ai.js';
import { aiChatsRoutes } from './ai-chats.js';
import { zveltioAIRoutes } from './zveltio-ai.js';
import { aiAnalyticsRoutes } from './ai-analytics.js';
import { aiAlchemistRoutes } from './ai-alchemist.js';
import { aiQueryRoutes } from './ai-query.js';
import { aiSchemaGenRoutes } from './ai-schema-gen.js';
// graphql → extensions/developer/graphql
// media → extensions/content/media
// approvals → extensions/workflow/approvals
// drafts → extensions/content/drafts
// documents → extensions/content/documents
import { syncRoutes } from './sync.js';
import { initDDLQueue } from '../lib/ddl-queue.js';
import { authRateLimit, apiRateLimit, aiRateLimit, writeRateLimit } from '../middleware/rate-limit.js';
import { tenantQuota } from '../middleware/tenant-quota.js';

// ── Core routes (always registered) ─────────────────────────────────────────
// /api/flows         — automation flows (routes/flows.ts)
// /api/tenants       — multi-tenancy (routes/tenants.ts)
// /api/ai/*          — AI: providers, chat, embeddings, search, alchemist, query, schema-gen
// /api/zveltio-ai    — ZveltioAI conversational agent
// /api/ai-analytics  — AI usage & cost tracking
//
// ── Extension routes (registered by extension on load) ───────────────────────
// /api/mail             → extensions/communications/mail
// /api/cloud + /share   → extensions/storage/cloud
// /api/pages            → extensions/content/page-builder
// /api/document-templates → extensions/content/document-templates
// /api/documents        → extensions/content/documents
// /api/approvals        → extensions/workflow/approvals
// /api/drafts           → extensions/content/drafts
// /api/media            → extensions/content/media
// /api/graphql          → extensions/developer/graphql
// /api/insights         → extensions/analytics/insights
// /api/quality          → extensions/analytics/quality
// /api/saved-queries    → extensions/developer/saved-queries
// /api/validation       → extensions/developer/validation
// /api/export           → extensions/data/export
// /api/import           → extensions/data/import
// /api/translations     → extensions/i18n/translations
// ────────────────────────────────────────────────────────────────────────────

interface RoutesContext {
  db: Database;
  auth: any;
}

export async function registerCoreRoutes(app: Hono, ctx: RoutesContext): Promise<void> {
  const { db, auth } = ctx;

  // Initialize DDL job queue (async — resets stale 'running' jobs before polling starts)
  await initDDLQueue(db);

  // ── Rate limiting ─────────────────────────────────────────────────────────
  app.use('/api/auth/sign-in/*', authRateLimit);
  app.use('/api/auth/sign-up/*', authRateLimit);
  app.use('/api/auth/forgot-password', authRateLimit);
  app.use('/api/ai/*', aiRateLimit);
  // Write operations (POST/PUT/PATCH/DELETE) on data are stricter (60/min) than reads (200/min)
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/api/data/*', writeRateLimit);
  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/api/sync/*', writeRateLimit);
  app.use('/api/*', apiRateLimit);

  // ── Tenant daily quota enforcement (runs after tenant middleware in index.ts) ──
  app.use('/api/*', tenantQuota(db));

  // Better-Auth handler — handles all /api/auth/** routes
  app.on(['GET', 'POST'], '/api/auth/**', async (c) => {
    try {
      return await auth.handler(c.req.raw);
    } catch (err) {
      console.error('[Auth Handler] Unhandled error:', err);
      return c.json({ error: 'Auth handler failed', detail: String(err) }, 500);
    }
  });

  // Profile convenience routes
  app.route('/api/me', authRoutes(db, auth));

  // Collections schema management (admin)
  app.route('/api/collections', collectionsRoutes(db, auth));

  // Collection relations (admin)
  app.route('/api/relations', relationsRoutes(db, auth));

  // Generic data CRUD (session + API key)
  app.route('/api/data', dataRoutes(db, auth));

  // Users management (admin)
  app.route('/api/users', usersRoutes(db, auth));

  // Permissions / Casbin (admin)
  app.route('/api/permissions', permissionsRoutes(db, auth));

  // File storage (authenticated)
  app.route('/api/storage', storageRoutes(db, auth));

  // Webhooks (admin)
  app.route('/api/webhooks', webhooksRoutes(db, auth));

  // Settings (admin + public subset)
  app.route('/api/settings', settingsRoutes(db, auth));

  // Export — moved to extensions/data/export

  // Import CSV/JSON — moved to extensions/data/import

  // Health + version + migration status + update check (public)
  app.route('/api/health', healthRoutes(db));

  // Admin utilities: API keys, notifications, audit, types, onboarding
  app.route('/api/admin', adminRoutes(db, auth));

  // Revisions + record comments (authenticated)
  app.route('/api/revisions', revisionsRoutes(db, auth));

  // i18n translations — moved to extensions/i18n/translations

  // In-app notifications + web push (authenticated)
  app.route('/api/notifications', notificationsRoutes(db, auth));

  // Real-time SSE stream (authenticated)
  app.route('/api/realtime', realtimeRoutes(db, auth));

  // Extension marketplace — moved to extensionLoader.registerMarketplace() in bootstrap

  // Schema branches — moved to extensions/developer/schema-branches

  // API documentation portal — moved to extensions/developer/api-docs

  // Database management — moved to extensions/developer/database

  // Media library — moved to extensions/content/media

  // Database backups — moved to extensions/operations/backup

  // GraphQL auto-generated API — moved to extensions/developer/graphql

  // Approval Workflows — moved to extensions/workflow/approvals

  // Content Draft/Publish Workflow — moved to extensions/content/drafts

  // GDPR Compliance — moved to extensions/compliance/gdpr

  // Saved Queries — moved to extensions/developer/saved-queries

  // Data Validation Rules — moved to extensions/developer/validation

  // Data Quality Dashboard — moved to extensions/analytics/quality

  // Analytics Insights — moved to extensions/analytics/insights

  // Documents Management — moved to extensions/content/documents

  // Automation flows (core)
  app.route('/api/flows', flowsRoutes(db, auth));

  // Multi-tenancy management (core)
  app.route('/api/tenants', tenantsRoutes(db, auth));

  // AI — deeply integrated into the platform (core)
  app.route('/api/ai', aiRoutes(db, auth));
  app.route('/api/ai', aiChatsRoutes(db, auth));
  app.route('/api/ai', aiSchemaGenRoutes(db, auth));
  app.route('/api/ai/alchemist', aiAlchemistRoutes(db, auth));
  app.route('/api/ai/query', aiQueryRoutes(db, auth));
  app.route('/api/zveltio-ai', zveltioAIRoutes(db, auth));
  app.route('/api/ai-analytics', aiAnalyticsRoutes(db, auth));

  // SDK Local-First Sync (push/pull batch operations)
  app.route('/api/sync', syncRoutes(db, auth));

  // BYOD Introspection — moved to extensions/developer/byod

  // Edge Functions — moved to extensions/developer/edge-functions (loaded when extension is active)

  // P2: XML-escape helper to prevent injection via SITE_URL or page slugs
  function xmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  // Sitemap (public)
  app.get('/api/sitemap.xml', async (c) => {
    const siteUrl = xmlEscape(process.env.SITE_URL || 'https://example.com');
    try {
      const pages = await sql<{ slug: string; updated_at: Date }>`
        SELECT slug, updated_at FROM zv_pages WHERE is_active = true ORDER BY slug
      `.execute(db).catch(() => ({ rows: [] }));

      const urls = pages.rows
        .map((p) => `  <url>
    <loc>${siteUrl}/${xmlEscape(p.slug)}</loc>
    <lastmod>${new Date(p.updated_at).toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
  </url>`)
        .join('\n');

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
${urls}
</urlset>`;

      return c.text(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
    } catch {
      return c.text('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', 200, { 'Content-Type': 'application/xml; charset=utf-8' });
    }
  });

  // WebSocket info (actual upgrade in Bun.serve)
  app.route('', wsRoutes(db, auth));
}
