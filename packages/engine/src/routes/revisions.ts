import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import { dynamicUpdate } from '../db/dynamic.js';
import { DDLManager } from '../lib/ddl-manager.js';

export function revisionsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth middleware
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });

  // GET / — List revisions with user join (admin only)
  app.get('/', async (c) => {
    const user = c.get('user') as any;
    if (!(await checkPermission(user.id, 'admin', '*'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const { collection, record_id, user_id, action, limit = '50', page = '1' } = c.req.query();
    const lim = Math.min(parseInt(limit), 200);
    const offset = (parseInt(page) - 1) * lim;

    const rows = await sql`
      SELECT
        r.*,
        u.name AS user_name,
        u.email AS user_email
      FROM zv_revisions r
      LEFT JOIN "user" u ON u.id = r.user_id
      WHERE 1=1
        ${collection ? sql`AND r.collection = ${collection}` : sql``}
        ${record_id ? sql`AND r.record_id = ${record_id}` : sql``}
        ${user_id ? sql`AND r.user_id = ${user_id}` : sql``}
        ${action ? sql`AND r.action = ${action}` : sql``}
      ORDER BY r.created_at DESC
      LIMIT ${lim} OFFSET ${offset}
    `.execute(db);

    const total = await sql<{ count: string }>`
      SELECT COUNT(*)::int AS count FROM zv_revisions
      WHERE 1=1
        ${collection ? sql`AND collection = ${collection}` : sql``}
        ${record_id ? sql`AND record_id = ${record_id}` : sql``}
        ${user_id ? sql`AND user_id = ${user_id}` : sql``}
        ${action ? sql`AND action = ${action}` : sql``}
    `.execute(db);

    return c.json({
      revisions: rows.rows,
      pagination: {
        total: (total.rows[0] as any)?.count ?? 0,
        page: parseInt(page),
        limit: lim,
      },
    });
  });

  // GET /:id — Get single revision
  app.get('/:id', async (c) => {
    const user = c.get('user') as any;
    if (!(await checkPermission(user.id, 'admin', '*'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const rows = await sql`
      SELECT r.*, u.name AS user_name, u.email AS user_email
      FROM zv_revisions r
      LEFT JOIN "user" u ON u.id = r.user_id
      WHERE r.id = ${c.req.param('id')}
    `.execute(db);

    const revision = rows.rows[0];
    if (!revision) return c.json({ error: 'Revision not found' }, 404);

    return c.json({ revision });
  });

  // POST /:id/revert — Revert record to this revision's state
  app.post('/:id/revert', async (c) => {
    const user = c.get('user') as any;
    if (!(await checkPermission(user.id, 'admin', '*'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const revision = await (db as any)
      .selectFrom('zv_revisions')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!revision) return c.json({ error: 'Revision not found' }, 404);
    if (revision.action === 'delete') {
      return c.json({ error: 'Cannot revert a delete — record no longer exists' }, 400);
    }

    const tableName = DDLManager.getTableName(revision.collection);
    const data = typeof revision.data === 'string' ? JSON.parse(revision.data) : revision.data;

    // P2: strip ALL protected system fields before reverting — prevents tenant_id / search_vector overwrite
    const REVERT_PROTECTED = new Set(['id', 'created_at', 'updated_at', 'tenant_id', 'search_vector', 'embedding', 'created_by']);
    const revertData: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!REVERT_PROTECTED.has(k)) revertData[k] = v;
    }

    const reverted = await dynamicUpdate(db, tableName, revision.record_id, {
      ...revertData,
      updated_by: user.id,
    });

    if (!reverted) return c.json({ error: 'Record not found — may have been deleted' }, 404);

    // Log the revert as a new revision
    await (db as any)
      .insertInto('zv_revisions')
      .values({
        collection: revision.collection,
        record_id: revision.record_id,
        action: 'update',
        data: JSON.stringify(reverted),
        delta: JSON.stringify({ _reverted_from: revision.id }),
        user_id: user.id,
      })
      .execute()
      .catch(() => { /* non-fatal */ });

    return c.json({ success: true, record: reverted });
  });

  // GET /record/:collection/:id/comments — Get comments for a record
  app.get('/record/:collection/:recordId/comments', async (c) => {
    const user = c.get('user') as any;
    const { collection, recordId } = c.req.param();

    if (!(await checkPermission(user.id, collection, 'read')) &&
        !(await checkPermission(user.id, 'admin', '*'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const comments = await sql`
      SELECT
        rc.*,
        u.name AS user_name,
        u.email AS user_email
      FROM zv_record_comments rc
      LEFT JOIN "user" u ON u.id = rc.user_id
      WHERE rc.collection = ${collection} AND rc.record_id = ${recordId}
      ORDER BY rc.created_at ASC
    `.execute(db);

    return c.json({ comments: comments.rows });
  });

  // POST /record/:collection/:id/comments — Add comment
  app.post(
    '/record/:collection/:recordId/comments',
    zValidator('json', z.object({ comment: z.string().min(1).max(2000) })),
    async (c) => {
      const user = c.get('user') as any;
      const { collection, recordId } = c.req.param();
      const { comment } = c.req.valid('json');

      // Try to insert — table may not exist in all deployments, non-fatal
      try {
        const row = await sql`
          INSERT INTO zv_record_comments (collection, record_id, comment, user_id)
          VALUES (${collection}, ${recordId}, ${comment}, ${user.id})
          RETURNING *
        `.execute(db);

        return c.json({ comment: row.rows[0] }, 201);
      } catch (err: any) {
        if (err.message?.includes('does not exist')) {
          return c.json({ error: 'Comments feature not yet migrated. Run migrations.' }, 503);
        }
        throw err;
      }
    },
  );

  // DELETE /record/comments/:commentId — Delete comment
  app.delete('/record/comments/:commentId', async (c) => {
    const user = c.get('user') as any;
    const commentId = c.req.param('commentId');
    const isAdmin = await checkPermission(user.id, 'admin', '*');

    // Replaced `OR TRUE` idiom (confusing, hard to audit) with explicit branch.
    // Admins can delete any comment; non-admins can only delete their own.
    if (isAdmin) {
      await sql`DELETE FROM zv_record_comments WHERE id = ${commentId}`.execute(db);
    } else {
      await sql`
        DELETE FROM zv_record_comments
        WHERE id = ${commentId} AND user_id = ${user.id}
      `.execute(db);
    }

    return c.json({ success: true });
  });

  return app;
}
