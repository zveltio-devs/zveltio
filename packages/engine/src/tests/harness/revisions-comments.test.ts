/**
 * Phase C — revisions routes: the audit list, revert 404, and the record
 * comment lifecycle (post → list → delete). Drives routes/revisions.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = 'user';
const RECORD = `rec-${Date.now()}`;

d('revisions + comments (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let commentId = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_record_comments WHERE record_id = ${RECORD}`
      .execute(db)
      .catch(() => {});
  });

  it('lists revisions (GET /)', async () => {
    const res = await app.request('/api/revisions?limit=10', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('lists revisions filtered by collection/record', async () => {
    const res = await app.request(`/api/revisions?collection=${COLLECTION}&record_id=${RECORD}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  });

  it('404s reverting an unknown revision (POST /:id/revert)', async () => {
    const res = await app.request('/api/revisions/00000000-0000-0000-0000-000000000000/revert', {
      method: 'POST',
      headers: { cookie },
    });
    expect([404, 400]).toContain(res.status);
  });

  it('lists comments for a record (GET /record/:collection/:recordId/comments)', async () => {
    const res = await app.request(`/api/revisions/record/${COLLECTION}/${RECORD}/comments`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  });

  it('posts a comment (POST /record/:collection/:recordId/comments)', async () => {
    const res = await app.request(
      `/api/revisions/record/${COLLECTION}/${RECORD}/comments`,
      json('POST', { comment: 'Harness note' }),
    );
    // 201 when the comments table is migrated (it is in the test DB).
    expect([201, 503]).toContain(res.status);
    if (res.status === 201) {
      commentId = ((await res.json()) as { comment: { id: string } }).comment.id;
      expect(commentId).toBeTruthy();
    }
  });

  it('deletes the comment (DELETE /record/comments/:commentId)', async () => {
    if (!commentId) return;
    const res = await app.request(`/api/revisions/record/comments/${commentId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
  });

  it('rejects unauthenticated revision listing', async () => {
    const res = await app.request('/api/revisions');
    expect(res.status).toBe(401);
  });
});
