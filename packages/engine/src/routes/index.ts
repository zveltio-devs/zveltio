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
import { exportRoutes } from './export.js';
import { adminRoutes } from './admin.js';
import { wsRoutes } from './ws.js';
import { relationsRoutes } from './relations.js';
import { revisionsRoutes } from './revisions.js';
import { translationsRoutes } from './translations.js';
import { realtimeRoutes } from './realtime.js';
import { notificationsRoutes } from './notifications.js';
import { importRoutes } from './import.js';
import { aiRoutes } from './ai.js';
import { aiSchemaGenRoutes } from './ai-schema-gen.js';
import { graphqlRoutes } from './graphql.js';
import { marketplaceRoutes } from './marketplace.js';
import { schemaBranchesRoutes } from './schema-branches.js';
import { apiDocsRoutes } from './api-docs.js';
import { databaseRoutes } from './database.js';
import { tenantsRoutes } from './tenants.js';
import { flowsRoutes } from './flows.js';
import { mediaRoutes } from './media.js';
import { backupRoutes } from './backup.js';
import { publicPagesRoutes, adminPagesRoutes } from './pages.js';
import { approvalsRoutes } from './approvals.js';
import { draftsRoutes } from './drafts.js';
import { gdprRoutes } from './gdpr.js';
import { savedQueriesRoutes } from './saved-queries.js';
import { validationRoutes } from './validation.js';
import { qualityRoutes } from './quality.js';
import { insightsRoutes } from './insights.js';
import { documentTemplatesRoutes } from './document-templates.js';
import { documentsRoutes } from './documents.js';
import { syncRoutes } from './sync.js';
import { introspectRoutes } from './introspect.js';
import { aiSearchRoutes } from './ai-search.js';
import { cloudRoutes, publicShareRouter, createCloudS3Client } from './cloud.js';
import { aiQueryRoutes } from './ai-query.js';
import { aiAlchemistRoutes } from './ai-alchemist.js';
import { mailRoutes } from './mail.js';
import { initDDLQueue } from '../lib/ddl-queue.js';

interface RoutesContext {
  db: Database;
  auth: any;
}

export async function registerCoreRoutes(app: Hono, ctx: RoutesContext): Promise<void> {
  const { db, auth } = ctx;

  // Initialize DDL job queue (async — resets stale 'running' jobs before polling starts)
  await initDDLQueue(db);

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

  // Export (admin)
  app.route('/api/export', exportRoutes(db, auth));

  // Import CSV/JSON (admin)
  app.route('/api/import', importRoutes(db, auth));

  // Admin utilities: API keys, notifications, audit, types, onboarding
  app.route('/api/admin', adminRoutes(db, auth));

  // Revisions + record comments (authenticated)
  app.route('/api/revisions', revisionsRoutes(db, auth));

  // i18n translations (admin CRUD, public read)
  app.route('/api/translations', translationsRoutes(db, auth));

  // In-app notifications + web push (authenticated)
  app.route('/api/notifications', notificationsRoutes(db, auth));

  // Real-time SSE stream (authenticated)
  app.route('/api/realtime', realtimeRoutes(db, auth));

  // AI: chat, embeddings, prompt templates, provider management
  app.route('/api/ai', aiRoutes(db, auth));

  // AI Prompt-to-Backend schema generator
  app.route('/api/ai', aiSchemaGenRoutes(db, auth));

  // Extension marketplace (admin)
  app.route('/api/marketplace', marketplaceRoutes(db, app));

  // Schema branches — safe schema development without affecting production
  app.route('/api/schema', schemaBranchesRoutes(db, auth));

  // API documentation portal — Swagger UI + OpenAPI spec
  app.route('/api/docs', apiDocsRoutes(db, auth));

  // Database management — functions, triggers, enums, roles, RLS
  app.route('/api/database', databaseRoutes(db, auth));

  // Multi-tenancy — tenant registry, environments, usage
  app.route('/api/tenants', tenantsRoutes(db, auth));

  // Flows — automation CRUD + manual trigger + step execution
  app.route('/api/flows', flowsRoutes(db, auth));

  // Media library — folders, files, tags (authenticated)
  app.route('/api/media', mediaRoutes(db, auth));

  // Database backups (admin)
  app.route('/api/backup', backupRoutes(db, auth));

  // CMS Pages — public read + admin CRUD
  app.route('/api/pages', publicPagesRoutes(db));
  app.route('/api/admin/pages', adminPagesRoutes(db, auth));

  // GraphQL auto-generated API + Playground
  app.route('/api/graphql', graphqlRoutes(db, auth));

  // Approval Workflows
  app.route('/api/approvals', approvalsRoutes(db, auth));

  // Content Draft/Publish Workflow
  app.route('/api/drafts', draftsRoutes(db, auth));

  // GDPR Compliance
  app.route('/api/gdpr', gdprRoutes(db, auth));

  // Saved Queries + Query Builder
  app.route('/api/saved-queries', savedQueriesRoutes(db, auth));

  // Data Validation Rules
  app.route('/api/validation', validationRoutes(db, auth));

  // Data Quality Dashboard
  app.route('/api/quality', qualityRoutes(db, auth));

  // Analytics Insights (dashboards + panels)
  app.route('/api/insights', insightsRoutes(db, auth));

  // Document Templates (admin-managed HTML/PDF templates)
  app.route('/api/document-templates', documentTemplatesRoutes(db, auth));

  // Documents Management (RO compliance doc generation)
  app.route('/api/documents', documentsRoutes(db, auth));

  // SDK Local-First Sync (push/pull batch operations)
  app.route('/api/sync', syncRoutes(db, auth));

  // BYOD Introspection — scanează schema externă și importă ca unmanaged collections
  app.route('/api/introspect', introspectRoutes(db, auth));

  // AI Semantic Search — vector similarity search across all indexed collections
  app.route('/api/ai/search', aiSearchRoutes(db, auth));

  // Text-to-SQL AI Copilot
  app.route('/api/ai/query', aiQueryRoutes(db, auth));

  // Data Alchemist — documents → structured database
  app.route('/api/ai/alchemist', aiAlchemistRoutes(db, auth));

  // Mail Client — IMAP/SMTP integrated email
  app.route('/api/mail', mailRoutes(db, auth));

  // Cloud Storage — versioning, trash, sharing, favorites, quotas
  const cloudS3 = createCloudS3Client();
  app.route('/api/cloud', cloudRoutes(db, auth, cloudS3));
  // Public share links — clean URLs at /share/:token (no auth required)
  app.route('/share', publicShareRouter(db, cloudS3));

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
