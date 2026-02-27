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
import { initDDLQueue } from '../lib/ddl-queue.js';

interface RoutesContext {
  db: Database;
  auth: any;
}

export function registerCoreRoutes(app: Hono, ctx: RoutesContext): void {
  const { db, auth } = ctx;

  // Initialize DDL job queue
  initDDLQueue(db);

  // Better-Auth handler — handles all /api/auth/** routes
  app.on(['GET', 'POST'], '/api/auth/**', (c) => auth.handler(c.req.raw));

  // Profile convenience routes
  app.route('/api/me', authRoutes(db, auth));

  // Collections schema management (admin)
  app.route('/api/collections', collectionsRoutes(db, auth));

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

  // Export / Import (admin)
  app.route('/api/export', exportRoutes(db, auth));

  // Admin utilities: API keys, notifications, audit, types, onboarding
  app.route('/api/admin', adminRoutes(db, auth));

  // WebSocket info (actual upgrade in Bun.serve)
  app.route('', wsRoutes(db, auth));
}
