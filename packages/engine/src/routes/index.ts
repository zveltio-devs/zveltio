import type { Hono } from 'hono';
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

  // WebSocket info (actual upgrade in Bun.serve)
  app.route('', wsRoutes(db, auth));
}
