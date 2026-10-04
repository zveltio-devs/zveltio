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
  let policyId = '';
  let openId = '';
  let hiddenId = '';

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

    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'bucket', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

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

  it('refuses a comment on a row the reader’s policy hides', async () => {
    const res = await comment(readerCookie, hiddenId, 'I can see you');
    expect(res.status).toBe(404);
  });

  it('refuses a comment on a record that does not exist', async () => {
    const res = await comment(godCookie, crypto.randomUUID(), 'into the void');
    expect(res.status).toBe(404);
  });
});
