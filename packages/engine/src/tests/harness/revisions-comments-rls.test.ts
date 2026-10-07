/**
 * Record comments answer to the same read gate as the record they sit on.
 *
 * `GET …/comments` checked collection-level `read` and nothing else, so a
 * member whose row policy hides a record read every comment on it by naming its
 * id. `POST …/comments` checked nothing at all: any signed-in user wrote a
 * comment onto any collection's record, including one they could not read.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateRlsCache } from '../../lib/tenancy/rls.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hcommentrls_${Date.now()}`;

d('record comments honour the read gate (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let readerCookie = '';
  let strangerCookie = '';
  let tenantAdminCookie = '';
  // A tenant admin who may read and update the collection, under its row rule
  // and its column permissions: `salary` hidden, `grade` read-only.
  let editorCookie = '';
  let editorId = '';
  let policyId = '';
  let openId = '';
  let hiddenId = '';
  const GHOST = `hghost_${Date.now()}`;

  const post = async (title: string, bucket: string): Promise<string> => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({ title, bucket }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  const comment = (cookie: string, recordId: string, text: string) =>
    app.request(`/api/revisions/record/${COLLECTION}/${recordId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ comment: text }),
    });

  const comments = (cookie: string, recordId: string) =>
    app.request(`/api/revisions/record/${COLLECTION}/${recordId}/comments`, {
      headers: { cookie },
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    ({ cookie: readerCookie } = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read'] }],
    }));
    ({ cookie: strangerCookie } = await createMemberSession(app, db));
    // A tenant admin (`admin` / `*`) with no read on this collection.
    ({ cookie: tenantAdminCookie } = await createMemberSession(app, db, {
      grants: [{ collection: 'admin', actions: ['*'] }],
    }));
    ({ cookie: editorCookie, userId: editorId } = await createMemberSession(app, db, {
      grants: [
        { collection: 'admin', actions: ['*'] },
        { collection: COLLECTION, actions: ['read', 'update'] },
        // An orphan grant: the collection is gone, its history is not.
        { collection: GHOST, actions: ['read'] },
      ],
    }));

    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'bucket', type: 'text', required: false, unique: false, indexed: false },
        { name: 'salary', type: 'text', required: false, unique: false, indexed: false },
        { name: 'grade', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    for (const [column, canRead] of [
      ['salary', false],
      ['grade', true],
    ] as const) {
      const res = await app.request('/api/admin/column-permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: godCookie },
        body: JSON.stringify({
          collection_name: COLLECTION,
          column_name: column,
          role: 'member',
          can_read: canRead,
          can_write: false,
        }),
      });
      expect([200, 201]).toContain(res.status);
    }
    await sql`
      INSERT INTO zv_revisions (collection, record_id, action, data, tenant_id)
      VALUES (${GHOST}, ${crypto.randomUUID()}, 'update', ${JSON.stringify({ secret: 'ghost-data' })}::text::jsonb,
              '00000000-0000-0000-0000-000000000001'::uuid)`.execute(db);

    const policy = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({
        collection: COLLECTION,
        role: '*',
        filter_field: 'bucket',
        filter_op: 'eq',
        filter_value_source: 'static:open',
        description: 'only the open bucket',
      }),
    });
    expect(policy.status).toBe(201);
    policyId = ((await policy.json()) as { policy: { id: string } }).policy.id;
    await invalidateRlsCache(COLLECTION);

    openId = await post('open', 'open');
    hiddenId = await post('hidden', 'restricted');
    expect((await comment(godCookie, hiddenId, 'salary review: 120k')).status).toBe(201);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_record_comments WHERE collection = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    if (policyId) {
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${policyId}::uuid`
        .execute(db)
        .catch(() => {});
    }
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_revisions WHERE collection IN (${COLLECTION}, ${GHOST})`
      .execute(db)
      .catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  it('does not list comments on a row the reader’s policy hides', async () => {
    const res = await comments(readerCookie, hiddenId);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('120k');
  });

  it('still lists comments on a row the reader can see', async () => {
    expect((await comment(godCookie, openId, 'visible note')).status).toBe(201);
    const res = await comments(readerCookie, openId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: Array<{ comment: string }> };
    expect(body.comments.map((c) => c.comment)).toContain('visible note');
  });

  it('refuses a comment from a user with no read on the collection', async () => {
    const res = await comment(strangerCookie, openId, 'drive-by');
    expect(res.status).toBe(403);
  });

  // One rule: comments follow the record's read gate. Tenant admin used to be
  // an exception, so an admin without read on the collection read and wrote
  // every comment on any of its records.
  it('refuses comments to a tenant admin with no read on the collection', async () => {
    expect((await comments(tenantAdminCookie, openId)).status).toBe(403);
    expect((await comment(tenantAdminCookie, openId, 'admin note')).status).toBe(403);
  });

  // A revision is a copy of the record: the same rule as its comments.
  it('hides revisions of a collection from a tenant admin with no read on it', async () => {
    const own = await sql<{ id: string }>`
      SELECT id FROM zv_revisions WHERE collection = ${COLLECTION} AND record_id = ${openId}
       LIMIT 1`.execute(db);
    const id = own.rows[0]?.id;
    expect(id).toBeDefined();
    const headers = { cookie: tenantAdminCookie };
    expect((await app.request(`/api/revisions/${id}`, { headers })).status).toBe(404);
    const revert = await app.request(`/api/revisions/${id}/revert`, { method: 'POST', headers });
    expect(revert.status).toBe(404);
    const list = await app.request(`/api/revisions?collection=${COLLECTION}`, { headers });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { revisions: unknown[] }).revisions).toHaveLength(0);
    // God still sees it.
    expect(
      (await app.request(`/api/revisions/${id}`, { headers: { cookie: godCookie } })).status,
    ).toBe(200);
  });

  it('refuses a tenant admin with no read on the collection deleting a comment', async () => {
    const row = await sql<{ id: string }>`
      SELECT id FROM zv_record_comments WHERE collection = ${COLLECTION} AND record_id = ${hiddenId}
       LIMIT 1`.execute(db);
    const id = row.rows[0]!.id;
    const res = await app.request(`/api/revisions/record/comments/${id}`, {
      method: 'DELETE',
      headers: { cookie: tenantAdminCookie },
    });
    expect(res.status).toBe(403);
    const left = await sql`SELECT 1 FROM zv_record_comments WHERE id = ${id}`.execute(db);
    expect(left.rows).toHaveLength(1);
  });

  it('refuses a comment on a row the reader’s policy hides', async () => {
    const res = await comment(readerCookie, hiddenId, 'I can see you');
    expect(res.status).toBe(404);
  });

  it('refuses a comment on a record that does not exist', async () => {
    const res = await comment(godCookie, crypto.randomUUID(), 'into the void');
    expect(res.status).toBe(404);
  });

  // ── Revisions: the record's read gate — row rules, column permissions — and
  //    a revert is an update through the data API's own checks.

  type Revision = {
    id: string;
    record_id: string;
    action: string;
    data: Record<string, unknown>;
    delta: Record<string, unknown> | null;
  };
  const listAs = async (cookie: string, query: string, base = '/api/revisions') => {
    const res = await app.request(`${base}?${query}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { revisions: Revision[] }).revisions;
  };
  const patchAsGod = async (id: string, body: Record<string, unknown>) => {
    const res = await app.request(`/api/data/${COLLECTION}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  };
  const stored = async (id: string) =>
    (
      await sql<Record<string, string>>`
        SELECT * FROM ${sql.table(`zvd_${COLLECTION}`)} WHERE id = ${id}::uuid`.execute(db)
    ).rows[0]!;
  const revisionOf = async (recordId: string, action: string) =>
    (
      await sql<{ id: string }>`
        SELECT id FROM zv_revisions WHERE collection = ${COLLECTION} AND record_id = ${recordId}
           AND action = ${action} ORDER BY created_at ASC LIMIT 1`.execute(db)
    ).rows[0]!.id;

  it('does not list revisions of a row the row rule hides', async () => {
    for (const base of ['/api/revisions', '/api/admin/revisions']) {
      const named = await listAs(
        editorCookie,
        `collection=${COLLECTION}&record_id=${hiddenId}`,
        base,
      );
      expect(named).toHaveLength(0);
      const all = await listAs(editorCookie, `collection=${COLLECTION}`, base);
      expect(all.map((r) => r.record_id)).not.toContain(hiddenId);
      expect(all.map((r) => r.record_id)).toContain(openId);
    }
    // God reads the hidden row, so its history too.
    const god = await listAs(godCookie, `collection=${COLLECTION}&record_id=${hiddenId}`);
    expect(god.length).toBeGreaterThan(0);
  });

  it('does not show the delete revision of a row hidden when it was deleted', async () => {
    const doomed = await post('doomed', 'restricted');
    const del = await app.request(`/api/data/${COLLECTION}/${doomed}`, {
      method: 'DELETE',
      headers: { cookie: godCookie },
    });
    expect(del.status).toBe(200);
    const revId = await revisionOf(doomed, 'delete');
    const res = await app.request(`/api/revisions/${revId}`, { headers: { cookie: editorCookie } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('doomed');
    expect(await listAs(editorCookie, `collection=${COLLECTION}&record_id=${doomed}`)).toHaveLength(
      0,
    );
    expect(
      await listAs(
        editorCookie,
        `collection=${COLLECTION}&record_id=${doomed}`,
        '/api/admin/revisions',
      ),
    ).toHaveLength(0);
    // God still reads it.
    const god = await app.request(`/api/revisions/${revId}`, { headers: { cookie: godCookie } });
    expect(god.status).toBe(200);
  });

  it('shapes revision data and delta by the caller’s column permissions', async () => {
    await patchAsGod(openId, { salary: '120000', grade: 'A' });
    const revId = (
      await sql<{ id: string }>`
        SELECT id FROM zv_revisions WHERE collection = ${COLLECTION} AND record_id = ${openId}
           AND delta ? 'salary' ORDER BY created_at DESC LIMIT 1`.execute(db)
    ).rows[0]!.id;
    const one = await app.request(`/api/revisions/${revId}`, { headers: { cookie: editorCookie } });
    expect(one.status).toBe(200);
    const text = await one.text();
    expect(text).not.toContain('120000');
    const { revision } = JSON.parse(text) as { revision: Revision };
    expect(revision.data.grade).toBe('A');
    expect(revision.data).not.toHaveProperty('salary');
    expect(revision.delta).not.toHaveProperty('salary');
    for (const base of ['/api/revisions', '/api/admin/revisions']) {
      const rows = await listAs(editorCookie, `collection=${COLLECTION}&record_id=${openId}`, base);
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain('120000');
    }
    // God is not masked.
    const god = await app.request(`/api/revisions/${revId}`, { headers: { cookie: godCookie } });
    expect(await god.text()).toContain('120000');
  });

  it('reverts through the update path: hidden columns untouched, read-only ones refused', async () => {
    const id = await post('before', 'open');
    const createRev = await revisionOf(id, 'create');
    await patchAsGod(id, { title: 'after', salary: '200' });
    const revert = (cookie: string) =>
      app.request(`/api/revisions/${createRev}/revert`, { method: 'POST', headers: { cookie } });

    // Only `title` differs among what the editor may see and write: it reverts,
    // and the hidden `salary` keeps its value.
    const ok = await revert(editorCookie);
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain('"200"');
    let row = await stored(id);
    expect(row.title).toBe('before');
    expect(row.salary).toBe('200');
    expect(row.updated_by).toBe(editorId);

    // Now a read-only column differs: the revert is refused, nothing written.
    await patchAsGod(id, { grade: 'B', title: 'later' });
    expect((await revert(editorCookie)).status).toBe(403);
    row = await stored(id);
    expect(row.grade).toBe('B');
    expect(row.title).toBe('later');
  });

  it('does not revert a revision of a row the row rule hides', async () => {
    const revId = await revisionOf(hiddenId, 'create');
    const res = await app.request(`/api/revisions/${revId}/revert`, {
      method: 'POST',
      headers: { cookie: editorCookie },
    });
    expect(res.status).toBe(404);
  });

  it('does not list the history of a dropped collection through an orphan grant', async () => {
    for (const base of ['/api/revisions', '/api/admin/revisions']) {
      const rows = await listAs(editorCookie, 'limit=200', base);
      expect(JSON.stringify(rows)).not.toContain('ghost-data');
      expect(await listAs(editorCookie, `collection=${GHOST}`, base)).toHaveLength(0);
    }
  });
});
