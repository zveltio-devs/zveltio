/**
 * Content Draft / Publish Workflow
 *
 * GET    /api/drafts                       — list drafts (filters: collection, record_id, status)
 * GET    /api/drafts/settings/:collection  — get publish settings for collection
 * PUT    /api/drafts/settings/:collection  — update publish settings (admin)
 * POST   /api/drafts                       — create new draft
 * GET    /api/drafts/:id                   — get single draft
 * PATCH  /api/drafts/:id                   — update draft (data, status, notes)
 * POST   /api/drafts/:id/publish           — publish draft to live record
 * DELETE /api/drafts/:id                   — discard draft
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';

const PublishSettingsSchema = z.object({
  drafts_enabled: z.boolean().optional(),
  require_review: z.boolean().optional(),
  reviewer_roles: z.array(z.string()).optional(),
  auto_publish: z.boolean().optional(),
});

// ── Zod schemas ───────────────────────────────────────────────────────────────

const CreateDraftSchema = z.object({
  collection: z.string(),
  record_id: z.string().uuid(),
  draft_data: z.record(z.string(), z.any()),
  notes: z.string().optional(),
  scheduled_at: z.string().datetime().optional(),
});

const UpdateDraftSchema = z.object({
  draft_data: z.record(z.string(), z.any()).optional(),
  status: z.enum(['draft', 'review', 'approved', 'rejected']).optional(),
  notes: z.string().optional(),
  scheduled_at: z.string().datetime().optional(),
});

// Safe collection name pattern — same as DDLManager.getTableName validates
const SAFE_COLLECTION_RE = /^[a-z][a-z0-9_]*$/;

// Fields that must never be overwritten via draft publish (system columns)
const DRAFT_PROTECTED_FIELDS = new Set([
  'id', 'created_at', 'created_by', 'updated_at', 'tenant_id',
  'search_vector', 'embedding',
]);

// ── Route factory ─────────────────────────────────────────────────────────────

export function draftsRoutes(db: Database, _auth: any): Hono {
  const app = new Hono();

  // Auth middleware
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', { ...session.user, role: (session.user as any).role ?? 'admin' });
    return next();
  });

  // GET / — list drafts
  app.get('/', async (c) => {
    const user = c.get('user');
    const effectiveDb = (c.get('tenantTrx') as Database | null) ?? db;
    const { collection, record_id, status } = c.req.query();

    const canRead = await checkPermission(user.id, collection || 'drafts', 'read');
    if (!canRead) return c.json({ error: 'Forbidden' }, 403);

    let query = (effectiveDb as any)
      .selectFrom('zv_content_drafts')
      .selectAll()
      .orderBy('created_at', 'desc');

    if (collection) query = query.where('collection', '=', collection);
    if (record_id) query = query.where('record_id', '=', record_id);
    if (status) query = query.where('status', '=', status);

    const drafts = await query.execute();
    return c.json({ drafts });
  });

  // GET /settings/:collection — get publish settings (before /:id)
  app.get('/settings/:collection', async (c) => {
    const collection = c.req.param('collection');
    const effectiveDb = (c.get('tenantTrx') as Database | null) ?? db;
    const settings = await (effectiveDb as any)
      .selectFrom('zv_collection_publish_settings')
      .selectAll()
      .where('collection', '=', collection)
      .executeTakeFirst();

    return c.json({
      settings: settings || {
        collection,
        drafts_enabled: false,
        require_review: false,
        reviewer_roles: ['admin'],
        auto_publish: false,
      },
    });
  });

  // PUT /settings/:collection — update publish settings
  app.put('/settings/:collection', zValidator('json', PublishSettingsSchema), async (c) => {
    const user = c.get('user');
    const effectiveDb = (c.get('tenantTrx') as Database | null) ?? db;
    const collection = c.req.param('collection');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    const body = c.req.valid('json');
    const existing = await (effectiveDb as any)
      .selectFrom('zv_collection_publish_settings')
      .select('id')
      .where('collection', '=', collection)
      .executeTakeFirst();

    if (existing) {
      await (effectiveDb as any)
        .updateTable('zv_collection_publish_settings')
        .set({ ...body, collection, updated_at: new Date() })
        .where('collection', '=', collection)
        .execute();
    } else {
      await (effectiveDb as any)
        .insertInto('zv_collection_publish_settings')
        .values({ collection, ...body })
        .execute();
    }

    return c.json({ success: true });
  });

  // POST / — create draft
  app.post('/', zValidator('json', CreateDraftSchema), async (c) => {
    const user = c.get('user');
    const effectiveDb = (c.get('tenantTrx') as Database | null) ?? db;
    const data = c.req.valid('json');

    const canCreate = await checkPermission(user.id, data.collection, 'update');
    if (!canCreate) return c.json({ error: 'Forbidden' }, 403);

    const versionResult = await (effectiveDb as any)
      .selectFrom('zv_revisions')
      .select((effectiveDb as any).fn.count('id').as('count'))
      .where('collection', '=', data.collection)
      .where('record_id', '=', data.record_id)
      .executeTakeFirst();

    const baseVersion = parseInt(versionResult?.count || '0') + 1;

    const draft = await (effectiveDb as any)
      .insertInto('zv_content_drafts')
      .values({
        collection: data.collection,
        record_id: data.record_id,
        draft_data: JSON.stringify(data.draft_data),
        base_version: baseVersion,
        status: 'draft',
        notes: data.notes || null,
        scheduled_at: data.scheduled_at ? new Date(data.scheduled_at) : null,
        created_by: user.id,
      })
      .returningAll()
      .executeTakeFirst();

    if (data.scheduled_at && draft) {
      await (effectiveDb as any)
        .insertInto('zv_publish_schedule')
        .values({ draft_id: draft.id, scheduled_at: new Date(data.scheduled_at) })
        .execute();
    }

    return c.json({ draft }, 201);
  });

  // GET /:id — get single draft
  app.get('/:id', async (c) => {
    const user = c.get('user');
    const effectiveDb = (c.get('tenantTrx') as Database | null) ?? db;
    const id = c.req.param('id');

    const draft = await (effectiveDb as any)
      .selectFrom('zv_content_drafts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!draft) return c.json({ error: 'Draft not found' }, 404);

    const canRead = await checkPermission(user.id, draft.collection, 'read');
    if (!canRead) return c.json({ error: 'Forbidden' }, 403);

    return c.json({ draft });
  });

  // PATCH /:id — update draft
  app.patch('/:id', zValidator('json', UpdateDraftSchema), async (c) => {
    const user = c.get('user');
    const effectiveDb = (c.get('tenantTrx') as Database | null) ?? db;
    const id = c.req.param('id');
    const data = c.req.valid('json');

    const draft = await (effectiveDb as any)
      .selectFrom('zv_content_drafts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!draft) return c.json({ error: 'Draft not found' }, 404);

    const canUpdate = await checkPermission(user.id, draft.collection, 'update');
    if (!canUpdate) return c.json({ error: 'Forbidden' }, 403);

    const updateData: Record<string, any> = { updated_at: new Date() };
    if (data.draft_data) updateData.draft_data = JSON.stringify(data.draft_data);
    if (data.notes !== undefined) updateData.notes = data.notes;
    if (data.scheduled_at !== undefined) {
      updateData.scheduled_at = data.scheduled_at ? new Date(data.scheduled_at) : null;
    }
    if (data.status) {
      updateData.status = data.status;
      if (data.status === 'approved' || data.status === 'rejected') {
        updateData.reviewed_by = user.id;
        updateData.reviewed_at = new Date();
      }
    }

    const updated = await (effectiveDb as any)
      .updateTable('zv_content_drafts')
      .set(updateData)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return c.json({ draft: updated });
  });

  // POST /:id/publish — publish draft to live record
  app.post('/:id/publish', async (c) => {
    const user = c.get('user');
    const effectiveDb = (c.get('tenantTrx') as Database | null) ?? db;
    const id = c.req.param('id');

    const draft = await (effectiveDb as any)
      .selectFrom('zv_content_drafts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!draft) return c.json({ error: 'Draft not found' }, 404);

    // N2: validate collection name before interpolating into table name
    if (!SAFE_COLLECTION_RE.test(draft.collection)) {
      return c.json({ error: 'Invalid collection name in draft' }, 400);
    }

    const settings = await (effectiveDb as any)
      .selectFrom('zv_collection_publish_settings')
      .selectAll()
      .where('collection', '=', draft.collection)
      .executeTakeFirst();

    if (settings?.require_review && draft.status !== 'approved') {
      return c.json({ error: 'Draft must be approved before publishing' }, 422);
    }

    const canPublish = await checkPermission(user.id, draft.collection, 'update');
    if (!canPublish) return c.json({ error: 'Forbidden' }, 403);

    const tableName = `zvd_${draft.collection}`;
    const rawDraftData = typeof draft.draft_data === 'string' ? JSON.parse(draft.draft_data) : draft.draft_data;

    // N1: strip protected system fields — prevent created_by/tenant_id overwrite via draft data
    const draftData: Record<string, any> = {};
    for (const [k, v] of Object.entries(rawDraftData ?? {})) {
      if (!DRAFT_PROTECTED_FIELDS.has(k)) draftData[k] = v;
    }

    await (effectiveDb as any)
      .updateTable(tableName)
      .set({ ...draftData, updated_at: new Date() })
      .where('id', '=', draft.record_id)
      .execute();

    await (effectiveDb as any)
      .updateTable('zv_content_drafts')
      .set({ status: 'approved', published_at: new Date() })
      .where('id', '=', id)
      .execute();

    // Broadcast WS event (non-critical)
    try {
      const { broadcastEvent } = await import('./ws.js');
      broadcastEvent(draft.collection, 'update', { record_id: draft.record_id, source: 'draft_publish', timestamp: Date.now() });
    } catch { /* WS broadcast is non-critical */ }

    return c.json({ success: true, record_id: draft.record_id });
  });

  // DELETE /:id — discard draft
  app.delete('/:id', async (c) => {
    const user = c.get('user');
    const effectiveDb = (c.get('tenantTrx') as Database | null) ?? db;
    const id = c.req.param('id');

    const draft = await (effectiveDb as any)
      .selectFrom('zv_content_drafts')
      .select(['id', 'collection', 'created_by'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!draft) return c.json({ error: 'Draft not found' }, 404);

    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (draft.created_by !== user.id && !isAdmin) return c.json({ error: 'Forbidden' }, 403);

    await (effectiveDb as any).deleteFrom('zv_content_drafts').where('id', '=', id).execute();
    return c.json({ success: true });
  });

  return app;
}
