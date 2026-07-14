/**
 * Phase C — media tags tenant isolation (routes/media.ts /tags). Regression:
 * zv_media_tags / zv_media_file_tags had no tenant_id, so GET /tags listed every
 * tenant's tags and PUT/DELETE /tags/:id could rename/delete another tenant's tag
 * by id. The handlers now scope tag reads/writes by the request tenant.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';
const FOREIGN_TAG_ID = '00000000-0000-4000-8000-0000000000fe';
const STAMP = Date.now();
const MY_TAG = `mine-tag-${STAMP}`;
const FOREIGN_TAG = `foreign-secret-tag-${STAMP}`;

d('media tags tenant isolation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let myTagId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    // A tag belonging to ANOTHER tenant, inserted directly.
    await db
      .insertInto('zv_media_tags')
      .values({ id: FOREIGN_TAG_ID, name: FOREIGN_TAG, color: '#000', tenant_id: OTHER_TENANT })
      .execute();
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zv_media_tags')
      .where('id', '=', FOREIGN_TAG_ID)
      .execute()
      .catch(() => {});
    if (myTagId) {
      await db
        .deleteFrom('zv_media_tags')
        .where('id', '=', myTagId)
        .execute()
        .catch(() => {});
    }
  });

  it('single-tenant: create + list a tag works and hides the other tenant’s tag', async () => {
    const create = await app.request('/api/media/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: MY_TAG, color: '#fff' }),
    });
    expect(create.status).toBe(201);
    myTagId = ((await create.json()) as { tag: { id: string } }).tag.id;

    const list = await app.request('/api/media/tags', { headers: { cookie } });
    expect(list.status).toBe(200);
    const names = ((await list.json()) as { tags: { id: string; name: string }[] }).tags.map(
      (t) => t.name,
    );
    expect(names).toContain(MY_TAG);
    expect(names).not.toContain(FOREIGN_TAG);
  });

  it('cross-tenant: DELETE /tags/:id does not remove another tenant’s tag', async () => {
    const res = await app.request(`/api/media/tags/${FOREIGN_TAG_ID}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200); // idempotent success, but nothing matched
    const still = await db
      .selectFrom('zv_media_tags')
      .select('id')
      .where('id', '=', FOREIGN_TAG_ID)
      .executeTakeFirst();
    expect(still?.id).toBe(FOREIGN_TAG_ID); // still there
  });

  it('cross-tenant: PUT /tags/:id does not rename another tenant’s tag', async () => {
    const res = await app.request(`/api/media/tags/${FOREIGN_TAG_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'HIJACKED' }),
    });
    expect(res.status).toBe(200);
    const row = await db
      .selectFrom('zv_media_tags')
      .select('name')
      .where('id', '=', FOREIGN_TAG_ID)
      .executeTakeFirst();
    expect(row?.name).toBe(FOREIGN_TAG); // unchanged
  });
});
