import { type Context, Hono } from 'hono';
import { guardSession } from '../lib/admin-guard.js';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission, isTenantAdmin } from '../lib/tenancy/index.js';
import {
  dataApiWrite,
  readableRevisions,
  recordReadable,
  revertPatch,
  shapeRevisionData,
} from '../lib/data/index.js';
import { reqDb, tenantId } from '../lib/route-db.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function revisionsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  /**
   * A record's comments are read and written by whoever may read the record:
   * collection `read`, then the row through its policies. The list checked only
   * the collection, so a row policy hid the record and not what was said about
   * it; the write checked nothing.
   */
  const commentGate = async (
    c: Context,
    user: { id: string },
    collection: string,
    recordId: string,
  ): Promise<Response | null> => {
    // The record's read gate, with no exception: a tenant admin without read on
    // the collection does not read or write its comments either. Session only
    // (`guardSession` below), so there is no API-key branch.
    if (!(await checkPermission(user.id, collection, 'read'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!(await recordReadable(db, reqDb(c, db), collection, recordId, user, 'session'))) {
      return c.json({ error: 'Record not found' }, 404);
    }
    return null;
  };

  // Auth middleware
  app.use('*', async (c, next) => {
    const session = await guardSession(c, auth);
    if (session instanceof Response) return session;
    c.set('user', session.user);
    await next();
  });

  // The revision routes read through `readableRevisions`: a revision is a copy
  // of the record and answers to its read gate (lib/data/revisions-read.ts).
  // The tenant-admin check below narrows who may browse history; it widens
  // nothing.

  // GET / — List revisions with user join (admin only)
  app.get('/', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    if (!(await isTenantAdmin(user.id))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const { collection, record_id, user_id, action, limit = '50', page = '1' } = c.req.query();
    const lim = Math.min(parseInt(limit) || 50, 200);
    const pageNo = Math.max(parseInt(page) || 1, 1);
    const { rows, total } = await readableRevisions(db, reqDb(c, db), tenantId(c), user, {
      collection,
      record_id,
      user_id,
      action,
      limit: lim,
      offset: (pageNo - 1) * lim,
      total: true,
    });

    return c.json({ revisions: rows, pagination: { total, page: pageNo, limit: lim } });
  });

  // GET /:id — Get single revision
  app.get('/:id', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    if (!(await isTenantAdmin(user.id))) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const { rows } = await readableRevisions(db, reqDb(c, db), tenantId(c), user, {
      id: c.req.param('id'),
      limit: 1,
      offset: 0,
    });
    if (!rows[0]) return c.json({ error: 'Revision not found' }, 404);
    return c.json({ revision: rows[0] });
  });

  // POST /:id/revert — Revert record to this revision's state
  app.post('/:id/revert', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    if (!(await isTenantAdmin(user.id))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const { rows, scopes } = await readableRevisions(db, reqDb(c, db), tenantId(c), user, {
      id: c.req.param('id'),
      limit: 1,
      offset: 0,
    });
    const revision = rows[0];
    if (!revision) return c.json({ error: 'Revision not found' }, 404);
    if (revision.action === 'delete') {
      return c.json({ error: 'Cannot revert a delete — record no longer exists' }, 400);
    }
    const scope = scopes.get(revision.collection)!;

    const patch = await revertPatch(reqDb(c, db), scope, revision);

    // A revert is an update, so it is the data API's PATCH: collection
    // `update`, writable columns, row rules, entity access, hooks, and the
    // revision it records. It used to be a raw `dynamicUpdate`, which wrote
    // columns the caller may not write and rows their rules do not reach.
    const res = await dataApiWrite('update', c, db, {
      collection: revision.collection,
      id: revision.record_id,
      body: async () => patch,
      user,
      authType: 'session',
      trx: c.get('tenantTrx') ?? undefined,
      tenantId: tenantId(c),
    });
    if (res.status !== 200) return res;
    const record = await shapeRevisionData(db, scope, revision.collection, await res.json());
    return c.json({ success: true, record });
  });

  // GET /record/:collection/:id/comments — Get comments for a record
  app.get('/record/:collection/:recordId/comments', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    const { collection, recordId } = c.req.param();

    const denied = await commentGate(c, user, collection, recordId);
    if (denied) return denied;

    const comments = await sql`
      SELECT
        rc.*,
        u.name AS user_name,
        u.email AS user_email
      FROM zv_record_comments rc
      LEFT JOIN "user" u ON u.id = rc.user_id
      WHERE rc.collection = ${collection} AND rc.record_id = ${recordId}
        AND rc.tenant_id = ${tenantId(c)}::uuid
      ORDER BY rc.created_at ASC
    `.execute(reqDb(c, db));

    return c.json({ comments: comments.rows });
  });

  // POST /record/:collection/:id/comments — Add comment
  app.post(
    '/record/:collection/:recordId/comments',
    zValidator('json', z.object({ comment: z.string().min(1).max(2000) })),
    async (c) => {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user') as any;
      const { collection, recordId } = c.req.param();
      const { comment } = c.req.valid('json');

      const denied = await commentGate(c, user, collection, recordId);
      if (denied) return denied;

      // Try to insert — table may not exist in all deployments, non-fatal
      try {
        const row = await sql`
          INSERT INTO zv_record_comments (collection, record_id, comment, user_id, tenant_id)
          VALUES (${collection}, ${recordId}, ${comment}, ${user.id}, ${tenantId(c)}::uuid)
          RETURNING *
        `.execute(reqDb(c, db));

        return c.json({ comment: row.rows[0] }, 201);
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user') as any;
    const commentId = c.req.param('commentId');

    // The same gate as reading and writing: a comment on a record the caller
    // cannot read is not theirs to delete, tenant admin or not.
    const target = await sql<{ collection: string; record_id: string }>`
      SELECT collection, record_id FROM zv_record_comments
       WHERE id = ${commentId} AND tenant_id = ${tenantId(c)}::uuid`.execute(reqDb(c, db));
    const row = target.rows[0];
    if (!row) return c.json({ success: true });
    const denied = await commentGate(c, user, row.collection, row.record_id);
    if (denied) return denied;
    const isAdmin = await isTenantAdmin(user.id);

    // Admins can delete any comment they can read; others only their own.
    if (isAdmin) {
      await sql`DELETE FROM zv_record_comments WHERE id = ${commentId} AND tenant_id = ${tenantId(c)}::uuid`.execute(
        reqDb(c, db),
      );
    } else {
      await sql`
        DELETE FROM zv_record_comments
        WHERE id = ${commentId} AND user_id = ${user.id} AND tenant_id = ${tenantId(c)}::uuid
      `.execute(reqDb(c, db));
    }

    return c.json({ success: true });
  });

  return app;
}
