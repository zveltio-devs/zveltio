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
// graphql → extensions/developer/graphql
// tenants → extensions/multitenancy
// media → extensions/content/media
// approvals → extensions/workflow/approvals
// drafts → extensions/content/drafts
// documents → extensions/content/documents
// ai → extensions/ai/core-ai
import { syncRoutes } from './sync.js';
import { initDDLQueue } from '../lib/ddl-queue.js';
import { authRateLimit, apiRateLimit, aiRateLimit } from '../middleware/rate-limit.js';
import { tenantQuota } from '../middleware/tenant-quota.js';

// ── Moved to extensions ──────────────────────────────────────────────────────
// /api/mail             → extensions/communications/mail
// /api/cloud + /share   → extensions/storage/cloud
// /api/pages            → extensions/content/page-builder (cms-routes)
// /api/document-templates → extensions/content/document-templates
// /api/documents        → extensions/content/documents
// /api/ai/alchemist     → extensions/ai/core-ai
// /api/ai/query         → extensions/ai/core-ai
// /api/ai (schema-gen)  → extensions/ai/core-ai
// /api/approvals        → extensions/workflow/approvals
// /api/drafts           → extensions/content/drafts
// /api/media            → extensions/content/media
// /api/tenants          → extensions/multitenancy
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
  app.use('/api/*', apiRateLimit);

  // ── Tenant daily quota enforcement (runs after tenant middleware in index.ts) ──
  app.use('/api/*', tenantQuota(db));

  // Better-Auth handler — handles all /api/auth/** routes
  app.on(['GET', 'POST'], '/api/auth/**', (c) => auth.handler(c.req.raw));

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

  // AI core — moved to extensions/ai/core-ai

  // Extension marketplace — moved to extensionLoader.registerMarketplace() in bootstrap

  // Schema branches — moved to extensions/developer/schema-branches

  // API documentation portal — moved to extensions/developer/api-docs

  // Database management — moved to extensions/developer/database

  // Multi-tenancy — moved to extensions/multitenancy

  // Flows — moved to extensions/automation/flows (loaded when extension is active)

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

  // SDK Local-First Sync (push/pull batch operations)
  app.route('/api/sync', syncRoutes(db, auth));

  // BYOD Introspection — moved to extensions/developer/byod

  // Edge Functions — moved to extensions/developer/edge-functions (loaded when extension is active)

  // Sitemap (public)
  app.get('/api/sitemap.xml', async (c) => {
    const siteUrl = process.env.SITE_URL || 'https://example.com';
    try {
      const pages = await sql<{ slug: string; updated_at: Date }>`
        SELECT slug, updated_at FROM zv_pages WHERE is_published = true ORDER BY slug
      `.execute(db).catch(() => ({ rows: [] }));

      const urls = pages.rows
        .map((p) => `  <url>
    <loc>${siteUrl}/${p.slug}</loc>
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
